package o11yconnect_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11yconnect"
	"github.com/jamesainslie/libo11y/go/o11ytest"
	"github.com/jamesainslie/libo11y/go/spec"
)

// summaries returns the o11y.request.summary records captured so far.
func summaries(rec *o11ytest.Recorder) []o11ytest.LogRecord {
	var out []o11ytest.LogRecord
	for _, l := range rec.Logs() {
		if name, _ := l.Attr(spec.EventNameKey); name == spec.EventRequestSummary {
			out = append(out, l)
		}
	}
	return out
}

func TestCanonicalLineSummarizesEachRPC(t *testing.T) {
	cases := []struct {
		input   string
		status  string
		rpcCode string
		outcome spec.Outcome
	}{
		{"hi", "200", "OK", spec.OutcomeSuccess},
		{"not-found", "404", "NOT_FOUND", spec.OutcomeSuccess},
		{"internal", "500", "INTERNAL", spec.OutcomeFailure},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			rec := o11ytest.Start(t)
			fx := start(t, rec, o11yconnect.WithCanonicalLine())
			_ = fx.call(context.Background(), t, echoProcedure, tc.input) // failures are part of the cases

			got := summaries(rec)
			if len(got) != 1 {
				t.Fatalf("got %d summaries, want 1", len(got))
			}
			for key, want := range map[string]string{
				"http.request.method":       "POST",
				"http.response.status_code": tc.status,
				string(spec.OutcomeKey):     string(tc.outcome),
				"rpc.system.name":           "connectrpc",
				"rpc.method":                echoMethod,
				"rpc.response.status_code":  tc.rpcCode,
			} {
				if v, ok := got[0].Attr(key); !ok || v != want {
					t.Errorf("%s = %q (present %v), want %q", key, v, ok, want)
				}
			}
			if _, ok := got[0].Attr(string(spec.DurationKey)); !ok {
				t.Error("summary lacks o11y.duration")
			}
			server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
			if got[0].SpanContext.SpanID() != server.SpanContext().SpanID() {
				t.Error("summary is not correlated with the server span")
			}
			rec.AssertConforms(t)
		})
	}
}

func TestCanonicalLineCarriesHandlerAttributes(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec, o11yconnect.WithCanonicalLine())
	if err := fx.call(context.Background(), t, echoProcedure, "record"); err != nil {
		t.Fatalf("call: %v", err)
	}
	got := summaries(rec)
	if len(got) != 1 {
		t.Fatalf("got %d summaries, want 1", len(got))
	}
	if v, ok := got[0].Attr("echo.items"); !ok || v != "3" {
		t.Errorf("echo.items = %q (present %v), want 3", v, ok)
	}
}

func TestCanonicalLineFiresOnPanic(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec, o11yconnect.WithCanonicalLine())
	if err := fx.call(context.Background(), t, echoProcedure, "panic"); err == nil {
		t.Fatal("call to a panicking handler succeeded")
	}
	got := summaries(rec)
	if len(got) != 1 {
		t.Fatalf("got %d summaries, want 1", len(got))
	}
	if v, _ := got[0].Attr("http.response.status_code"); v != "500" {
		t.Errorf("status = %q, want 500", v)
	}
	if v, _ := got[0].Attr(string(spec.OutcomeKey)); v != string(spec.OutcomeFailure) {
		t.Errorf("outcome = %q, want failure", v)
	}
	server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
	if got[0].SpanContext.SpanID() != server.SpanContext().SpanID() {
		t.Error("summary is not correlated with the server span")
	}
	if server.Status().Code != codes.Error {
		t.Errorf("server span status = %v, want Error, agreeing with the summary", server.Status())
	}
}

