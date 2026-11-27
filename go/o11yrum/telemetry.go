package o11yrum

import (
	"context"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
)

// scopeName is the instrumentation scope of the gateway's own telemetry
// and of the metrics it derives.
const scopeName = "github.com/jamesainslie/libo11y/go/o11yrum"

// Self-telemetry attribute keys. Only the specification may mint o11y.*
// names, so the gateway's own use o11yrum.*.
const (
	telApp     = "o11yrum.app"
	telSignal  = "o11yrum.signal"
	telOutcome = "o11yrum.outcome"
	telReason  = "o11yrum.reason"
	telSink    = "o11yrum.sink"
)

// Batch outcomes and the reason recorded for a batch that was not refused.
const (
	outcomeAccepted = "accepted"
	outcomePartial  = "partial"
	outcomeRejected = "rejected"
	reasonOK        = "ok"
	sinkOK          = "ok"
	sinkError       = "error"
)

// durationBuckets are the boundaries the semantic conventions advise for
// durations in seconds.
var durationBuckets = []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10}

// appUnknown labels a batch whose app is not configured, or not yet
// known, so the label stays bounded by the configuration.
const appUnknown = "unknown"

// telemetry holds the gateway's own instruments.
type telemetry struct {
	batches      metric.Int64Counter
	dropped      metric.Int64Counter
	attrsRemoved metric.Int64Counter
	sinkDuration metric.Float64Histogram
}

// newTelemetry creates the instruments on mp, or on a noop provider when
// mp is nil. An instrument that cannot be created is logged once to log
// (when not nil) and replaced by a noop one.
func newTelemetry(mp metric.MeterProvider, log *slog.Logger) *telemetry {
	if mp == nil {
		mp = noop.NewMeterProvider()
	}
	m := mp.Meter(scopeName)
	fallback := noop.NewMeterProvider().Meter(scopeName)
	failed := false
	check := func(name string, err error) bool {
		if err == nil {
			return true
		}
		if log != nil && !failed {
			log.Warn("o11yrum: self-telemetry instrument unavailable", slog.String("o11yrum.instrument", name), slog.Any("error", err))
		}
		failed = true
		return false
	}
	t := &telemetry{}
	var err error
	if t.batches, err = m.Int64Counter("o11yrum.batches", metric.WithUnit("{batch}"),
		metric.WithDescription("OTLP requests the gateway handled, by app, signal, outcome and reason.")); !check("o11yrum.batches", err) {
		t.batches, _ = fallback.Int64Counter("o11yrum.batches")
	}
	if t.dropped, err = m.Int64Counter("o11yrum.records.dropped", metric.WithUnit("{record}"),
		metric.WithDescription("Spans and log records validation dropped, by app, signal and reason.")); !check("o11yrum.records.dropped", err) {
		t.dropped, _ = fallback.Int64Counter("o11yrum.records.dropped")
	}
	if t.attrsRemoved, err = m.Int64Counter("o11yrum.attributes.removed", metric.WithUnit("{attribute}"),
		metric.WithDescription("Attributes the policy removed from accepted records, by app and signal.")); !check("o11yrum.attributes.removed", err) {
		t.attrsRemoved, _ = fallback.Int64Counter("o11yrum.attributes.removed")
	}
	if t.sinkDuration, err = m.Float64Histogram("o11yrum.sink.duration", metric.WithUnit("s"),
		metric.WithExplicitBucketBoundaries(durationBuckets...),
		metric.WithDescription("Time one sink took to export one batch, by sink and outcome.")); !check("o11yrum.sink.duration", err) {
		t.sinkDuration, _ = fallback.Float64Histogram("o11yrum.sink.duration")
	}
	return t
}

// report records one finished OTLP request. What validation removed is
// counted only for a batch the gateway accepted: a refused batch is sent
// again, and would be counted twice.
func (t *telemetry) report(ctx context.Context, sig Signal, rep *batchReport) {
	t.batch(ctx, rep.app, sig, rep.outcome, rep.reason)
	if rep.outcome != outcomeRejected {
		t.validated(ctx, rep.app, sig, rep.drops, rep.attrsRemoved)
	}
}

// batch counts one OTLP request.
func (t *telemetry) batch(ctx context.Context, app string, sig Signal, outcome, reason string) {
	t.batches.Add(ctx, 1, metric.WithAttributes(
		attribute.String(telApp, app), attribute.String(telSignal, string(sig)),
		attribute.String(telOutcome, outcome), attribute.String(telReason, reason)))
}

// validated records what validation removed from one batch.
func (t *telemetry) validated(ctx context.Context, app string, sig Signal, drops dropCounts, attrsRemoved int64) {
	for reason, n := range drops {
		if n > 0 {
			t.dropped.Add(ctx, n, metric.WithAttributes(
				attribute.String(telApp, app), attribute.String(telSignal, string(sig)),
				attribute.String(telReason, reason)))
		}
	}
	if attrsRemoved > 0 {
		t.attrsRemoved.Add(ctx, attrsRemoved, metric.WithAttributes(
			attribute.String(telApp, app), attribute.String(telSignal, string(sig))))
	}
}

// batchReport collects one request's outcome for o11yrum.batches. The
// ingest path fills it in and records it once, when the request ends.
type batchReport struct {
	app          string
	outcome      string
	reason       string
	drops        dropCounts
	attrsRemoved int64
}

func newBatchReport() *batchReport {
	return &batchReport{app: appUnknown, outcome: outcomeRejected, reason: "unknown"}
}

func (b *batchReport) reject(reason string) { b.outcome, b.reason = outcomeRejected, reason }

// validated keeps what validation removed, for report.
func (b *batchReport) validated(drops dropCounts, attrsRemoved int64) {
	b.drops, b.attrsRemoved = drops, attrsRemoved
}

func (b *batchReport) accept(drops dropCounts) {
	b.outcome, b.reason = outcomeAccepted, reasonOK
	if drops.total() > 0 {
		b.outcome = outcomePartial
	}
}

// timedSink records how long its sink takes to export, including a sink
// that panics, which exportOne turns into an error.
type timedSink struct {
	Sink
	tel *telemetry
}

func (s timedSink) Export(ctx context.Context, b Batch) (err error) {
	start := time.Now()
	outcome := sinkError
	defer func() {
		s.tel.sinkDuration.Record(ctx, time.Since(start).Seconds(), metric.WithAttributes(
			attribute.String(telSink, s.Name()), attribute.String(telOutcome, outcome)))
	}()
	if err = s.Sink.Export(ctx, b); err == nil {
		outcome = sinkOK
	}
	return err
}
