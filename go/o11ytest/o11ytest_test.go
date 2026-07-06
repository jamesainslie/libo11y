package o11ytest_test

import (
	"context"
	"slices"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

func TestRecorderCapturesAllThreeSignals(t *testing.T) {
	rec := o11ytest.Start(t)

	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "operation")
	rec.SDK.Logger().InfoContext(ctx, "working", "step", 1)

	counter, err := rec.SDK.MeterProvider().Meter("svc").Int64Counter("work.done")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(ctx, 1)
	span.End()

	spans := rec.Spans()
	if len(spans) != 1 || spans[0].Name() != "operation" {
		t.Fatalf("spans = %v, want one named operation", spans)
	}

	logs := rec.Logs()
	if len(logs) != 1 || logs[0].Record.Message != "working" {
		t.Fatalf("logs = %+v, want one record with message working", logs)
	}

	if !slices.Contains(rec.MetricNames(), "work.done") {
		t.Errorf("MetricNames = %v, want to contain work.done", rec.MetricNames())
	}
}

func TestLogSpanCorrelation(t *testing.T) {
	rec := o11ytest.Start(t)

	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "op")
	rec.SDK.Logger().InfoContext(ctx, "inside")
	span.End()

	logs := rec.Logs()
	if len(logs) != 1 {
		t.Fatalf("got %d logs, want 1", len(logs))
	}
	wantTrace := rec.Spans()[0].SpanContext().TraceID()
	if logs[0].SpanContext.TraceID() != wantTrace {
		t.Errorf("log trace = %s, want %s", logs[0].SpanContext.TraceID(), wantTrace)
	}

	// The flattened record also carries top-level correlation attributes.
	if got, ok := logs[0].Attr("trace_id"); !ok || got != wantTrace.String() {
		t.Errorf("trace_id attr = %q (ok=%v), want %s", got, ok, wantTrace)
	}
}

func TestHarnessesAreIsolated(t *testing.T) {
	t.Run("first", func(t *testing.T) {
		t.Parallel()
		rec := o11ytest.Start(t)
		_, span := rec.SDK.TracerProvider().Tracer("a").Start(context.Background(), "only-first")
		span.End()
		if len(rec.Spans()) != 1 {
			t.Errorf("first harness sees %d spans, want 1", len(rec.Spans()))
		}
	})
	t.Run("second", func(t *testing.T) {
		t.Parallel()
		rec := o11ytest.Start(t)
		if len(rec.Spans()) != 0 {
			t.Errorf("second harness sees %d spans, want 0 (isolation)", len(rec.Spans()))
		}
	})
}

func TestUserOptionsOverrideDefaults(t *testing.T) {
	rec := o11ytest.Start(t, o11y.WithServiceName("custom-name"))
	for _, kv := range rec.SDK.Resource().Attributes() {
		if string(kv.Key) == "service.name" {
			if got := kv.Value.AsString(); got != "custom-name" {
				t.Errorf("service.name = %q, want custom-name", got)
			}
			return
		}
	}
	t.Error("service.name missing")
}

func TestDebugLogsCaptured(t *testing.T) {
	rec := o11ytest.Start(t)
	rec.SDK.Logger().Debug("verbose detail")
	if len(rec.Logs()) != 1 {
		t.Errorf("debug record not captured; harness should default to Debug level")
	}
}

func TestAssertConformsPasses(t *testing.T) {
	rec := o11ytest.Start(t)
	// The harness SDK carries the required tier-0 identity by default.
	rec.AssertConforms(t)
}

func TestAssertCorrelatedPasses(t *testing.T) {
	rec := o11ytest.Start(t)
	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "op")
	rec.SDK.Logger().InfoContext(ctx, "inside")
	span.End()
	rec.AssertCorrelated(t)
}
