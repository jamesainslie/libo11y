package o11y

import (
	"context"
	"log/slog"
	"slices"
)

// sinkMode identifies which log sink a per-leg classifier is guarding. It is
// the seam that lets classification differ by destination: Phase 1 uses it to
// withhold confidential attributes from the console while still exporting them
// over OTLP. Through Phase 0 both modes classify identically.
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
// into groups so every leaf is judged on its effective dotted key. Change
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
