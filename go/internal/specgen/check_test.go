package main

import (
	"slices"
	"strings"
	"testing"
)

// parseGroups decodes a registry-file YAML snippet with the same strict
// decoder load() uses, so the checks are tested against real parse output.
func parseGroups(t *testing.T, doc string) []group {
	t.Helper()
	file, err := decodeRegistry([]byte(doc))
	if err != nil {
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

// hasRule reports whether any violation carries the given rule ID.
func hasRule(violations []violation, ruleID string) bool {
	for _, v := range violations {
		if v.RuleID == ruleID {
			return true
		}
	}
	return false
}

func assertViolations(t *testing.T, doc string, wantIDs ...string) {
	t.Helper()
	groups := parseGroups(t, doc)
	got := violationIDs(checkGroups(groups, buildIndex(groups)))
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
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.api_key
        type: string
        annotations:
          o11y.sensitivity: secret
          o11y.cardinality: bounded
  - id: libo11y.span.server
    type: span
    attributes:
      - ref: o11y.api_key
        annotations:
          o11y.sensitivity: secret
`, "libo11y_secret_referenced")
}

// TestSecretReferencedAcrossGroupsFlagged pins the cross-group seam: a
// secret key defined in a forbidden group and referenced (without a local
// annotation) from a signal group is flagged via the prebuilt index.
func TestSecretReferencedAcrossGroupsFlagged(t *testing.T) {
	groups := []group{
		{ID: "libo11y.resource.forbidden", Attributes: []attr{{
			Ref:         "x.secret",
			Annotations: map[string]string{"o11y.sensitivity": "secret"},
		}}},
		{ID: "some.signal.group", Type: "attribute_group", Attributes: []attr{{Ref: "x.secret"}}},
	}
	idx := buildIndex(groups)
	vs := checkGroups(groups, idx)
	if !hasRule(vs, "libo11y_secret_referenced") {
		t.Fatalf("secret ref in a signal group not flagged: %v", vs)
	}
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
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.label
        type: string
        annotations:
          o11y.sensitivity: internal
          o11y.cardinality: unbounded
  - id: metric.o11y.dropped
    type: metric
    metric_name: o11y.dropped
    instrument: counter
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
    instrument: counter
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
	if violations := checkGroups(m.groups, buildIndex(m.groups)); len(violations) != 0 {
		for _, v := range violations {
			t.Errorf("registry violation: %s", v)
		}
	}
}

func TestPolicyRulesResolveAcrossGroups(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		want string
	}{
		{"unbounded label via ref", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.tenant.id
        type: string
        annotations: {o11y.sensitivity: internal, o11y.cardinality: unbounded}
  - id: metric.o11y.requests
    type: metric
    metric_name: o11y.requests
    instrument: counter
    unit: "{request}"
    stability: development
    attributes:
      - ref: o11y.tenant.id
`, "libo11y_unbounded_metric_label"},
		{"unclassified label", `
groups:
  - id: metric.o11y.requests
    type: metric
    metric_name: o11y.requests
    instrument: counter
    unit: "{request}"
    stability: development
    attributes:
      - ref: http.route
`, "libo11y_metric_label_unclassified"},
		{"dangling o11y ref", `
groups:
  - id: event.o11y.x
    type: event
    name: o11y.x
    stability: development
    attributes:
      - ref: o11y.outcom
`, "libo11y_ref_undefined"},
		{"duplicate definition", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.a
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
      - id: o11y.a
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
`, "libo11y_attr_duplicate"},
		{"conflicting classification", `
groups:
  - id: g1
    type: attribute_group
    attributes:
      - ref: host.ip
        annotations: {o11y.sensitivity: pii}
  - id: g2
    type: attribute_group
    attributes:
      - ref: host.ip
        annotations: {o11y.sensitivity: public}
`, "libo11y_classification_conflict"},
		{"bad event name", `
groups:
  - id: event.bad
    type: event
    name: "o11y.Bad Name"
    stability: development
`, "libo11y_event_naming"},
		{"bad stability", `
groups:
  - id: event.o11y.s
    type: event
    name: o11y.s
    stability: whatever
`, "libo11y_stability_unknown"},
		{"bad attribute stability", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.a
        type: string
        stability: whatever
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
`, "libo11y_stability_unknown"},
		{"bad requirement level", `
groups:
  - id: libo11y.span.x
    type: attribute_group
    attributes:
      - ref: http.route
        requirement_level: mandatory
`, "libo11y_requirement_unknown"},
		{"bad instrument", `
groups:
  - id: metric.o11y.b
    type: metric
    metric_name: o11y.b
    instrument: banana
    unit: s
    stability: development
`, "libo11y_instrument_unknown"},
		{"bad unit", `
groups:
  - id: metric.o11y.c
    type: metric
    metric_name: o11y.c
    instrument: histogram
    unit: "milliseconds please"
    stability: development
`, "libo11y_metric_unit_invalid"},
		{"unit in name", `
groups:
  - id: metric.o11y.latency_ms
    type: metric
    metric_name: o11y.latency_ms
    instrument: histogram
    unit: ms
    stability: development
`, "libo11y_metric_unit_in_name"},
		{"metric name casing", `
groups:
  - id: metric.o11y.Latency
    type: metric
    metric_name: o11y.Latency
    instrument: histogram
    unit: s
    stability: development
`, "libo11y_metric_naming"},
		{"deprecated target undefined", `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.old
        type: string
        deprecated:
          reason: renamed
          renamed_to: o11y.new
`, "libo11y_deprecated_target_undefined"},
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

// TestCrossGroupViolationsReportedOnce pins that registry-wide findings (a
// duplicate definition, a classification conflict) appear once, not once
// per occurrence.
func TestCrossGroupViolationsReportedOnce(t *testing.T) {
	groups := parseGroups(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.a
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
      - id: o11y.a
        type: string
        annotations: {o11y.sensitivity: pii, o11y.cardinality: bounded}
  - id: g2
    type: attribute_group
    attributes:
      - ref: o11y.a
        annotations: {o11y.sensitivity: internal}
`)
	counts := map[string]int{}
	for _, id := range violationIDs(checkGroups(groups, buildIndex(groups))) {
		counts[id]++
	}
	for _, rule := range []string{"libo11y_attr_duplicate", "libo11y_classification_conflict"} {
		if counts[rule] != 1 {
			t.Errorf("%s reported %d times, want 1", rule, counts[rule])
		}
	}
}

func TestFixRound1Rules(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		want []string
	}{
		{"enum member without value", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          members:
            - {id: alpha, stability: development}
`, []string{"libo11y_enum_member_empty"}},
		{"enum member without id", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.kind
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
        type:
          members:
            - {value: "alpha", stability: development}
`, []string{"libo11y_enum_member_empty"}},
		{"local bounded cannot override defined unbounded", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.tenant.id
        type: string
        annotations: {o11y.sensitivity: internal, o11y.cardinality: unbounded}
  - id: metric.o11y.requests
    type: metric
    metric_name: o11y.requests
    instrument: counter
    unit: "{request}"
    attributes:
      - ref: o11y.tenant.id
        annotations: {o11y.cardinality: bounded}
`, []string{"libo11y_unbounded_metric_label", "libo11y_cardinality_conflict"}},
		{"spelled-out unit", `
groups:
  - id: metric.o11y.d
    type: metric
    metric_name: o11y.d
    instrument: histogram
    unit: seconds
`, []string{"libo11y_metric_unit_invalid"}},
		{"unknown attribute annotation", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.a
        type: string
        annotations: {o11y.sensitivty: public, o11y.sensitivity: public, o11y.cardinality: bounded}
`, []string{"libo11y_annotation_unknown"}},
		{"unknown group annotation", `
groups:
  - id: libo11y.resource.tier9
    type: attribute_group
    annotations: {o11y.teir: "9"}
`, []string{"libo11y_annotation_unknown"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			groups := parseGroups(t, tc.doc)
			vs := checkGroups(groups, buildIndex(groups))
			for _, want := range tc.want {
				if !hasRule(vs, want) {
					t.Errorf("rule %s not raised; got %v", want, violationIDs(vs))
				}
			}
		})
	}
}

// TestMetricUnitsAccepted pins the UCUM atoms the unit rule accepts, alone
// and as a per-unit.
func TestMetricUnitsAccepted(t *testing.T) {
	for _, unit := range []string{"1", "%", "s", "ms", "us", "ns", "min", "h", "d", "By", "KiBy", "MiBy", "GiBy", "bit", "Hz", "{request}", "By/s", "{request}/s"} {
		t.Run(unit, func(t *testing.T) {
			groups := parseGroups(t, `
groups:
  - id: metric.o11y.u
    type: metric
    metric_name: o11y.u
    instrument: counter
    unit: "`+unit+`"
`)
			if vs := checkGroups(groups, buildIndex(groups)); len(vs) != 0 {
				t.Errorf("unit %q rejected: %v", unit, violationIDs(vs))
			}
		})
	}
}

func TestForbiddenGroupMatchedByIDSuffixOnly(t *testing.T) {
	if isForbiddenGroup(group{ID: "libo11y.resource.forbiddenish"}) {
		t.Error("substring match treated a non-forbidden group as forbidden")
	}
	if !isForbiddenGroup(group{ID: "libo11y.resource.forbidden"}) {
		t.Error("the forbidden group was not recognized")
	}
}

// TestLegacyKeyRequiresRename pins that an o11y.legacy_key annotation only
// appears on a tombstone that names its replacement, so the generated
// LegacyKeys table never maps a legacy key to nothing.
func TestLegacyKeyRequiresRename(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.thing
        type: string
        deprecated:
          reason: obsoleted
        annotations: {o11y.sensitivity: public, o11y.legacy_key: thing}
`, "libo11y_legacy_key_unrenamed")
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.new.thing
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.thing
        type: string
        deprecated:
          reason: renamed
          renamed_to: o11y.new.thing
        annotations: {o11y.sensitivity: public, o11y.legacy_key: thing}
`)
}

// TestLegacyKeyRules pins the remaining legacy-key rules: a legacy key on an
// attribute that is not a renamed tombstone has no replacement, two
// tombstones may not claim one legacy key, and a legacy key may not be
// empty, its own replacement, or a name the registry still uses.
func TestLegacyKeyRules(t *testing.T) {
	const live = `
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.new.thing
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
      - id: o11y.other.thing
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
`
	cases := []struct {
		name string
		doc  string
		want []string
	}{
		{"not deprecated", `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.thing
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded, o11y.legacy_key: thing}
`, []string{"libo11y_legacy_key_unrenamed"}},
		{"scalar deprecation", `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.thing
        type: string
        deprecated: replaced by something
        annotations: {o11y.sensitivity: public, o11y.legacy_key: thing}
`, []string{"libo11y_legacy_key_unrenamed"}},
		{"duplicate", `
groups:` + live + `
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.a
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.new.thing}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: thing}
      - id: o11y.deprecated.b
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.other.thing}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: thing}
`, []string{"libo11y_legacy_key_duplicate"}},
		{"empty", `
