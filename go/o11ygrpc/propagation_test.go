package o11ygrpc_test

import (
	"context"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/baggage"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"github.com/jamesainslie/libo11y/go/o11ygrpc"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

const healthCheckMethod = "grpc.health.v1.Health/Check"

// healthFixture is an in-process gRPC health service over bufconn, with
// client and server both instrumented against one harness SDK.
type healthFixture struct {
	client healthpb.HealthClient
	// got receives the server-side context of every RPC, in arrival order.
	got <-chan context.Context
	// drain gracefully stops the server. It returns once every in-flight
	// RPC has completed, including its stats End callback, so the server
	// span of a finished RPC is guaranteed to be recorded afterwards.
	drain func()
}

// next returns the server-side context of the next RPC, failing the test
// instead of hanging if none arrives.
func (fx *healthFixture) next(t *testing.T) context.Context {
	t.Helper()
	select {
	case ctx := <-fx.got:
		return ctx
	case <-time.After(10 * time.Second):
		t.Fatal("no server-side RPC context captured")
		return nil
	}
}

func startHealthServer(t *testing.T, rec *o11ytest.Recorder, serverOpts ...o11ygrpc.Option) *healthFixture {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	got := make(chan context.Context, 8)
	capture := func(ctx context.Context) {
		select {
		case got <- ctx:
		default:
		}
	}
	srv := grpc.NewServer(
		grpc.StatsHandler(o11ygrpc.ServerHandler(append([]o11ygrpc.Option{o11ygrpc.WithSDK(rec.SDK)}, serverOpts...)...)),
		grpc.UnaryInterceptor(func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, h grpc.UnaryHandler) (any, error) {
			capture(ctx)
			return h(ctx, req)
		}),
		grpc.StreamInterceptor(func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, h grpc.StreamHandler) error {
			capture(ss.Context())
			return h(srv, ss)
		}),
	)
	healthpb.RegisterHealthServer(srv, health.NewServer())
	// Serve returns only when the server stops, after the test body; its
	// error cannot be reported once the test has finished.
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithStatsHandler(o11ygrpc.ClientHandler(o11ygrpc.WithSDK(rec.SDK))))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &healthFixture{client: healthpb.NewHealthClient(conn), got: got, drain: srv.GracefulStop}
}

func findSpan(spans []sdktrace.ReadOnlySpan, kind trace.SpanKind, name string) sdktrace.ReadOnlySpan {
	for _, s := range spans {
		if s.SpanKind() == kind && s.Name() == name {
			return s
		}
	}
	return nil
}

func TestGRPCPropagatesTraceContextAndBaggage(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	fx := startHealthServer(t, rec)

	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := rec.SDK.TracerProvider().Tracer("client").Start(baggage.ContextWithBaggage(context.Background(), bag), "call")
	defer span.End()

	if _, err := fx.client.Check(ctx, &healthpb.HealthCheckRequest{}); err != nil {
		t.Fatalf("Check: %v", err)
	}
	watchCtx, cancelWatch := context.WithCancel(ctx)
	defer cancelWatch()
	stream, err := fx.client.Watch(watchCtx, &healthpb.HealthCheckRequest{})
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("Recv: %v", err)
	}
	serverSpans := map[string]trace.SpanID{}
	for _, kind := range []string{"unary", "stream"} {
		serverCtx := fx.next(t)
		sc := trace.SpanContextFromContext(serverCtx)
		serverSpans[kind] = sc.SpanID()
		if sc.TraceID() != span.SpanContext().TraceID() {
			t.Errorf("%s: server trace %s, want %s", kind, sc.TraceID(), span.SpanContext().TraceID())
		}
		if v := baggage.FromContext(serverCtx).Member("tenant").Value(); v != "acme" {
			t.Errorf("%s: server baggage tenant = %q, want acme", kind, v)
		}
	}
	if _, err := fx.client.Check(ctx, &healthpb.HealthCheckRequest{Service: "missing"}); status.Code(err) != codes.NotFound {
		t.Errorf("error status = %v, want NotFound", err)
	}
	if tid := trace.SpanContextFromContext(fx.next(t)).TraceID(); tid != span.SpanContext().TraceID() {
		t.Errorf("error RPC: server trace %s, want %s", tid, span.SpanContext().TraceID())
	}

	cancelWatch()
	fx.drain()
	byID := map[trace.SpanID]sdktrace.ReadOnlySpan{}
	for _, s := range rec.Spans() {
		byID[s.SpanContext().SpanID()] = s
	}
	// The server span is the child of the client RPC span, not of the
	// caller's own span. A unary client span has ended by the time Check
	// returns, so it can be matched exactly; the cancelled Watch client
	// span ends asynchronously, so only its parentage is checked.
	for kind, id := range serverSpans {
		server, ok := byID[id]
		if !ok {
			t.Errorf("%s: server span %s not recorded", kind, id)
			continue
		}
		parent := server.Parent().SpanID()
		if !parent.IsValid() || parent == span.SpanContext().SpanID() {
			t.Errorf("%s: server span parent = %s, want the client RPC span", kind, parent)
			continue
		}
		if kind == "unary" {
			if client, ok := byID[parent]; !ok || client.SpanKind() != trace.SpanKindClient {
				t.Errorf("unary: server span parent %s is not a recorded client span", parent)
			}
		}
	}
}

