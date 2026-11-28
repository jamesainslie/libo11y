package main

import (
	"errors"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestGenJavaSpecAndTables(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	specSrc, err := genJavaSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"package ing.o11y.libo11y.spec.generated;",
		"public static final String SCHEMA_URL =",
		"public static final String SPEC_VERSION =",
		"public static final String SEMCONV_VERSION =",
		`public static final String EVENT_NAME_KEY = "event.name";`,
		"public static final class DeploymentEnvironment",
		`public static final String PRODUCTION = "production";`,
		"public enum Signal implements WireValue {",
		`public static final Key<Outcome> OUTCOME = key("o11y.outcome", ValueType.STRING, Outcome.class);`,
		`public static final String TELEMETRY_CONFIGURED = "o11y.telemetry.configured";`,
		`public static final String SCHEMA_VIOLATIONS = "o11y.schema.violations";`,
	} {
		if !strings.Contains(specSrc, want) {
			t.Errorf("Spec.java missing %q", want)
		}
	}

	tablesSrc, err := genJavaTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"public enum Sensitivity",
		"public static final Map<String, ResourceAttr> RESOURCE =",
		"public static final List<String> REQUIRED_TIER0 =",
		"public static final Set<String> ENVIRONMENT_VALUES =",
		"public static final Map<String, Sensitivity> SENSITIVITY_OF =",
		"public static final Map<String, Cardinality> CARDINALITY_OF =",
		"public static final Map<String, String> LEGACY_KEYS =",
		"public static final List<String> METRIC_RESOURCE_LABELS =",
		"public static final Map<String, EventInfo> EVENTS =",
		"public static final Map<String, MetricInfo> METRICS =",
		"public static final Map<String, List<String>> SPAN_REQUIRED =",
		"public static final Map<String, List<String>> RUM_SPAN_REQUIRED =",
		`public static final String APP_REGISTRY_SCHEMA = "libo11y.app-registry/v1";`,
		"public static final Set<String> APP_RESERVED_NAMESPACES =",
	} {
		if !strings.Contains(tablesSrc, want) {
			t.Errorf("SpecTables.java missing %q", want)
		}
	}

	goprintSrc := genJavaGoPrint()
	if !strings.Contains(goprintSrc, "public static final int[] RANGES = new int[] {") {
		t.Errorf("GoPrintRanges.java missing RANGES")
	}
}

func TestGenJavaRejectsUnknownClasses(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m.cardByName["o11y.bogus"] = "infinite"
	if _, err := genJavaTables(m); err == nil || !strings.Contains(err.Error(), "infinite") {
		t.Fatalf("genJavaTables error = %v, want unknown cardinality error", err)
	}
}

func TestGenJavaRejectsCollidingConstNames(t *testing.T) {
	m := &model{
		specVersion:    "1.3.0",
		schemaURL:      "https://schemas.o11y.ing/libo11y/1.3.0",
		semconvVersion: "1.41.0",
		minted: []attr{
			{ID: "o11y.foo.bar"},
			{ID: "o11y.foo_bar"},
		},
	}
	_, err := genJavaSpec(m)
	if !errors.Is(err, errJavaName) {
		t.Fatalf("genJavaSpec error = %v, want errJavaName", err)
	}
}

// javaSection returns the source of the nested type that starts with
// header, up to the next line that closes a nested type at four spaces.
func javaSection(t *testing.T, src, header string) string {
	t.Helper()
	_, rest, ok := strings.Cut(src, header)
	if !ok {
		t.Fatalf("source lacks %q", header)
	}
	body, _, _ := strings.Cut(rest, "\n    }\n")
	return body
}

