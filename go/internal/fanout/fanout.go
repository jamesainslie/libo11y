// Package fanout implements the libo11y log pipeline core: a slog.Handler
// that resolves attribute groups itself, applies a uniform attribute
// replacer, injects trace correlation attributes at the top level, and
// dispatches the resulting flattened records to every configured sink.
//
// Owning group resolution (rather than delegating WithAttrs/WithGroup to
// each sink) is what guarantees three properties no sink can provide alone:
// correlation attributes stay top-level even inside open groups, the user
// replacer sees identical attributes on every sink, and all sinks emit
// structurally identical records; per-sink confidentiality redaction runs in
// each leg's classifier.
package fanout

import (
	"context"
	"errors"
	"log/slog"

	"go.opentelemetry.io/otel/trace"
)

// Attribute keys for trace correlation, injected at the top level of every
// record emitted inside a valid span context.
const (
	TraceIDKey = "trace_id"
	SpanIDKey  = "span_id"
)

// Correlate wraps a sink so every record emitted inside a valid span
// context is prefixed with top-level trace_id and span_id attributes.
//
// It is intended for sinks that receive pre-flattened records from a
// Handler (which never calls WithAttrs or WithGroup on its legs); sinks
// that derive correlation natively from the context, such as the OTLP
// bridge, must not be wrapped or they would carry the identifiers twice.
func Correlate(sink slog.Handler) slog.Handler {
	return correlated{sink: sink}
}

type correlated struct {
	sink slog.Handler
}

func (c correlated) Enabled(ctx context.Context, level slog.Level) bool {
	return c.sink.Enabled(ctx, level)
}

func (c correlated) Handle(ctx context.Context, record slog.Record) error {
	spanCtx := trace.SpanContextFromContext(ctx)
	if !spanCtx.IsValid() {
		return c.sink.Handle(ctx, record)
	}
	prefixed := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	prefixed.AddAttrs(
		slog.String(TraceIDKey, spanCtx.TraceID().String()),
		slog.String(SpanIDKey, spanCtx.SpanID().String()),
	)
	record.Attrs(func(a slog.Attr) bool {
		prefixed.AddAttrs(a)
		return true
	})
	return c.sink.Handle(ctx, prefixed)
}

func (c correlated) WithAttrs(attrs []slog.Attr) slog.Handler {
	return correlated{sink: c.sink.WithAttrs(attrs)}
}

func (c correlated) WithGroup(name string) slog.Handler {
	return correlated{sink: c.sink.WithGroup(name)}
}

// ReplaceFunc rewrites or drops a leaf attribute. groups is the path of
// group names enclosing the attribute. Returning a zero Attr drops it.
type ReplaceFunc func(groups []string, attr slog.Attr) slog.Attr

type forceKey struct{}

// WithForce marks ctx so records emitted with it bypass every level gate:
// the Handler reports Enabled for any level and dispatches to all sinks
// regardless of their own gates. Used for records that must always emit,
// such as audit events and the startup canary.
func WithForce(ctx context.Context) context.Context {
	return context.WithValue(ctx, forceKey{}, true)
}

func isForced(ctx context.Context) bool {
	forced, ok := ctx.Value(forceKey{}).(bool)
	return ok && forced
}

// Config assembles a Handler.
type Config struct {
	// Legs are the sinks that receive flattened records.
	Legs []slog.Handler
	// Level gates all sinks. Nil means slog.LevelInfo.
	Level slog.Leveler
	// Replace, if non-nil, is applied to every leaf event attribute.
	// Correlation attributes are exempt.
	Replace ReplaceFunc
}

// Handler is the fan-out log handler. It is immutable; WithAttrs and
// WithGroup return derived handlers sharing the sinks.
type Handler struct {
	legs    []slog.Handler
	level   slog.Leveler
	replace ReplaceFunc

	prefix []slog.Attr // processed attrs added before any group was opened
	frames []frame     // open groups, outermost first
}

type frame struct {
	name  string
	attrs []slog.Attr
}

// New builds a Handler from cfg.
func New(cfg Config) *Handler {
	return &Handler{
		legs:    cfg.Legs,
		level:   cfg.Level,
		replace: cfg.Replace,
	}
}

// Enabled reports whether records at level should be emitted. Records in a
// [WithForce] context are always enabled.
func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	if isForced(ctx) {
		return true
	}
	minLevel := slog.LevelInfo
	if h.level != nil {
		minLevel = h.level.Level()
	}
	return level >= minLevel
}

// WithAttrs returns a handler whose records carry attrs inside the
// currently open groups.
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	processed := h.processAttrs(attrs)
	if len(processed) == 0 {
		return h
	}
	derived := h.clone()
	if len(derived.frames) == 0 {
		derived.prefix = append(derived.prefix, processed...)
		return derived
	}
	last := &derived.frames[len(derived.frames)-1]
	last.attrs = append(last.attrs, processed...)
	return derived
}

