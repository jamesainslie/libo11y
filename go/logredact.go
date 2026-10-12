package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"strings"

	"go.opentelemetry.io/otel/attribute"
)

// sinkMode identifies which log sink a per-leg classifier is guarding. It is
// the seam that lets classification differ by destination: Phase 1 uses it to
// withhold confidential attributes from the console while still exporting them
// over OTLP. Through Phase 0 both modes classify identically. The OTLP leg
// also marks each record's context as classified, so the LoggerProvider's
// [redactingLogProcessor], which classifies records from every other bridge,
// leaves it alone.
type sinkMode int

const (
	// sinkConsole marks the console (and any extra user-supplied) sink.
	sinkConsole sinkMode = iota
	// sinkOTLP marks the OTLP export sink.
	sinkOTLP
)

// classifyingHandler wraps a single fan-out leg so every record's attributes
// pass through the SDK's [sensitivityPolicy] before reaching inner. Moving
// classification into each leg (rather than running it once in the shared
// fan-out replacer) is what makes redaction sink-aware: each leg carries its
// own [sinkMode]. The user replacer still runs once upstream in the fan-out,
// so every leg sees identical attributes; only classification is per-leg.
// Through Phase 0 both sinks classify identically, so mode is not yet
// consulted (Phase 1 uses it for confidential-console-withhold). Because
// classification is per leg, the walk of composite values (Go maps and
// slices of them, see classifyComposite) also runs once per leg, by design:
// each leg must be able to classify differently.
func classifyingHandler(inner slog.Handler, mode sinkMode, policy *sensitivityPolicy) slog.Handler {
	return &classifier{inner: inner, mode: mode, policy: policy}
}

type classifier struct {
	inner  slog.Handler
	mode   sinkMode
	policy *sensitivityPolicy
	groups []string
}

func (c *classifier) Enabled(ctx context.Context, level slog.Level) bool {
	return c.inner.Enabled(ctx, level)
}

func (c *classifier) Handle(ctx context.Context, record slog.Record) error {
	if c.mode == sinkOTLP {
		ctx = markPipelineClassified(ctx)
	}
	attrs := make([]slog.Attr, 0, record.NumAttrs())
	changed := false
	record.Attrs(func(a slog.Attr) bool {
		out, keep, ch := c.classifyAttr(c.groups, a)
		changed = changed || ch
		if keep {
			attrs = append(attrs, out)
		}
		return true
	})
	// Nothing was dropped or rewritten: forward the original record so the
	// common path adds no record rebuild.
	if !changed {
		return c.inner.Handle(ctx, record)
	}
	classified := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	classified.AddAttrs(attrs...)
	return c.inner.Handle(ctx, classified)
}

// classifyAttr classifies one attribute at the given group path, recursing
// into groups, and into Go maps, slices of them, and pointers to either
// logged under an unclassified key (see classifyComposite), so every leaf is
// judged on its effective dotted key. A value under a classified key is
// judged whole. Change tracking comes from the classification action, never
// from comparing slog values, because slog.Value.Equal panics on
// uncomparable values.
func (c *classifier) classifyAttr(groups []string, a slog.Attr) (out slog.Attr, keep, changed bool) {
	return c.classifyAttrIn(groups, a, nil)
}

