// Package redact provides capture-time protection for sensitive values in
// logs, complementing the emit-time attribute replacer configured with
// o11y.WithAttrReplacer.
//
// Capture-time protection is expressed through [log/slog.LogValuer], Go's
// native mechanism for controlling how a value renders in logs: a protected
// value is redacted wherever it is logged, on every sink, with no handler
// cooperation required. [Secret] and [Masked] also guard the fmt and JSON
// surfaces, so a value that must never leak renders redacted under %v, %s,
// %#v, and json.Marshal as well.
//
// Three protections exist, from weakest to strictest:
//
//   - mask: a run of 'X' of equal rune count, preserving only the value's shape
//   - redact: the literal "REDACTED"
//   - omit: the field is absent entirely
//
// For struct types, [Struct] applies protections declared with `o11y` field
// tags, with the strictest protection winning through nesting:
//
//	type Payment struct {
//		Card     string `o11y:"mask"`
//		CVV      string `o11y:"redact"`
//		PIN      string `o11y:"omit"`
//		Merchant string
//	}
//
//	slog.Info("charge", "payment", redact.Struct(payment))
package redact

import (
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"unicode/utf8"
)

// Redacted is the literal that replaces redacted values.
const Redacted = "REDACTED"

// TagKey is the struct tag key read by [Struct].
const TagKey = "o11y"

// Secret wraps a value that must never appear in telemetry. It renders as
// "REDACTED" through slog, fmt (%v, %s, %#v), and JSON marshaling. Retrieve
// the wrapped value explicitly with [Secret.Reveal].
type Secret[T any] struct {
	value T
}

// NewSecret wraps value in a [Secret].
func NewSecret[T any](value T) Secret[T] {
	return Secret[T]{value: value}
}

// Reveal returns the wrapped value. The deliberate name makes retrieval
// easy to audit.
func (s Secret[T]) Reveal() T { return s.value }

// LogValue implements [slog.LogValuer].
func (s Secret[T]) LogValue() slog.Value { return slog.StringValue(Redacted) }

// String implements [fmt.Stringer].
func (s Secret[T]) String() string { return Redacted }

// GoString implements [fmt.GoStringer], guarding the %#v verb.
func (s Secret[T]) GoString() string { return Redacted }

// MarshalText implements [encoding.TextMarshaler].
func (s Secret[T]) MarshalText() ([]byte, error) { return []byte(Redacted), nil }

// MarshalJSON implements [encoding/json.Marshaler].
func (s Secret[T]) MarshalJSON() ([]byte, error) { return []byte(`"` + Redacted + `"`), nil }

// Masked is a string that renders as a run of 'X' of equal rune count
// through slog, fmt, and JSON marshaling, preserving only its visible
// shape. Convert to protect: redact.Masked(cardNumber).
type Masked string

// LogValue implements [slog.LogValuer].
func (m Masked) LogValue() slog.Value { return slog.StringValue(m.masked()) }

// String implements [fmt.Stringer].
func (m Masked) String() string { return m.masked() }

// GoString implements [fmt.GoStringer], guarding the %#v verb.
func (m Masked) GoString() string { return m.masked() }

// MarshalText implements [encoding.TextMarshaler].
func (m Masked) MarshalText() ([]byte, error) { return []byte(m.masked()), nil }

// MarshalJSON implements [encoding/json.Marshaler].
func (m Masked) MarshalJSON() ([]byte, error) { return []byte(`"` + m.masked() + `"`), nil }

func (m Masked) masked() string { return strings.Repeat("X", utf8.RuneCountInString(string(m))) }

// protection is ordered: higher values are stricter and win through nesting.
type protection int

const (
	passthrough protection = iota
	mask
	redact
	omit
)

func parseProtection(tag string) (protection, bool) {
	switch tag {
	case "":
		return passthrough, true
	case "mask":
		return mask, true
	case "redact":
		return redact, true
	case "omit":
		return omit, true
	default:
		return redact, false // unknown tags fail closed
	}
}

// Struct returns a [slog.LogValuer] that renders v (a struct or pointer to
// struct) as a log group, applying the protections declared in `o11y` field
// tags. Untagged fields pass through; unexported fields are omitted; an
// unrecognized tag value fails closed to redact. The strictest protection
// in scope wins through nesting: fields of a struct inside a masked field
// are masked at minimum.
//
// Non-struct values pass through unchanged.
func Struct(v any) slog.LogValuer {
	return structValuer{v: v}
}

type structValuer struct {
	v any
}

// LogValue implements [slog.LogValuer].
func (s structValuer) LogValue() slog.Value {
	return protectValue(reflect.ValueOf(s.v), passthrough)
}

type fieldPlan struct {
	index      int
	name       string
	protection protection
}

var planCache sync.Map // reflect.Type -> []fieldPlan

func plansFor(t reflect.Type) []fieldPlan {
	if cached, ok := planCache.Load(t); ok {
		return cached.([]fieldPlan) // cache only ever holds []fieldPlan
	}
	fields := reflect.VisibleFields(t)
	plans := make([]fieldPlan, 0, len(fields))
	for _, field := range fields {
		if !field.IsExported() || len(field.Index) > 1 {
			// Promoted fields of embedded structs render when the embedded
			// struct itself does, as a group keyed by its type name.
			continue
		}
		level, _ := parseProtection(field.Tag.Get(TagKey))
		plans = append(plans, fieldPlan{
			index:      field.Index[0],
			name:       field.Name,
			protection: level,
		})
	}
	planCache.Store(t, plans)
	return plans
}

func protectValue(v reflect.Value, floor protection) slog.Value {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return slog.AnyValue(nil)
		}
		v = v.Elem()
	}

	if v.Kind() != reflect.Struct {
		switch floor {
		case mask:
			return slog.StringValue(strings.Repeat("X", utf8.RuneCountInString(fmt.Sprint(v.Interface()))))
		case redact:
			return slog.StringValue(Redacted)
		default:
			return slog.AnyValue(v.Interface())
		}
	}

	if floor == redact {
		return slog.StringValue(Redacted)
	}

	plans := plansFor(v.Type())
	attrs := make([]slog.Attr, 0, len(plans))
	for _, plan := range plans {
		effective := max(floor, plan.protection)
		if effective == omit {
			continue
		}
		attrs = append(attrs, slog.Attr{
			Key:   plan.name,
			Value: protectValue(v.Field(plan.index), effective),
		})
	}
	return slog.GroupValue(attrs...)
}
