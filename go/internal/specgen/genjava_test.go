package main

import (
	"errors"
	"strings"
	"testing"
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
		"public static final class Signal",
		`public static final String OUTCOME = "o11y.outcome";`,
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
