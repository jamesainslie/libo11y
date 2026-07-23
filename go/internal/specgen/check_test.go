package main

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// parseGroups unmarshals a registry-file YAML snippet into groups, the same
// shape load() produces, so the checks are tested against real parse output.
func parseGroups(t *testing.T, doc string) []group {
	t.Helper()
	var file registryFile
	if err := yaml.Unmarshal([]byte(doc), &file); err != nil {
		t.Fatalf("parsing test registry: %v", err)
	}
	return file.Groups
}

// violationIDs flattens violations to their rule IDs for compact assertions.
func violationIDs(violations []violation) []string {
	ids := make([]string, 0, len(violations))
	for _, v := range violations {
		ids = append(ids, v.RuleID)
	}
	return ids
}

func assertViolations(t *testing.T, doc string, wantIDs ...string) {
	t.Helper()
	got := violationIDs(checkGroups(parseGroups(t, doc)))
	if len(got) != len(wantIDs) {
		t.Fatalf("checkGroups() violations = %v, want %v", got, wantIDs)
	}
	for i, want := range wantIDs {
		if got[i] != want {
			t.Errorf("violation[%d] = %q, want %q", i, got[i], want)
		}
	}
}

// validAttribute is a fully classified minted attribute that passes every
// policy; each test mutates one aspect of it.
const validRegistry = `
groups:
  - id: registry.o11y
    type: attribute_group
    brief: test
    attributes:
      - id: o11y.outcome
        type: string
        stability: stable
        brief: test
        annotations:
          o11y.sensitivity: public
          o11y.cardinality: enum
`

func TestCheckGroupsCleanRegistry(t *testing.T) {
	assertViolations(t, validRegistry)
}

func TestCheckGroupsSensitivityMissing(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.outcome
        type: string
        annotations:
          o11y.cardinality: enum
`, "libo11y_sensitivity_missing")
}

func TestCheckGroupsSensitivityUnknownClass(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.outcome
        type: string
        annotations:
          o11y.sensitivity: radioactive
          o11y.cardinality: enum
`, "libo11y_sensitivity_unknown")
}

func TestCheckGroupsSecretReferenced(t *testing.T) {
	assertViolations(t, `
groups:
  - id: libo11y.span.server
    type: span
    attributes:
      - ref: o11y.api_key
        annotations:
          o11y.sensitivity: secret
`, "libo11y_secret_referenced")
}

// TestCheckGroupsSecretDefinitionAllowed pins the carve-out: a secret-class
// attribute may be DEFINED (documenting a forbidden key); only referencing
// one from a signal group is a violation.
func TestCheckGroupsSecretDefinitionAllowed(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.api_key
        type: string
        annotations:
          o11y.sensitivity: secret
          o11y.cardinality: bounded
`)
}

// TestCheckGroupsDeprecatedUnknownClassStillFails pins the asymmetry
// inherited from the policy suite: deprecation exempts an attribute from
// the missing-classification rules, but a present-and-invalid class is
// always a violation.
func TestCheckGroupsDeprecatedUnknownClassStillFails(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.old_name
        type: string
        deprecated:
          reason: renamed
        annotations:
          o11y.sensitivity: radioactive
          o11y.cardinality: infinite
`, "libo11y_sensitivity_unknown", "libo11y_cardinality_unknown")
}

func TestCheckGroupsDeprecatedAttributesExemptFromClassification(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.old_name
        type: string
        deprecated:
          reason: renamed
`)
}

func TestCheckGroupsCardinalityMissing(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.outcome
        type: string
        annotations:
          o11y.sensitivity: public
`, "libo11y_cardinality_missing")
}

func TestCheckGroupsCardinalityUnknownClass(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.outcome
        type: string
        annotations:
          o11y.sensitivity: public
          o11y.cardinality: infinite
`, "libo11y_cardinality_unknown")
}

func TestCheckGroupsUnboundedMetricLabel(t *testing.T) {
	assertViolations(t, `
groups:
  - id: metric.o11y.dropped
    type: metric
    metric_name: o11y.dropped
    unit: "{record}"
    attributes:
      - ref: o11y.label
        annotations:
          o11y.cardinality: unbounded
`, "libo11y_unbounded_metric_label")
}

func TestCheckGroupsNaming(t *testing.T) {
	tests := []struct {
		name   string
		attrID string
		wantOK bool
	}{
		{"dotted snake_case", "o11y.record.class", true},
		{"single segment", "outcome", false},
		{"uppercase", "o11y.Outcome", false},
		{"trailing dot", "o11y.outcome.", false},
		{"kebab segment", "o11y.record-class", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := strings.ReplaceAll(`
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: 'ATTR'
        type: string
        annotations:
          o11y.sensitivity: public
          o11y.cardinality: enum
`, "ATTR", tt.attrID)
			var want []string
			if !tt.wantOK {
				want = []string{"libo11y_attr_naming"}
				// A name outside o11y.* also trips ownership; order is
				// naming first, then ownership.
				if !strings.HasPrefix(tt.attrID, "o11y.") {
					want = append(want, "libo11y_namespace_ownership")
				}
			}
			assertViolations(t, doc, want...)
		})
	}
}

func TestCheckGroupsOwnership(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: http.request.flavor
        type: string
        annotations:
          o11y.sensitivity: public
          o11y.cardinality: enum
`, "libo11y_namespace_ownership")
}

func TestCheckGroupsEventNamespace(t *testing.T) {
	assertViolations(t, `
groups:
  - id: event.request.summary
    type: event
    name: request.summary
    stability: stable
`, "libo11y_event_namespace")
}

func TestCheckGroupsEventStability(t *testing.T) {
	assertViolations(t, `
groups:
  - id: event.o11y.request.summary
    type: event
    name: o11y.request.summary
`, "libo11y_event_stability")
}

func TestCheckGroupsMetricRules(t *testing.T) {
	tests := []struct {
		name       string
		metricName string
		unit       string
		wantIDs    []string
	}{
		{"clean", "o11y.telemetry.dropped", "{record}", nil},
		{"prometheus total suffix", "o11y.requests_total", "{request}", []string{"libo11y_metric_total_suffix"}},
		{"count suffix", "o11y.requests.count", "{request}", []string{"libo11y_metric_count_suffix"}},
		{"missing unit", "o11y.telemetry.dropped", "", []string{"libo11y_metric_unit_missing"}},
		{"foreign namespace", "http.server.duration", "s", []string{"libo11y_metric_namespace"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			doc := `
groups:
  - id: metric.test
    type: metric
    metric_name: ` + tt.metricName + `
    stability: stable
`
			if tt.unit != "" {
				doc += `    unit: "` + tt.unit + `"` + "\n"
			}
			assertViolations(t, doc, tt.wantIDs...)
		})
	}
}

// TestCheckRealRegistry pins that the committed registry is clean under the
// ported policy suite.
func TestCheckRealRegistry(t *testing.T) {
	m, err := load("../../..")
	if err != nil {
		t.Fatalf("loading registry: %v", err)
	}
	if violations := checkGroups(m.groups); len(violations) != 0 {
		for _, v := range violations {
			t.Errorf("registry violation: %s", v)
		}
	}
}
