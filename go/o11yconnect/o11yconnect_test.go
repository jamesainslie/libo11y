package o11yconnect_test

import (
	"context"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"connectrpc.com/connect"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/protobuf/types/known/wrapperspb"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yconnect"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

const (
	echoProcedure       = "/test.v1.EchoService/Echo"
	echoMethod          = "test.v1.EchoService/Echo"
	echoGetProcedure    = "/test.v1.EchoService/EchoGet" // side-effect free, so callable with GET
	echoGetMethod       = "test.v1.EchoService/EchoGet"
	echoStreamProcedure = "/test.v1.EchoService/EchoStream" // server streaming
	echoStreamMethod    = "test.v1.EchoService/EchoStream"
	healthProcedure     = "/grpc.health.v1.Health/Check"
)

// fixture is a Connect server over httptest whose handlers are instrumented
// with a ServerInterceptor bound to one harness SDK.
type fixture struct {
	rec    *o11ytest.Recorder
	url    string
	client *http.Client
	// handled receives the server-side context of each RPC, in arrival order.
	handled chan context.Context
}

// echo answers with its input. The input selects other behaviour: "not-found"
// and "internal" fail with that code, "not-modified" fails with
// connect.NewNotModifiedError, "record" adds an attribute to the RPC's wide
// event, and "panic" panics.
func (fx *fixture) echo(ctx context.Context, req *connect.Request[wrapperspb.StringValue]) (*connect.Response[wrapperspb.StringValue], error) {
	select {
	case fx.handled <- ctx:
	default:
	}
	fx.rec.SDK.Logger().InfoContext(ctx, "echo handled")
	switch req.Msg.GetValue() {
	case "not-found":
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no such thing"))
	case "internal":
		return nil, connect.NewError(connect.CodeInternal, errors.New("broken"))
	case "not-modified":
		return nil, connect.NewNotModifiedError(nil)
	case "record":
		o11y.RecordFromContext(ctx).Set(slog.Int("echo.items", 3))
	case "panic":
		panic("echo panicked")
	}
	return connect.NewResponse(wrapperspb.String(req.Msg.GetValue())), nil
}

// echoStream is echo as a server-streaming RPC: it sends echo's answer as
// its one message, or fails as echo does.
func (fx *fixture) echoStream(ctx context.Context, req *connect.Request[wrapperspb.StringValue], stream *connect.ServerStream[wrapperspb.StringValue]) error {
	resp, err := fx.echo(ctx, req)
	if err != nil {
		return err
	}
	return stream.Send(resp.Msg)
}

func start(t *testing.T, rec *o11ytest.Recorder, serverOpts ...o11yconnect.Option) *fixture {
	t.Helper()
	interceptor, err := o11yconnect.ServerInterceptor(append([]o11yconnect.Option{o11yconnect.WithSDK(rec.SDK)}, serverOpts...)...)
	if err != nil {
		t.Fatalf("ServerInterceptor: %v", err)
	}
	return serve(t, rec, interceptor, nil)
}

// serve starts the echo handlers instrumented with interceptor. A non-nil
// wrap wraps the whole mux, as HTTP middleware in front of Connect would.
func serve(t *testing.T, rec *o11ytest.Recorder, interceptor connect.Interceptor, wrap func(http.Handler) http.Handler) *fixture {
	t.Helper()
	// handled holds the first 8 RPC contexts; later ones are dropped.
	fx := &fixture{rec: rec, handled: make(chan context.Context, 8)}
	mux := http.NewServeMux()
	for _, procedure := range []string{echoProcedure, healthProcedure} {
		mux.Handle(procedure, connect.NewUnaryHandler(procedure, fx.echo, connect.WithInterceptors(interceptor)))
	}
	mux.Handle(echoGetProcedure, connect.NewUnaryHandler(echoGetProcedure, fx.echo,
		connect.WithInterceptors(interceptor), connect.WithIdempotency(connect.IdempotencyNoSideEffects)))
	mux.Handle(echoStreamProcedure, connect.NewServerStreamHandler(echoStreamProcedure, fx.echoStream, connect.WithInterceptors(interceptor)))
	var handler http.Handler = mux
	if wrap != nil {
		handler = wrap(mux)
	}
	srv := httptest.NewUnstartedServer(handler)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // the panic test's recovered panic is expected
	srv.Start()
	t.Cleanup(srv.Close)
	fx.url, fx.client = srv.URL, srv.Client()
	return fx
}

// call makes one unary RPC in the Connect protocol. With clientOpts it
// uses a client instrumented by ClientInterceptor(clientOpts...); without,
// an uninstrumented client.
func (fx *fixture) call(ctx context.Context, t *testing.T, procedure, value string, clientOpts ...o11yconnect.Option) error {
	t.Helper()
	var options []connect.ClientOption
	if len(clientOpts) > 0 {
		interceptor, err := o11yconnect.ClientInterceptor(clientOpts...)
		if err != nil {
			t.Fatalf("ClientInterceptor: %v", err)
		}
		options = append(options, connect.WithInterceptors(interceptor))
	}
	return fx.unary(ctx, procedure, value, options...)
}

// unary makes one unary RPC with a client built from options, which pick
// the protocol (Connect unless they say otherwise) and any interceptors.
func (fx *fixture) unary(ctx context.Context, procedure, value string, options ...connect.ClientOption) error {
	client := connect.NewClient[wrapperspb.StringValue, wrapperspb.StringValue](fx.client, fx.url+procedure, options...)
	_, err := client.CallUnary(ctx, connect.NewRequest(wrapperspb.String(value)))
	return err
}

// stream makes one server-streaming RPC in the Connect protocol with an
// uninstrumented client and reads it to the end.
func (fx *fixture) stream(ctx context.Context, value string) error {
	client := connect.NewClient[wrapperspb.StringValue, wrapperspb.StringValue](fx.client, fx.url+echoStreamProcedure)
	stream, err := client.CallServerStream(ctx, connect.NewRequest(wrapperspb.String(value)))
	if err != nil {
		return err
	}
	for stream.Receive() {
	}
	return errors.Join(stream.Err(), stream.Close())
}

func spanByKind(t *testing.T, spans []sdktrace.ReadOnlySpan, kind trace.SpanKind) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range spans {
		if s.SpanKind() == kind {
			return s
		}
	}
	t.Fatalf("no %v span among %d spans", kind, len(spans))
	return nil
}

