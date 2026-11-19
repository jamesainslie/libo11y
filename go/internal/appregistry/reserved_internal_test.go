package appregistry

import (
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