func TestGRPCIgnoreHealthChecks(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		opts       []o11ygrpc.Option
		wantServer bool
	}{
		"default records probes":            {nil, true},
		"WithIgnoreHealthChecks skips them": {[]o11ygrpc.Option{o11ygrpc.WithIgnoreHealthChecks()}, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			rec := o11ytest.Start(t)
			fx := startHealthServer(t, rec, tc.opts...)
			if _, err := fx.client.Check(context.Background(), &healthpb.HealthCheckRequest{}); err != nil {
				t.Fatalf("Check: %v", err)
			}
			fx.drain()

			spans := rec.Spans()
			if findSpan(spans, trace.SpanKindClient, healthCheckMethod) == nil {
				t.Fatalf("no client span for %s; the RPC was not observed", healthCheckMethod)
			}
			if got := findSpan(spans, trace.SpanKindServer, healthCheckMethod) != nil; got != tc.wantServer {
				t.Errorf("server span recorded = %v, want %v", got, tc.wantServer)
			}
			gotMetrics := slices.ContainsFunc(rec.MetricNames(), func(n string) bool {
				return strings.HasPrefix(n, "rpc.server.")
			})
			if gotMetrics != tc.wantServer {
				t.Errorf("server RPC metrics recorded = %v, want %v (metrics %v)", gotMetrics, tc.wantServer, rec.MetricNames())
			}
		})
	}
}

func TestGRPCPublicEndpointLinksInsteadOfParenting(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)
	fx := startHealthServer(t, rec, o11ygrpc.WithPublicEndpoint())

	ctx, span := rec.SDK.TracerProvider().Tracer("client").Start(context.Background(), "call")
	if _, err := fx.client.Check(ctx, &healthpb.HealthCheckRequest{}); err != nil {
		t.Fatalf("Check: %v", err)
	}
	span.End()
	fx.drain()

	spans := rec.Spans()
	client := findSpan(spans, trace.SpanKindClient, healthCheckMethod)
	server := findSpan(spans, trace.SpanKindServer, healthCheckMethod)
	if client == nil || server == nil {
		t.Fatalf("client span %v, server span %v; want both", client, server)
	}
	if server.Parent().IsValid() {
		t.Errorf("server span parent = %v, want none (new root)", server.Parent())
	}
	if server.SpanContext().TraceID() == client.SpanContext().TraceID() {
		t.Errorf("server span joined the caller's trace %s", client.SpanContext().TraceID())
	}
	links := server.Links()
	if len(links) != 1 {
		t.Fatalf("server span has %d links, want 1", len(links))
	}
	if got, want := links[0].SpanContext.TraceID(), client.SpanContext().TraceID(); got != want {
		t.Errorf("link trace = %s, want client trace %s", got, want)
	}
	if got, want := links[0].SpanContext.SpanID(), client.SpanContext().SpanID(); got != want {
		t.Errorf("link span = %s, want client span %s", got, want)
	}
}
