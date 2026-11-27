package main

import (
	"errors"
	"strings"
	"testing"
)

func TestGenPySpecAndTables(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	specSrc, err := genPySpec(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"SCHEMA_URL: Final[str] =",
		"SPEC_VERSION: Final[str] =",
		"SEMCONV_VERSION: Final[str] =",
		`EVENT_NAME_KEY: Final[str] = "event.name"`,
		"class Environment(StrEnum):",
		`PRODUCTION = "production"`,
		"class Signal(StrEnum):",
		`ATTR_OUTCOME: Final[str] = "o11y.outcome"`,
		`EVENT_TELEMETRY_CONFIGURED: Final[str] = "o11y.telemetry.configured"`,
		`METRIC_SCHEMA_VIOLATIONS: Final[str] = "o11y.schema.violations"`,
	} {
		if !strings.Contains(specSrc, want) {
			t.Errorf("spec.py missing %q", want)
		}
	}

	tablesSrc, err := genPyTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"class Sensitivity(StrEnum):",
		"RESOURCE: Final[Mapping[str, ResourceAttr]] = MappingProxyType(",
		"REQUIRED_TIER0: Final[tuple[str, ...]] =",
		"ENVIRONMENT_VALUES: Final[frozenset[str]] =",
		"SENSITIVITY_OF: Final[Mapping[str, Sensitivity]] = MappingProxyType(",
		"CARDINALITY_OF: Final[Mapping[str, Cardinality]] = MappingProxyType(",
		"LEGACY_KEYS: Final[Mapping[str, str]] = MappingProxyType(",
		"METRIC_RESOURCE_LABELS: Final[tuple[str, ...]] =",
		"EVENTS: Final[Mapping[str, EventInfo]] = MappingProxyType(",
		"METRICS: Final[Mapping[str, MetricInfo]] = MappingProxyType(",
		"SPAN_REQUIRED: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(",
		"RUM_SPAN_REQUIRED: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(",
		`APP_REGISTRY_SCHEMA: Final[str] = "libo11y.app-registry/v1"`,
		"APP_RESERVED_NAMESPACES: Final[frozenset[str]] =",
	} {
		if !strings.Contains(tablesSrc, want) {
			t.Errorf("tables.py missing %q", want)
		}
	}

	goprintSrc := genPyGoPrint()
	if !strings.Contains(goprintSrc, "GO_PRINT_RANGES: Final[tuple[int, ...]] = (") {
		t.Errorf("goprint.py missing GO_PRINT_RANGES declaration")
	}
}

func TestGenPyRejectsUnknownClasses(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m.cardByName["o11y.bogus"] = "infinite"
	if _, err := genPyTables(m); err == nil || !strings.Contains(err.Error(), "infinite") {
		t.Fatalf("genPyTables error = %v, want unknown cardinality error", err)
	}
}

func TestGenPyRejectsCollidingConstNames(t *testing.T) {
	m := &model{
		specVersion:    "1.2.0",
		schemaURL:      "https://schemas.o11y.ing/libo11y/1.2.0",
		semconvVersion: "1.41.0",
		minted: []attr{
			{ID: "o11y.foo.bar"},
			{ID: "o11y.foo_bar"},
		},
	}
	_, err := genPySpec(m)
	if !errors.Is(err, errPyName) {
		t.Fatalf("genPySpec error = %v, want errPyName", err)
	}
}
