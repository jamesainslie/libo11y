package o11y

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strconv"

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
// sensitivity classification. One policy per SDK serves the classifying slog
// legs (console, OTLP, and extra sinks) and the span wrappers around the
// exporter and any injected processor's OnEnd (span, event, and link
// attributes). Resource construction runs before the
// violation counter exists, so it uses a recorder-less policy built from the
// same settings and newSDK records its counts afterwards. Further signals
// are added as they are wired to it, so every signal asks the same policy
// what to do with a key and the signals cannot drift apart.
//
// Classification is key-based, so a value logged under an entirely
// unclassified key escapes this layer; that residual gap is inherent and is
// the redact package's job (capture-time protection of the value itself).
type sensitivityPolicy struct {
	lookup func(attribute.Key) spectables.Sensitivity
	pii    PIIMode
	key    []byte // HMAC key for PIIHash tokens
	rec    *violationRecorder
}

func newSensitivityPolicy(s *settings, rec *violationRecorder) *sensitivityPolicy {
	lookup := s.sensitivity
	if lookup == nil {
		lookup = func(k attribute.Key) spectables.Sensitivity { return spectables.SensitivityOf[k] }
	}
	return &sensitivityPolicy{lookup: lookup, pii: s.piiMode, key: s.piiHashKey, rec: rec}
}

// classOf classifies key without recording anything: secret-classified keys
// are always dropped, and PII-classified keys are handled per the PII mode.
func (p *sensitivityPolicy) classOf(key attribute.Key) classAction {
	switch p.lookup(key) {
	case spectables.Secret:
		return actionDrop
	case spectables.PII:
		switch p.pii {
		case PIIAllow:
			return actionKeep
		case PIIHash:
			return actionRewrite
		default: // PIIDrop
			return actionDrop
		}
	default:
		return actionKeep
	}
}

// decide classifies key and records a violation for every action taken.
func (p *sensitivityPolicy) decide(signal spec.Signal, key attribute.Key) classAction {
	act := p.classOf(key)
	if act != actionKeep {
		p.rec.record(signal, ruleFor(p.lookup(key)))
	}
	return act
}

// ruleFor names the violation rule for an attribute of the given class that
// classification dropped or rewrote.
func ruleFor(class spectables.Sensitivity) string {
	if class == spectables.Secret {
		return "secret_attribute"
	}
	return "pii_attribute"
}

// minPIIHashKeyLen is the shortest key PIIHash accepts: 256 bits, the
// SHA-256 output size, so the key is never the weakest part of the token.
const minPIIHashKeyLen = 32

// token renders the keyed, non-reversible replacement for a PII value under
// PIIHash: HMAC-SHA256, truncated to 128 bits, which keeps tokens joinable
// while making collisions negligible. v must be the canonical rendering from
// canonicalSlog or canonicalAttr, so one value tokenizes identically on every
// signal.
func (p *sensitivityPolicy) token(v string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte(v)) // hash.Hash writes never fail
	return "hmac-sha256:" + hex.EncodeToString(mac.Sum(nil)[:16])
}

// slogAttr classifies a leaf slog attribute on its effective grouped key.
func (p *sensitivityPolicy) slogAttr(groups []string, a slog.Attr) (slog.Attr, classAction) {
	switch act := p.decide(spec.SignalLogs, attribute.Key(effectiveKey(groups, a.Key))); act {
	case actionDrop:
		return slog.Attr{}, act
	case actionRewrite:
		return slog.String(a.Key, p.token(canonicalSlog(a.Value))), act
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
		return kv.Key.String(p.token(canonicalAttr(kv.Value))), act
	default:
		return kv, act
	}
}

// The canonical rendering is the hash input for PII tokens. Logs carry
// slog values and spans and the resource carry attribute values, whose own
// String methods disagree on slices (slog renders []string{"a", "b"} as
// "[a b]", attribute as a JSON array), so both are rendered here to one
// form: scalars as their strconv text (floats in the shortest 'g' form) and
// slices as a JSON array of the elements' canonical strings, for example
// ["10.0.0.1","10.0.0.2"] and ["1","2"]. Byte slices render as standard
// base64 on both paths, and slog values with a text form (net.IP,
// net.HardwareAddr, and other encoding.TextMarshaler or fmt.Stringer types)
// render as that text. Values with no counterpart on the other path (slog
// times, durations, and arbitrary types; attribute maps) fall back to their
// own String rendering.
//
// The form deliberately does not encode the type, so values that render to
// the same text share a token: the string "1", the integer 1, and the float
// 1.0 all render as 1, a net.IP shares a token with its string form, and a
// string that reads as a JSON array, such as ["1","2"], shares a token with
// the slice it spells. The value, not its Go or OTel type, is what PII joins
// on. A named slice type with its own String or MarshalText method hashes
// that text, not the JSON-array form, so it joins with an attribute holding
// the same text rather than with a slice attribute. Strings hash their raw
// bytes when scalar, but inside a slice they pass through JSON encoding,
// which replaces invalid UTF-8 with U+FFFD, so slice elements that differ
// only in invalid bytes share a token.