// logNamed returns the one log record with the given message.
func logNamed(t *testing.T, rec *o11ytest.Recorder, message string) o11ytest.LogRecord {
	t.Helper()
	for _, l := range rec.Logs() {
		if l.Record.Message == message {
			return l
		}
	}
	t.Fatalf("no log record %q", message)
	return o11ytest.LogRecord{}
}

func TestServerInterceptorRecordsSpanAndMetrics(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec)
	if err := fx.call(context.Background(), t, echoProcedure, "hi"); err != nil {
		t.Fatalf("call: %v", err)
	}

	span := spanByKind(t, rec.Spans(), trace.SpanKindServer)
	if span.Name() != echoMethod {
		t.Errorf("span name = %q, want %q", span.Name(), echoMethod)
	}
	attrs := attribute.NewSet(span.Attributes()...)
	for key, want := range map[attribute.Key]string{"rpc.system.name": "connectrpc", "rpc.method": echoMethod} {
		if v, ok := attrs.Value(key); !ok || v.AsString() != want {
			t.Errorf("%s = %q (present %v), want %q", key, v.AsString(), ok, want)
		}
	}
	if !slices.Contains(rec.MetricNames(), "rpc.server.call.duration") {
		t.Errorf("metrics %v lack rpc.server.call.duration", rec.MetricNames())
	}
	rec.AssertConforms(t)
}

