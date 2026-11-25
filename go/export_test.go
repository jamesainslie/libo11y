package o11y

import (
	"maps"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// WithSensitivityForTest overlays classification entries for one SDK so
// tests exercise the secret path without mutating the generated table. The
// table is copied, so later changes to the caller's map do not affect the SDK.
func WithSensitivityForTest(table map[attribute.Key]spectables.Sensitivity) Option {
	overlay := maps.Clone(table)
	return func(s *settings) {
		s.sensitivity = func(k attribute.Key) spectables.Sensitivity {
			if v, ok := overlay[k]; ok {
				return v
			}
			return spectables.SensitivityOf[k]
		}
	}
}

// WithBaggageEgressForTest sets the baggage egress predicate for one SDK.
func WithBaggageEgressForTest(allow func(string) bool) Option {
	return func(s *settings) { s.baggageAllow = allow }
}

// SanitizeEndpoint exposes sanitizeEndpoint to the external test package.
var SanitizeEndpoint = sanitizeEndpoint

// MaxCompositeDepth and CompositeWalkBudget expose the composite walk's
// bounds so tests can build values just past them.
const (
	MaxCompositeDepth   = maxCompositeDepth
	CompositeWalkBudget = compositeWalkBudget
)

// ExportWindowOpen reports whether a Shutdown or ForceFlush call is
// recording the export failures of signal ("traces" or "logs") right now.
func (s *SDK) ExportWindowOpen(signal string) bool {
	f := s.spanFailures
	if signal == "logs" {
		f = s.logFailures
	}
	w := f.windows.Load()
	return w != nil && len(*w) > 0
}