// classifyAttrIn is classifyAttr within an ongoing composite walk; w is nil
// at the top of an attribute, and a walk starts when a composite is found.
func (c *classifier) classifyAttrIn(groups []string, a slog.Attr, w *compositeWalk) (out slog.Attr, keep, changed bool) {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		path := groups
		if a.Key != "" {
			path = append(slices.Clone(groups), a.Key)
		}
		members := a.Value.Group()
		kept := make([]slog.Attr, 0, len(members))
		memberChanged := false
		for _, m := range members {
			mo, mk, mc := c.classifyAttrIn(path, m, w)
			memberChanged = memberChanged || mc
			if mk {
				kept = append(kept, mo)
			}
		}
		if len(kept) == 0 {
			return slog.Attr{}, false, true
		}
		if !memberChanged {
			return a, true, false
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(kept...)}, true, true
	}
	// One classification lookup per attribute: the class decides both
	// whether a composite value is walked and what happens to a leaf.
	class := c.policy.lookup(attribute.Key(effectiveKey(groups, a.Key)))
	if c.policy.actionFor(class) == actionKeep {
		if a.Value.Kind() == slog.KindAny && a.Key != "" {
			if w == nil {
				w = newCompositeWalk()
			}
			path := append(slices.Clone(groups), a.Key)
			if v, vk, vc, ok := c.classifyComposite(path, a.Value.Any(), 0, w); ok {
				switch {
				case !vc:
					return a, true, false
				case !vk:
					return slog.Attr{}, false, true
				default:
					return slog.Any(a.Key, v), true, true
				}
			}
		}
		return a, true, false
	}
	res, action := c.policy.slogLeaf(a, class)
	if action == actionDrop {
		return slog.Attr{}, false, true
	}
	return res, true, true
}

// maxCompositeDepth bounds how deeply a composite walk goes: nested maps by
// effective key length, and nested slices and pointer indirections by walk
// depth. The key-length bound counts the handler's own groups too, so a
// composite under very deeply grouped handlers fails closed even when it is
// shallow itself; that is deliberate, since the bound must hold whatever the
// nesting came from. A map or slice past the bound is dropped rather than
// forwarded unexamined.
const maxCompositeDepth = 16

// compositeWalkBudget caps the nodes (maps, slices, pointers, and their
// members) one walk visits. Shared references make a value without cycles
// (a map referenced by several members on every level) expand exponentially
// when walked; past the budget the walk drops what remains, so the work, and
// the rebuilt value every sink then encodes, stays bounded.
const compositeWalkBudget = 2048

// compositeWalk is the state of one walk over a composite value: the
// identities of the maps, slices, and pointers on the current path, to cut
// references back into it, and the remaining node budget.
type compositeWalk struct {
	onPath []uintptr
	budget int
}

func newCompositeWalk() *compositeWalk { return &compositeWalk{budget: compositeWalkBudget} }

// spend takes one node from the budget and reports whether any remained.
func (w *compositeWalk) spend() bool {
	w.budget--
	return w.budget >= 0
}

// enter records that the walk descends into v and reports false when v is
// already on the current path (a cycle). leave must follow a successful
// enter. Values without an identity (arrays, nil, zero-length slices with no
// backing array) are always entered.
func (w *compositeWalk) enter(v reflect.Value) bool {
	id := identity(v)
	if id != 0 && slices.Contains(w.onPath, id) {
		return false
	}
	w.onPath = append(w.onPath, id)
	return true
}

func (w *compositeWalk) leave() { w.onPath = w.onPath[:len(w.onPath)-1] }

// identity returns the address that identifies a map, slice, or pointer, or
// 0 for anything else.
func identity(v reflect.Value) uintptr {
	switch v.Kind() {
	case reflect.Map, reflect.Slice, reflect.Pointer:
		return v.Pointer()
	default:
		return 0
	}
}

