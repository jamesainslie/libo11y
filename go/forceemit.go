package o11y

import (
	"context"

	"github.com/jamesainslie/libo11y/go/internal/fanout"
)

// ForceEmit marks ctx so log records emitted with it bypass every level
// gate: the SDK's handler accepts any level and delivers the record to all
// sinks regardless of their own gates. Use it for records that must always
// be emitted, such as audit and security events:
//
//	slog.InfoContext(o11y.ForceEmit(ctx), "user role changed",
//		"actor", actorID, "subject", subjectID, "role", role)
//
// Force-emit affects only level gating. Attribute replacement, redaction,
// and correlation apply unchanged, so a forced record is still protected.
func ForceEmit(ctx context.Context) context.Context {
	return fanout.WithForce(ctx)
}
