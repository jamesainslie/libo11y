package o11ygin_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygin"
)

func newSDK(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("o11ygin-test"),
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

	const inboundTrace = "0af7651916cd43dd8448eb211c80319c"
	recorded := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/users/1", nil)
	req.Header.Set("traceparent", "00-"+inboundTrace+"-b7ad6b7169203331-01")
	router.ServeHTTP(recorded, req)

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got := spans[0].SpanContext().TraceID().String(); got != inboundTrace {
		t.Errorf("trace = %s, want inbound %s", got, inboundTrace)
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