// TestServerCorrelationTriangle pins that one RPC's server span, the log
// its handler writes, and the exemplar on its duration share one identity.
func TestServerCorrelationTriangle(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec)
	if err := fx.call(context.Background(), t, echoProcedure, "hi"); err != nil {
		t.Fatalf("call: %v", err)
	}

	span := spanByKind(t, rec.Spans(), trace.SpanKindServer).SpanContext()
	if got := logNamed(t, rec, "echo handled").SpanContext; got.SpanID() != span.SpanID() {
		t.Errorf("handler log span = %v, want the server span %v", got.SpanID(), span.SpanID())
	}
	exemplars := rec.Exemplars("rpc.server.call.duration")
	if len(exemplars) == 0 {
		t.Fatal("no exemplar on rpc.server.call.duration")
	}
	if exemplars[0].TraceID != span.TraceID() || exemplars[0].SpanID != span.SpanID() {
		t.Errorf("exemplar %v/%v, want %v/%v", exemplars[0].TraceID, exemplars[0].SpanID, span.TraceID(), span.SpanID())
	}
}

func TestServerAdoptsTheCallersContext(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec)
	ctx, caller := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "caller")
	if err := fx.call(ctx, t, echoProcedure, "hi", o11yconnect.WithSDK(rec.SDK)); err != nil {
		t.Fatalf("call: %v", err)
	}
	caller.End()

	server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
	client := spanByKind(t, rec.Spans(), trace.SpanKindClient)
	if server.Parent().SpanID() != client.SpanContext().SpanID() {
		t.Errorf("server parent = %v, want the client span %v", server.Parent().SpanID(), client.SpanContext().SpanID())
	}
	if server.SpanContext().TraceID() != caller.SpanContext().TraceID() {
		t.Error("server span is not in the caller's trace")
	}
}

func TestPublicEndpointLinksInsteadOfAdopting(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec, o11yconnect.WithPublicEndpoint())
	ctx, caller := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "caller")
	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatalf("NewMember: %v", err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatalf("baggage.New: %v", err)
	}
	if err := fx.call(baggage.ContextWithBaggage(ctx, bag), t, echoProcedure, "hi", o11yconnect.WithSDK(rec.SDK)); err != nil {
		t.Fatalf("call: %v", err)
	}
	caller.End()

	server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
	client := spanByKind(t, rec.Spans(), trace.SpanKindClient)
	if server.Parent().IsValid() {
		t.Errorf("server span has parent %v, want a new root", server.Parent())
	}
	if server.SpanContext().TraceID() == client.SpanContext().TraceID() {
		t.Error("server span joined the caller's trace")
	}
	if links := server.Links(); len(links) != 1 || links[0].SpanContext.SpanID() != client.SpanContext().SpanID() {
		t.Errorf("links = %v, want one link to the client span", links)
	}
	if got := baggage.FromContext(<-fx.handled).Member("tenant").Value(); got != "acme" {
		t.Errorf("handler baggage tenant = %q, want acme (baggage is still adopted)", got)
	}
}

// TestClientInterceptorOnAHandlerStillAdopts pins that only
// WithPublicEndpoint decides whether a handler trusts inbound context: a
// handler given ClientInterceptor by mistake adopts it as ServerInterceptor
// does, instead of silently starting a new trace per RPC.
func TestClientInterceptorOnAHandlerStillAdopts(t *testing.T) {
	rec := o11ytest.Start(t)
	interceptor, err := o11yconnect.ClientInterceptor(o11yconnect.WithSDK(rec.SDK))
	if err != nil {
		t.Fatalf("ClientInterceptor: %v", err)
	}
	fx := serve(t, rec, interceptor, nil)
	if err := fx.call(context.Background(), t, echoProcedure, "hi", o11yconnect.WithSDK(rec.SDK)); err != nil {
		t.Fatalf("call: %v", err)
	}

	server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
	client := spanByKind(t, rec.Spans(), trace.SpanKindClient)
	if server.Parent().SpanID() != client.SpanContext().SpanID() {
		t.Errorf("server parent = %v, want the client span %v", server.Parent().SpanID(), client.SpanContext().SpanID())
	}
}

