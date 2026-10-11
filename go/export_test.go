package o11y

import (
	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// WithSensitivityForTest overlays classification entries for one SDK so
// tests exercise the secret path without mutating the generated table.
func WithSensitivityForTest(table map[attribute.Key]spectables.Sensitivity) Option {
	return func(s *settings) {
		s.sensitivity = func(k attribute.Key) spectables.Sensitivity {
			if v, ok := table[k]; ok {
				return v
			}
			return spectables.SensitivityOf[k]
		}
	}
}
