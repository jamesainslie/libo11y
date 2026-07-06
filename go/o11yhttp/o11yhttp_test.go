package o11yhttp_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
)

func newSDK(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder, *sdkmetric.ManualReader) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("o11yhttp-test"),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			t.Errorf("Shutdown: %v", err)
		}
	})
	return sdk, recorder, reader
}

func TestServerSpanUsesRoutePattern(t *testing.T) {
	sdk, recorder, reader := newSDK(t)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	server := httptest.NewServer(o11yhttp.NewHandler(mux, "users", o11yhttp.WithSDK(sdk)))
	defer server.Close()

	resp, err := http.Get(server.URL + "/users/42")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("closing body: %v", err)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got, want := spans[0].Name(), "GET /users/{id}"; got != want {
		t.Errorf("span name = %q, want %q (route-aware naming)", got, want)
	}

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !hasMetric(&data, "http.server.request.duration") {
		t.Errorf("http.server.request.duration missing; stable HTTP semconv metrics expected")
	}
}

func hasMetric(data *metricdata.ResourceMetrics, name string) bool {
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name == name {
				return true
			}
		}
	}
	return false
}

func TestIgnorePathsFilters(t *testing.T) {
	sdk, recorder, _ := newSDK(t)

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {})
	handler := o11yhttp.NewHandler(mux, "server",
		o11yhttp.WithSDK(sdk),
		o11yhttp.WithIgnorePaths("/healthz", "/debug/*"),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	for _, target := range []string{"/healthz", "/debug/vars", "/work"} {
		resp, err := http.Get(server.URL + target)
		if err != nil {
			t.Fatalf("GET %s: %v", target, err)
		}
		if err := resp.Body.Close(); err != nil {
			t.Fatalf("closing body: %v", err)
		}
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1 (probes filtered)", len(spans))
	}
}

// TestTransportPropagatesTraceContext verifies the one-identity contract on
// egress: the outgoing request carries the active span's trace ID in a W3C
// traceparent header.
func TestTransportPropagatesTraceContext(t *testing.T) {
	sdk, recorder, _ := newSDK(t)

	var traceparent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		traceparent = r.Header.Get("traceparent")
	}))
	defer upstream.Close()

	client := &http.Client{Transport: o11yhttp.NewTransport(nil, o11yhttp.WithSDK(sdk))}

	ctx, span := sdk.TracerProvider().Tracer("test").Start(context.Background(), "outbound-call")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream.URL, nil)
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

	if traceparent == "" {
		t.Fatal("no traceparent header on outgoing request")
	}
	wantTrace := span.SpanContext().TraceID().String()
	if !strings.Contains(traceparent, wantTrace) {
		t.Errorf("traceparent %q does not carry active trace ID %s", traceparent, wantTrace)
	}

	spans := recorder.Ended()
	if len(spans) != 2 { // client span + manual span
		t.Errorf("got %d spans, want 2", len(spans))
	}
}

// TestServerAdoptsInboundTraceContext verifies the one-identity contract on
// ingress: a valid inbound traceparent becomes the server span's trace.
func TestServerAdoptsInboundTraceContext(t *testing.T) {
	sdk, recorder, _ := newSDK(t)

	handler := o11yhttp.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}),
		"server",
		o11yhttp.WithSDK(sdk),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	const inboundTrace = "0af7651916cd43dd8448eb211c80319c"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("traceparent", "00-"+inboundTrace+"-b7ad6b7169203331-01")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("closing body: %v", err)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got := spans[0].SpanContext().TraceID().String(); got != inboundTrace {
		t.Errorf("server span trace = %s, want inbound %s (context must be adopted)", got, inboundTrace)
	}
	if got := spans[0].Parent().SpanID().String(); got != "b7ad6b7169203331" {
		t.Errorf("server span parent = %s, want inbound span ID", got)
	}
}
