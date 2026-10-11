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
//
// The `o11y` tag also recognizes the two-axis classification vocabulary:
// `confidential` maps to mask and `secret` maps to redact, so capture-time
// tags speak the same language as the telemetry spec. Value-typing a secret
// field is the fail-closed backstop that key-based classification cannot
// provide: a key can be renamed to an unclassified name, but a tagged field
// carries its protection with the value.
package redact

import (
	"encoding"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"sort"
	"strconv"
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

// Format implements [fmt.Formatter], guarding every fmt verb. Without it,
// numeric verbs such as %d bypass the Stringer and reflect into the wrapped
// value.
func (s Secret[T]) Format(f fmt.State, _ rune) {
	_, _ = io.WriteString(f, Redacted) // writing to fmt.State never fails
}

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

// Format implements [fmt.Formatter], guarding every fmt verb. Without it, a
// verb like %d on a string-backed type embeds the raw operand in fmt's
// bad-verb error string.
func (m Masked) Format(f fmt.State, _ rune) {
	_, _ = io.WriteString(f, m.masked()) // writing to fmt.State never fails
}

func (m Masked) masked() string { return maskString(string(m)) }

// protection is ordered: higher values are stricter and win through nesting.
type protection int

const (
	passthrough protection = iota
	mask
	redact
	omit
)

// parseProtection maps an o11y tag value to a protection level. Alongside the
// three protection names (mask, redact, omit) it recognizes the two-axis
// classification vocabulary: confidential maps to mask, secret maps to redact.
// Value-typing a secret field is the fail-closed backstop that key-based
// classification cannot provide, since a key can be renamed to an unclassified
// name but a tagged field cannot. Unknown tags fail closed to redact.
func parseProtection(tag string) (protection, bool) {
	switch tag {
	case "":
		return passthrough, true
	case "mask", "confidential":
		return mask, true
	case "redact", "secret":
		return redact, true
	case "omit":
		return omit, true
	default:
		return redact, false // unknown tags fail closed
	}
}

// maxDepth bounds the recursion of [Struct] rendering. Values nested deeper
// (including cyclic graphs, which would otherwise recurse forever) render
// as REDACTED: failing closed beats crashing the process or leaking.
const maxDepth = 32

// Struct returns a [slog.LogValuer] that renders v (a struct or pointer to
// struct) as a log group, applying the protections declared in `o11y` field
// tags. Untagged fields pass through; unexported fields are omitted; an
// unrecognized tag value fails closed to redact. The strictest protection
// in scope wins through nesting: fields of a struct inside a masked field
// are masked at minimum. Protection follows values into slices, arrays,
// maps, pointers, and interfaces, so a []Payment element is exactly as
// protected as a Payment field. Map entries render sorted by key. Under a
// mask floor, map entries render as a group keyed by sorted position, each
// holding the masked key and the protected value.
//
// A nested value implementing [slog.LogValuer] is rendered through its own
// LogValue (under passthrough and mask floors), so self-protecting types
// such as [Secret] keep their protection inside Struct. Cyclic or deeper
// than 32-level structures render as REDACTED rather than recursing
// without bound.
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
	return protectValue(reflect.ValueOf(s.v), passthrough, 0)
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

var logValuerType = reflect.TypeFor[slog.LogValuer]()

func protectValue(v reflect.Value, floor protection, depth int) slog.Value {
	if floor == redact {
		return slog.StringValue(Redacted)
	}
	// Every iteration descends one level, so the bound is checked inside the
	// loop: a self-referential interface (var v any; v = &v) would otherwise
	// spin forever without ever reaching the recursive depth check.
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if depth > maxDepth {
			return slog.StringValue(Redacted) // cycle or absurd nesting: fail closed
		}
		if v.IsNil() {
			return slog.AnyValue(nil)
		}
		// A self-protecting value renders through its own LogValue; Struct
		// must never weaken protection a type already carries.
		if valuer, ok := v.Interface().(slog.LogValuer); ok {
			return resolveProtected(valuer, floor, depth)
		}
		v = v.Elem()
		depth++
	}
	if depth > maxDepth {
		return slog.StringValue(Redacted)
	}
	if !v.IsValid() {
		return slog.AnyValue(nil) // Struct(nil)
	}
	if v.IsValid() && v.CanInterface() && v.Type().Implements(logValuerType) {
		if valuer, ok := v.Interface().(slog.LogValuer); ok {
			return resolveProtected(valuer, floor, depth)
		}
	}
	if text, ok := leafText(v); ok {
		if floor == mask && text != Redacted {
			return slog.StringValue(maskString(text))
		}
		return slog.StringValue(text)
	}

	switch v.Kind() {
	case reflect.Struct:
		plans := plansFor(v.Type())
		attrs := make([]slog.Attr, 0, len(plans))
		for _, plan := range plans {
			effective := max(floor, plan.protection)
			if effective == omit {
				continue
			}
			attrs = append(attrs, slog.Attr{
				Key:   plan.name,
				Value: protectValue(v.Field(plan.index), effective, depth+1),
			})
		}
		return slog.GroupValue(attrs...)

	case reflect.Slice, reflect.Array:
		if v.Kind() == reflect.Slice && v.IsNil() {
			return slog.AnyValue(nil)
		}
		elems := make([]slog.Value, v.Len())
		for i := range v.Len() {
			elems[i] = protectValue(v.Index(i), floor, depth+1)
		}
		return sliceValue(elems)

	case reflect.Map:
		if v.IsNil() {
			return slog.AnyValue(nil)
		}
		keys := v.MapKeys()
		rendered := make([]string, len(keys))
		for i, k := range keys {
			rendered[i] = fmt.Sprint(k.Interface())
		}
		order := make([]int, len(keys))
		for i := range order {
			order[i] = i
		}
		sort.SliceStable(order, func(a, b int) bool { return rendered[order[a]] < rendered[order[b]] })
		attrs := make([]slog.Attr, 0, len(keys))
		for pos, i := range order {
			value := protectValue(v.MapIndex(keys[i]), floor, depth+1)
			if floor == mask {
				// Masked keys of equal length would collide, so entries are
				// keyed by position and carry the masked key alongside.
				attrs = append(attrs, slog.Group(strconv.Itoa(pos),
					slog.String("key", maskString(rendered[i])),
					slog.Any("value", value)))
				continue
			}
			attrs = append(attrs, slog.Attr{Key: rendered[i], Value: value})
		}
		return slog.GroupValue(attrs...)

	default:
		if floor == mask {
			return slog.StringValue(maskString(fmt.Sprint(v.Interface())))
		}
		return slog.AnyValue(v.Interface())
	}
}

