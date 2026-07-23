package main

import (
	"fmt"
	"regexp"
	"strings"
)

// The policy suite below is the normative validation for the libo11y
// registry, replacing the earlier external policy runner. Each rule ID is
// stable and referenced by docs/SPEC.md.

// violation is one policy failure found in the registry.
type violation struct {
	RuleID   string
	Category string
	Group    string
	Attr     string
}

func (v violation) String() string {
	return fmt.Sprintf("%s (%s): group %s, attribute %s", v.RuleID, v.Category, v.Group, v.Attr)
}

var (
	sensitivityClasses = map[string]bool{"public": true, "internal": true, "pii": true, "secret": true}
	cardinalityClasses = map[string]bool{"enum": true, "bounded": true, "unbounded": true}

	// Minted attribute names: lowercase dotted namespaces, snake_case
	// within segments, at least two segments.
	attrNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$`)
)

// index is a whole-registry view built in a first pass and consulted by the
// per-attribute checks in the second pass. secretKeys are attribute names
// classified secret anywhere in the registry; mintedNames are the o11y.*
// names defined by the registry. upstreamKeys is populated in a later phase
// (ref and deprecation cross-checks against vendored semconv); it is empty
// here.
type index struct {
	secretKeys   map[string]bool
	mintedNames  map[string]bool
	upstreamKeys map[string]semconvEntry
}

// semconvEntry is a placeholder for the vendored upstream attribute record
// consulted by the ref and deprecation rules introduced in a later phase.
type semconvEntry struct{}

// buildIndex runs the first pass over the registry, collecting the
// cross-group facts the per-attribute checks need: which keys are secret and
// which o11y.* names the registry mints.
func buildIndex(groups []group) *index {
	idx := &index{
		secretKeys:   map[string]bool{},
		mintedNames:  map[string]bool{},
		upstreamKeys: map[string]semconvEntry{},
	}
	for _, g := range groups {
		for _, a := range g.Attributes {
			if a.Annotations["o11y.sensitivity"] == "secret" {
				idx.secretKeys[a.name()] = true
			}
			if a.ID != "" && strings.HasPrefix(a.ID, "o11y.") {
				idx.mintedNames[a.ID] = true
			}
		}
	}
	return idx
}

// isForbiddenGroup reports whether a group documents forbidden keys rather
// than emitting them. A secret key defined in such a group is a permitted
// definition; a reference to it from any other group is a violation.
func isForbiddenGroup(g group) bool {
	return strings.Contains(g.ID, ".forbidden")
}

// checkGroups validates registry groups against the libo11y policy suite:
// naming, namespace ownership, sensitivity and cardinality classification,
// event discipline, and metric naming and unit rules. It runs as a second
// pass over the prebuilt idx, which carries the cross-group facts (secret
// keys, minted names) the per-attribute rules consult.
func checkGroups(groups []group, idx *index) []violation {
	var violations []violation
	for _, g := range groups {
		for _, a := range g.Attributes {
			violations = append(violations, checkAttribute(g, a, idx)...)
		}
		violations = append(violations, checkGroup(g)...)
	}
	return violations
}

func checkAttribute(g group, a attr, idx *index) []violation {
	var violations []violation
	fail := func(ruleID, category, attrName string) {
		violations = append(violations, violation{RuleID: ruleID, Category: category, Group: g.ID, Attr: attrName})
	}

	deprecated := a.Deprecated.Kind != 0

	if a.ID != "" {
		if !attrNamePattern.MatchString(a.ID) {
			fail("libo11y_attr_naming", "naming", a.ID)
		}
		// Namespace ownership: minting names inside semconv-owned or
		// third-party namespaces forfeits upstream rename tooling and
		// invites collisions.
		if !strings.HasPrefix(a.ID, "o11y.") {
			fail("libo11y_namespace_ownership", "ownership", a.ID)
		}

		// Sensitivity drives the runtime redaction layer; an unclassified
		// attribute is a hole. Cardinality budgets guard metric labels.
		sensitivity, hasSensitivity := a.Annotations["o11y.sensitivity"]
		switch {
		case !hasSensitivity && !deprecated:
			fail("libo11y_sensitivity_missing", "sensitivity", a.ID)
		case hasSensitivity && !sensitivityClasses[sensitivity]:
			fail("libo11y_sensitivity_unknown", "sensitivity", a.ID)
		}

		cardinality, hasCardinality := a.Annotations["o11y.cardinality"]
		switch {
		case !hasCardinality && !deprecated:
			fail("libo11y_cardinality_missing", "cardinality", a.ID)
		case hasCardinality && !cardinalityClasses[cardinality]:
			fail("libo11y_cardinality_unknown", "cardinality", a.ID)
		}
	}

	// Secret-class attributes may exist only as documentation of a
	// forbidden key: no signal group may reference one. A reference is a
	// violation when it carries a local secret annotation or when the index
	// records the referenced key as secret elsewhere; a forbidden group
	// defines such keys and is exempt.
	if a.Ref != "" && !isForbiddenGroup(g) {
		if a.Annotations["o11y.sensitivity"] == "secret" || idx.secretKeys[a.Ref] {
			fail("libo11y_secret_referenced", "sensitivity", a.Ref)
		}
	}

	// Unbounded attributes are forbidden as metric labels. Reported via
	// name() rather than Ref so a defined unbounded label still names
	// itself in the violation.
	if g.Type == "metric" && a.Annotations["o11y.cardinality"] == "unbounded" {
		fail("libo11y_unbounded_metric_label", "cardinality", a.name())
	}

	return violations
}

func checkGroup(g group) []violation {
	var violations []violation
	fail := func(ruleID, category, name string) {
		violations = append(violations, violation{RuleID: ruleID, Category: category, Group: g.ID, Attr: name})
	}

	// Event discipline: names are static, dot-namespaced, owned (o11y.*),
	// and every event group declares stability.
	if g.Type == "event" {
		if !strings.HasPrefix(g.Name, "o11y.") {
			fail("libo11y_event_namespace", "events", g.Name)
		}
		if g.Stability == "" {
			fail("libo11y_event_stability", "events", g.Name)
		}
	}

	// Metric rules: UCUM units in the unit field only (no Prometheus-style
	// suffixes), and libo11y instruments live under o11y.*.
	if g.Type == "metric" {
		if strings.HasSuffix(g.MetricName, "_total") {
			fail("libo11y_metric_total_suffix", "units", g.MetricName)
		}
		if strings.HasSuffix(g.MetricName, ".count") {
			fail("libo11y_metric_count_suffix", "units", g.MetricName)
		}
		if g.Unit == "" {
			fail("libo11y_metric_unit_missing", "units", g.MetricName)
		}
		if !strings.HasPrefix(g.MetricName, "o11y.") {
			fail("libo11y_metric_namespace", "units", g.MetricName)
		}
	}

	return violations
}