groups:` + live + `
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.a
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.new.thing}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: " "}
`, []string{"libo11y_legacy_key_invalid"}},
		{"live name", `
groups:` + live + `
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.a
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.new.thing}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: o11y.other.thing}
`, []string{"libo11y_legacy_key_invalid"}},
		{"own replacement", `
groups:
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.deprecated.a
        type: string
        deprecated: {reason: renamed, renamed_to: vcs.thing}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: vcs.thing}
`, []string{"libo11y_legacy_key_invalid"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assertViolations(t, tc.doc, tc.want...)
		})
	}
}

// TestRenameNeedsTransform pins that a rename recorded only as a tombstone
// is refused unless it is a pre-1.0.0 rename (it names its legacy key):
// renames from 1.0.0 on need a schema-file transform the generator cannot
// render yet.
func TestRenameNeedsTransform(t *testing.T) {
	const live = `
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.new.thing
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: bounded}
`
	assertViolations(t, `
groups:`+live+`
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.old.thing
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.new.thing}
        annotations: {o11y.sensitivity: public}
`, "libo11y_rename_needs_transform")
	assertViolations(t, `
groups:`+live+`
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.old.thing
        type: string
        deprecated: {reason: obsoleted}
        annotations: {o11y.sensitivity: public}
`)
}

// TestRUMSpanKind pins that a RUM span-shape group names one of the RUM
// span shapes, and that the shape matches its group ID suffix.
func TestRUMSpanKind(t *testing.T) {
	const body = `
    type: attribute_group
    attributes:
      - ref: session.id
        requirement_level: required