// leafText returns the text form of values that are opaque leaves rather
// than containers to walk: types implementing encoding.TextMarshaler or
// fmt.Stringer whose type cannot carry protection anywhere inside it (see
// [mayCarryProtection]). Any other value is walked, which keeps nested tags
// authoritative: a String method cannot fold a tagged field into its text.
// A panicking String or MarshalText renders REDACTED.
func leafText(v reflect.Value) (text string, ok bool) {
	if !v.IsValid() || !v.CanInterface() || mayCarryProtection(v.Type()) {
		return "", false
	}
	defer func() {
		if recover() != nil {
			text, ok = Redacted, true // fail closed on a panicking method
		}
	}()
	switch x := v.Interface().(type) {
	case encoding.TextMarshaler:
		b, err := x.MarshalText()
		if err != nil {
			return "", false
		}
		return string(b), true
	case fmt.Stringer:
		return x.String(), true
	}
	return "", false
}

var protectionScanCache sync.Map // reflect.Type -> bool

// mayCarryProtection reports whether a value of type t could hold anything
// that Struct must protect: an o11y-tagged field at any depth (exported,
// unexported, or embedded), a self-protecting [slog.LogValuer] component,
// or an interface-typed component whose dynamic value is unknown until run
// time (fail closed). Components are reached through struct fields,
// pointers, slices, arrays, and map keys and values. Results are cached per
// type; recursive types terminate, and scans deeper than maxDepth fail
// closed.
func mayCarryProtection(t reflect.Type) bool {
	if t == nil {
		return false
	}
	if cached, ok := protectionScanCache.Load(t); ok {
		return cached.(bool) // cache only ever holds bool
	}
	result := scanProtection(t, make(map[reflect.Type]bool), 0)
	protectionScanCache.Store(t, result)
	return result
}

