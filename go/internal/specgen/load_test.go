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
	manifest := "name: test\nschema_url: https://schemas.o11y.ing/libo11y/1.0.0\nsemconv_version: 1.41.0\n"
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

// TestLoadRejectsLaxNestedFields pins that strict decoding reaches inside
// the nested mappings too: enum type specs, enum members, and deprecation
// records. Each error names the field and carries the rule ID.
func TestLoadRejectsLaxNestedFields(t *testing.T) {
	cases := map[string]struct{ doc, field string }{
		"member field": {`
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          members:
            - {id: alpha, vaule: "alpha", stability: development}
`, "vaule"},
		"type key": {`
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          memebrs:
            - {id: alpha, value: "alpha", stability: development}
`, "memebrs"},
		"deprecation key": {`
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.old
        type: string
        deprecated: {reason: renamed, renamed_too: o11y.new}
`, "renamed_too"},
		"top-level field": {`
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.thing
        type: string
        requirement_lvl: required
`, "requirement_lvl"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := load(writeRegistry(t, map[string]string{"a.yaml": tc.doc}))
			if err == nil {
				t.Fatalf("load accepted a registry with unknown field %s", tc.field)
			}
			for _, want := range []string{"libo11y_registry_unknown_field:", tc.field} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("load error = %v, want it to contain %q", err, want)
				}
			}
		})
	}
}

// TestLoadRejectsEnumTypeWithoutMembers pins that a mapping type must
// declare members; an empty spec would silently generate a plain string.
func TestLoadRejectsEnumTypeWithoutMembers(t *testing.T) {
	root := writeRegistry(t, map[string]string{"a.yaml": `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type: {members: []}
`})
	if _, err := load(root); err == nil {
		t.Fatal("load accepted an enum type with no members")
	}
}

// TestLoadAcceptsEmptyFiles pins that an empty or comment-only registry
// file contributes no groups rather than failing the load.
func TestLoadAcceptsEmptyFiles(t *testing.T) {
	root := writeRegistry(t, map[string]string{
		"empty.yaml":   "",
		"comment.yaml": "# placeholder for future groups\n",
	})
	m, err := load(root)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(m.groups) != 0 {
		t.Errorf("groups = %d, want 0", len(m.groups))
	}
}

// TestLoadRejectsMultipleDocuments pins that a second YAML document in one
// file is an error, never silently ignored.
func TestLoadRejectsMultipleDocuments(t *testing.T) {
	root := writeRegistry(t, map[string]string{"a.yaml": "groups: []\n---\ngroups:\n  - id: registry.o11y\n    type: attribute_group\n"})
	if _, err := load(root); err == nil {
		t.Fatal("load accepted a file with two YAML documents")
	}
}
