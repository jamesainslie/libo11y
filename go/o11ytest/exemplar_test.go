package o11ytest_test

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/sdk/metric/exemplar"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// TestFullCorrelationTriangle pins libo11y's central promise: one operation
// produces a span, a log record, and a metric exemplar that all carry the
// same trace identity, so any signal reconciles to the other two.
func TestFullCorrelationTriangle(t *testing.T) {
	rec := o11ytest.Start(t)

	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "checkout")
	rec.SDK.Logger().InfoContext(ctx, "order accepted")
	counter, err := rec.SDK.MeterProvider().Meter("svc").Int64Counter("orders.processed")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(ctx, 1)
	span.End()

	spans := rec.Spans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	wantTrace := spans[0].SpanContext().TraceID()
	wantSpan := spans[0].SpanContext().SpanID()

	// Leg 1: log -> trace.
	logs := rec.Logs()
	if len(logs) != 1 {
		t.Fatalf("got %d logs, want 1", len(logs))
	}
	if logs[0].SpanContext.TraceID() != wantTrace {
		t.Errorf("log trace = %s, want %s", logs[0].SpanContext.TraceID(), wantTrace)
	}

	// Leg 2: metric exemplar -> trace.
	exemplars := rec.Exemplars("orders.processed")
	if len(exemplars) != 1 {
		t.Fatalf("got %d exemplars, want 1 (trace-based filter inside sampled span)", len(exemplars))
	}
	if exemplars[0].TraceID != wantTrace {
		t.Errorf("exemplar trace = %s, want %s", exemplars[0].TraceID, wantTrace)
	}
	if exemplars[0].SpanID != wantSpan {
		t.Errorf("exemplar span = %s, want %s", exemplars[0].SpanID, wantSpan)
	}
	if exemplars[0].Value != 1 {
		t.Errorf("exemplar value = %v, want 1", exemplars[0].Value)
	}
}

func TestHistogramExemplars(t *testing.T) {
	rec := o11ytest.Start(t)

	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "op")
	hist, err := rec.SDK.MeterProvider().Meter("svc").Float64Histogram("request.duration")
	if err != nil {
		t.Fatalf("Float64Histogram: %v", err)
	}
	hist.Record(ctx, 0.25)
	span.End()

	exemplars := rec.Exemplars("request.duration")
	if len(exemplars) != 1 {
		t.Fatalf("got %d exemplars, want 1", len(exemplars))
	}
	if got := exemplars[0].TraceID; got != rec.Spans()[0].SpanContext().TraceID() {
		t.Errorf("exemplar trace = %s, want the recording span's trace", got)
	}
	if exemplars[0].Value != 0.25 {
		t.Errorf("exemplar value = %v, want 0.25", exemplars[0].Value)
	}
}

// TestNoExemplarOutsideSpan pins the default trace-based filter: a
// measurement with no sampled span records no exemplar.
func TestNoExemplarOutsideSpan(t *testing.T) {
	rec := o11ytest.Start(t)

	counter, err := rec.SDK.MeterProvider().Meter("svc").Int64Counter("background.work")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(context.Background(), 1)

	if got := rec.Exemplars("background.work"); len(got) != 0 {
		t.Errorf("got %d exemplars outside any span, want 0 under trace-based filter", len(got))
	}
}

func TestExemplarFilterAlwaysOff(t *testing.T) {
	rec := o11ytest.Start(t, o11y.WithExemplarFilter(exemplar.AlwaysOffFilter))

	ctx, span := rec.SDK.TracerProvider().Tracer("svc").Start(context.Background(), "op")
	counter, err := rec.SDK.MeterProvider().Meter("svc").Int64Counter("hits")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(ctx, 1)
	span.End()

	if got := rec.Exemplars("hits"); len(got) != 0 {
		t.Errorf("got %d exemplars with AlwaysOffFilter, want 0", len(got))
	}
}

func TestExemplarFilterAlwaysOn(t *testing.T) {
	rec := o11ytest.Start(t, o11y.WithExemplarFilter(exemplar.AlwaysOnFilter))

	counter, err := rec.SDK.MeterProvider().Meter("svc").Int64Counter("hits")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(context.Background(), 1)

	// AlwaysOn records exemplars even without a span; they carry no trace
	// identity but preserve the measured value.
	exemplars := rec.Exemplars("hits")
	if len(exemplars) != 1 {
		t.Fatalf("got %d exemplars with AlwaysOnFilter outside a span, want 1", len(exemplars))
	}
	if exemplars[0].TraceID.IsValid() {
		t.Errorf("exemplar outside span carries trace ID %s, want zero", exemplars[0].TraceID)
	}
}