// TestCanonicalLineReportsWhatTheServerSends covers the protocols and
// stream types whose wire status differs from the Connect unary mapping.
func TestCanonicalLineReportsWhatTheServerSends(t *testing.T) {
	cases := []struct {
		name       string
		rpc        func(context.Context, *fixture) error
		rpcMethod  string
		httpMethod string
		status     string
		rpcCode    string
		system     string
		outcome    spec.Outcome
	}{
		{
			name:      "stream",
			rpc:       func(ctx context.Context, fx *fixture) error { return fx.stream(ctx, "hi") },
			rpcMethod: echoStreamMethod, httpMethod: "POST", status: "200", rpcCode: "OK",
			system: "connectrpc", outcome: spec.OutcomeSuccess,
		},
		{
			name:      "stream error",
			rpc:       func(ctx context.Context, fx *fixture) error { return fx.stream(ctx, "internal") },
			rpcMethod: echoStreamMethod, httpMethod: "POST", status: "200", rpcCode: "INTERNAL",
			system: "connectrpc", outcome: spec.OutcomeFailure,
		},
		{
			name: "grpc-web error",
			rpc: func(ctx context.Context, fx *fixture) error {
				return fx.unary(ctx, echoProcedure, "not-found", connect.WithGRPCWeb())
			},
			rpcMethod: echoMethod, httpMethod: "POST", status: "200", rpcCode: "NOT_FOUND",
			system: "grpc", outcome: spec.OutcomeSuccess,
		},
		{
			name: "not modified on get",
			rpc: func(ctx context.Context, fx *fixture) error {
				return fx.unary(ctx, echoGetProcedure, "not-modified",
					connect.WithHTTPGet(), connect.WithIdempotency(connect.IdempotencyNoSideEffects))
			},
			rpcMethod: echoGetMethod, httpMethod: "GET", status: "304", rpcCode: "OK",
			system: "connectrpc", outcome: spec.OutcomeSuccess,
		},
		{
			// connect-go sends 304 only for GET; otherwise not-modified is
			// an unknown error on the wire.
			name: "not modified on post",
			rpc: func(ctx context.Context, fx *fixture) error {
				return fx.unary(ctx, echoProcedure, "not-modified")
			},
			rpcMethod: echoMethod, httpMethod: "POST", status: "500", rpcCode: "UNKNOWN",
			system: "connectrpc", outcome: spec.OutcomeFailure,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			fx := start(t, rec, o11yconnect.WithCanonicalLine())
			_ = tc.rpc(context.Background(), fx) // failures are part of the cases

			got := summaries(rec)
			if len(got) != 1 {
				t.Fatalf("got %d summaries, want 1", len(got))
			}
			for key, want := range map[string]string{
				"http.request.method":       tc.httpMethod,
				"http.response.status_code": tc.status,
				string(spec.OutcomeKey):     string(tc.outcome),
				"rpc.system.name":           tc.system,
				"rpc.method":                tc.rpcMethod,
				"rpc.response.status_code":  tc.rpcCode,
			} {
				if v, ok := got[0].Attr(key); !ok || v != want {
					t.Errorf("%s = %q (present %v), want %q", key, v, ok, want)
				}
			}
			server := spanByKind(t, rec.Spans(), trace.SpanKindServer)
			if got[0].SpanContext.SpanID() != server.SpanContext().SpanID() {
				t.Error("summary is not correlated with the server span")
			}
			rec.AssertConforms(t)
		})
	}
}

func TestCanonicalLineSkipsIgnoredHealthChecks(t *testing.T) {
	rec := o11ytest.Start(t)
	fx := start(t, rec, o11yconnect.WithCanonicalLine(), o11yconnect.WithIgnoreHealthChecks())
	if err := fx.call(context.Background(), t, healthProcedure, "probe"); err != nil {
		t.Fatalf("call: %v", err)
	}
	if got := summaries(rec); len(got) != 0 {
		t.Errorf("health check produced %d summaries, want none", len(got))
	}
}

// TestCanonicalLineRequiresAnSDK pins that WithCanonicalLine without
// WithSDK is refused rather than silently emitting nothing.
func TestCanonicalLineRequiresAnSDK(t *testing.T) {
	interceptor, err := o11yconnect.ServerInterceptor(o11yconnect.WithCanonicalLine())
	if err == nil {
		t.Fatalf("ServerInterceptor(WithCanonicalLine()) = %v, nil; want an error", interceptor)
	}
	if want := "o11yconnect: WithCanonicalLine requires WithSDK"; err.Error() != want {
		t.Errorf("error = %q, want %q", err, want)
	}
}
