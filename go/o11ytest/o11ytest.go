// Package o11ytest is a hermetic test harness for asserting the telemetry
// an application emits through libo11y: spans, metrics, and log records,
// including the correlation between them, in ordinary unit tests.
//
// [Start] builds a fully in-memory SDK with o11y.New and o11y.WithoutOTELEnv:
// no process globals are touched, no exporter dials out, and no OTEL_*
// variable affects behavior, so harnesses are deterministic and safe under
// t.Parallel(). The resource still carries host and process detector values
// describing the machine. Keys named in OTEL_RESOURCE_ATTRIBUTES appear on
// the resource, and on recorded telemetry, with empty values (see
// o11y.WithoutOTELEnv). The OTel SDK constructors still parse some OTEL_*
// variables, and malformed values are reported to the global otel error
// handler.
//
//	rec := o11ytest.Start(t)
//	svc := NewCheckoutService(rec.SDK)   // inject providers under test
//	svc.Handle(ctx, order)
//
//	spans := rec.Spans()
//	logs := rec.Logs()
//	// assert names, attributes, and shared trace IDs
package o11ytest

import (
	"context"
	"log/slog"
	"maps"
	"slices"
	"sync"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/conformance"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// Recorder gives access to the telemetry recorded by a harness SDK.
type Recorder struct {
	// SDK is the in-memory SDK under the harness. Inject its providers
	// (or its Logger) into the code under test.
	SDK *o11y.SDK

	tb     testing.TB
	spans  *tracetest.SpanRecorder
	reader *sdkmetric.ManualReader
	logs   *logCapture
}

// LogRecord is one captured log record together with the span context that
// was active when it was emitted, enabling correlation assertions.
type LogRecord struct {
	Record      slog.Record
	SpanContext trace.SpanContext
}

// Attr returns the string form of the top-level attribute named key, or
// false if the record does not carry it.
func (r LogRecord) Attr(key string) (string, bool) {
	var value string
	var found bool
	r.Record.Attrs(func(a slog.Attr) bool {
		if a.Key == key {
			value, found = a.Value.String(), true
			return false
		}
		return true
	})
	return value, found
}

// Start builds a hermetic SDK and returns its Recorder. The SDK is shut
// down via t.Cleanup; a shutdown failure fails the test.
//
// Defaults: the service name is the test name, log level is Debug, runtime
// metrics and console output are off, every span is sampled, exemplars use
// the trace-based filter, OTEL_* variables do not affect behavior, and
// nothing is exported anywhere. Additional options are applied after these
// defaults and may override them (for example o11y.WithServiceName or
// o11y.WithAttrReplacer).
func Start(tb testing.TB, opts ...o11y.Option) *Recorder {
	tb.Helper()

	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	logs := &logCapture{}

	base := []o11y.Option{
		o11y.WithServiceName(tb.Name()),
		o11y.WithEnvironment(spec.EnvironmentTest),
		o11y.WithLogLevel(slog.LevelDebug),
		o11y.WithSpanProcessor(spans),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(logs),
		o11y.WithoutOTELEnv(),
		o11y.WithTraceSampler(sdktrace.AlwaysSample()),
		o11y.WithExemplarFilter(exemplar.TraceBasedFilter),
	}
	sdk, err := o11y.New(context.Background(), append(base, opts...)...)
	if err != nil {
		tb.Fatalf("o11ytest: building SDK: %v", err)
	}
	tb.Cleanup(func() {
		if err := sdk.Shutdown(context.Background()); err != nil {
			tb.Errorf("o11ytest: shutdown: %v", err)
		}
	})

	return &Recorder{SDK: sdk, tb: tb, spans: spans, reader: reader, logs: logs}
}

// Spans returns all spans ended so far, in end order.
func (r *Recorder) Spans() []sdktrace.ReadOnlySpan {
	return r.spans.Ended()
}

// Metrics collects and returns the current state of every instrument. It
// fails the test if collection fails.
func (r *Recorder) Metrics() metricdata.ResourceMetrics {
	r.tb.Helper()
	data, err := r.collect()
	if err != nil {
		r.tb.Fatalf("o11ytest: collecting metrics: %v", err)
	}
	return data
}

// collect reads the current state of every instrument from the harness's
// manual reader.
func (r *Recorder) collect() (metricdata.ResourceMetrics, error) {
	var data metricdata.ResourceMetrics
	err := r.reader.Collect(context.Background(), &data)
	return data, err
}

// MetricNames returns the names of all instruments with recorded data,
// for quick presence assertions.
func (r *Recorder) MetricNames() []string {
	r.tb.Helper()
	data := r.Metrics()
	var names []string
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			names = append(names, m.Name)
		}
	}
	return names
}

// Logs returns all log records captured so far, in emission order.
func (r *Recorder) Logs() []LogRecord {
	return r.logs.snapshot()
}

