package o11y

import (
	"context"
	"strings"

	"go.opentelemetry.io/otel/metric"

	"github.com/jamesainslie/libo11y/go/spec"
)

// PIIMode selects how attributes the specification classifies as PII are
// handled on logs (every log sink), on spans (span, event, and link
// attributes at export), and on the telemetry resource every signal carries.
// Later releases extend it to every signal.
type PIIMode int

const (
	// PIIDrop removes PII attributes entirely. This is the default.
	PIIDrop PIIMode = iota
	// PIIHash replaces a PII value with a keyed HMAC-SHA256 token, so values
	// stay joinable across records without being reversible by anyone who
	// lacks the key. Requires [WithPIIHashKey].
	PIIHash
	// PIIAllow emits PII attributes unchanged. Never the default; requires
	// an explicit opt-in and a data-handling justification.
	PIIAllow
)

// violationRecorder counts specification violations on the library's own
// metric scope. It is nil when validation is disabled.
type violationRecorder struct {
	counter metric.Int64Counter
}

func newViolationRecorder(mp metric.MeterProvider) *violationRecorder {
	counter, err := mp.Meter(scopeName).Int64Counter(
		"o11y.schema.violations",
		metric.WithUnit("{violation}"),
		metric.WithDescription("Telemetry records that violated the libo11y specification."),
	)
	if err != nil {
		return nil
	}
	return &violationRecorder{counter: counter}
}

func (v *violationRecorder) record(signal spec.Signal, rule string) {
	if v == nil {
		return
	}
	// A background context is deliberate: classification runs in slog
	// handlers and in export-side processors, several of which (WithAttrs,
	// the span exporter's batch) have no per-record context, and this
	// fire-and-forget counter has no need for trace-exemplar linkage.
	v.counter.Add(context.Background(), 1, metric.WithAttributes(
		spec.SignalValue(signal),
		spec.Rule(rule),
	))
}

// effectiveKey joins the enclosing group path with the leaf key to form the
// dotted spec attribute name the classification tables are keyed on. A grouped
// attribute such as slog.Group("host", slog.String("ip", v)) must classify on
// "host.ip", not the leaf "ip", so grouping cannot bypass the spec layer.
func effectiveKey(groups []string, key string) string {
	if len(groups) == 0 {
		return key
	}
	return strings.Join(groups, ".") + "." + key
}
