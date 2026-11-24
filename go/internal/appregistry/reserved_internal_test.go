package appregistry

import (
	"slices"
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// TestReservedNamespacesCoverSpecTable pins the invariant the runtime
// sensitivity lookup relies on: every key the specification classifies sits
// under a reserved namespace, so no valid application registry can declare a
// key whose class the specification table would override.
func TestReservedNamespacesCoverSpecTable(t *testing.T) {
	for key := range spectables.SensitivityOf {
		root, _, _ := strings.Cut(string(key), ".")
		if !reservedNamespaces[root] {
			t.Errorf("spec key %s is under namespace %q, which an application registry may claim", key, root)
		}
	}
}

// TestReservedNamespacesSorted pins the exported list: every reserved
// namespace, once, in sorted order, so generated code is stable.
func TestReservedNamespacesSorted(t *testing.T) {
	got := ReservedNamespaces()
	if len(got) != len(reservedNamespaces) {
		t.Fatalf("ReservedNamespaces() has %d entries, want %d", len(got), len(reservedNamespaces))
	}
	if !slices.IsSorted(got) {
		t.Errorf("ReservedNamespaces() is not sorted: %v", got)
	}
	for _, ns := range []string{"o11y", "otel", "http"} {
		if !slices.Contains(got, ns) {
			t.Errorf("ReservedNamespaces() lacks %q", ns)
		}
	}
}
