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
	"cmp"
	"encoding"
	"fmt"
	"io"
	"log/slog"
	"reflect"
	"slices"
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
// protected as a Payment field.
//
// Non-struct values are walked the same way. Slices and arrays render as a
// group keyed by index. Maps render as a group sorted by key text (ties
// broken by the key's dynamic type name). Under a mask floor, when a key's
// type may carry protection, or when two keys render the same text, map
// entries instead render as a group keyed by sorted position, each holding
// the protected key (masked, or REDACTED for a key whose type has tagged
// fields, a LogValuer, or dynamic components such as an interface)
// and the protected value. A value implementing [encoding.TextMarshaler] or
// [fmt.Stringer] whose type cannot carry protection (time.Time, net.IP,
// netip.Addr) renders as its text form, masked under a mask floor; any other
// such value is walked so a String method cannot fold a tagged field into
// its text, and a panicking String or MarshalText renders REDACTED. A nil
// value, nil pointer, nil interface, nil slice, or nil map renders as a nil
// value. Scalars render unchanged, or masked under a mask floor.
//
// A nested value implementing [slog.LogValuer] is rendered through its own
// LogValue (under passthrough and mask floors), so self-protecting types
// such as [Secret] keep their protection inside Struct. The floor in scope
// is then enforced on the result: values it returns are walked so their
// tags still apply, and under a mask floor every leaf is masked. Group keys
// a LogValuer emits are treated as field names and are never masked, so a
// LogValuer that carries data in group keys must protect those keys itself.
// Cyclic or deeper than 32-level structures render as REDACTED rather than
// recursing without bound.
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
		if rendered, ok := errorValue(v, floor); ok {
			return rendered
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
	if v.CanInterface() && v.Type().Implements(logValuerType) {
		if valuer, ok := v.Interface().(slog.LogValuer); ok {
			return resolveProtected(valuer, floor, depth)
		}
	}
	if rendered, ok := errorValue(v, floor); ok {
		return rendered
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
		entries := make([]mapEntry, len(keys))
		positional := floor == mask
		for i, k := range keys {
			entries[i] = renderMapKey(k)
			entries[i].index = i
			positional = positional || entries[i].redacted
		}
		slices.SortStableFunc(entries, func(a, b mapEntry) int {
			return cmp.Or(cmp.Compare(a.text, b.text), cmp.Compare(a.typeName, b.typeName))
		})
		for i := 1; i < len(entries) && !positional; i++ {
			// Distinct keys with equal text (1 and int64(1)) would collide.
			positional = entries[i].text == entries[i-1].text
		}
		attrs := make([]slog.Attr, 0, len(entries))
		for pos, e := range entries {
			value := protectValue(v.MapIndex(keys[e.index]), floor, depth+1)
			if !positional {
				attrs = append(attrs, slog.Attr{Key: e.text, Value: value})
				continue
			}
			// Masked or redacted keys would collide, so entries are keyed by
			// position and carry the protected key alongside.
			key := e.text
			if floor == mask && !e.redacted {
				key = maskString(key)
			}
			attrs = append(attrs, slog.Group(strconv.Itoa(pos),
				slog.String("key", key),
				slog.Any("value", value)))
		}
		return slog.GroupValue(attrs...)

	default:
		if floor == mask {
			return slog.StringValue(maskString(fmt.Sprint(v.Interface())))
		}
		return slog.AnyValue(v.Interface())
	}
}

// mapEntry is a map key prepared for rendering: its text, the dynamic type
// name used as a deterministic sort tiebreaker, whether the text was
// redacted, and the key's index in the MapKeys result.
type mapEntry struct {
	text     string
	typeName string
	redacted bool
	index    int
}

