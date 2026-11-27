package main

import (
	"strings"
	"testing"
)

func TestGenCSpec(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatal(err)
	}
	src, err := genCSpec(m)
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []string{
		`#ifndef O11Y_SPEC_H`,
		`#define O11Y_SCHEMA_URL "https://schemas.o11y.ing/libo11y/1.3.0"`,
		`#define O11Y_SPEC_VERSION "1.3.0"`,
		`#define O11Y_SEMCONV_VERSION "1.41.0"`,
		`#define O11Y_EVENT_NAME_KEY "event.name"`,
		`#define O11Y_APP_REGISTRY_SCHEMA "libo11y.app-registry/v1"`,
		`O11Y_SENSITIVITY_UNCLASSIFIED = 0`,
		`#define O11Y_ENVIRONMENT_PRODUCTION "production"`,
		`#define O11Y_ENVIRONMENT_TEST "test"`,
		`#define O11Y_OUTCOME_SUCCESS "success"`,
		`#define O11Y_ATTR_OUTCOME "o11y.outcome"`,
		`#define O11Y_ATTR_CONTAINER_ID "container.id"`,
		`#define O11Y_ATTR_HOST_NAME "host.name"`,
		`#define O11Y_EVENT_TELEMETRY_CONFIGURED "o11y.telemetry.configured"`,
		`#define O11Y_METRIC_SCHEMA_VIOLATIONS "o11y.schema.violations"`,
	} {
		if !strings.Contains(src, want) {
			t.Errorf("genCSpec missing %s", want)
		}
	}

	// Forbidden keys must never appear as generated attribute constants.
	for _, forbidden := range []string{
		"O11Y_ATTR_HOST_IP",
		"O11Y_ATTR_HOST_MAC",
		"O11Y_ATTR_PROCESS_COMMAND_LINE",
		"O11Y_ATTR_DEVICE_ID",
		"O11Y_ATTR_HTTP_REQUEST_HEADER_AUTHORIZATION",
	} {
		if strings.Contains(src, forbidden) {
			t.Errorf("genCSpec emitted forbidden key macro %s", forbidden)
		}
	}
}

func TestCQuoteEscapes(t *testing.T) {
	got := cQuote("a\"b\\c\n\t??/é")
	want := `"a\"b\\c\n\t\??/\303\251"`
	if got != want {
		t.Errorf("cQuote = %s, want %s", got, want)
	}
}