// TestBehindInstrumentedHTTPTheOuterLayerDecidesTrust pins the documented
// composition with o11yhttp: the HTTP layer has already started a span, so
// otelconnect extracts nothing and nests the RPC span under it, and a
// public endpoint must be declared on the HTTP layer to keep callers out.
func TestBehindInstrumentedHTTPTheOuterLayerDecidesTrust(t *testing.T) {
	rec := o11ytest.Start(t)
	interceptor, err := o11yconnect.ServerInterceptor(o11yconnect.WithSDK(rec.SDK), o11yconnect.WithPublicEndpoint())
	if err != nil {
		t.Fatalf("ServerInterceptor: %v", err)
	}
	fx := serve(t, rec, interceptor, func(h http.Handler) http.Handler {
		return o11yhttp.NewHandler(h, "api", o11yhttp.WithSDK(rec.SDK), o11yhttp.WithPublicEndpoint())
	})
	ctx, caller := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "caller")
	if err := fx.call(ctx, t, echoProcedure, "hi", o11yconnect.WithSDK(rec.SDK)); err != nil {
		t.Fatalf("call: %v", err)
	}
	caller.End()

	var rpc, outer sdktrace.ReadOnlySpan
	for _, s := range rec.Spans() {
		if s.SpanKind() != trace.SpanKindServer {
			continue
		}
		if s.Name() == echoMethod {
			rpc = s
		} else {
			outer = s
		}
	}
	if rpc == nil || outer == nil {
		t.Fatalf("want an HTTP and an RPC server span, got rpc=%v http=%v", rpc, outer)
	}
	if rpc.Parent().SpanID() != outer.SpanContext().SpanID() {
		t.Errorf("rpc span parent = %v, want the HTTP server span %v", rpc.Parent().SpanID(), outer.SpanContext().SpanID())
	}
	if rpc.SpanContext().TraceID() == caller.SpanContext().TraceID() {
		t.Error("rpc span joined the caller's trace")
	}
}

// TestPanicMarksTheServerSpan pins that a panicking handler leaves its
// server span with status Error, as o11yhttp does, whichever constructor
// instrumented the handler and with no connect.WithRecover to turn the
// panic into an error first.
func TestPanicMarksTheServerSpan(t *testing.T) {
	for name, build := range map[string]func(...o11yconnect.Option) (connect.Interceptor, error){
		"server": o11yconnect.ServerInterceptor,
		"client": o11yconnect.ClientInterceptor,
	} {
		t.Run(name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			interceptor, err := build(o11yconnect.WithSDK(rec.SDK))
			if err != nil {
				t.Fatalf("interceptor: %v", err)
			}
			fx := serve(t, rec, interceptor, nil)
			if err := fx.call(context.Background(), t, echoProcedure, "panic"); err == nil {
				t.Fatal("call to a panicking handler succeeded")
			}
			if got := spanByKind(t, rec.Spans(), trace.SpanKindServer).Status(); got.Code != codes.Error {
				t.Errorf("server span status = %v, want Error", got)
			}
		})
	}
}

func TestIgnoreHealthChecks(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec, o11yconnect.WithIgnoreHealthChecks())
	client := []o11yconnect.Option{o11yconnect.WithSDK(rec.SDK), o11yconnect.WithIgnoreHealthChecks()}
	if err := fx.call(context.Background(), t, healthProcedure, "probe", client...); err != nil {
		t.Fatalf("health call: %v", err)
	}
	if spans := rec.Spans(); len(spans) != 0 {
		t.Fatalf("health check produced %d spans, want none", len(spans))
	}
	if err := fx.call(context.Background(), t, echoProcedure, "hi", client...); err != nil {
		t.Fatalf("echo call: %v", err)
	}
	if spans := rec.Spans(); len(spans) != 2 {
		t.Errorf("echo produced %d spans, want a client and a server span", len(spans))
	}
}

func TestInterceptorsWithoutSDKUseGlobals(t *testing.T) {
	if _, err := o11yconnect.ServerInterceptor(); err != nil {
		t.Errorf("ServerInterceptor() error = %v", err)
	}
	if _, err := o11yconnect.ClientInterceptor(); err != nil {
		t.Errorf("ClientInterceptor() error = %v", err)
	}
}
