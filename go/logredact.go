package o11y

import (
	"context"
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
// consulted (Phase 1 uses it for confidential-console-withhold).
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
// into groups, and into string-keyed Go maps and slices of them logged under
// an unclassified key (see classifyComposite), so every leaf is judged on its
// effective dotted key. A value under a classified key is judged whole. Change
// tracking comes from the classification action, never from comparing slog
// values, because slog.Value.Equal panics on uncomparable values.
func (c *classifier) classifyAttr(groups []string, a slog.Attr) (out slog.Attr, keep, changed bool) {
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
			mo, mk, mc := c.classifyAttr(path, m)
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
	if a.Value.Kind() == slog.KindAny && a.Key != "" &&
		c.policy.classOf(attribute.Key(effectiveKey(groups, a.Key))) == actionKeep {
		path := append(slices.Clone(groups), a.Key)
		if v, vk, vc, ok := c.classifyComposite(path, a.Value.Any(), 0); ok {
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
	res, action := c.policy.slogAttr(groups, a)
	switch action {
	case actionDrop:
		return slog.Attr{}, false, true
	case actionRewrite:
		return res, true, true
	default:
		return a, true, false
	}
}

// maxCompositeDepth bounds how deeply classifyComposite walks nested maps
// (by effective key length) and nested slices, so a self-referencing value
// cannot recurse forever. Deeper values are opaque leaves under their
// holder's key.
const maxCompositeDepth = 16

// classifyComposite walks a Go value logged as one slog value when it is a
// map with string keys, or a slice or array that can hold such maps, so its
// members are judged on their dotted effective keys under path (the holder's
// effective key) like slog groups are. This matches what a log bridge
// produces for the same value (map values, and slices of them), so the
// console, extra sinks, the OTLP leg, and other bridges agree. ok is false
// for any other value, which stays a leaf. A map or slice emptied by
// classification is dropped (keep false); a changed one is rebuilt as
// map[string]any or []any holding the surviving members, and an unchanged
// one is returned as is.
func (c *classifier) classifyComposite(path []string, x any, depth int) (out any, keep, changed, ok bool) {
	rv := reflect.ValueOf(x)
	if !rv.IsValid() || depth >= maxCompositeDepth || len(path) > maxCompositeDepth {
		return x, true, false, false
	}
	switch rv.Kind() {
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return x, true, false, false
		}
		keys := rv.MapKeys()
		slices.SortFunc(keys, func(a, b reflect.Value) int { return strings.Compare(a.String(), b.String()) })
		kept := make(map[string]any, len(keys))
		for _, k := range keys {
			member := slog.Any(k.String(), rv.MapIndex(k).Interface())
			mo, mk, mc := c.classifyAttr(path, member)
			changed = changed || mc
			if mk {
				kept[k.String()] = mo.Value.Any()
			}
		}
		if !changed {
			return x, true, false, true
		}
		return kept, len(kept) > 0, true, true
	case reflect.Slice, reflect.Array:
		switch rv.Type().Elem().Kind() {
		case reflect.Interface, reflect.Map, reflect.Slice, reflect.Array:
		default:
			return x, true, false, false // cannot hold a map: a plain leaf
		}
		kept := make([]any, 0, rv.Len())
		for i := range rv.Len() {
			e := rv.Index(i).Interface()
			eo, ek, ec, eok := c.classifyComposite(path, e, depth+1)
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
	default:
		return x, true, false, false
	}
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
