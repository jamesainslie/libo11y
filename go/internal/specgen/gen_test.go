package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// TestEventTemplatesGenerated pins that a required template attribute on an
// event is emitted as a template requirement, not as a literal key.
func TestEventTemplatesGenerated(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genTables(m)
	if err != nil {
		t.Fatal(err)
	}
	want := `"o11y.telemetry.configured": {RequiredTemplates: []attribute.Key{"o11y.config"}}`
	if !strings.Contains(src, want) {
		t.Errorf("generated tables missing %s", want)
	}
	if docRow := "| `o11y.telemetry.configured` | `o11y.config.<key>` |"; !strings.Contains(genDocs(m), docRow) {
		t.Errorf("generated docs missing %s", docRow)
	}
}

// TestGeneratedArtifactsMatchCommitted is the golden test: every committed
// generated artifact equals what the generator renders from the committed
// registry, so a stale artifact fails go test, not only make spec-drift.
func TestGeneratedArtifactsMatchCommitted(t *testing.T) {
	root := "../../.."
	m, err := load(root)
	if err != nil {
		t.Fatal(err)
	}
	outputs, err := render(m)
	if err != nil {
		t.Fatal(err)
	}
	for rel, want := range outputs {
		got, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatalf("%s: %v (run make spec-generate)", rel, err)
		}
		if string(got) != want {
			t.Errorf("%s is stale; run make spec-generate", rel)
		}
	}
}

func TestGeneratorRejectsBadEnums(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		want string
	}{
		{"duplicate value", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          members:
            - {id: a, value: "x", stability: development}
            - {id: b, value: "x", stability: development}
`, "libo11y_enum_duplicate_value"},
		{"member value whitespace", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          members:
            - {id: a, value: " x", stability: development}
`, "libo11y_enum_value_whitespace"},
		{"annotation enum whitespace", `
groups:
  - id: libo11y.resource.tier0
    type: attribute_group
    attributes:
      - ref: deployment.environment.name
        annotations: {o11y.enum: "production, staging"}
`, "libo11y_enum_value_whitespace"},
		{"annotation enum duplicate", `
groups:
  - id: libo11y.resource.tier0
    type: attribute_group
    attributes:
      - ref: deployment.environment.name
        annotations: {o11y.enum: "production,production"}
`, "libo11y_enum_duplicate_value"},
		{"name collision", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.http.route
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
  - id: libo11y.resource.tier1
    type: attribute_group
    attributes:
      - ref: http.route
        annotations: {o11y.gen: copy}
`, "libo11y_go_name_collision"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			groups := parseGroups(t, tc.doc)
			if vs := checkGroups(groups, buildIndex(groups)); !hasRule(vs, tc.want) {
				t.Errorf("rule %s not raised; got %v", tc.want, violationIDs(vs))
			}
		})
	}
}

func TestHeaderGroupsImports(t *testing.T) {
	var b strings.Builder
	header(&b, "spec", &model{specVersion: "1.0.0"}, "go.opentelemetry.io/otel/attribute", "strings")
	src := b.String()
	if !strings.Contains(src, "\"strings\"\n\n\t\"go.opentelemetry.io/otel/attribute\"") {
		t.Errorf("imports not grouped stdlib-first:\n%s", src)
	}
}

func TestTierOrderIsNumeric(t *testing.T) {
	got := sortTiers([]string{"tier10", "tier2", "tier0", "forbidden"})
	want := []string{"tier0", "tier2", "tier10", "forbidden"}
	if !slices.Equal(got, want) {
		t.Errorf("sortTiers = %v, want %v", got, want)
	}
}

// TestSensitivityZeroValueIsUnclassified pins that the zero value of the
// generated Sensitivity type is Unclassified, so a key missing from
// SensitivityOf is never mistaken for an explicitly public one.
func TestSensitivityZeroValueIsUnclassified(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genTables(m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(src, "Unclassified Sensitivity = iota") {
		t.Errorf("Sensitivity zero value is not Unclassified:\n%s", src[:min(len(src), 600)])
	}
}

// TestRenderRejectsUnknownSensitivity pins that an unknown class is an
// error rather than a silent fallback to some other class.
func TestRenderRejectsUnknownSensitivity(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m.classByName["o11y.bogus"] = "radioactive"
	if _, err := render(m); err == nil || !strings.Contains(err.Error(), "radioactive") {
		t.Fatalf("render error = %v, want an unknown-class error naming radioactive", err)
	}
}

// TestGenerateRefusesInvalidRegistry pins that generate mode validates the
// registry first and writes nothing when any policy rule fails.
func TestGenerateRefusesInvalidRegistry(t *testing.T) {
	root := writeRegistry(t, map[string]string{"a.yaml": `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.thing
        type: string
`})
	var stderr bytes.Buffer
	if err := run(root, false, &stderr); err == nil {
		t.Fatal("run succeeded on a registry with violations")
	}
	if !strings.Contains(stderr.String(), "libo11y_sensitivity_missing") {
		t.Errorf("violations not reported; stderr = %q", stderr.String())
	}
	for _, rel := range []string{"go/spec/spec.go", "go/internal/spectables/tables.go", "docs/taxonomy/resource.md"} {
		if _, err := os.Stat(filepath.Join(root, rel)); !os.IsNotExist(err) {
			t.Errorf("%s written despite violations (stat err %v)", rel, err)
		}
	}
}
