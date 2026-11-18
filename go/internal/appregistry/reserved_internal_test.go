package appregistry

import (
	"os"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// TestReservedNamespacesMatchSemconvPin pins reservedNamespaces to the
// semconv release the spec registry pins, so a semconv bump cannot land
// without a review of the reserved list.
func TestReservedNamespacesMatchSemconvPin(t *testing.T) {
	raw, err := os.ReadFile("../../../spec/registry/manifest.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		SemconvVersion string `yaml:"semconv_version"`
	}
	if err := yaml.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.SemconvVersion != reservedSemconvVersion {
		t.Errorf("manifest pins semconv %s but reservedNamespaces reflects %s: review reservedNamespaces for the new semconv release, then update the constant",
			manifest.SemconvVersion, reservedSemconvVersion)
	}
}

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
