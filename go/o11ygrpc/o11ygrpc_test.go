package o11ygrpc_test

import (
	"context"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"google.golang.org/grpc/stats"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygrpc"
	"github.com/jamesainslie/libo11y/go/spec"
)

func newSDK(t *testing.T) (*o11y.SDK, *tracetest.SpanRecorder, *sdkmetric.ManualReader) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("o11ygrpc-test"),
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

// driveRPC simulates the gRPC framework's stats callbacks for one unary RPC.
func driveRPC(handler stats.Handler, fullMethod string) {
	ctx := handler.TagRPC(context.Background(), &stats.RPCTagInfo{FullMethodName: fullMethod})
	handler.HandleRPC(ctx, &stats.Begin{})
	handler.HandleRPC(ctx, &stats.End{})
}

func TestServerHandlerRecordsSpans(t *testing.T) {
	sdk, recorder, reader := newSDK(t)

	handler := o11ygrpc.ServerHandler(o11ygrpc.WithSDK(sdk))
	driveRPC(handler, "/checkout.Cart/AddItem")

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	if got, want := spans[0].Name(), "checkout.Cart/AddItem"; got != want {
		t.Errorf("span name = %q, want %q", got, want)
	}

	var data metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &data); err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(data.ScopeMetrics) == 0 {
		t.Error("no RPC metrics recorded")
	}
}

func TestClientHandlerRecordsSpans(t *testing.T) {
	sdk, recorder, _ := newSDK(t)

	handler := o11ygrpc.ClientHandler(o11ygrpc.WithSDK(sdk))
	driveRPC(handler, "/checkout.Cart/AddItem")

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
}

func TestHandlersWithoutSDKUseGlobals(t *testing.T) {
	// Constructing against globals must work even before any Setup call;
	// the handlers fall back to no-op providers.
	if handler := o11ygrpc.ServerHandler(); handler == nil {
		t.Error("ServerHandler() returned nil")
	}
	if handler := o11ygrpc.ClientHandler(); handler == nil {
		t.Error("ClientHandler() returned nil")
	}
}
