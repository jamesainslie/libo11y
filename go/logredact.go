package o11y

import (
	"context"
	"log/slog"
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
// pass through the spec classifier ([classify]) before reaching inner. Moving
// classification into each leg (rather than running it once in the shared
// fan-out replacer) is what makes redaction sink-aware: each leg carries its
// own [sinkMode]. The user replacer still runs once upstream in the fan-out,
// so every leg sees identical attributes; only classification is per-leg.
func classifyingHandler(inner slog.Handler, mode sinkMode, pii PIIMode, rec *violationRecorder) slog.Handler {
	return &classifier{inner: inner, mode: mode, pii: pii, rec: rec}
}

type classifier struct {
	inner slog.Handler
	mode  sinkMode
	pii   PIIMode
	rec   *violationRecorder
}

func (c *classifier) Enabled(ctx context.Context, level slog.Level) bool {
	return c.inner.Enabled(ctx, level)
}

func (c *classifier) Handle(ctx context.Context, record slog.Record) error {
	classified := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	record.Attrs(func(a slog.Attr) bool {
		if out, keep := c.classifyAttr(nil, a); keep {
			classified.AddAttrs(out)
		}
		return true
	})
	return c.inner.Handle(ctx, classified)
}

// classifyAttr classifies a single attribute at the given group path,
// recursing into groups so the effective dotted key is used for every leaf.
// It reports whether the attribute survives classification.
func (c *classifier) classifyAttr(groups []string, a slog.Attr) (slog.Attr, bool) {
	a.Value = a.Value.Resolve()
	if a.Value.Kind() == slog.KindGroup {
		path := groups
		if a.Key != "" {
			path = make([]string, len(groups)+1)
			copy(path, groups)
			path[len(groups)] = a.Key
		}
		members := a.Value.Group()
		kept := make([]slog.Attr, 0, len(members))
		for _, m := range members {
			if out, keep := c.classifyAttr(path, m); keep {
				kept = append(kept, out)
			}
		}
		if len(kept) == 0 {
			return slog.Attr{}, false
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(kept...)}, true
	}
	out := classify(c.mode, c.pii, c.rec, groups, a)
	if out.Equal(slog.Attr{}) || out.Key == "" {
		return slog.Attr{}, false
	}
	return out, true
}

func (c *classifier) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &classifier{inner: c.inner.WithAttrs(attrs), mode: c.mode, pii: c.pii, rec: c.rec}
}

func (c *classifier) WithGroup(name string) slog.Handler {
	return &classifier{inner: c.inner.WithGroup(name), mode: c.mode, pii: c.pii, rec: c.rec}
}
