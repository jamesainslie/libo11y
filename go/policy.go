package o11y

import (
	"log/slog"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

// classAction reports what classification did to one attribute, so callers
// track changes without comparing values (slog.Value.Equal panics on
// uncomparable values such as slices and maps).
type classAction int

const (
	actionKeep classAction = iota
	actionRewrite
	actionDrop
)

// sensitivityPolicy is the single enforcement point for the specification's
// sensitivity classification. One policy is built per SDK; its consumers
// today are the classifying slog legs (console, OTLP, and extra sinks) and the
// span exporter wrapper (span, event, and link attributes). Further signals
// are added as they are wired to it, so every signal asks the same policy
// what to do with a key and the signals cannot drift apart.
//
// Classification is key-based, so a value logged under an entirely
// unclassified key escapes this layer; that residual gap is inherent and is
// the redact package's job (capture-time protection of the value itself).
type sensitivityPolicy struct {
	lookup func(attribute.Key) spectables.Sensitivity
	pii    PIIMode
	rec    *violationRecorder
}

func newSensitivityPolicy(s *settings, rec *violationRecorder) *sensitivityPolicy {
	lookup := s.sensitivity
	if lookup == nil {
		lookup = func(k attribute.Key) spectables.Sensitivity { return spectables.SensitivityOf[k] }
	}
	return &sensitivityPolicy{lookup: lookup, pii: s.piiMode, rec: rec}
}

// decide classifies key and records a violation for every action taken:
// secret-classified keys are always dropped, and PII-classified keys are
// handled per the PII mode.
func (p *sensitivityPolicy) decide(signal spec.Signal, key attribute.Key) classAction {
	switch p.lookup(key) {
	case spectables.Secret:
		p.rec.record(signal, "secret_attribute")
		return actionDrop
	case spectables.PII:
		switch p.pii {
		case PIIAllow:
			return actionKeep
		case PIIDrop:
			p.rec.record(signal, "pii_attribute")
			return actionDrop
		default: // PIIHash
			p.rec.record(signal, "pii_attribute")
			return actionRewrite
		}
	default:
		return actionKeep
	}
}

// token renders the stable replacement for a PII value under PIIHash.
func (p *sensitivityPolicy) token(v string) string { return hashValue(v) }

// slogAttr classifies a leaf slog attribute on its effective grouped key.
func (p *sensitivityPolicy) slogAttr(groups []string, a slog.Attr) (slog.Attr, classAction) {
	switch act := p.decide(spec.SignalLogs, attribute.Key(effectiveKey(groups, a.Key))); act {
	case actionDrop:
		return slog.Attr{}, act
	case actionRewrite:
		return slog.String(a.Key, p.token(a.Value.String())), act
	default:
		return a, act
	}
}

// kv classifies a flat OTel attribute for the given signal.
func (p *sensitivityPolicy) kv(signal spec.Signal, kv attribute.KeyValue) (attribute.KeyValue, classAction) {
	switch act := p.decide(signal, kv.Key); act {
	case actionDrop:
		return attribute.KeyValue{}, act
	case actionRewrite:
		return kv.Key.String(p.token(kv.Value.String())), act
	default:
		return kv, act
	}
}
