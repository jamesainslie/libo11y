package main

import (
	"bytes"
	"fmt"
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

// TestForbiddenKeysAreNotPublicAPI pins that the forbidden group documents
// keys rather than exporting them: no generated key constant, no resource
// tier, and its own section in the taxonomy docs.
func TestForbiddenKeysAreNotPublicAPI(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	out, err := render(m)
	if err != nil {
		t.Fatal(err)
	}
	specSrc := out["go/spec/spec.go"]
	for _, name := range []string{"HostIPKey", "HostMACKey", "ProcessCommandLineKey", "ProcessCommandArgsKey", "DeviceIDKey"} {
		if strings.Contains(specSrc, name) {
			t.Errorf("forbidden key constant %s is generated into the public spec package", name)
		}
	}
	tables := out["go/internal/spectables/tables.go"]
	if strings.Contains(tables, `Tier: "forbidden"`) {
		t.Error("forbidden keys are listed as a resource tier")
	}
	if !strings.Contains(out["docs/taxonomy/resource.md"], "## Forbidden keys") {
		t.Error("taxonomy docs lack a forbidden-keys section")
	}
	// Every key in the forbidden group, including the secret headers, stays
	// out of the generated constants and in SensitivityOf, which runtime
	// enforcement needs.
	if len(m.forbidden) == 0 {
		t.Fatal("registry has no forbidden keys")
	}
	_, sensitivity, _ := strings.Cut(tables, "var SensitivityOf = ")
	sensitivity, _, _ = strings.Cut(sensitivity, "\n}\n")
	for _, a := range m.forbidden {
		if name := goName(a.name()) + "Key"; strings.Contains(specSrc, name) {
			t.Errorf("forbidden key constant %s is generated into the public spec package", name)
		}
		if want := fmt.Sprintf("%q:", a.name()); !strings.Contains(sensitivity, want) {
			t.Errorf("forbidden key %s missing from SensitivityOf", a.name())
		}
	}
}

// TestSecretHeadersClassified pins that the credential-bearing HTTP header
// keys are classified secret, so the runtime drops them on every signal,
// and that the forbidden-keys docs list them.
func TestSecretHeadersClassified(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"http.request.header.authorization",
		"http.request.header.proxy-authorization",
		"http.request.header.cookie",
		"http.response.header.set-cookie",
	} {
		if got := m.classByName[key]; got != "secret" {
			t.Errorf("%s classified %q, want secret", key, got)
		}
		if got := m.cardByName[key]; got != "unbounded" {
			t.Errorf("%s cardinality %q, want unbounded", key, got)
		}
	}
	if row := "| `http.request.header.authorization` | secret |"; !strings.Contains(genDocs(m), row) {
		t.Errorf("forbidden-keys docs lack the row starting %s", row)
	}
}

// TestLegacyKeysGenerated pins the generated table mapping each key a
// pre-spec release emitted to its spec replacement.
func TestLegacyKeysGenerated(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genTables(m)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(src, "var LegacyKeys = map[string]attribute.Key{") {
		t.Fatal("generated tables lack LegacyKeys")
	}
	for legacy, replacement := range map[string]string{
		"vcs.revision": "vcs.ref.head.revision",
		"vcs.time":     "o11y.build.time",
		"vcs.modified": "o11y.build.modified",
	} {
		if want := fmt.Sprintf("%q: %q,", legacy, replacement); !strings.Contains(src, want) {
			t.Errorf("LegacyKeys lacks %s", want)
		}
	}
}

// TestRegistryTidyUps pins the smaller registry corrections: the
// vcs.modified tombstone shares its replacement's boolean type, container.id
// is generated like the other release-candidate upstream keys, and url.path
// on the wide event is classified.
func TestRegistryTidyUps(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := m.typeByName["o11y.deprecated.vcs.modified"], m.typeByName["o11y.build.modified"]; got != want || got != "boolean" {
		t.Errorf("vcs.modified tombstone type = %q, replacement type = %q, want both boolean", got, want)
	}
	if !slices.Contains(m.copiedRefs(), "container.id") {
		t.Error("container.id is not generated as a copied key like k8s.pod.name")
	}
	if got := m.classByName["url.path"]; got != "internal" {
		t.Errorf("url.path sensitivity = %q, want internal", got)
	}
	if got := m.cardByName["url.path"]; got != "unbounded" {
		t.Errorf("url.path cardinality = %q, want unbounded", got)
	}
}

// TestEveryForbiddenGroupStaysOutOfTiers pins that the generator and the
// checker recognize forbidden groups the same way: a group whose ID ends in
// .forbidden is documented as forbidden keys, never published as a tier.
func TestEveryForbiddenGroupStaysOutOfTiers(t *testing.T) {
	root := writeRegistry(t, map[string]string{"a.yaml": `
groups:
  - id: libo11y.resource.pci.forbidden
    type: attribute_group
    attributes:
      - ref: card.number
        requirement_level: opt_in
        brief: Card numbers are cardholder data.
        annotations: {o11y.sensitivity: secret, o11y.cardinality: unbounded}
`})
	m, err := load(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.tiers) != 0 || len(m.tierOrder) != 0 {
		t.Errorf("forbidden group published as a tier: %v", m.tierOrder)
	}
	if len(m.forbidden) != 1 || m.forbidden[0].name() != "card.number" {
		t.Errorf("forbidden = %v, want card.number", m.forbidden)
	}
}
