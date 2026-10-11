package o11ytest_test

import (
	"context"
	"fmt"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// The parent sets hostile ambient configuration (allowed because it is not
// parallel); the parallel children run after the parent body returns and
// before its environment is restored.
func TestHarnessIgnoresAmbientConfiguration(t *testing.T) {
	t.Setenv("OTEL_TRACES_SAMPLER", "always_off")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "host.name=ambient-host,deployment.environment.name=production")
	t.Setenv("OTEL_SERVICE_NAME", "ambient-service")
	t.Setenv("OTEL_METRICS_EXEMPLAR_FILTER", "always_off")
	t.Setenv("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1")
	t.Setenv("OTEL_TRACES_EXPORTER", "console")
	t.Setenv("OTEL_LOGS_EXPORTER", "console")

	for i := range 8 {
		t.Run(fmt.Sprintf("harness-%d", i), func(t *testing.T) {
			t.Parallel()
			rec := o11ytest.Start(t)
			ctx, span := rec.SDK.TracerProvider().Tracer("t").Start(context.Background(), "op",
				trace.WithAttributes(attribute.Int("a", 1), attribute.Int("b", 2), attribute.Int("c", 3)))
			hist, err := rec.SDK.MeterProvider().Meter("t").Float64Histogram("h")
			if err != nil {
				t.Fatal(err)
			}
			hist.Record(ctx, 1.5)
			rec.SDK.Logger().InfoContext(ctx, "inside")
			span.End()

			spans := rec.Spans()
			if len(spans) != 1 {
				t.Fatalf("captured %d spans, want 1 (ambient sampler leaked in)", len(spans))
			}
			if n := len(spans[0].Attributes()); n != 3 {
				t.Errorf("span kept %d attributes, want 3 (ambient span limits leaked in)", n)
			}
			res := map[string]string{}
			for _, kv := range rec.SDK.Resource().Attributes() {
				res[string(kv.Key)] = kv.Value.String()
			}
			if res["service.name"] != t.Name() || res["deployment.environment.name"] != "test" {
				t.Errorf("identity = %q/%q, want %q/test", res["service.name"], res["deployment.environment.name"], t.Name())
			}
			if res["host.name"] == "ambient-host" {
				t.Error("OTEL_RESOURCE_ATTRIBUTES leaked into the harness resource")
			}
			if len(rec.Exemplars("h")) == 0 {
				t.Error("no exemplars (ambient exemplar filter leaked in)")
			}
			rec.AssertCorrelated(t)
		})
	}
}

func TestHarnessCallerOptionsStillWin(t *testing.T) {
	t.Parallel()
	rec := o11ytest.Start(t, o11y.WithTraceSampler(sdktrace.NeverSample()))
	_, span := rec.SDK.TracerProvider().Tracer("t").Start(context.Background(), "op")
	span.End()
	if n := len(rec.Spans()); n != 0 {
		t.Errorf("captured %d spans, want 0: caller sampler must override the harness default", n)
	}
}