// canonicalAttr renders an attribute value in the canonical form.
func canonicalAttr(v attribute.Value) string {
	switch v.Type() {
	case attribute.BOOL:
		return strconv.FormatBool(v.AsBool())
	case attribute.INT64:
		return strconv.FormatInt(v.AsInt64(), 10)
	case attribute.FLOAT64:
		return canonicalFloat(v.AsFloat64())
	case attribute.STRING:
		return v.AsString()
	case attribute.BYTESLICE:
		return base64.StdEncoding.EncodeToString(v.AsByteSlice())
	case attribute.BOOLSLICE:
		return canonicalArray(v.AsBoolSlice(), strconv.FormatBool)
	case attribute.INT64SLICE:
		return canonicalArray(v.AsInt64Slice(), func(i int64) string { return strconv.FormatInt(i, 10) })
	case attribute.FLOAT64SLICE:
		return canonicalArray(v.AsFloat64Slice(), canonicalFloat)
	case attribute.STRINGSLICE:
		return canonicalArray(v.AsStringSlice(), func(s string) string { return s })
	case attribute.SLICE:
		return canonicalArray(v.AsSlice(), canonicalAttr)
	default:
		return v.String()
	}
}

// canonicalSlog renders a resolved, non-group slog value in the canonical
// form.
func canonicalSlog(v slog.Value) string {
	switch v.Kind() {
	case slog.KindBool:
		return strconv.FormatBool(v.Bool())
	case slog.KindInt64:
		return strconv.FormatInt(v.Int64(), 10)
	case slog.KindUint64:
		return strconv.FormatUint(v.Uint64(), 10)
	case slog.KindFloat64:
		return canonicalFloat(v.Float64())
	case slog.KindString:
		return v.String()
	case slog.KindAny:
		return canonicalAny(v.Any())
	default:
		return v.String()
	}
}

// canonicalAny renders an arbitrary slog payload: plain byte slices as
// base64; types with a text form (encoding.TextMarshaler, then fmt.Stringer)
// as that text, so a net.IP or net.HardwareAddr matches the string a span
// would carry for it; other slices and arrays as a canonical array of their
// elements; and everything else through its slog value.
func canonicalAny(x any) string {
	if b, ok := x.([]byte); ok {
		return base64.StdEncoding.EncodeToString(b)
	}
	if text, ok := textForm(x); ok {
		return text
	}
	rv := reflect.ValueOf(x)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		if v := slog.AnyValue(x); v.Kind() != slog.KindAny {
			return canonicalSlog(v)
		}
		return fmt.Sprint(x)
	}
	elems := make([]any, rv.Len())
	for i := range elems {
		elems[i] = rv.Index(i).Interface()
	}
	return canonicalArray(elems, canonicalAny)
}

// textForm returns the text of a value implementing encoding.TextMarshaler
// (when MarshalText succeeds) or else fmt.Stringer, and whether it has one.
// These are caller-defined methods running inside the host's log call, so a
// panic in either (a nil receiver or a nil field, for example) is recovered
// and the value falls back to fmt.Sprint, which recovers panics itself.
func textForm(x any) (text string, ok bool) {
	defer func() {
		if recover() != nil {
			text, ok = fmt.Sprint(x), true
		}
	}()
	if m, isMarshaler := x.(encoding.TextMarshaler); isMarshaler {
		if b, err := m.MarshalText(); err == nil {
			return string(b), true
		}
	}
	if s, isStringer := x.(fmt.Stringer); isStringer {
		return s.String(), true
	}
	return "", false
}

// canonicalFloat renders a float in the shortest form that round-trips.
func canonicalFloat(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

// canonicalArray renders elems as a JSON array of their canonical strings.
func canonicalArray[T any](elems []T, render func(T) string) string {
	strs := make([]string, len(elems))
	for i, e := range elems {
		strs[i] = render(e)
	}
	out, _ := json.Marshal(strs) // a []string always marshals
	return string(out)
}
