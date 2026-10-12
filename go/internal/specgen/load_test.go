package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeRegistry builds a throwaway repository root holding a manifest and
// the given registry files, so load() is tested against real files.
func writeRegistry(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	reg := filepath.Join(root, "spec", "registry")
	if err := os.MkdirAll(reg, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := "name: test\nschema_url: https://jamesainslie.dev/schemas/libo11y/1.0.0\nsemconv_version: 1.41.0\n"
	if err := os.WriteFile(filepath.Join(reg, "manifest.yaml"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(reg, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// TestLoadVersions pins that the manifest yields both version constants the
// generated artifacts embed.
func TestLoadVersions(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatalf("loading registry: %v", err)
	}
	if m.specVersion != "1.0.0" {
		t.Errorf("specVersion = %q, want %q", m.specVersion, "1.0.0")
	}
	if m.semconvVersion != "1.41.0" {
		t.Errorf("semconvVersion = %q, want %q", m.semconvVersion, "1.41.0")
	}
}

// TestLoadRejectsUnknownFields pins strict decoding: a misspelled registry
// key is a load error, never a silently ignored field.
func TestLoadRejectsUnknownFields(t *testing.T) {
	root := writeRegistry(t, map[string]string{"a.yaml": `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.thing
        type: string
        requirement_lvl: required
`})
	if _, err := load(root); err == nil || !strings.Contains(err.Error(), "requirement_lvl") {
		t.Fatalf("load error = %v, want an unknown-field error naming requirement_lvl", err)
	}
}
