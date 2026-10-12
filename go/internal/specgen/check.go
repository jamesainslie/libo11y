package main

import (
	"fmt"
	"regexp"
	"slices"
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

	// ucumUnit accepts dimensionless 1, percent, or one UCUM term with an
	// optional per-term (By/s, {request}/s). A term is an allowlisted UCUM
	// atom or a curly-brace annotation such as {request}; spelled-out words
	// such as seconds or bytes are not UCUM.
	ucumUnit = regexp.MustCompile(`^(1|%|` + ucumTerm + `(/` + ucumTerm + `)?)$`)

	// annotationKeys are the annotation keys the registry, the checks, and
	// the generator understand. Anything else is a typo or an unreviewed
	// extension.
	annotationKeys = map[string]bool{
		"o11y.sensitivity": true, "o11y.cardinality": true, "o11y.gen": true,
		"o11y.source": true, "o11y.role": true, "o11y.signals": true,
		"o11y.type": true, "o11y.tier": true, "o11y.enum": true,
		"o11y.fallback": true, "o11y.derivation": true, "o11y.span.kind": true,
		"o11y.metric_labels": true, "o11y.legacy_key": true,
	}

	// cardinalityRank orders cardinality classes from least to most
	// dangerous as a metric label.
	cardinalityRank = map[string]int{"enum": 1, "bounded": 2, "unbounded": 3}
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
	"libo11y_go_name_collision":       true,
	"libo11y_cardinality_conflict":    true,
	"libo11y_legacy_key_duplicate":    true,
}

const ucumTerm = `(s|ms|us|ns|min|h|d|By|KiBy|MiBy|GiBy|bit|Hz|\{[a-z][a-z0-9_.]*\})`

// stricterCardinality returns whichever of two cardinality classes is the
// more dangerous as a metric label, so a local annotation can tighten a
// definition's class but never loosen it.
func stricterCardinality(a, b string) string {
	if cardinalityRank[b] > cardinalityRank[a] {
		return b
	}
	return a
}

// unknownAnnotations returns the annotation keys outside annotationKeys,
// sorted for stable output.
func unknownAnnotations(annotations map[string]string) []string {
	var unknown []string
	for key := range annotations {
		if !annotationKeys[key] {
			unknown = append(unknown, key)
		}
	}
	slices.Sort(unknown)
	return unknown
}

// index is a whole-registry view built in a first pass and consulted by the
// per-attribute checks in the second pass. secretKeys are attribute names
// classified secret anywhere in the registry; mintedNames are the o11y.*
// names defined by the registry; cardinality maps each defined attribute to
// its cardinality class so a bare ref resolves to it; definitions counts the
// definitions of each attribute name; classByRef collects every sensitivity
// class any occurrence of an attribute declares and cardByRef every
// cardinality class; goNames maps each Go
// identifier the generator derives for a minted or copied key to the
// attribute names that produce it; names holds every attribute name the
// registry defines or references; legacyKeys counts the tombstones claiming
// each o11y.legacy_key.
//
// Only o11y.* references are resolved: the registry vendors no upstream
// semantic conventions, so references to upstream keys (http.*, k8s.*, ...)
// are not validated here. A future pinned semconv snapshot will
// populate upstreamKeys and extend the ref and deprecation rules to them;
// until then upstreamKeys is empty.
type index struct {
	secretKeys   map[string]bool
	mintedNames  map[string]bool
	upstreamKeys map[string]semconvEntry
	cardinality  map[string]string          // defined attribute -> cardinality
	definitions  map[string]int             // defined attribute -> definition count
	classByRef   map[string]map[string]bool // attribute -> sensitivity classes seen anywhere
	cardByRef    map[string]map[string]bool // attribute -> cardinality classes seen anywhere
	goNames      map[string]map[string]bool // generated Go name -> attribute names
	names        map[string]bool            // every attribute name defined or referenced
	legacyKeys   map[string]int             // o11y.legacy_key value -> claiming tombstones
}

