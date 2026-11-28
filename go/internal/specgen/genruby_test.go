package main

import (
	"errors"
	"strings"
	"testing"
)

func TestGenRbSpecAndTables(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	specSrc, err := genRbSpec(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# frozen_string_literal: true",
		"SCHEMA_URL =",
		"SPEC_VERSION =",
		"SEMCONV_VERSION =",
		`EVENT_NAME_KEY = "event.name"`,
		"module Environment",
		`PRODUCTION = "production"`,
		"module Signal",
		`ATTR_OUTCOME = "o11y.outcome"`,
		`EVENT_TELEMETRY_CONFIGURED = "o11y.telemetry.configured"`,
		`METRIC_SCHEMA_VIOLATIONS = "o11y.schema.violations"`,
	} {
		if !strings.Contains(specSrc, want) {
			t.Errorf("spec.rb missing %q", want)
		}
	}

	tablesSrc, err := genRbTables(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"module Sensitivity",
		"RESOURCE = {",
		"REQUIRED_TIER0 = [",
		"ENVIRONMENT_VALUES = Set[",
		"SENSITIVITY_OF = {",
		"CARDINALITY_OF = {",
		"LEGACY_KEYS = {",
		"METRIC_RESOURCE_LABELS = [",
		"EVENTS = {",
		"METRICS = {",
		"SPAN_REQUIRED = {",
		"RUM_SPAN_REQUIRED = {",
		`APP_REGISTRY_SCHEMA = "libo11y.app-registry/v1"`,
		"APP_RESERVED_NAMESPACES = Set[",
	} {
		if !strings.Contains(tablesSrc, want) {
			t.Errorf("tables.rb missing %q", want)
		}
	}

	goprintSrc := genRbGoPrint()
	if !strings.Contains(goprintSrc, "GO_PRINT_RANGES = [") {
		t.Errorf("goprint.rb missing GO_PRINT_RANGES")
	}
}

func TestGenRbRejectsUnknownClasses(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	m.cardByName["o11y.bogus"] = "infinite"
	if _, err := genRbTables(m); err == nil || !strings.Contains(err.Error(), "infinite") {
		t.Fatalf("genRbTables error = %v, want unknown cardinality error", err)
	}
}

func TestGenRbRejectsCollidingConstNames(t *testing.T) {
	m := &model{
		specVersion:    "1.2.0",
		schemaURL:      "https://schemas.o11y.ing/libo11y/1.2.0",
		semconvVersion: "1.41.0",
		minted: []attr{
			{ID: "o11y.foo.bar"},
			{ID: "o11y.foo_bar"},
		},
	}
	_, err := genRbSpec(m)
	if !errors.Is(err, errRbName) {
		t.Fatalf("genRbSpec error = %v, want errRbName", err)
	}
}
