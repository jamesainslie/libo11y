package specrules_test

import (
	"testing"

	"github.com/jamesainslie/libo11y/go/internal/specrules"
)

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"o11y.outcome":       true,
		"lor.user.id":        true,
		"o11y.rum.view.name": true,
		"o11y.cost_center":   true,
		"outcome":            false, // one segment
		"o11y.Outcome":       false,
		"o11y..outcome":      false,
		"o11y.outcome_":      false,
		"o11y.2xx":           false,
		"o11y.rum.view-name": false,
	} {
		if got := specrules.ValidName(name); got != want {
			t.Errorf("ValidName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestClasses(t *testing.T) {
	for _, c := range []string{"public", "internal", "pii", "secret"} {
		if !specrules.IsSensitivity(c) {
			t.Errorf("IsSensitivity(%q) = false", c)
		}
	}
	for _, c := range []string{"", "PII", "confidential"} {
		if specrules.IsSensitivity(c) {
			t.Errorf("IsSensitivity(%q) = true", c)
		}
	}
	for _, c := range []string{"enum", "bounded", "unbounded"} {
		if !specrules.IsCardinality(c) {
			t.Errorf("IsCardinality(%q) = false", c)
		}
	}
	for _, c := range []string{"", "high", "Enum"} {
		if specrules.IsCardinality(c) {
			t.Errorf("IsCardinality(%q) = true", c)
		}
	}
}