// semconvEntry is a placeholder for the upstream attribute record the
// future pinned semconv snapshot will provide to the ref and deprecation rules.
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
		cardByRef:    map[string]map[string]bool{},
		goNames:      map[string]map[string]bool{},
		names:        map[string]bool{},
		legacyKeys:   map[string]int{},
	}
	for _, g := range groups {
		for _, a := range g.Attributes {
			idx.names[a.name()] = true
			if legacy, ok := a.Annotations["o11y.legacy_key"]; ok {
				idx.legacyKeys[legacy]++
			}
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
				addToSet(idx.classByRef, a.name(), class)
			}
			if card, ok := a.Annotations["o11y.cardinality"]; ok {
				addToSet(idx.cardByRef, a.name(), card)
			}
			if generatesKey(a) {
				addToSet(idx.goNames, goName(a.name()), a.name())
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

// generatesKey reports whether the generator emits a Go key constant for
// a: every minted o11y.* definition and every ref copied from upstream
// (o11y.gen: copy).
func generatesKey(a attr) bool {
	if a.ID != "" {
		return strings.HasPrefix(a.ID, "o11y.")
	}
	return a.Annotations["o11y.gen"] == "copy"
}

// enumValues returns the raw closed value set an attribute declares: its
// enum member values and the entries of any o11y.enum annotation.
func enumValues(a attr) []string {
	var values []string
	for _, member := range a.enumMembers() {
		values = append(values, member.Value)
	}
	if enum, ok := a.Annotations["o11y.enum"]; ok {
		values = append(values, strings.Split(enum, ",")...)
	}
	return values
}

// addToSet adds value to the set held under key, creating it on first use.
func addToSet(sets map[string]map[string]bool, key, value string) {
	if sets[key] == nil {
		sets[key] = map[string]bool{}
	}
	sets[key][value] = true
}

// deprecatedTarget returns the renamed_to target of a deprecated attribute
// whose deprecation is written in mapping form, and "" otherwise.
func deprecatedTarget(a attr) string {
	if a.Deprecated.Kind != yaml.MappingNode {
		return ""
	}
	var deprecation deprecationSpec
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
	} else {
		// A reference may restate a class; a restated class must still be
		// a known one.
		if class, ok := a.Annotations["o11y.sensitivity"]; ok && !sensitivityClasses[class] {
			fail("libo11y_sensitivity_unknown", "sensitivity", a.Ref)
		}
		if class, ok := a.Annotations["o11y.cardinality"]; ok && !cardinalityClasses[class] {
			fail("libo11y_cardinality_unknown", "cardinality", a.Ref)
		}
	}

	for _, key := range unknownAnnotations(a.Annotations) {
		fail("libo11y_annotation_unknown", "annotations", a.name()+" "+key)
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

	// Every occurrence of a name must agree on its cardinality; otherwise a
	// local annotation could relabel an unbounded key as bounded.
	if classes := idx.cardByRef[a.name()]; len(classes) > 1 {
		fail("libo11y_cardinality_conflict", "cardinality", a.name())
	}

	// Metric labels: unbounded attributes are forbidden, and every label
	// must have a known cardinality, annotated locally or resolved through
	// the attribute's definition. The stricter of the two applies, so a
	// local annotation can never loosen the definition's class. Reported
	// via name() so a defined label still names itself in the violation.
	if g.Type == "metric" {
		switch stricterCardinality(a.Annotations["o11y.cardinality"], idx.cardinality[a.name()]) {
		case "unbounded":
			fail("libo11y_unbounded_metric_label", "cardinality", a.name())
		case "":
			fail("libo11y_metric_label_unclassified", "cardinality", a.name())
		}
	}

	if target := deprecatedTarget(a); strings.HasPrefix(target, "o11y.") && !idx.mintedNames[target] {
		fail("libo11y_deprecated_target_undefined", "references", target)
	}

	// Two keys that map to one Go identifier would make the generated
	// package fail to compile.
	if generatesKey(a) && len(idx.goNames[goName(a.name())]) > 1 {
		fail("libo11y_go_name_collision", "naming", a.name())
	}

	// Enum values are emitted verbatim as Go constants and runtime
	// allowlists: each must be unique and carry no padding.
	for _, member := range a.enumMembers() {
		if member.ID == "" || member.Value == "" {
			fail("libo11y_enum_member_empty", "enums", a.name())
		}
	}
	seenValues := map[string]bool{}
	for _, v := range enumValues(a) {
		if v != strings.TrimSpace(v) {
			fail("libo11y_enum_value_whitespace", "enums", a.name())
		}
		if v = strings.TrimSpace(v); seenValues[v] {
			fail("libo11y_enum_duplicate_value", "enums", a.name())
		}
		seenValues[v] = true
	}

	if a.Stability != "" && !stabilities[a.Stability] {
		fail("libo11y_stability_unknown", "stability", a.name())
	}
	if !requirementLevels[a.requirement()] {
		fail("libo11y_requirement_unknown", "requirement", a.name())
	}

	if legacy, ok := a.Annotations["o11y.legacy_key"]; ok {
		violations = append(violations, checkLegacyKey(g, a, legacy, idx)...)
	}

	return violations
}

// checkLegacyKey validates an o11y.legacy_key annotation, which feeds
// spectables.LegacyKeys: the key a pre-spec release emitted, mapped to the
// tombstone's replacement. The tombstone must name a replacement
// (renamed_to); the legacy key must be non-empty, differ from that
// replacement, and not be a name the registry still defines or references;
// and only one tombstone may claim it.
func checkLegacyKey(g group, a attr, legacy string, idx *index) []violation {
	var violations []violation
	fail := func(ruleID, attrName string) {
		violations = append(violations, violation{RuleID: ruleID, Category: "references", Group: g.ID, Attr: attrName})
	}
	target := deprecatedTarget(a)
	if target == "" {
		fail("libo11y_legacy_key_unrenamed", a.name())
	}
	if strings.TrimSpace(legacy) == "" || legacy == target || idx.names[legacy] {
		fail("libo11y_legacy_key_invalid", a.name())
	}
	if idx.legacyKeys[legacy] > 1 {
		fail("libo11y_legacy_key_duplicate", legacy)
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
	for _, key := range unknownAnnotations(g.Annotations) {
		fail("libo11y_annotation_unknown", "annotations", key)
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