// AssertConforms fails the test if the code under test broke the libo11y
// specification. It is the consumer-facing conformance gate: a service can
// prove in its own suite that it satisfies the specification. It reports:
//   - any secret-classified attribute the code under test put on a log
//     record or span, detected through the o11y.schema.violations
//     self-metric and reported per signal. The pipeline redacted it, but
//     secrets must never be logged or traced. A secret that options passed
//     to [Start] put on the resource is reported separately. Secret
//     attributes on metric measurements are dropped without being counted
//     (the filter runs on the measurement hot path), so they are not
//     reported;
//   - any recorded event lacking an attribute its registered contract
//     requires;
//   - any secret-classified attribute visible in recorded logs or spans,
//     which would be a redaction regression;
//   - any required tier-0 attribute missing from the SDK's resource. The
//     harness supplies service name and environment unless options
//     override them.
//
// Log attributes nested in slog groups are checked under their dotted keys
// (slog.Group("http", slog.String("request.method", v)) is
// http.request.method), matching the library's classification.
//
// It flushes the SDK first, so violations counted on an injected trace
// exporter's batch path are included. Call it from the test body, before
// the harness SDK shuts down in t.Cleanup: it collects metrics, which
// fails after shutdown.
func (r *Recorder) AssertConforms(tb testing.TB) {
	tb.Helper()

	present := map[attribute.Key]bool{}
	for _, kv := range r.SDK.Resource().Attributes() {
		present[kv.Key] = true
	}
	for _, key := range spectables.RequiredTier0 {
		if !present[key] {
			tb.Errorf("o11ytest: resource missing required tier-0 attribute %q", key)
		}
	}

	// Span violations under an injected exporter are counted on the batch
	// export path, so flush before reading the counter.
	if err := r.SDK.ForceFlush(context.Background()); err != nil {
		tb.Errorf("o11ytest: flushing before conformance checks: %v", err)
	}
	bySignal := r.violationsBySignal(tb, secretAttributeRule)
	for _, signal := range slices.Sorted(maps.Keys(bySignal)) {
		n := bySignal[signal]
		if signal == string(spec.SignalResource) {
			tb.Errorf("o11ytest: options passed to Start put a secret-classified attribute on the resource "+
				"(%d redaction(s) counted); it was redacted, but secrets must never be emitted", n)
			continue
		}
		tb.Errorf("o11ytest: the code under test emitted secret-classified attributes on %s "+
			"(%d redaction(s) counted); they were redacted, but secrets must never be emitted", signal, n)
	}

	for _, record := range r.Logs() {
		var keys []string
		record.Record.Attrs(func(a slog.Attr) bool {
			walkAttr("", a, func(key string) {
				keys = append(keys, key)
				if spectables.SensitivityOf[attribute.Key(key)] == spectables.Secret {
					tb.Errorf("o11ytest: log record %q carries secret-classified attribute %q in the clear",
						record.Record.Message, key)
				}
			})
			return true
		})
		if name, ok := record.Attr(spec.EventNameKey); ok {
			for _, problem := range conformance.CheckEvent(name, keys) {
				tb.Errorf("o11ytest: %s", problem)
			}
		}
	}

	for _, span := range r.Spans() {
		for _, kv := range span.Attributes() {
			if spectables.SensitivityOf[kv.Key] == spectables.Secret {
				tb.Errorf("o11ytest: span %q carries secret-classified attribute %q in the clear",
					span.Name(), kv.Key)
			}
		}
	}
}

// violationsMetric is the library's self-metric counting specification
// violations, and secretAttributeRule the o11y.rule value it records when
// classification removes a secret-classified attribute.
const (
	violationsMetric    = "o11y.schema.violations"
	secretAttributeRule = "secret_attribute"
)

// violationsBySignal sums the o11y.schema.violations data points recorded
// for one rule, keyed by their o11y.signal value; signals with no
// violations are absent. A single emitted attribute may count more than
// once (each log sink classifies independently), so callers should treat
// any positive count as a violation rather than rely on its value.
func (r *Recorder) violationsBySignal(tb testing.TB, rule string) map[string]int64 {
	tb.Helper()
	data, err := r.collect()
	if err != nil {
		tb.Errorf("o11ytest: collecting metrics: %v", err)
		return nil
	}
	totals := map[string]int64{}
	for _, sm := range data.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != violationsMetric {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				continue
			}
			for _, dp := range sum.DataPoints {
				if v, ok := dp.Attributes.Value(spec.RuleKey); !ok || v.AsString() != rule || dp.Value <= 0 {
					continue
				}
				signal, _ := dp.Attributes.Value(spec.SignalKey)
				totals[signal.AsString()] += dp.Value
			}
		}
	}
	return totals
}

