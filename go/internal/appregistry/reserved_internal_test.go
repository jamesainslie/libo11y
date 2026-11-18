package appregistry

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
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