`
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.view\n    annotations: {o11y.rum.span: view}"+body)
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.view\n    annotations: {o11y.rum.span: page}"+body, "libo11y_rum_span_kind")
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.view"+body, "libo11y_rum_span_kind")
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.view\n    annotations: {o11y.rum.span: action}"+body, "libo11y_rum_span_kind")
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.action\n    annotations: {o11y.rum.span: action}"+body)
	assertViolations(t, "groups:\n  - id: libo11y.rum.span.app_load\n    annotations: {o11y.rum.span: app_load}"+body)
}

// TestTombstoneDoesNotCollideWithLiveKey pins that a deprecated definition
// whose Go name matches a live key raises no collision, because tombstones
// mint no constants.
func TestTombstoneDoesNotCollideWithLiveKey(t *testing.T) {
	assertViolations(t, `
groups:
  - id: registry.o11y
    type: attribute_group
    attributes:
      - id: o11y.request.outcome
        type: string
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
  - id: registry.o11y.deprecated
    type: attribute_group
    attributes:
      - id: o11y.request_outcome
        type: string
        deprecated: {reason: renamed, renamed_to: o11y.request.outcome}
        annotations: {o11y.sensitivity: public, o11y.legacy_key: request_outcome}
`)
}

// TestGroupDuplicate pins that two groups sharing an ID raise
// libo11y_group_duplicate once per duplicated ID.
func TestGroupDuplicate(t *testing.T) {
	groups := parseGroups(t, `