// TestGenJavaClosedEnumsAreJavaEnums pins that every closed registry value
// set becomes a Java enum whose constants carry the wire string, with an
// accessor, a lookup that does not throw, and the set of wire values.
func TestGenJavaClosedEnumsAreJavaEnums(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genJavaSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(src, "public static final class Outcome") {
		t.Error("Outcome is still a class of String constants")
	}
	outcome := javaSection(t, src, "public enum Outcome implements WireValue {")
	for _, want := range []string{
		`SUCCESS("success"),`,
		`FAILURE("failure"),`,
		`UNKNOWN("unknown");`,
		`public static final Set<String> WIRE_VALUES = Set.of("success", "failure", "unknown");`,
		"public String value() {",
		"public String toString() {",
		"public static Optional<Outcome> fromValue(String value) {",
		`case "success" -> Optional.of(SUCCESS);`,
		"default -> Optional.empty();",
		"public static boolean isValid(String value) {",
	} {
		if !strings.Contains(outcome, want) {
			t.Errorf("enum Outcome missing %q", want)
		}
	}
	for _, a := range m.minted {
		if len(a.enumMembers()) == 0 {
			continue
		}
		header := "public enum " + javaTypeName(a.ID) + " implements WireValue {"
		if !strings.Contains(src, header) {
			t.Errorf("closed enum %s is not a Java enum (want %q)", a.ID, header)
		}
	}
	for _, want := range []string{
		"public interface WireValue {",
		"public enum ValueType {",
		"public static final class Key<T> {",
		"public static final class TemplateKey<T> {",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("Spec.java missing %q", want)
		}
	}
}

// TestGenJavaEnvironmentStaysOpen pins that deployment.environment.name,
// which an application extends with extra environments, is not modeled as a
// closed enum.
func TestGenJavaEnvironmentStaysOpen(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genJavaSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(src, "enum DeploymentEnvironment") {
		t.Error("DeploymentEnvironment is a closed enum, but the registry lets applications add values")
	}
	env := javaSection(t, src, "public static final class DeploymentEnvironment {")
	for _, want := range []string{
		`public static final String PRODUCTION = "production";`,
		`public static final String TEST = "test";`,
		"public static final Set<String> REGISTERED = Set.of(PRODUCTION, STAGING, DEVELOPMENT, TEST);",
		"public static boolean isRegistered(String value) {",
	} {
		if !strings.Contains(env, want) {
			t.Errorf("DeploymentEnvironment missing %q", want)
		}
	}
}

// TestGenJavaTypedKeys pins that every attribute key carries its registry
// value type, that enum keys carry their enum type, and that a template key
// builds typed keys from a suffix.
func TestGenJavaTypedKeys(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genJavaSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	attrs := javaSection(t, src, "public static final class Attributes {")
	for _, want := range []string{
		`public static final Key<Outcome> OUTCOME = key("o11y.outcome", ValueType.STRING, Outcome.class);`,
		`public static final Key<Signal> SIGNAL = key("o11y.signal", ValueType.STRING, Signal.class);`,
		`public static final Key<String> RULE = key("o11y.rule", ValueType.STRING, String.class);`,
		`public static final Key<Double> DURATION = key("o11y.duration", ValueType.DOUBLE, Double.class);`,
		`public static final Key<Boolean> BUILD_MODIFIED = key("o11y.build.modified", ValueType.BOOLEAN, Boolean.class);`,
		`public static final Key<Long> RUM_SUMMARY_SEQ = key("o11y.rum.summary.seq", ValueType.LONG, Long.class);`,
		`public static final TemplateKey<String> LABEL = templateKey("o11y.label", ValueType.STRING, String.class);`,
		`public static final TemplateKey<String> CONFIG = templateKey("o11y.config", ValueType.STRING, String.class);`,
		`public static final Key<Long> PROCESS_PID = key("process.pid", ValueType.LONG, Long.class);`,
		`public static final Key<String> HOST_NAME = key("host.name", ValueType.STRING, String.class);`,
	} {
		if !strings.Contains(attrs, want) {
			t.Errorf("Spec.Attributes missing %q", want)
		}
	}
	if strings.Contains(attrs, "public static final String ") {
		t.Error("Spec.Attributes still has untyped String keys")
	}
	template := javaSection(t, src, "public static final class TemplateKey<T> {")
	if !strings.Contains(template, "public Key<T> of(String suffix) {") {
		t.Error("TemplateKey cannot build a key from a suffix")
	}
	for _, want := range []string{"public String getKey() {", "public ValueType getType() {", "public Class<T> getValueClass() {"} {
		if !strings.Contains(javaSection(t, src, "public static final class Key<T> {"), want) {
			t.Errorf("Key missing %q", want)
		}
		if !strings.Contains(template, want) {
			t.Errorf("TemplateKey missing %q", want)
		}
	}

	// Forbidden keys get no constant of any type.
	if len(m.forbidden) == 0 {
		t.Fatal("registry has no forbidden keys")
	}
	for _, a := range m.forbidden {
		if strings.Contains(attrs, javaQuote(a.name())) {
			t.Errorf("forbidden key %s has a generated constant", a.name())
		}
	}

	tables, err := genJavaTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"public static final Map<String, String> ATTRIBUTE_TYPES = buildAttributeTypes();",
		`map.put("o11y.outcome", "enum");`,
		`map.put("o11y.label", "template[string]");`,
		`map.put("o11y.rum.summary.seq", "int");`,
		`map.put("process.pid", "int");`,
	} {
		if !strings.Contains(tables, want) {
			t.Errorf("SpecTables.java missing %q", want)
		}
	}
}

