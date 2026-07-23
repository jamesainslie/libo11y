package o11y

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"strings"

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
	// A background context is deliberate: the slog ReplaceAttr signature
	// carries no context, and this fire-and-forget counter has no need for
	// trace-exemplar linkage.
	v.counter.Add(context.Background(), 1, metric.WithAttributes(
		spec.SignalValue(signal),
		spec.Rule(rule),
	))
}

// specReplacer returns an [AttrReplacer] that enforces the spec's sensitivity
// classification: secret-classified attributes are always dropped, and
// PII-classified attributes are handled per mode. It composes after the
// user's replacer and classifies on the final key, so a value cannot be
// leaked by renaming a classified key to another known key. Classification
// is key-based, so renaming to an entirely unclassified key still escapes
// this layer; that residual gap is inherent and is the redact package's
// job (capture-time protection of the value itself). Each action is
// recorded as a schema violation.
func specReplacer(user AttrReplacer, mode PIIMode, rec *violationRecorder) AttrReplacer {
	return func(groups []string, a slog.Attr) slog.Attr {
		if user != nil {
			a = user(groups, a)
			if a.Equal(slog.Attr{}) || a.Key == "" {
				return a
			}
		}
		return classify(sinkConsole, mode, rec, groups, a)
	}
}

// classify applies the spec's sensitivity ruling to a single leaf attribute
// on its effective (grouped) key: secret-classified attributes are always
// dropped, and PII-classified attributes are handled per mode. It is the one
// implementation shared by [specReplacer] and the per-leg classifyingHandler,
// so the two seams cannot drift. The sink mode selects per-sink policy;
// through Phase 0 both sinks classify identically, so mode is not yet
// consulted here (Phase 1 uses it for confidential-console-withhold).
func classify(_ sinkMode, mode PIIMode, rec *violationRecorder, groups []string, a slog.Attr) slog.Attr {
	key := attribute.Key(effectiveKey(groups, a.Key))
	switch spectables.SensitivityOf[key] {
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
