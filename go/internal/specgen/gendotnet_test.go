package main

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestGenCsSpecAndTables(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	specSrc, err := genCsSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"namespace Libo11y.Spec;",
		"public const string SchemaUrl =",
		"public const string SpecVersion =",
		"public const string SemconvVersion =",
		`public const string EventNameKey = "event.name";`,
		"public static class DeploymentEnvironment",
		`public const string Production = "production";`,
		"public static class Signal",
		`public const string Outcome = "o11y.outcome";`,
		`public const string TelemetryConfigured = "o11y.telemetry.configured";`,
		`public const string SchemaViolations = "o11y.schema.violations";`,
	} {
		if !strings.Contains(specSrc, want) {
			t.Errorf("Spec.g.cs missing %q", want)
		}
	}

	tablesSrc, err := genCsTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"public enum Sensitivity",
		"public static readonly FrozenDictionary<string, ResourceAttr> Resource =",
		"public static readonly ImmutableArray<string> RequiredTier0 =",
		"public static readonly FrozenSet<string> EnvironmentValues =",
		"public static readonly FrozenDictionary<string, Sensitivity> SensitivityOf =",
		"public static readonly FrozenDictionary<string, Cardinality> CardinalityOf =",
		"public static readonly FrozenDictionary<string, string> LegacyKeys =",
		"public static readonly ImmutableArray<string> MetricResourceLabels =",
		"public static readonly FrozenDictionary<string, EventInfo> Events =",
		"public static readonly FrozenDictionary<string, MetricInfo> Metrics =",
		"public static readonly FrozenDictionary<string, ImmutableArray<string>> SpanRequired =",
		"public static readonly FrozenDictionary<string, ImmutableArray<string>> RumSpanRequired =",
		`public const string AppRegistrySchema = "libo11y.app-registry/v1";`,
		"public static readonly FrozenSet<string> AppReservedNamespaces =",
	} {
		if !strings.Contains(tablesSrc, want) {
			t.Errorf("Tables.g.cs missing %q", want)
		}
	}

	goprintSrc := genCsGoPrint()
	if !strings.Contains(goprintSrc, "public static ReadOnlySpan<int> Ranges =>") {
		t.Errorf("GoPrint.g.cs missing Ranges")
	}
}

func TestGenCsRejectsUnknownClasses(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m.cardByName["o11y.bogus"] = "infinite"
	if _, err := genCsTables(m); err == nil || !strings.Contains(err.Error(), "infinite") {
		t.Fatalf("genCsTables error = %v, want unknown cardinality error", err)
	}
}

func TestGenCsRejectsCollidingConstNames(t *testing.T) {
	m := &model{
		specVersion:    "1.2.0",
		schemaURL:      "https://schemas.o11y.ing/libo11y/1.2.0",
		semconvVersion: "1.41.0",
		minted: []attr{
			{ID: "o11y.foo.bar"},
			{ID: "o11y.foo_bar"},
		},
	}
	_, err := genCsSpec(m)
	if !errors.Is(err, errCsName) {
		t.Fatalf("genCsSpec error = %v, want errCsName", err)
	}
}

// csTestModel is a minimal model holding the given minted attributes.
func csTestModel(t *testing.T, minted ...string) *model {
	t.Helper()
	m := &model{
		specVersion:    "1.2.0",
		schemaURL:      "https://schemas.o11y.ing/libo11y/1.2.0",
		semconvVersion: "1.41.0",
		classByName:    map[string]string{},
		cardByName:     map[string]string{},
	}
	for _, src := range minted {
		var a attr
		if err := yaml.Unmarshal([]byte(src), &a); err != nil {
			t.Fatal(err)
		}
		m.minted = append(m.minted, a)
		m.groups = append(m.groups, group{ID: "test", Attributes: []attr{a}})
	}
	return m
}

func TestGenCsRejectsMemberNamedLikeItsType(t *testing.T) {
	m := csTestModel(t, "id: o11y.status\ntype:\n  members:\n    - {id: status, value: status}\n")
	_, err := genCsSpec(m)
	if !errors.Is(err, errCsName) || !strings.Contains(err.Error(), "CS0542") {
		t.Fatalf("genCsSpec error = %v, want errCsName naming CS0542", err)
	}
}

func TestGenCsRejectsConstantNamedLikeItsClass(t *testing.T) {
	m := csTestModel(t, "id: o11y.spec.attributes\ntype: string\n")
	_, err := genCsSpec(m)
	if !errors.Is(err, errCsName) || !strings.Contains(err.Error(), "CS0542") {
		t.Fatalf("genCsSpec error = %v, want errCsName naming CS0542", err)
	}
}

func TestGenCsRejectsConstantNamedLikeAnObjectMember(t *testing.T) {
	m := csTestModel(t, "id: o11y.to_string\ntype: string\n")
	if _, err := genCsSpec(m); !errors.Is(err, errCsName) {
		t.Fatalf("genCsSpec error = %v, want errCsName", err)
	}
}

