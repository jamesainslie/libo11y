package ops_test

import (
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/ops/internal/pack"
	"github.com/jamesainslie/libo11y/ops/internal/thresholds"
	"github.com/jamesainslie/libo11y/ops/internal/version"
)

// TestGeneratedUpToDate fails when the committed dashboards, rules or
// kustomization differ from what the generator produces, or when a
// generated directory holds a file the generator no longer writes.
func TestGeneratedUpToDate(t *testing.T) {
	arts, err := pack.Build(thresholds.Default(), version.Version)
	if err != nil {
		t.Fatal(err)
	}
	drift, err := pack.Drift(".", arts)
	if err != nil {
		t.Fatal(err)
	}
	if len(drift) > 0 {
		t.Fatalf("generated files are out of date; run make ops-generate from the repository root:\n  %s", strings.Join(drift, "\n  "))
	}
}
