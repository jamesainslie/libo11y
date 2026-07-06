package o11yhttp_test

import (
	"context"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yhttp"
	"github.com/jamesainslie/libo11y/go/spec"
)

// captureHandler collects flattened log records for assertions. It is
// concurrency-safe because middleware emits from the server goroutine while
// the test goroutine reads.
type captureHandler struct {
	mu      *sync.Mutex
	records *[]map[string]any
}

func newCapture() (captureHandler, func() []map[string]any) {
	var mu sync.Mutex
	var records []map[string]any
	h := captureHandler{mu: &mu, records: &records}
	snapshot := func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		out := make([]map[string]any, len(records))
		copy(out, records)
		return out
	}
	return h, snapshot
}

func (c captureHandler) Enabled(context.Context, slog.Level) bool { return true }
func (c captureHandler) Handle(_ context.Context, r slog.Record) error {
	m := map[string]any{"msg": r.Message}
	r.Attrs(func(a slog.Attr) bool {
		m[a.Key] = a.Value.Any()
		return true
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	*c.records = append(*c.records, m)
	return nil
}
func (c captureHandler) WithAttrs([]slog.Attr) slog.Handler { return c }
func (c captureHandler) WithGroup(string) slog.Handler      { return c }

// quietLogger discards the httptest server's per-connection panic log.
func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// TestCanonicalLineEmitsRequestSummary verifies the wide-event path: one
// o11y.request.summary event per request carrying method, route, status,
// outcome, and handler-accumulated attributes.
func TestCanonicalLineEmitsRequestSummary(t *testing.T) {
	capture, snapshot := newCapture()
	recorder := tracetest.NewSpanRecorder()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("canonical-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(capture),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		o11y.RecordFromContext(r.Context()).Set(slog.String("order.id", r.PathValue("id")))
		w.WriteHeader(http.StatusOK)
	})
	handler := o11yhttp.NewHandler(mux, "orders",
		o11yhttp.WithSDK(sdk),
		o11yhttp.WithCanonicalLine(),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	resp, err := http.Get(server.URL + "/orders/42")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("closing body: %v", err)
	}

	var summary map[string]any
	for _, record := range snapshot() {
		if record["event.name"] == "o11y.request.summary" {
			summary = record
		}
	}
	if summary == nil {
		t.Fatal("no o11y.request.summary event emitted")
	}
	if summary["http.route"] != "/orders/{id}" {
		t.Errorf("http.route = %v, want /orders/{id}", summary["http.route"])
	}
	if summary["http.request.method"] != "GET" {
		t.Errorf("http.request.method = %v, want GET", summary["http.request.method"])
	}
	if summary["o11y.outcome"] != "success" {
		t.Errorf("o11y.outcome = %v, want success", summary["o11y.outcome"])
	}
	if summary["order.id"] != "42" {
		t.Errorf("order.id = %v, want 42 (accumulated by handler)", summary["order.id"])
	}
}

func newSDK(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder, *sdkmetric.ManualReader) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("o11yhttp-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
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

// TestServerDurationCarriesExemplar pins the metric-to-trace leg through
// real middleware: the http.server.request.duration histogram must carry
// an exemplar stamped with the server span's trace identity.
func TestServerDurationCarriesExemplar(t *testing.T) {
	sdk, recorder, reader := newSDK(t)

	handler := o11yhttp.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}),
		"server",
		o11yhttp.WithSDK(sdk),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	resp, err := http.Get(server.URL + "/work")
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
	wantTrace := spans[0].SpanContext().TraceID()

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	exemplars := durationExemplars(&data)
	if len(exemplars) == 0 {
		t.Fatal("http.server.request.duration carries no exemplars")
	}
	var gotTrace [16]byte
	copy(gotTrace[:], exemplars[0].TraceID)
	if gotTrace != [16]byte(wantTrace) {
		t.Errorf("exemplar trace = %x, want %s", exemplars[0].TraceID, wantTrace)
	}
}

func durationExemplars(data *metricdata.ResourceMetrics) []metricdata.Exemplar[float64] {
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != "http.server.request.duration" {
				continue
			}
			hist, ok := m.Data.(metricdata.Histogram[float64])
			if !ok {
				return nil
			}
			var out []metricdata.Exemplar[float64]
			for _, dp := range hist.DataPoints {
				out = append(out, dp.Exemplars...)
			}
			return out
		}
	}
	return nil
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

// TestCanonicalLinePreservesFlusher pins that the canonical-line wrapper
// does not strip the optional ResponseWriter interfaces streaming handlers
// rely on.
func TestCanonicalLinePreservesFlusher(t *testing.T) {
	capture, _ := newCapture()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("flusher-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(capture),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()

	var flushable atomic.Bool
	handler := o11yhttp.NewHandler(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// The modern stdlib idiom for reaching Flush through wrappers.
			if err := http.NewResponseController(w).Flush(); err == nil {
				flushable.Store(true)
			}
		}),
		"stream",
		o11yhttp.WithSDK(sdk),
		o11yhttp.WithCanonicalLine(),
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	resp, err := http.Get(server.URL + "/stream")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("closing body: %v", err)
	}
	if !flushable.Load() {
		t.Error("canonical-line wrapper stripped http.Flusher (streaming would break)")
	}
}

// TestCanonicalLineOnPanic pins that a panicking handler still emits the
// summary, marked as a failure rather than a spurious 200 success.
func TestCanonicalLineOnPanic(t *testing.T) {
	capture, snapshot := newCapture()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("panic-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(tracetest.NewSpanRecorder()),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(capture),
	)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()

	// httptest's server recovers per-connection panics; suppress its log.
	handler := o11yhttp.NewHandler(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("handler exploded")
		}),
		"panicky",
		o11yhttp.WithSDK(sdk),
		o11yhttp.WithCanonicalLine(),
	)
	server := httptest.NewServer(handler)
	server.Config.ErrorLog = quietLogger()
	defer server.Close()

	// The panic aborts the connection, so the client sees an error; the
	// summary must still have been emitted server-side before unwinding.
	resp, err := http.Get(server.URL + "/boom")
	if err == nil {
		_ = resp.Body.Close()
	}

	var summary map[string]any
	for _, record := range snapshot() {
		if record["event.name"] == "o11y.request.summary" {
			summary = record
		}
	}
	if summary == nil {
		t.Fatal("no summary emitted for a panicking request")
	}
	if summary["o11y.outcome"] != "failure" {
		t.Errorf("o11y.outcome = %v, want failure for a panic", summary["o11y.outcome"])
	}
	if code, _ := summary["http.response.status_code"].(int64); code != 500 {
		t.Errorf("http.response.status_code = %v, want 500 for a panic", summary["http.response.status_code"])
	}
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
