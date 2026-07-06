package o11y

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jamesainslie/libo11y/go/spec"
)

// Event emits a contract-bearing event: a log record identified by name,
// exempt from level gating and sampling (via force-emit), correlated to the
// active span. Events are the schema'd, dashboard-and-audit-facing records
// the specification distinguishes from free-form messages.
//
//	sdk.Event(ctx, spec.EventRequestSummary,
//		slog.String("http.request.method", "GET"),
//		spec.OutcomeValue(spec.OutcomeSuccess),
//	)
//
// The name travels as the event.name attribute, the convention-sanctioned
// carrier until the log bridge can set the top-level EventName field
// directly; the API is unchanged by that future migration. Events at or
// above the configured level also record normally; force-emit ensures those
// below it are not dropped.
func (s *SDK) Event(ctx context.Context, name string, attrs ...slog.Attr) {
	record := slog.NewRecord(time.Now(), slog.LevelInfo, name, 0)
	record.AddAttrs(append([]slog.Attr{slog.String(spec.EventNameKey, name)}, attrs...)...)
	_ = s.handler.Handle(ForceEmit(ctx), record)
}

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
