package main

import (
	"errors"
	"strings"
	"testing"
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
		"public static readonly IReadOnlyList<string> RequiredTier0 =",
		"public static readonly FrozenSet<string> EnvironmentValues =",
		"public static readonly FrozenDictionary<string, Sensitivity> SensitivityOf =",
		"public static readonly FrozenDictionary<string, Cardinality> CardinalityOf =",
		"public static readonly FrozenDictionary<string, string> LegacyKeys =",
		"public static readonly IReadOnlyList<string> MetricResourceLabels =",
		"public static readonly FrozenDictionary<string, EventInfo> Events =",
		"public static readonly FrozenDictionary<string, MetricInfo> Metrics =",
		"public static readonly FrozenDictionary<string, IReadOnlyList<string>> SpanRequired =",
		"public static readonly FrozenDictionary<string, IReadOnlyList<string>> RumSpanRequired =",
		`public const string AppRegistrySchema = "libo11y.app-registry/v1";`,
		"public static readonly FrozenSet<string> AppReservedNamespaces =",
	} {
		if !strings.Contains(tablesSrc, want) {
			t.Errorf("Tables.g.cs missing %q", want)
		}
	}

	goprintSrc := genCsGoPrint()
	if !strings.Contains(goprintSrc, "public static readonly int[] Ranges =") {
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