// walkAttr calls visit with the dotted key of every leaf under a, joining
// enclosing group names with "." exactly as the library's classification
// does, so slog.Group("http", slog.String("request.method", v)) is read
// as http.request.method. An empty-key group is inlined into its parent.
func walkAttr(prefix string, a slog.Attr, visit func(key string)) {
	key := a.Key
	switch {
	case key == "":
		key = prefix
	case prefix != "":
		key = prefix + "." + key
	}
	if v := a.Value.Resolve(); v.Kind() == slog.KindGroup {
		for _, member := range v.Group() {
			walkAttr(key, member, visit)
		}
		return
	}
	visit(key)
}

// AssertCorrelated fails the test unless every log record emitted inside a
// span carries that span's trace identity, closing the log-to-trace leg of
// the correlation triangle. Records emitted outside any span are ignored.
// Records emitted without a context (Info instead of InfoContext) carry no
// span and cannot be checked; prefer the Context variants.
func (r *Recorder) AssertCorrelated(tb testing.TB) {
	tb.Helper()
	for _, record := range r.Logs() {
		if !record.SpanContext.IsValid() {
			continue
		}
		traceID, ok := record.Attr("trace_id")
		if !ok {
			tb.Errorf("o11ytest: correlated record %q has no trace_id attribute", record.Record.Message)
			continue
		}
		if traceID != record.SpanContext.TraceID().String() {
			tb.Errorf("o11ytest: record %q trace_id %q does not match its span %q",
				record.Record.Message, traceID, record.SpanContext.TraceID())
		}
	}
}

// Exemplar is one metric exemplar in harness form: the trace identity and
// value stamped onto a data point by a measurement inside a sampled span.
type Exemplar struct {
	TraceID trace.TraceID
	SpanID  trace.SpanID
	Value   float64
}

// Exemplars collects metrics and returns the exemplars recorded on the
// named instrument across all its data points. Use it to assert the
// metric-to-trace leg of telemetry correlation:
//
//	exemplars := rec.Exemplars("orders.processed")
//	if exemplars[0].TraceID != span.SpanContext().TraceID() { ... }
func (r *Recorder) Exemplars(instrumentName string) []Exemplar {
	r.tb.Helper()
	data := r.Metrics()
	var out []Exemplar
	for _, scope := range data.ScopeMetrics {
		for _, m := range scope.Metrics {
			if m.Name != instrumentName {
				continue
			}
			out = append(out, exemplarsOf(m.Data)...)
		}
	}
	return out
}

func exemplarsOf(data metricdata.Aggregation) []Exemplar {
	var out []Exemplar
	switch agg := data.(type) {
	case metricdata.Sum[int64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v int64) float64 { return float64(v) })...)
		}
	case metricdata.Sum[float64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v float64) float64 { return v })...)
		}
	case metricdata.Histogram[int64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v int64) float64 { return float64(v) })...)
		}
	case metricdata.Histogram[float64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v float64) float64 { return v })...)
		}
	case metricdata.ExponentialHistogram[int64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v int64) float64 { return float64(v) })...)
		}
	case metricdata.ExponentialHistogram[float64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v float64) float64 { return v })...)
		}
	case metricdata.Gauge[int64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v int64) float64 { return float64(v) })...)
		}
	case metricdata.Gauge[float64]:
		for _, dp := range agg.DataPoints {
			out = append(out, convertExemplars(dp.Exemplars, func(v float64) float64 { return v })...)
		}
	}
	return out
}

func convertExemplars[N int64 | float64](exemplars []metricdata.Exemplar[N], toFloat func(N) float64) []Exemplar {
	out := make([]Exemplar, 0, len(exemplars))
	for _, e := range exemplars {
		var converted Exemplar
		converted.Value = toFloat(e.Value)
		copy(converted.TraceID[:], e.TraceID)
		copy(converted.SpanID[:], e.SpanID)
		out = append(out, converted)
	}
	return out
}

// logCapture is a concurrency-safe slog.Handler recording every record
// together with the active span context.
//
// WithAttrs and WithGroup return the receiver unchanged. That is correct
// only under the fan-out pipeline, which resolves groups and attrs itself
// and hands its legs fully flattened records; logCapture is not a valid
// standalone slog.Handler.
type logCapture struct {
	mu      sync.Mutex
	records []LogRecord
}

func (c *logCapture) Enabled(context.Context, slog.Level) bool { return true }

func (c *logCapture) Handle(ctx context.Context, record slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, LogRecord{
		Record:      record.Clone(),
		SpanContext: trace.SpanContextFromContext(ctx),
	})
	return nil
}

func (c *logCapture) WithAttrs(attrs []slog.Attr) slog.Handler { return c }

func (c *logCapture) WithGroup(string) slog.Handler { return c }

func (c *logCapture) snapshot() []LogRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]LogRecord, len(c.records))
	copy(out, c.records)
	return out
}
