package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"time"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
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
// below it are not dropped. On an inert handle (see [SDK]) Event does
// nothing.
func (s *SDK) Event(ctx context.Context, name string, attrs ...slog.Attr) {
	if !s.live() {
		return
	}
	// Delivery is best effort for application events: Event has no error
	// return, and a synchronously rejecting sink is caught once, at Setup,
	// by the startup canary.
	_ = s.emitEvent(ctx, slog.LevelInfo, name, attrs)
}

// emitEvent is the structural force-emit path shared by Event, the startup
// summary, and, later, app-event registration and the log sampler. It
// builds the named record and force-emits it through the handler so the
// record is exempt from level gating by construction, not by name matching
// (no log sampler exists yet). The exemption is the ForceEmit marker on the
// context; a bare record carrying event.name without it stays subject to
// the level gate. The event.name attribute is reserved on the context, so
// the handler writes it after it has flattened inline groups and run the
// attribute replacer, and neither can add a second name or change this one.
// The handler's error is returned so the startup summary can serve as the
// initialization canary.
func (s *SDK) emitEvent(ctx context.Context, level slog.Level, name string, attrs []slog.Attr) error {
	record := slog.NewRecord(time.Now(), level, name, 0)
	record.AddAttrs(eventAttrs(attrs)...)
	ctx = fanout.WithReserved(ForceEmit(ctx), slog.String(spec.EventNameKey, name))
	return s.handler.Handle(ctx, record)
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

// errorType is the error.type of an event: the Go type of the error that
// failed. fmt.Errorf and errors.Join wrap that error in types of their own,
// which say nothing about the failure, so errorType looks through each one
// that holds exactly one error. A wrapper holding several stays as it is,
// and so does a wrapper type from any other package, such as *url.Error,
// which is itself the type of the failure.
func errorType(err error) string {
	for err != nil {
		inner := soleWrapped(err)
		if inner == nil {
			return fmt.Sprintf("%T", err)
		}
		err = inner
	}
	return ""
}

// soleWrapped returns the one error err wraps when err is a wrapper made by
// the fmt or errors package, and nil otherwise.
func soleWrapped(err error) error {
	t := reflect.TypeOf(err)
	if t.Kind() == reflect.Pointer {
		t = t.Elem() // a pointer type has no package of its own
	}
	if pkg := t.PkgPath(); pkg != "fmt" && pkg != "errors" {
		return nil
	}
	switch w := err.(type) { //nolint:errorlint // the walk visits each level of the tree itself
	case interface{ Unwrap() error }:
		return w.Unwrap()
	case interface{ Unwrap() []error }:
		if inner := w.Unwrap(); len(inner) == 1 {
			return inner[0]
		}
	}
	return nil
}