// scanProtection is the depth-first scan behind mayCarryProtection. A true
// result short-circuits to the root, so a type already in seen is either on
// the current path (a cycle, which adds nothing new) or fully scanned and
// found clean; either way it contributes false.
func scanProtection(t reflect.Type, seen map[reflect.Type]bool, depth int) bool {
	if depth > maxDepth {
		return true
	}
	if seen[t] {
		return false
	}
	seen[t] = true
	if t.Implements(logValuerType) {
		return true
	}
	switch t.Kind() {
	case reflect.Interface:
		return true
	case reflect.Pointer, reflect.Slice, reflect.Array:
		return scanProtection(t.Elem(), seen, depth+1)
	case reflect.Map:
		return scanProtection(t.Key(), seen, depth+1) || scanProtection(t.Elem(), seen, depth+1)
	case reflect.Struct:
		for i := range t.NumField() {
			field := t.Field(i)
			if _, tagged := field.Tag.Lookup(TagKey); tagged {
				return true
			}
			if scanProtection(field.Type, seen, depth+1) {
				return true
			}
		}
	}
	return false
}

// maskString renders s as a run of 'X' of equal rune count.
func maskString(s string) string { return strings.Repeat("X", utf8.RuneCountInString(s)) }

// resolveProtected renders a self-protecting value through its own
// LogValue, then enforces the surrounding floor on the result whatever its
// kind, so a masked field cannot leak through a LogValuer that returns a
// number, a group, or an arbitrary value.
func resolveProtected(valuer slog.LogValuer, floor protection, depth int) slog.Value {
	resolved := slog.AnyValue(valuer).Resolve() // Resolve recovers panics
	return applyFloor(resolved, floor, depth)
}

// applyFloor enforces a protection floor on an already-resolved value.
// Groups are walked so every leaf is protected; arbitrary values are walked
// with Struct's own traversal so their tags still apply strictest-wins. A
// leaf already rendered REDACTED keeps that stricter rendering.
func applyFloor(v slog.Value, floor protection, depth int) slog.Value {
	if depth > maxDepth {
		return slog.StringValue(Redacted)
	}
	switch floor {
	case passthrough:
		return v
	case redact, omit:
		return slog.StringValue(Redacted)
	}
	v = v.Resolve()
	switch v.Kind() {
	case slog.KindGroup:
		members := v.Group()
		out := make([]slog.Attr, len(members))
		for i, m := range members {
			out[i] = slog.Attr{Key: m.Key, Value: applyFloor(m.Value, floor, depth+1)}
		}
		return slog.GroupValue(out...)
	case slog.KindString:
		if v.String() == Redacted {
			return v
		}
		return slog.StringValue(maskString(v.String()))
	case slog.KindAny:
		return protectValue(reflect.ValueOf(v.Any()), floor, depth+1)
	default: // int64, uint64, float64, bool, duration, time
		return slog.StringValue(maskString(v.String()))
	}
}

// sliceValue renders protected slice elements as a single value. slog has
// no first-class list value, so elements become a group keyed by index:
// stable, queryable, and structurally identical on every sink.
func sliceValue(elems []slog.Value) slog.Value {
	attrs := make([]slog.Attr, len(elems))
	for i, elem := range elems {
		attrs[i] = slog.Attr{Key: fmt.Sprint(i), Value: elem}
	}
	return slog.GroupValue(attrs...)
}