// TestGenJavaKeyTypesFromModel checks the value-type mapping on a small
// model, including the error for a type the Java API cannot carry.
func TestGenJavaKeyTypesFromModel(t *testing.T) {
	scalar := func(id, typ string) attr {
		a := attr{ID: id}
		a.Type.Kind = yaml.ScalarNode
		a.Type.Value = typ
		return a
	}
	base := func(minted ...attr) *model {
		return &model{
			specVersion:    "1.3.0",
			schemaURL:      "https://schemas.o11y.ing/libo11y/1.3.0",
			semconvVersion: "1.41.0",
			minted:         minted,
			tiers:          map[string][]attr{},
		}
	}
	src, err := genJavaSpec(base(
		scalar("o11y.count", "int"),
		scalar("o11y.ratio", "double"),
		scalar("o11y.flag", "boolean"),
		scalar("o11y.name", "string"),
		scalar("o11y.limit", "template[int]"),
	))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`Key<Long> COUNT = key("o11y.count", ValueType.LONG, Long.class);`,
		`Key<Double> RATIO = key("o11y.ratio", ValueType.DOUBLE, Double.class);`,
		`Key<Boolean> FLAG = key("o11y.flag", ValueType.BOOLEAN, Boolean.class);`,
		`Key<String> NAME = key("o11y.name", ValueType.STRING, String.class);`,
		`TemplateKey<Long> LIMIT = templateKey("o11y.limit", ValueType.LONG, Long.class);`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("Spec.java missing %q", want)
		}
	}

	if _, err := genJavaSpec(base(scalar("o11y.tags", "string[]"))); !errors.Is(err, errJavaName) {
		t.Errorf("genJavaSpec(string[]) error = %v, want errJavaName", err)
	}

	untyped := base()
	untyped.tiers = map[string][]attr{"tier2": {{Ref: "host.name", Annotations: map[string]string{"o11y.gen": "copy"}}}}
	untyped.tierOrder = []string{"tier2"}
	if _, err := genJavaSpec(untyped); !errors.Is(err, errJavaName) {
		t.Errorf("genJavaSpec(copied ref without o11y.type) error = %v, want errJavaName", err)
	}
}

// TestGenJavaRejectsReservedEnumMember pins that an enum member cannot take
// the name of the enum's own wire-value set.
func TestGenJavaRejectsReservedEnumMember(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte("members:\n  - id: wire_values\n    value: wire_values\n"), &doc); err != nil {
		t.Fatal(err)
	}
	a := attr{ID: "o11y.mode", Type: *doc.Content[0]}
	m := &model{specVersion: "1.3.0", minted: []attr{a}, tiers: map[string][]attr{}}
	if _, err := genJavaSpec(m); !errors.Is(err, errJavaName) {
		t.Fatalf("genJavaSpec error = %v, want errJavaName", err)
	}
}
