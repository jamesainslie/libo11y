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
