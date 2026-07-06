package o11y

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// PIIMode selects how attributes the specification classifies as PII are
// handled on the log pipeline.
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
	v.counter.Add(context.Background(), 1, metric.WithAttributes(
		spec.SignalValue(signal),
		spec.Rule(rule),
	))
}

// specReplacer returns an [AttrReplacer] that enforces the spec's sensitivity
// classification: secret-classified attributes are always dropped, and
// PII-classified attributes are handled per mode. It composes after the
// user's replacer (which may rename keys) so it cannot be bypassed by
// renaming, and it records each action as a schema violation.
func specReplacer(user AttrReplacer, mode PIIMode, rec *violationRecorder) AttrReplacer {
	return func(groups []string, a slog.Attr) slog.Attr {
		if user != nil {
			a = user(groups, a)
			if a.Equal(slog.Attr{}) || a.Key == "" {
				return a
			}
		}
		switch spectables.SensitivityOf[attribute.Key(a.Key)] {
		case spectables.Secret:
			rec.record(spec.SignalLogs, "secret_attribute")
			return slog.Attr{} // never emit a secret
		case spectables.PII:
			switch mode {
			case PIIDrop:
				rec.record(spec.SignalLogs, "pii_attribute")
				return slog.Attr{}
			case PIIAllow:
				return a
			default: // PIIHash
				rec.record(spec.SignalLogs, "pii_attribute")
				return slog.String(a.Key, hashValue(a.Value.String()))
			}
		default:
			return a
		}
	}
}

// hashValue renders a stable, non-reversible token for a PII value.
func hashValue(v string) string {
	sum := sha256.Sum256([]byte(v))
	return "sha256:" + hex.EncodeToString(sum[:8])
}
