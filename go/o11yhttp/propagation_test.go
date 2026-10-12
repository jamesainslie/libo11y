package o11yhttp_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// TestHTTPPropagatesTraceContextAndBaggage drives a real round trip from an
// instrumented client transport to an instrumented server and requires the
// server to continue the caller's trace, as a child of the client span, with
// the caller's baggage.
func TestHTTPPropagatesTraceContextAndBaggage(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t)

	got := make(chan context.Context, 1)
	server := httptest.NewServer(o11yhttp.NewHandler(
		http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got <- r.Context() }),
		"server",
		o11yhttp.WithSDK(rec.SDK),
	))
	t.Cleanup(server.Close)
	client := &http.Client{Transport: o11yhttp.NewTransport(nil, o11yhttp.WithSDK(rec.SDK))}

	member, err := baggage.NewMember("tenant", "acme")
	if err != nil {
		t.Fatal(err)
	}
	bag, err := baggage.New(member)
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := rec.SDK.TracerProvider().Tracer("client").Start(baggage.ContextWithBaggage(context.Background(), bag), "call")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("closing body: %v", err)
	}
	span.End()

	serverCtx := <-got
	serverSC := trace.SpanContextFromContext(serverCtx)
	if serverSC.TraceID() != span.SpanContext().TraceID() {
		t.Errorf("server trace %s, want %s", serverSC.TraceID(), span.SpanContext().TraceID())
	}
	if v := baggage.FromContext(serverCtx).Member("tenant").Value(); v != "acme" {
		t.Errorf("server baggage tenant = %q, want acme", v)
	}

	// The handler writes nothing, so the response is sent only after it
	// returns and otelhttp has ended the server span: by the time Do
	// returns, the server span is recorded.
	var clientSpanID, serverParent trace.SpanID
	var serverRecorded bool
	for _, s := range rec.Spans() {
		switch {
		case s.SpanKind() == trace.SpanKindClient:
			clientSpanID = s.SpanContext().SpanID()
		case s.SpanContext().SpanID() == serverSC.SpanID():
			serverRecorded = true
			serverParent = s.Parent().SpanID()
		}
	}
	if !clientSpanID.IsValid() || !serverRecorded {
		t.Fatalf("client span recorded = %v, server span recorded = %v; want both", clientSpanID.IsValid(), serverRecorded)
	}
	if serverParent != clientSpanID {
		t.Errorf("server span parent = %s, want client span %s", serverParent, clientSpanID)
	}
}
