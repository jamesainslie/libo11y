package o11y

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"go.opentelemetry.io/otel/metric"

	"github.com/jamesainslie/libo11y/go/spec"
)

// PIIMode selects how attributes the specification classifies as PII are
// handled on logs (every log sink) and on spans (span, event, and link
// attributes at export). Later releases extend it to every signal.
type PIIMode int

const (
	// PIIHash replaces a PII value with a short salted-free SHA-256 prefix,
	// preserving joinability without exposing the value. This is the default.
	PIIHash PIIMode = iota
	// PIIDrop removes PII attributes entirely.
	PIIDrop
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

// hashValue renders a stable, non-reversible token for a PII value.
func hashValue(v string) string {
	sum := sha256.Sum256([]byte(v))
	return "sha256:" + hex.EncodeToString(sum[:8])
}