// renderMapKey renders a map key safely. A key whose dynamic type may carry
// protection renders REDACTED (fail closed: fmt.Sprint would print tagged
// fields raw); other keys use their text form or fmt.Sprint.
func renderMapKey(k reflect.Value) mapEntry {
	for k.Kind() == reflect.Interface && !k.IsNil() {
		k = k.Elem()
	}
	entry := mapEntry{typeName: fmt.Sprintf("%T", k.Interface())}
	switch {
	case k.Kind() == reflect.Interface: // nil interface key
		entry.text = fmt.Sprint(k.Interface())
	case mayCarryProtection(k.Type()):
		entry.text, entry.redacted = Redacted, true
	default:
		if text, ok := leafText(k); ok {
			entry.text = text
		} else {
			entry.text = fmt.Sprint(k.Interface())
		}
	}
	return entry
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

var errorType = reflect.TypeFor[error]()

// maxErrorNodes bounds how many values errorIsClean visits for one error,
// so a pathological error graph fails closed instead of running long.
const maxErrorNodes = 256

// errorValue renders v as its Error() text when v's type implements error:
// unchanged under passthrough, masked under a mask floor. When anything
// reachable from the error could carry protection, the whole error renders
// REDACTED, because Error() may fold that content into its text.
func errorValue(v reflect.Value, floor protection) (slog.Value, bool) {
	if !v.IsValid() || !v.CanInterface() || !v.Type().Implements(errorType) {
		return slog.Value{}, false
	}
	err, ok := v.Interface().(error)
	if !ok || err == nil {
		return slog.Value{}, false
	}
	text := errorText(err)
	if floor == mask && text != Redacted {
		text = maskString(text)
	}
	return slog.StringValue(text), true
}

// errorText returns err.Error() when the error is clean, and REDACTED when
// it is not or when Error or Unwrap panics.
func errorText(err error) (text string) {
	defer func() {
		if recover() != nil {
			text = Redacted // fail closed on a panicking method
		}
	}()
	budget := maxErrorNodes
	if !errorIsClean(reflect.ValueOf(err), &budget, 0) {
		return Redacted
	}
	return err.Error()
}

// errorIsClean reports whether nothing reachable from an error value could
// carry protection. Types are checked with [mayCarryProtection], except that
// interface components whose static type is error are not failed outright:
// their dynamic values are visited instead, as are the errors returned by
// Unwrap() error and Unwrap() []error. This covers wrapping errors whether or
// not they expose their causes through Unwrap.
func errorIsClean(v reflect.Value, budget *int, depth int) bool {
	*budget--
	if *budget < 0 || depth > maxDepth {
		return false
	}
	if !v.IsValid() {
		return true
	}
	switch v.Kind() {
	case reflect.Interface:
		return v.IsNil() || errorIsClean(v.Elem(), budget, depth+1)
	case reflect.Pointer:
		if v.IsNil() {
			return true
		}
	}
	t := v.Type()
	if !mayCarryProtection(t) {
		return true // no tags and no dynamic content anywhere in the type
	}
	if errorScanMayCarryProtection(t) {
		return false // something other than an error interface may carry protection
	}
	// Only error-typed interfaces remain: visit their dynamic values.
	if v.CanInterface() {
		switch u := v.Interface().(type) {
		case interface{ Unwrap() error }:
			if !errorIsClean(reflect.ValueOf(u.Unwrap()), budget, depth+1) {
				return false
			}
		case interface{ Unwrap() []error }:
			for _, inner := range u.Unwrap() {
				if !errorIsClean(reflect.ValueOf(inner), budget, depth+1) {
					return false
				}
			}
		}
	}
	switch v.Kind() {
	case reflect.Pointer:
		return errorIsClean(v.Elem(), budget, depth+1)
	case reflect.Struct:
		for i := range v.NumField() {
			if !errorIsClean(v.Field(i), budget, depth+1) {
				return false
			}
		}
	case reflect.Slice, reflect.Array:
		for i := range v.Len() {
			if !errorIsClean(v.Index(i), budget, depth+1) {
				return false
			}
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			if !errorIsClean(iter.Key(), budget, depth+1) || !errorIsClean(iter.Value(), budget, depth+1) {
				return false
			}
		}
	}
	return true
}

var (
	protectionScanCache sync.Map // reflect.Type -> bool
	errorScanCache      sync.Map // reflect.Type -> bool
)

// errorScanMayCarryProtection is [mayCarryProtection] except that interface
// components whose static type is exactly error are treated as clean;
// errorIsClean visits their dynamic values instead.
func errorScanMayCarryProtection(t reflect.Type) bool {
	return cachedScan(&errorScanCache, t, true)
}

// mayCarryProtection reports whether a value of type t could hold anything
// that Struct must protect: an o11y-tagged field at any depth (exported,
// unexported, or embedded), a self-protecting [slog.LogValuer] component,
// or an interface, func, chan, or unsafe pointer component whose content is
// unknown until run time (fail closed). Components are reached through
// struct fields, pointers, slices, arrays, and map keys and values. Results
// are cached per type; recursive types terminate, and scans deeper than
// maxDepth fail closed.
func mayCarryProtection(t reflect.Type) bool {
	return cachedScan(&protectionScanCache, t, false)
}

func cachedScan(cache *sync.Map, t reflect.Type, errorsClean bool) bool {
	if t == nil {
		return false
	}
	if cached, ok := cache.Load(t); ok {
		return cached.(bool) // cache only ever holds bool
	}
	result := scanProtection(t, make(map[reflect.Type]bool), 0, errorsClean)
	cache.Store(t, result)
	return result
}

// scanProtection is the depth-first scan behind mayCarryProtection. A true
// result short-circuits to the root, so a type already in seen is either on
// the current path (a cycle, which adds nothing new) or fully scanned and
// found clean; either way it contributes false. With errorsClean set,
// interface components of static type error count as clean.
func scanProtection(t reflect.Type, seen map[reflect.Type]bool, depth int, errorsClean bool) bool {
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
		// What an interface holds is unknown until run time.
		return !errorsClean || t != errorType
	case reflect.Func, reflect.Chan, reflect.UnsafePointer:
		// Dynamic content: what a func returns, a chan delivers, or an
		// unsafe pointer addresses is unknown until run time.
		return true
	case reflect.Pointer, reflect.Slice, reflect.Array:
		return scanProtection(t.Elem(), seen, depth+1, errorsClean)
	case reflect.Map:
		return scanProtection(t.Key(), seen, depth+1, errorsClean) ||
			scanProtection(t.Elem(), seen, depth+1, errorsClean)
	case reflect.Struct:
		for i := range t.NumField() {
			field := t.Field(i)
			if _, tagged := field.Tag.Lookup(TagKey); tagged {
				return true
			}
			if scanProtection(field.Type, seen, depth+1, errorsClean) {
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
// with Struct's own traversal so their tags still apply strictest-wins, even
// under a passthrough floor. Group keys are treated as field names and are
// never masked. Under passthrough, scalars and arbitrary values whose type
// cannot carry protection are returned unchanged. A leaf already rendered
// REDACTED keeps that stricter rendering.
func applyFloor(v slog.Value, floor protection, depth int) slog.Value {
	if depth > maxDepth {
		return slog.StringValue(Redacted)
	}
	if floor == redact || floor == omit {
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
	case slog.KindAny:
		if floor == passthrough && !mayCarryProtection(reflect.TypeOf(v.Any())) {
			return v
		}
		return protectValue(reflect.ValueOf(v.Any()), floor, depth+1)
	}
	// Remaining kinds are scalars: string, int64, uint64, float64, bool,
	// duration, and time.
	if floor == passthrough || (v.Kind() == slog.KindString && v.String() == Redacted) {
		return v
	}
	return slog.StringValue(maskString(v.String()))
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
