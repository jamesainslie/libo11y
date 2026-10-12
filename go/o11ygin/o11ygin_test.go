package o11ygin_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygin"
	"github.com/jamesainslie/libo11y/go/spec"
)

func newSDK(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("o11ygin-test"),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithSpanProcessor(recorder),
		o11y.WithMetricReader(sdkmetric.NewManualReader()),
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
	return sdk, recorder
}

func newRouter(sdk *o11y.SDK, opts ...o11ygin.Option) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(o11ygin.Middleware("api", append([]o11ygin.Option{o11ygin.WithSDK(sdk)}, opts...)...))
	router.GET("/users/:id", func(c *gin.Context) { c.Status(http.StatusOK) })
	router.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusOK) })
	return router
}

func TestMiddlewareRecordsRouteAwareSpans(t *testing.T) {
	sdk, recorder := newSDK(t)
	router := newRouter(sdk)

	recorded := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/users/42", nil)
	router.ServeHTTP(recorded, req)

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got, want := spans[0].Name(), "GET /users/:id"; got != want {
		t.Errorf("span name = %q, want %q (route pattern, not raw path)", got, want)
	}
}

func TestMiddlewareAdoptsInboundTraceContext(t *testing.T) {
	sdk, recorder := newSDK(t)
	router := newRouter(sdk)

	var serverCtx context.Context
	router.GET("/ctx", func(c *gin.Context) {
		serverCtx = c.Request.Context()
		c.Status(http.StatusOK)
	})

	const inboundTrace = "0af7651916cd43dd8448eb211c80319c"
	const inboundSpan = "b7ad6b7169203331"
	recorded := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ctx", nil)
	req.Header.Set("traceparent", "00-"+inboundTrace+"-"+inboundSpan+"-01")
	req.Header.Set("baggage", "tenant=acme")
	router.ServeHTTP(recorded, req)

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got := spans[0].SpanContext().TraceID().String(); got != inboundTrace {
		t.Errorf("trace = %s, want inbound %s", got, inboundTrace)
	}
	if got := spans[0].Parent().SpanID().String(); got != inboundSpan {
		t.Errorf("parent span = %s, want inbound %s", got, inboundSpan)
	}
	if serverCtx == nil {
		t.Fatal("handler did not run")
	}
	if got := trace.SpanContextFromContext(serverCtx).TraceID().String(); got != inboundTrace {
		t.Errorf("handler context trace = %s, want inbound %s", got, inboundTrace)
	}
	if v := baggage.FromContext(serverCtx).Member("tenant").Value(); v != "acme" {
		t.Errorf("handler baggage tenant = %q, want acme", v)
	}
}

func TestSpanNameFormatter(t *testing.T) {
	sdk, recorder := newSDK(t)
	router := newRouter(sdk, o11ygin.WithSpanNameFormatter(func(c *gin.Context) string {
		return "custom " + c.FullPath()
	}))

	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/users/9", nil))

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got, want := spans[0].Name(), "custom /users/:id"; got != want {
		t.Errorf("span name = %q, want %q", got, want)
	}
}

// TestMiddlewareBeforeRecoveryRecordsPanic pins the documented middleware
// order: registered before gin.Recovery, the middleware sees the 500 a
// recovered panic produces and marks the span Error.
func TestMiddlewareBeforeRecoveryRecordsPanic(t *testing.T) {
	sdk, recorder := newSDK(t)
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(o11ygin.Middleware("api", o11ygin.WithSDK(sdk)), gin.RecoveryWithWriter(io.Discard))
	router.GET("/boom", func(*gin.Context) { panic("boom") })

	recorded := httptest.NewRecorder()
	router.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if recorded.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorded.Code)
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got := spans[0].Status().Code; got != codes.Error {
		t.Errorf("span status = %v, want Error", got)
	}
	var status attribute.Value
	for _, kv := range spans[0].Attributes() {
		if kv.Key == "http.response.status_code" {
			status = kv.Value
		}
	}
	if status.AsInt64() != http.StatusInternalServerError {
		t.Errorf("http.response.status_code = %v, want 500", status.String())
	}
}

func TestIgnorePathsFilters(t *testing.T) {
	sdk, recorder := newSDK(t)
	router := newRouter(sdk, o11ygin.WithIgnorePaths("/healthz"))

	for _, target := range []string{"/healthz", "/users/7"} {
		recorded := httptest.NewRecorder()
		router.ServeHTTP(recorded, httptest.NewRequest(http.MethodGet, target, nil))
	}

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1 (probe filtered)", len(spans))
	}
	if got, want := spans[0].Name(), "GET /users/:id"; got != want {
		t.Errorf("span name = %q, want %q", got, want)
	}
}