func TestGenCsRejectsEnumsNamedLikeHandWrittenTypes(t *testing.T) {
	for _, key := range []string{
		"o11y.app_registry",
		"o11y.app_registry_attribute",
		"o11y.app_registry_violation",
		"o11y.compiled_app_registry",
		"o11y.app_registry_parse_exception",
		"o11y.app_registry_validation_exception",
		"o11y.app_registry_validator",
		"o11y.go_quote",
		"o11y.yaml_v3_parser",
		"o11y.frozen_set",
	} {
		t.Run(key, func(t *testing.T) {
			m := csTestModel(t, "id: "+key+"\ntype:\n  members:\n    - {id: one, value: one}\n")
			_, err := genCsSpec(m)
			if !errors.Is(err, errCsName) || !strings.Contains(err.Error(), "collide") {
				t.Fatalf("genCsSpec error = %v, want a collision with a spec type", err)
			}
		})
	}
}

// TestCsReservedTypesCoverHandWrittenTypes fails when a type declared by
// hand in the Libo11y.Spec namespace is missing from csReservedTypes, so a
// generated enum class could never take its name.
func TestCsReservedTypesCoverHandWrittenTypes(t *testing.T) {
	files, err := filepath.Glob("../../../dotnet/src/Libo11y.Spec/*.cs")
	if err != nil || len(files) == 0 {
		t.Fatalf("no hand-written C# files found: %v", err)
	}
	decl := regexp.MustCompile(`(?m)^(?:(?:public|internal|static|sealed|abstract|readonly|partial)\s+)*(?:record\s+struct|record\s+class|record|class|struct|enum|interface)\s+([A-Z][A-Za-z0-9_]*)`)
	found := 0
	for _, file := range files {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, match := range decl.FindAllStringSubmatch(string(src), -1) {
			found++
			if !csReservedTypes[match[1]] {
				t.Errorf("%s declares %s, which csReservedTypes does not reserve", filepath.Base(file), match[1])
			}
		}
	}
	if found < 9 {
		t.Fatalf("found %d hand-written types, want at least 9", found)
	}
}

// TestGenCsDocumentsEveryPublicMember checks that every public declaration
// in the generated C# carries an XML doc comment, so the build, which
// treats CS1591 as an error, cannot break on a new registry entry.
func TestGenCsDocumentsEveryPublicMember(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	specSrc, err := genCsSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	tablesSrc, err := genCsTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for name, src := range map[string]string{"Spec.g.cs": specSrc, "Tables.g.cs": tablesSrc, "GoPrint.g.cs": genCsGoPrint()} {
		lines := strings.Split(src, "\n")
		for i, line := range lines {
			trimmed := strings.TrimSpace(line)
			isDecl := strings.HasPrefix(trimmed, "public ") || strings.HasPrefix(trimmed, "internal ")
			isEnumMember := regexp.MustCompile(`^[A-Z][A-Za-z0-9]*,$`).MatchString(trimmed)
			if !isDecl && !isEnumMember {
				continue
			}
			if i == 0 || !strings.HasPrefix(strings.TrimSpace(lines[i-1]), "///") {
				t.Errorf("%s:%d: %q has no doc comment", name, i+1, trimmed)
			}
		}
	}
	for _, want := range []string{
		"/// <summary>The values of the <c>o11y.outcome</c> attribute.",
		"Sensitivity: public. Cardinality: enum.</summary>\n    public const string Outcome = \"o11y.outcome\";",
	} {
		if !strings.Contains(specSrc, want) {
			t.Errorf("Spec.g.cs missing %q", want)
		}
	}
}

func TestGenCsDocTextIsOneEscapedLine(t *testing.T) {
	m := csTestModel(t, "id: o11y.demo.key\ntype: string\nbrief: |\n  Uses `a<b` & more\n  on two lines\n")
	m.classByName["o11y.demo.key"] = "pii"
	m.cardByName["o11y.demo.key"] = "bounded"
	src, err := genCsSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	want := "    /// <summary>Uses <c>a&lt;b</c> &amp; more on two lines. Sensitivity: pii. Cardinality: bounded.</summary>\n    public const string DemoKey = \"o11y.demo.key\";"
	if !strings.Contains(src, want) {
		t.Errorf("Spec.g.cs missing %q in:\n%s", want, src)
	}
}

func TestGenCsTablesExposeNoArrays(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genCsTables(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(src, "IReadOnlyList") {
		t.Errorf("Tables.g.cs exposes IReadOnlyList, which an array can back")
	}
	for _, line := range strings.Split(src, "\n") {
		if strings.Contains(line, "new string[]") && !strings.Contains(line, "FrozenSet.ToFrozenSet(") {
			t.Errorf("Tables.g.cs exposes a string array: %s", strings.TrimSpace(line))
		}
	}
	if goprint := genCsGoPrint(); strings.Contains(goprint, "public static class") || strings.Contains(goprint, "int[] Ranges") {
		t.Errorf("GoPrint.g.cs exposes its ranges as a public array")
	}
}