groups:
  - id: libo11y.rum.span.view
    type: attribute_group
    annotations: {o11y.rum.span: view}
  - id: libo11y.rum.span.view
    type: attribute_group
    annotations: {o11y.rum.span: view}
  - id: libo11y.rum.span.view
    type: attribute_group
    annotations: {o11y.rum.span: view}
  - id: registry.o11y
    type: attribute_group
`)
	var got []violation
	for _, v := range checkGroups(groups, buildIndex(groups)) {
		if v.RuleID == "libo11y_group_duplicate" {
			got = append(got, v)
		}
	}
	if len(got) != 1 || got[0].Group != "libo11y.rum.span.view" || got[0].Category != "references" {
		t.Errorf("libo11y_group_duplicate violations = %v, want one for libo11y.rum.span.view", got)
	}
}

// summaryEnums defines cut-down versions of the two enums the RUM view
// summary breaks its counts down by.
const summaryEnums = `groups:
  - id: registry.o11y.rum
    type: attribute_group
    brief: RUM.
    attributes:
      - id: o11y.rum.error.source
        type:
          members:
            - {id: uncaught, value: "uncaught", stability: development, brief: U.}
            - {id: csp, value: "csp", stability: development, brief: C.}
        stability: development
        brief: Source.
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
      - id: o11y.rum.frustration.type
        type:
          members:
            - {id: rage, value: "rage", stability: development, brief: R.}
        stability: development
        brief: Type.
        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}
