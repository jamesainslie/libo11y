package main

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// The policy suite below is the normative validation for the libo11y
// registry, replacing the earlier external policy runner. Each rule ID is
// stable and listed in docs/SPEC.md section 8.

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
	// within segments, at least two segments. Event and metric names
	// follow the same shape.
	attrNamePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$`)

	// stabilities are the stability levels the semconv registry schema
	// accepts, on groups and attributes alike.
	stabilities = map[string]bool{
		"stable": true, "development": true, "deprecated": true,
		"release_candidate": true, "alpha": true, "beta": true,
	}
	instruments       = map[string]bool{"counter": true, "updowncounter": true, "histogram": true, "gauge": true}
	requirementLevels = map[string]bool{"required": true, "recommended": true, "opt_in": true, "conditionally_required": true}

	// ucumUnit accepts the UCUM subset the registry uses: dimensionless 1,
	// percent, a curly-brace annotation such as {request}, or a unit atom
	// with an optional per-unit (By, ms, By/s).
	ucumUnit = regexp.MustCompile(`^(1|%|\{[a-z][a-z0-9_.]*\}|[A-Za-z]+(/[A-Za-z]+)?)$`)
	// unitInName catches a unit smuggled into a metric name; units belong
	// in the unit field only.
	unitInName = regexp.MustCompile(`[._](ms|us|ns|s|seconds|milliseconds|bytes|by|kb|mb|percent)$`)
)

// registryWideRules are findings about an attribute name across the whole
// registry rather than about one occurrence of it; checkGroups reports each
// (rule, attribute) pair once, at its first occurrence.
var registryWideRules = map[string]bool{
	"libo11y_attr_duplicate":          true,
	"libo11y_classification_conflict": true,
}

// index is a whole-registry view built in a first pass and consulted by the
// per-attribute checks in the second pass. secretKeys are attribute names
// classified secret anywhere in the registry; mintedNames are the o11y.*
// names defined by the registry; cardinality maps each defined attribute to
// its cardinality class so a bare ref resolves to it; definitions counts the
// definitions of each attribute name; classByRef collects every sensitivity
// class any occurrence of an attribute declares.
//
// Only o11y.* references are resolved: the registry vendors no upstream
// semantic conventions, so references to upstream keys (http.*, k8s.*, ...)
// are not validated here. Phase 2 adds a pinned semconv snapshot, which will
// populate upstreamKeys and extend the ref and deprecation rules to them;
// until then upstreamKeys is empty.
type index struct {
	secretKeys   map[string]bool
	mintedNames  map[string]bool
	upstreamKeys map[string]semconvEntry
	cardinality  map[string]string          // defined attribute -> cardinality
	definitions  map[string]int             // defined attribute -> definition count
	classByRef   map[string]map[string]bool // attribute -> sensitivity classes seen anywhere
}

// semconvEntry is a placeholder for the upstream attribute record the
// Phase 2 semconv snapshot will provide to the ref and deprecation rules.
type semconvEntry struct{}

// buildIndex runs the first pass over the registry, collecting the
// cross-group facts the per-attribute checks need: which keys are secret,
// which o11y.* names the registry mints, how each defined attribute's
// cardinality is classified, how often each name is defined, and which
// sensitivity classes each name carries.
func buildIndex(groups []group) *index {
	idx := &index{
		secretKeys:   map[string]bool{},
		mintedNames:  map[string]bool{},
		upstreamKeys: map[string]semconvEntry{},
		cardinality:  map[string]string{},
		definitions:  map[string]int{},
		classByRef:   map[string]map[string]bool{},
	}
	for _, g := range groups {
		for _, a := range g.Attributes {
			if a.Annotations["o11y.sensitivity"] == "secret" {
				idx.secretKeys[a.name()] = true
			}
			if a.ID != "" {
				idx.definitions[a.ID]++
				if strings.HasPrefix(a.ID, "o11y.") {
					idx.mintedNames[a.ID] = true
				}
				if card, ok := a.Annotations["o11y.cardinality"]; ok {
					idx.cardinality[a.ID] = card
				}
			}
			if class, ok := a.Annotations["o11y.sensitivity"]; ok {
				if idx.classByRef[a.name()] == nil {
					idx.classByRef[a.name()] = map[string]bool{}
				}
				idx.classByRef[a.name()][class] = true
			}
		}
	}
	return idx
}

// isForbiddenGroup reports whether a group documents forbidden keys rather
// than emitting them. A secret key defined in such a group is a permitted
// definition; a reference to it from any other group is a violation. The
// group is recognized by its ID ending in .forbidden, never by substring.
func isForbiddenGroup(g group) bool {
	return strings.HasSuffix(g.ID, ".forbidden")
}

// checkGroups validates registry groups against the libo11y policy suite:
// naming, namespace ownership, references, sensitivity and cardinality
// classification, stability and requirement enums, event discipline, and
// metric naming, instrument, and unit rules. It runs as a second pass over
// the prebuilt idx, which carries the cross-group facts the per-attribute
// rules consult. Registry-wide findings are reported once per attribute.
func checkGroups(groups []group, idx *index) []violation {
	var violations []violation
	for _, g := range groups {
		for _, a := range g.Attributes {
			violations = append(violations, checkAttribute(g, a, idx)...)
		}
		violations = append(violations, checkGroup(g)...)
	}
	return dedupeRegistryWide(violations)
}

// dedupeRegistryWide keeps the first occurrence of each registry-wide
// (rule, attribute) finding and every other violation as is.
func dedupeRegistryWide(violations []violation) []violation {
	seen := map[[2]string]bool{}
	kept := violations[:0]
	for _, v := range violations {
		if registryWideRules[v.RuleID] {
			key := [2]string{v.RuleID, v.Attr}
			if seen[key] {
				continue
			}
			seen[key] = true
		}
		kept = append(kept, v)
	}
	return kept
}

// deprecatedTarget returns the renamed_to target of a deprecated attribute
// whose deprecation is written in mapping form, and "" otherwise.
func deprecatedTarget(a attr) string {
	if a.Deprecated.Kind != yaml.MappingNode {
		return ""
	}
	var deprecation struct {
		RenamedTo string `yaml:"renamed_to"`
	}
	if err := a.Deprecated.Decode(&deprecation); err != nil {
		return ""
	}
	return deprecation.RenamedTo
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

	// References into the owned namespace must resolve to a definition.
	if a.Ref != "" && strings.HasPrefix(a.Ref, "o11y.") && !idx.mintedNames[a.Ref] {
		fail("libo11y_ref_undefined", "references", a.Ref)
	}
	// One definition per name: a second silently shadows the first.
	if a.ID != "" && idx.definitions[a.ID] > 1 {
		fail("libo11y_attr_duplicate", "references", a.ID)
	}
	// The redaction layer holds one class per key; two occurrences that
	// disagree leave the effective class to file order.
	if classes := idx.classByRef[a.name()]; len(classes) > 1 {
		fail("libo11y_classification_conflict", "sensitivity", a.name())
	}

	// Metric labels: unbounded attributes are forbidden, and every label
	// must have a known cardinality, either annotated locally or resolved
	// through the attribute's definition. Reported via name() so a defined
	// label still names itself in the violation.
	if g.Type == "metric" {
		card := a.Annotations["o11y.cardinality"]
		if card == "" {
			card = idx.cardinality[a.name()]
		}
		switch card {
		case "unbounded":
			fail("libo11y_unbounded_metric_label", "cardinality", a.name())
		case "":
			fail("libo11y_metric_label_unclassified", "cardinality", a.name())
		}
	}

	if target := deprecatedTarget(a); strings.HasPrefix(target, "o11y.") && !idx.mintedNames[target] {
		fail("libo11y_deprecated_target_undefined", "references", target)
	}

	if a.Stability != "" && !stabilities[a.Stability] {
		fail("libo11y_stability_unknown", "stability", a.name())
	}
	if !requirementLevels[a.requirement()] {
		fail("libo11y_requirement_unknown", "requirement", a.name())
	}

	return violations
}

func checkGroup(g group) []violation {
	var violations []violation
	fail := func(ruleID, category, name string) {
		violations = append(violations, violation{RuleID: ruleID, Category: category, Group: g.ID, Attr: name})
	}

	if g.Stability != "" && !stabilities[g.Stability] {
		fail("libo11y_stability_unknown", "stability", g.ID)
	}

	// Event discipline: names are static, dot-namespaced, owned (o11y.*),
	// and every event group declares stability.
	if g.Type == "event" {
		if !strings.HasPrefix(g.Name, "o11y.") {
			fail("libo11y_event_namespace", "events", g.Name)
		}
		if !attrNamePattern.MatchString(g.Name) {
			fail("libo11y_event_naming", "naming", g.Name)
		}
		if g.Stability == "" {
			fail("libo11y_event_stability", "events", g.Name)
		}
	}

	// Metric rules: dotted snake_case names under o11y.*, a known
	// instrument, and UCUM units in the unit field only (no
	// Prometheus-style or unit suffixes in the name).
	if g.Type == "metric" {
		if !attrNamePattern.MatchString(g.MetricName) {
			fail("libo11y_metric_naming", "naming", g.MetricName)
		}
		if !instruments[g.Instrument] {
			fail("libo11y_instrument_unknown", "metrics", g.MetricName)
		}
		if strings.HasSuffix(g.MetricName, "_total") {
			fail("libo11y_metric_total_suffix", "units", g.MetricName)
		}
		if strings.HasSuffix(g.MetricName, ".count") {
			fail("libo11y_metric_count_suffix", "units", g.MetricName)
		}
		if unitInName.MatchString(g.MetricName) {
			fail("libo11y_metric_unit_in_name", "units", g.MetricName)
		}
		if g.Unit == "" {
			fail("libo11y_metric_unit_missing", "units", g.MetricName)
		} else if !ucumUnit.MatchString(g.Unit) {
			fail("libo11y_metric_unit_invalid", "units", g.Unit)
		}
		if !strings.HasPrefix(g.MetricName, "o11y.") {
			fail("libo11y_metric_namespace", "units", g.MetricName)
		}
	}

	return violations
}
