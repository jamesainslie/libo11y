package o11y_test

import (
	"context"
	"log/slog"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ytest"
	"github.com/jamesainslie/libo11y/go/spec"
)

// TestBareEventNameIsNotForceExempt locks the structural nature of the event
// exemption: a record carrying event.name but emitted through the raw logger
// WITHOUT the force marker must still obey the level gate. The exemption comes
// from the structural force-emit path in Event, not from name matching.
func TestBareEventNameIsNotForceExempt(t *testing.T) {
	rec := o11ytest.Start(t, o11y.WithLogLevel(slog.LevelWarn))

	// Emit an INFO record with event.name via the raw logger (not sdk.Event):
	// no force marker, so the WARN level gate must drop it.
	rec.SDK.Logger().LogAttrs(context.Background(), slog.LevelInfo, "x",
		slog.String(spec.EventNameKey, "app.thing"))

	if got := len(rec.Logs()); got != 0 {
		t.Fatalf("bare event-name record was emitted below level: %d", got)
	}
}
