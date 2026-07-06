// Package o11ytest is a hermetic test harness for asserting the telemetry
// an application emits through libo11y: spans, metrics, and log records,
// including the correlation between them, in ordinary unit tests.
//
// [Start] builds a fully in-memory SDK with o11y.New: no process globals
// are touched, no exporter dials out, and no environment variable is read
// or written, so harnesses in different tests are isolated and safe under
// t.Parallel().
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
	"sync"
	"testing"

	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
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
// metrics and console output are off, and nothing is exported anywhere.
// Additional options are applied after these defaults and may override
// them (for example o11y.WithServiceName or o11y.WithAttrReplacer).
func Start(tb testing.TB, opts ...o11y.Option) *Recorder {
	tb.Helper()

	spans := tracetest.NewSpanRecorder()
	reader := sdkmetric.NewManualReader()
	logs := &logCapture{}

	base := []o11y.Option{
		o11y.WithServiceName(tb.Name()),
		o11y.WithLogLevel(slog.LevelDebug),
		o11y.WithSpanProcessor(spans),
		o11y.WithMetricReader(reader),
		o11y.WithoutLogExport(),
		o11y.WithoutRuntimeMetrics(),
		o11y.WithoutConsoleLog(),
		o11y.WithExtraLogHandler(logs),
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
	var data metricdata.ResourceMetrics
	if err := r.reader.Collect(context.Background(), &data); err != nil {
		r.tb.Fatalf("o11ytest: collecting metrics: %v", err)
	}
	return data
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
