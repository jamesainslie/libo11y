package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/jamesainslie/libo11y/go/spec"
)

// Event emits a contract-bearing event: a log record identified by name,
// exempt from level gating (via force-emit), correlated to the active span.
// Events are the schema'd, dashboard-and-audit-facing records the
// specification distinguishes from free-form messages. Any name is
// accepted; the names registered in the specification carry a contract.
//
//	sdk.Event(ctx, spec.EventRequestSummary,
//		slog.String("http.request.method", "GET"),
//		slog.String(string(spec.OutcomeKey), string(spec.OutcomeSuccess)),
//	)
//
// The name travels as the event.name attribute, the convention-sanctioned
// carrier until the log bridge can set the top-level EventName field
// directly; the API is unchanged by that future migration. Events at or
// above the configured level also record normally; force-emit ensures those
// below it are not dropped.
func (s *SDK) Event(ctx context.Context, name string, attrs ...slog.Attr) {
	// Delivery is best effort for application events: Event has no error
	// return, and a synchronously rejecting sink is caught once, at Setup,
	// by the startup canary.
	_ = s.emitEvent(ctx, slog.LevelInfo, name, attrs)
}

// emitEvent is the structural force-emit path shared by Event, the startup
// summary, and, later, app-event registration and the log sampler. It
// builds the named record, stamps the event.name attribute, and force-emits
// through the handler so the record is exempt from level gating by
// construction, not by name matching (no log sampler exists yet). The
// exemption is the ForceEmit marker on the context; a bare record carrying
// event.name without it stays subject to the level gate. The handler's error is returned so
// the startup summary can serve as the initialization canary.
func (s *SDK) emitEvent(ctx context.Context, level slog.Level, name string, attrs []slog.Attr) error {
	attrs = eventAttrs(attrs)
	record := slog.NewRecord(time.Now(), level, name, 0)
	record.AddAttrs(append([]slog.Attr{slog.String(spec.EventNameKey, name)}, attrs...)...)
	return s.handler.Handle(ForceEmit(ctx), record)
}

// eventAttrs returns a copy of a caller's event attributes without any
// event.name (the library sets it, never callers) and without duplicate
// keys. The caller's slice is not modified.
func eventAttrs(attrs []slog.Attr) []slog.Attr {
	return dedupeAttrs(slices.DeleteFunc(slices.Clone(attrs), func(a slog.Attr) bool {
		return a.Key == spec.EventNameKey
	}))
}

// dedupeAttrs keeps the last occurrence of each key, preserving the order of
// those survivors, so later attributes win without emitting duplicate keys.
// Empty-key attributes (inline groups) are distinct by definition and always
// pass through. Small inputs, the common case, are scanned without a map.
func dedupeAttrs(attrs []slog.Attr) []slog.Attr {
	out := make([]slog.Attr, 0, len(attrs))
	if len(attrs) <= smallAttrsLen {
		for i, a := range attrs {
			later := slices.ContainsFunc(attrs[i+1:], func(b slog.Attr) bool { return b.Key == a.Key })
			if a.Key == "" || !later {
				out = append(out, a)
			}
		}
		return out
	}
	last := make(map[string]int, len(attrs))
	for i, a := range attrs {
		last[a.Key] = i
	}
	for i, a := range attrs {
		if a.Key == "" || last[a.Key] == i {
			out = append(out, a)
		}
	}
	return out
}

// smallAttrsLen is the attribute count up to which dedupeAttrs scans
// pairwise instead of building a map.
const smallAttrsLen = 8

// emitDropped records the o11y.telemetry.dropped event when a signal fails
// to flush at shutdown, so the loss reaches the surviving sinks (console
// and any extra handlers) rather than passing silently. The OTLP log leg
// may already be down; delivery is best-effort by design.
func (s *SDK) emitDropped(ctx context.Context, signal string, cause error) {
	s.Event(ctx, spec.EventTelemetryDropped,
		slog.String(string(spec.SignalKey), signal),
		slog.String("error.type", errorType(cause)),
	)
}

func errorType(err error) string {
	if err == nil {
		return ""
	}
	return fmt.Sprintf("%T", err)
}