// WithGroup returns a handler that nests subsequent attributes under name.
func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	derived := h.clone()
	derived.frames = append(derived.frames, frame{name: name})
	return derived
}

// Handle flattens the record and dispatches it to every enabled sink.
func (h *Handler) Handle(ctx context.Context, record slog.Record) error {
	recordAttrs := make([]slog.Attr, 0, record.NumAttrs())
	record.Attrs(func(a slog.Attr) bool {
		recordAttrs = append(recordAttrs, a)
		return true
	})
	recordAttrs = h.processAttrs(recordAttrs)

	out := make([]slog.Attr, 0, len(h.prefix)+len(recordAttrs))
	out = append(out, h.prefix...)
	out = append(out, h.foldFrames(recordAttrs)...)

	flat := slog.NewRecord(record.Time, record.Level, record.Message, record.PC)
	flat.AddAttrs(out...)

	forced := isForced(ctx)
	var errs []error
	for _, leg := range h.legs {
		if !forced && !leg.Enabled(ctx, record.Level) {
			continue
		}
		if err := leg.Handle(ctx, flat.Clone()); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (h *Handler) clone() *Handler {
	derived := *h
	derived.prefix = append([]slog.Attr(nil), h.prefix...)
	derived.frames = make([]frame, len(h.frames))
	for i, f := range h.frames {
		derived.frames[i] = frame{
			name:  f.name,
			attrs: append([]slog.Attr(nil), f.attrs...),
		}
	}
	return &derived
}

// foldFrames nests the open groups (with their accumulated attributes plus
// the record's attributes innermost) into group-valued attributes, eliding
// groups that end up empty.
func (h *Handler) foldFrames(recordAttrs []slog.Attr) []slog.Attr {
	if len(h.frames) == 0 {
		return recordAttrs
	}
	nested := recordAttrs
	for i := len(h.frames) - 1; i >= 0; i-- {
		contents := make([]slog.Attr, 0, len(h.frames[i].attrs)+len(nested))
		contents = append(contents, h.frames[i].attrs...)
		contents = append(contents, nested...)
		if len(contents) == 0 {
			nested = nil
			continue
		}
		nested = []slog.Attr{{
			Key:   h.frames[i].name,
			Value: slog.GroupValue(contents...),
		}}
	}
	return nested
}

// processAttrs resolves, filters, and replaces attributes at the current
// group path per the slog.Handler contract: zero attrs are dropped, empty
// keyed non-groups are dropped, empty-keyed groups are inlined, and empty
// groups are elided.
func (h *Handler) processAttrs(attrs []slog.Attr) []slog.Attr {
	return h.processAttrsAt(h.groupPath(), attrs)
}

func (h *Handler) groupPath() []string {
	if len(h.frames) == 0 {
		return nil
	}
	path := make([]string, len(h.frames))
	for i, f := range h.frames {
		path[i] = f.name
	}
	return path
}

func (h *Handler) processAttrsAt(path []string, attrs []slog.Attr) []slog.Attr {
	out := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		a.Value = a.Value.Resolve()
		if a.Equal(slog.Attr{}) {
			continue
		}
		// trace_id and span_id are reserved at the top level: only the
		// correlation layer may write them. Dropping user-supplied ones
		// prevents duplicate JSON keys that shadow the genuine identity
		// at query time.
		if len(path) == 0 && (a.Key == TraceIDKey || a.Key == SpanIDKey) {
			continue
		}
		if a.Value.Kind() == slog.KindGroup {
			// Inlined (empty-keyed) groups do not contribute to the group
			// path, matching ReplaceAttr semantics in the standard library.
			// The copy also prevents sibling groups from aliasing one
			// backing array.
			memberPath := path
			if a.Key != "" {
				memberPath = make([]string, len(path)+1)
				copy(memberPath, path)
				memberPath[len(path)] = a.Key
			}
			members := h.processAttrsAt(memberPath, a.Value.Group())
			switch {
			case len(members) == 0:
				// Elide empty groups.
			case a.Key == "":
				// Inline members of empty-keyed groups.
				out = append(out, members...)
			default:
				out = append(out, slog.Attr{Key: a.Key, Value: slog.GroupValue(members...)})
			}
			continue
		}
		if a.Key == "" {
			continue
		}
		if h.replace != nil {
			a = h.replace(append([]string(nil), path...), a)
			a.Value = a.Value.Resolve()
			if a.Equal(slog.Attr{}) || a.Key == "" {
				continue
			}
		}
		out = append(out, a)
	}
	return out
}