`

// summaryGroup renders a registry.o11y.rum.summary group holding one int
// count attribute per key.
func summaryGroup(keys ...string) string {
	var b strings.Builder
	b.WriteString("  - id: registry.o11y.rum.summary\n    type: attribute_group\n    brief: Summary.\n    attributes:\n")
	for _, k := range keys {
		b.WriteString("      - id: " + k + "\n        type: int\n        stability: development\n        brief: A count.\n        annotations: {o11y.sensitivity: public, o11y.cardinality: unbounded}\n")
	}
	return b.String()
}

// summaryCoverage returns the libo11y_rum_summary_coverage violations doc
// raises.
func summaryCoverage(t *testing.T, doc string) []violation {
	t.Helper()
	groups := parseGroups(t, doc)
	var got []violation
	for _, v := range checkGroups(groups, buildIndex(groups)) {
		if v.RuleID == "libo11y_rum_summary_coverage" {
			got = append(got, v)
		}
	}
	return got
}

// TestRUMSummaryCoverageComplete pins that a summary with one count per
// enum member raises nothing.
func TestRUMSummaryCoverageComplete(t *testing.T) {
	assertViolations(t, summaryEnums+summaryGroup(
		"o11y.rum.summary.errors.uncaught", "o11y.rum.summary.errors.csp", "o11y.rum.summary.frustrations.rage"))
}

// TestRUMSummaryCoverageViolations pins what libo11y_rum_summary_coverage
// reports, in order: missing counts in enum member order, then unknown
// counts in registry order, for each enum in turn.
func TestRUMSummaryCoverageViolations(t *testing.T) {
	complete := []string{"o11y.rum.summary.errors.uncaught", "o11y.rum.summary.errors.csp", "o11y.rum.summary.frustrations.rage"}
	for name, tc := range map[string]struct {
		doc       string
		wantAttrs []string
	}{
		"missing error count": {
			doc:       summaryEnums + summaryGroup("o11y.rum.summary.errors.uncaught", "o11y.rum.summary.frustrations.rage"),
			wantAttrs: []string{"o11y.rum.summary.errors.csp"},
		},
		"missing frustration count": {
			doc:       summaryEnums + summaryGroup("o11y.rum.summary.errors.uncaught", "o11y.rum.summary.errors.csp"),
			wantAttrs: []string{"o11y.rum.summary.frustrations.rage"},
		},
		"unknown count": {
			doc:       summaryEnums + summaryGroup(append(complete, "o11y.rum.summary.errors.bogus")...),
			wantAttrs: []string{"o11y.rum.summary.errors.bogus"},
		},
		"missing then unknown": {
			doc: summaryEnums + summaryGroup(
				"o11y.rum.summary.errors.bogus", "o11y.rum.summary.errors.csp",
				"o11y.rum.summary.frustrations.nope", "o11y.rum.summary.frustrations.rage"),
			wantAttrs: []string{"o11y.rum.summary.errors.uncaught", "o11y.rum.summary.errors.bogus", "o11y.rum.summary.frustrations.nope"},
		},
		"enum defined twice reports a missing count once": {
			doc: summaryEnums + summaryGroup("o11y.rum.summary.errors.uncaught", "o11y.rum.summary.frustrations.rage") +
				"  - id: registry.o11y.rum.again\n    type: attribute_group\n    attributes:\n" +
				"      - id: o11y.rum.error.source\n        type:\n          members:\n" +
				"            - {id: csp, value: \"csp\", stability: development, brief: C.}\n" +
				"        annotations: {o11y.sensitivity: public, o11y.cardinality: enum}\n",
			wantAttrs: []string{"o11y.rum.summary.errors.csp"},
		},
		"counts split across duplicated summary groups": {
			doc: summaryEnums + summaryGroup("o11y.rum.summary.errors.uncaught") +
				summaryGroup("o11y.rum.summary.errors.csp", "o11y.rum.summary.frustrations.rage"),
		},
		"enum absent": {
			doc: strings.SplitAfter(summaryEnums, "annotations: {o11y.sensitivity: public, o11y.cardinality: enum}\n")[0] +
				summaryGroup("o11y.rum.summary.errors.uncaught", "o11y.rum.summary.errors.csp"),
			wantAttrs: []string{"o11y.rum.frustration.type"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			got := summaryCoverage(t, tc.doc)
			var attrs []string
			for _, v := range got {
				if v.Group != "registry.o11y.rum.summary" || v.Category != "rum" {
					t.Errorf("violation %v, want group registry.o11y.rum.summary and category rum", v)
				}
				attrs = append(attrs, v.Attr)
			}
			if !slices.Equal(attrs, tc.wantAttrs) {
				t.Errorf("libo11y_rum_summary_coverage attributes = %v, want %v", attrs, tc.wantAttrs)
			}
		})
	}
}

// TestRUMSummaryCoverageNoSummaryGroup pins that the rule applies only when
// the registry defines registry.o11y.rum.summary.
func TestRUMSummaryCoverageNoSummaryGroup(t *testing.T) {
	assertViolations(t, summaryEnums)
}