// classifyComposite walks a Go value logged as one slog value when it is a
// map, or a slice or array that can hold one, so its members are judged on
// their dotted effective keys under path (the holder's effective key) like
// slog groups are. Non-nil pointers and interfaces are followed, and map
// keys that are not strings are rendered with %+v, as otelslog does, so the
// walk covers the map values otelslog makes (it also turns complex numbers
// into small maps of their parts, which carry nothing to classify). The
// console, extra sinks, the OTLP leg, and other bridges therefore agree. ok
// is false for any other value, which stays a leaf.
//
// A map or slice emptied by classification is dropped (keep false); a
// changed one is rebuilt as map[string]any or []any holding the surviving
// members, and an unchanged one is returned as is. The walk fails closed:
// past maxCompositeDepth, on a reference back into the current path, or once
// the walk's node budget is spent, a map or slice (or what remains of one) is
// dropped, reported as a change, and never forwarded unexamined.
func (c *classifier) classifyComposite(path []string, x any, depth int, w *compositeWalk) (out any, keep, changed, ok bool) {
	rv := reflect.ValueOf(x)
	entered := 0
	defer func() {
		for range entered {
			w.leave()
		}
	}()
	for rv.IsValid() && (rv.Kind() == reflect.Pointer || rv.Kind() == reflect.Interface) {
		if rv.IsNil() {
			return x, true, false, false
		}
		if rv.Kind() == reflect.Pointer {
			if depth++; depth >= maxCompositeDepth || !w.spend() || !w.enter(rv) {
				return nil, false, true, true
			}
			entered++
		}
		rv = rv.Elem()
	}
	if !rv.IsValid() || !mayHoldMap(rv) {
		return x, true, false, false
	}
	if depth >= maxCompositeDepth || len(path) > maxCompositeDepth || !w.spend() || !w.enter(rv) {
		return nil, false, true, true
	}
	entered++
	if rv.Kind() == reflect.Map {
		type member struct {
			key   string
			value any
		}
		members := make([]member, 0, rv.Len())
		for it := rv.MapRange(); it.Next(); {
			members = append(members, member{mapKey(it.Key()), it.Value().Interface()})
		}
		slices.SortFunc(members, func(a, b member) int { return strings.Compare(a.key, b.key) })
		kept := make(map[string]any, len(members))
		for _, m := range members {
			if !w.spend() {
				changed = true // the budget is spent: drop the remaining members
				break
			}
			mo, mk, mc := c.classifyAttrIn(path, slog.Any(m.key, m.value), w)
			changed = changed || mc
			if mk {
				kept[m.key] = mo.Value.Any()
			}
		}
		if !changed {
			return x, true, false, true
		}
		return kept, len(kept) > 0, true, true
	}
	kept := make([]any, 0, rv.Len())
	for i := range rv.Len() {
		if !w.spend() {
			changed = true // the budget is spent: drop the remaining elements
			break
		}
		e := rv.Index(i).Interface()
		eo, ek, ec, eok := c.classifyComposite(path, e, depth+1, w)
		if !eok {
			kept = append(kept, e)
			continue
		}
		changed = changed || ec
		if ek {
			kept = append(kept, eo)
		}
	}
	if !changed {
		return x, true, false, true
	}
	return kept, len(kept) > 0, true, true
}

// mayHoldMap reports whether v is a map, or a slice or array whose elements
// can be or lead to one. Slices of scalars ([]byte, []string) are leaves and
// are never walked element by element.
func mayHoldMap(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Map:
		return true
	case reflect.Slice, reflect.Array:
		switch v.Type().Elem().Kind() {
		case reflect.Interface, reflect.Map, reflect.Slice, reflect.Array, reflect.Pointer:
			return true
		}
	}
	return false
}

// mapKey renders a map key as otelslog does: strings as themselves, any
// other key with %+v.
func mapKey(k reflect.Value) string {
	if k.Kind() == reflect.String {
		return k.String()
	}
	return fmt.Sprintf("%+v", k.Interface())
}

// WithAttrs classifies the attributes at the handler's current group path
// before handing them to the inner handler, so pre-bound attributes obey the
// same rules as per-record ones.
func (c *classifier) WithAttrs(attrs []slog.Attr) slog.Handler {
	kept := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		if out, keep, _ := c.classifyAttr(c.groups, a); keep {
			kept = append(kept, out)
		}
	}
	return &classifier{inner: c.inner.WithAttrs(kept), mode: c.mode, policy: c.policy, groups: c.groups}
}

// WithGroup extends the group path used to build effective keys.
func (c *classifier) WithGroup(name string) slog.Handler {
	if name == "" {
		return c
	}
	return &classifier{
		inner: c.inner.WithGroup(name), mode: c.mode, policy: c.policy,
		groups: append(slices.Clone(c.groups), name),
	}
}
