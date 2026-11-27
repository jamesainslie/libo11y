package main

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// rumSpecPath is the o11yrum gateway's copy of the tables it validates
// against. The gateway versions independently of the core module, so it
// cannot rely on go/internal/spectables at a matching version.
const rumSpecPath = "go/o11yrum/internal/rumspec/rumspec.go"

const rumSpecDoc = `Package rumspec holds the libo11y specification tables the o11yrum
gateway validates incoming telemetry against: sensitivity and cardinality
classes, attribute types, enum members, event and span requirements, and
the RUM metric definitions.`

const rumSpecTypes = `// Sensitivity classifies an attribute. Unclassified is the zero value.
type Sensitivity uint8

// Sensitivity classes, from the o11y.sensitivity annotation.
const (
	Unclassified Sensitivity = iota
	Public
	Internal
	PII
	Secret
)

// Cardinality classifies how many values an attribute takes.
type Cardinality uint8

// Cardinality classes, from the o11y.cardinality annotation.
const (
	CardinalityUnknown Cardinality = iota
	Enum
	Bounded
	Unbounded
)

// Metric describes one registered metric.
type Metric struct {
	Instrument string
	Unit       string
	Brief      string
	Labels     []string
	Required   []string
}

`

// genRUMSpec renders the gateway's spec tables.
func genRUMSpec(m *model) (string, error) {
	var b strings.Builder
	header(&b, "rumspec", rumSpecDoc, m)
	fmt.Fprintf(&b, "// SpecVersion is the libo11y specification version these tables implement.\nconst SpecVersion = %q\n\n", m.specVersion)
	b.WriteString(rumSpecTypes)

	b.WriteString("// Sensitivities maps each classified attribute to its class.\nvar Sensitivities = map[string]Sensitivity{\n")
	for _, k := range slices.Sorted(maps.Keys(m.classByName)) {
		c, err := sensitivityConst(m.classByName[k])
		if err != nil {
			return "", fmt.Errorf("attribute %s: %w", k, err)
		}
		fmt.Fprintf(&b, "\t%q: %s,\n", k, c)
	}

	b.WriteString("}\n\n// Cardinalities maps each classified attribute to its cardinality.\nvar Cardinalities = map[string]Cardinality{\n")
	for _, k := range slices.Sorted(maps.Keys(m.cardByName)) {
		c, err := rumCardinalityConst(m.cardByName[k])
		if err != nil {
			return "", fmt.Errorf("attribute %s: %w", k, err)
		}
		fmt.Fprintf(&b, "\t%q: %s,\n", k, c)
	}

	b.WriteString("}\n\n// Types maps each attribute the registry defines to its type.\nvar Types = map[string]string{\n")
	for _, k := range slices.Sorted(maps.Keys(m.typeByName)) {
		fmt.Fprintf(&b, "\t%q: %q,\n", k, m.typeByName[k])
	}

	b.WriteString("}\n\n// Enums maps each enum attribute to its member values, in registry order.\nvar Enums = map[string][]string{\n")
	var templates []string
	for _, a := range m.minted {
		if strings.HasPrefix(m.typeByName[a.ID], "template") {
			templates = append(templates, a.ID)
		}
		members := a.enumMembers()
		if len(members) == 0 {
			continue
		}
		values := make([]string, 0, len(members))
		for _, mem := range members {
			values = append(values, mem.Value)
		}
		fmt.Fprintf(&b, "\t%q: {%s},\n", a.ID, quoteAll(values))
	}
	slices.Sort(templates)
	fmt.Fprintf(&b, "}\n\n// Templates lists template attributes; a key <template>.<name> is defined.\nvar Templates = []string{%s}\n\n", quoteAll(templates))

	b.WriteString("// Events maps each registered event to its required attributes.\nvar Events = map[string][]string{\n")
	eventTemplates := map[string][]string{}
	for _, ev := range m.events {
		required, templates := m.eventRequirements(ev)
		fmt.Fprintf(&b, "\t%q: {%s},\n", ev.Name, quoteAll(required))
		if len(templates) > 0 {
			eventTemplates[ev.Name] = templates
		}
	}
	b.WriteString("}\n\n// EventTemplates maps each event that requires a template attribute to\n// those templates; any <template>.<name> attribute satisfies one.\nvar EventTemplates = map[string][]string{\n")
	for _, name := range slices.Sorted(maps.Keys(eventTemplates)) {
		fmt.Fprintf(&b, "\t%q: {%s},\n", name, quoteAll(eventTemplates[name]))
	}

	b.WriteString("}\n\n// RUMSpanRequired maps each RUM span shape to its required attributes.\nvar RUMSpanRequired = map[string][]string{\n")
	for _, g := range m.rumSpans {
		fmt.Fprintf(&b, "\t%q: {%s},\n", g.Annotations["o11y.rum.span"], quoteAll(requiredNames(g)))
	}

	b.WriteString("}\n\n// Metrics maps each registered metric to its definition.\nvar Metrics = map[string]Metric{\n")
	for _, mt := range m.metrics {
		labels := make([]string, 0, len(mt.Attributes))
		for _, a := range mt.Attributes {
			labels = append(labels, a.name())
		}
		fmt.Fprintf(&b, "\t%q: {Instrument: %q, Unit: %q, Brief: %q, Labels: []string{%s}, Required: []string{%s}},\n",
			mt.MetricName, mt.Instrument, mt.Unit, strings.TrimSpace(mt.Brief), quoteAll(labels), quoteAll(requiredNames(mt)))
	}
	b.WriteString("}\n")
	return b.String(), nil
}

// rumCardinalityConst maps a registry cardinality class to its rumspec
// constant. An unknown class is an error, never a guess.
func rumCardinalityConst(class string) (string, error) {
	switch class {
	case "enum":
		return "Enum", nil
	case "bounded":
		return "Bounded", nil
	case "unbounded":
		return "Unbounded", nil
	default:
		return "", fmt.Errorf("unknown cardinality class %q", class)
	}
}
