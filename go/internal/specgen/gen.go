package main

import (
	"fmt"
	"sort"
	"strings"
)

// genSpec renders the public go/spec package.
func genSpec(m *model) string {
	var b strings.Builder
	header(&b, "spec", m, "log/slog", "go.opentelemetry.io/otel/attribute")

	fmt.Fprintf(&b, "// Spec identity.\nconst (\n")
	fmt.Fprintf(&b, "\t// SchemaURL is stamped on every resource libo11y builds.\n")
	fmt.Fprintf(&b, "\tSchemaURL = %q\n", m.schemaURL)
	fmt.Fprintf(&b, "\t// SpecVersion is the libo11y specification version this module implements.\n")
	fmt.Fprintf(&b, "\tSpecVersion = %q\n", m.specVersion)
	fmt.Fprintf(&b, "\t// SemconvVersion is the pinned OpenTelemetry semantic conventions version.\n")
	fmt.Fprintf(&b, "\tSemconvVersion = %q\n", m.semconvVersion)
	b.WriteString(")\n\n")

	b.WriteString(`// SeverityNumber maps a slog level to its OpenTelemetry log severity
// number. The offset is fixed and normative: Debug=5, Info=9, Warn=13,
// Error=17.
func SeverityNumber(level slog.Level) int { return int(level) + 9 }

// EventNameKey is the log attribute carrying an event's name until the
// bridge can set the top-level EventName record field directly.
const EventNameKey = "event.name"

`)

	// Enums from minted attributes.
	for _, a := range m.minted {
		members := a.enumMembers()
		if len(members) == 0 {
			continue
		}
		typeName := goName(a.ID)
		fmt.Fprintf(&b, "// %s is the closed value set for %s.\ntype %s string\n\nconst (\n", typeName, a.ID, typeName)
		for _, member := range members {
			fmt.Fprintf(&b, "\t%s%s %s = %q\n", typeName, goName(member.ID), typeName, member.Value)
		}
		b.WriteString(")\n\n")
	}

	// Environment enum comes from the deployment.environment.name overlay.
	if envValues := m.environmentValues(); len(envValues) > 0 {
		b.WriteString("// Environment is the closed value set for deployment.environment.name.\n// Org extensions register at Setup with WithEnvironmentValues.\ntype Environment string\n\nconst (\n")
		for _, v := range envValues {
			fmt.Fprintf(&b, "\tEnvironment%s Environment = %q\n", goName(v), v)
		}
		b.WriteString(")\n\n")
	}

	// Minted attribute keys and constructors.
	b.WriteString("// Attribute keys minted by the libo11y specification.\nconst (\n")
	for _, a := range m.minted {
		fmt.Fprintf(&b, "\t%sKey attribute.Key = %q\n", goName(a.ID), a.ID)
	}
	b.WriteString(")\n\n")

	for _, a := range m.minted {
		name := goName(a.ID)
		switch {
		case len(a.enumMembers()) > 0:
			fmt.Fprintf(&b, "// %sValue returns the %s attribute.\nfunc %sValue(v %s) attribute.KeyValue { return %sKey.String(string(v)) }\n\n", name, a.ID, name, name, name)
		case a.scalarType() == "boolean":
			fmt.Fprintf(&b, "// %s returns the %s attribute.\nfunc %s(v bool) attribute.KeyValue { return %sKey.Bool(v) }\n\n", name, a.ID, name, name)
		case a.scalarType() == "double":
			fmt.Fprintf(&b, "// %s returns the %s attribute.\nfunc %s(v float64) attribute.KeyValue { return %sKey.Float64(v) }\n\n", name, a.ID, name, name)
		case a.scalarType() == "int":
			fmt.Fprintf(&b, "// %s returns the %s attribute.\nfunc %s(v int64) attribute.KeyValue { return %sKey.Int64(v) }\n\n", name, a.ID, name, name)
		case strings.HasPrefix(a.scalarType(), "template"):
			fmt.Fprintf(&b, "// %s returns one %s.<key> attribute.\nfunc %s(key, v string) attribute.KeyValue { return attribute.String(%q+key, v) }\n\n", name, a.ID, name, a.ID+".")
		default:
			fmt.Fprintf(&b, "// %s returns the %s attribute.\nfunc %s(v string) attribute.KeyValue { return %sKey.String(v) }\n\n", name, a.ID, name, name)
		}
	}

	// Copied upstream keys (development/RC upstream: copy, don't depend).
	copied := m.copiedRefs()
	if len(copied) > 0 {
		b.WriteString("// Upstream attribute keys copied from the pinned registry snapshot\n// (their upstream definitions are not yet stable).\nconst (\n")
		for _, name := range copied {
			fmt.Fprintf(&b, "\t%sKey attribute.Key = %q\n", goName(name), name)
		}
		b.WriteString(")\n\n")
	}

	// Event names.
	b.WriteString("// Registered event names.\nconst (\n")
	for _, ev := range m.events {
		fmt.Fprintf(&b, "\tEvent%s = %q\n", goName(strings.TrimPrefix(ev.Name, "o11y.")), ev.Name)
	}
	b.WriteString(")\n")

	return b.String()
}

// environmentValues reads the enum annotation off the tier0
// deployment.environment.name ref. The policy suite rejects padded values
// (libo11y_enum_value_whitespace); trimming here keeps the generator from
// ever emitting one.
func (m *model) environmentValues() []string {
	for _, a := range m.tiers["tier0"] {
		if a.name() == "deployment.environment.name" {
			if enum, ok := a.Annotations["o11y.enum"]; ok {
				values := strings.Split(enum, ",")
				for i, v := range values {
					values[i] = strings.TrimSpace(v)
				}
				return values
			}
		}
	}
	return nil
}

// copiedRefs returns the sorted, deduplicated names of refs marked
// o11y.gen: copy across all tier groups.
func (m *model) copiedRefs() []string {
	seen := map[string]bool{}
	for _, tier := range m.tierOrder {
		for _, a := range m.tiers[tier] {
			if a.Annotations["o11y.gen"] == "copy" && !seen[a.name()] {
				seen[a.name()] = true
			}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// genTables renders go/internal/spectables.
func genTables(m *model) (string, error) {
	var b strings.Builder
	header(&b, "spectables", m, "go.opentelemetry.io/otel/attribute")

	b.WriteString(`// Sensitivity classifies an attribute for the redaction layer. The zero
// value, Unclassified, is what SensitivityOf yields for a key the spec has
// no opinion on; the runtime treats unclassified keys like Public ones, but
// the two stay distinguishable.
type Sensitivity int

const (
	Unclassified Sensitivity = iota
	Public
	Internal
	PII
	Secret
)

// Requirement is a spec requirement level.
type Requirement int

const (
	Required Requirement = iota
	ConditionallyRequired
	Recommended
	OptIn
)

// AttrInfo describes one attribute's place in the resource taxonomy.
type AttrInfo struct {
	Tier        string
	Requirement Requirement
	Source      string
	Role        string
}

// EventInfo describes a registered event. Required lists literal
// attribute keys the event must carry. RequiredTemplates lists template
// attributes the event satisfies by carrying at least one
// <template>.<key> attribute.
type EventInfo struct {
	Required          []attribute.Key
	RequiredTemplates []attribute.Key
}

`)

	// Resource taxonomy table.
	b.WriteString("// Resource is the tiered resource-attribute taxonomy.\nvar Resource = map[attribute.Key]AttrInfo{\n")
	for _, tier := range m.tierOrder {
		for _, a := range m.tiers[tier] {
			fmt.Fprintf(&b, "\t%q: {Tier: %q, Requirement: %s, Source: %q, Role: %q},\n",
				a.name(), tier, requirementConst(a.requirement()), a.Annotations["o11y.source"], a.Annotations["o11y.role"])
		}
	}
	b.WriteString("}\n\n")

	// Required tier-0 keys in file order.
	b.WriteString("// RequiredTier0 lists the attributes Setup requires at init.\nvar RequiredTier0 = []attribute.Key{\n")
	for _, a := range m.tiers["tier0"] {
		if a.requirement() == "required" {
			fmt.Fprintf(&b, "\t%q,\n", a.name())
		}
	}
	b.WriteString("}\n\n")

	// Environment enum values.
	b.WriteString("// EnvironmentValues is the base allowed set for deployment.environment.name.\nvar EnvironmentValues = map[string]bool{\n")
	for _, v := range m.environmentValues() {
		fmt.Fprintf(&b, "\t%q: true,\n", v)
	}
	b.WriteString("}\n\n")

	// Sensitivity map over every classified attribute.
	names := make([]string, 0, len(m.classByName))
	for name := range m.classByName {
		names = append(names, name)
	}
	sort.Strings(names)
	b.WriteString("// SensitivityOf classifies every attribute the spec has an opinion on.\nvar SensitivityOf = map[attribute.Key]Sensitivity{\n")
	for _, name := range names {
		class, err := sensitivityConst(m.classByName[name])
		if err != nil {
			return "", fmt.Errorf("attribute %s: %w", name, err)
		}
		fmt.Fprintf(&b, "\t%q: %s,\n", name, class)
	}
	b.WriteString("}\n\n")

	// Legacy keys from the deprecation tombstones.
	legacy := make([]string, 0, len(m.legacyKeys))
	for name := range m.legacyKeys {
		legacy = append(legacy, name)
	}
	sort.Strings(legacy)
	b.WriteString("// LegacyKeys maps each attribute key a pre-spec libo11y release emitted\n// to the spec key that replaces it, from the registry's deprecation\n// tombstones.\nvar LegacyKeys = map[string]attribute.Key{\n")
	for _, name := range legacy {
		fmt.Fprintf(&b, "\t%q: %q,\n", name, m.legacyKeys[name])
	}
	b.WriteString("}\n\n")

	// Metric resource label allowlist.
	b.WriteString("// MetricResourceLabels is the identity quintet: the only resource\n// attributes permitted as effective metric labels.\nvar MetricResourceLabels = []attribute.Key{\n")
	for _, a := range m.metricLabels {
		fmt.Fprintf(&b, "\t%q,\n", a.name())
	}
	b.WriteString("}\n\n")

	// Events registry.
	b.WriteString("// Events maps registered event names to their contracts.\nvar Events = map[string]EventInfo{\n")
	for _, ev := range m.events {
		required, templates := m.eventRequirements(ev)
		var fields []string
		if len(required) > 0 {
			fields = append(fields, fmt.Sprintf("Required: []attribute.Key{%s}", quoteAll(required)))
		}
		if len(templates) > 0 {
			fields = append(fields, fmt.Sprintf("RequiredTemplates: []attribute.Key{%s}", quoteAll(templates)))
		}
		fmt.Fprintf(&b, "\t%q: {%s},\n", ev.Name, strings.Join(fields, ", "))
	}
	b.WriteString("}\n\n")

	// Span shape tables.
	b.WriteString("// SpanRequired maps span kinds registered by the spec to the\n// attributes required on them.\nvar SpanRequired = map[string][]attribute.Key{\n")
	for _, sp := range m.spans {
		kind := sp.Annotations["o11y.span.kind"]
		var required []string
		for _, a := range sp.Attributes {
			if a.requirement() == "required" {
				required = append(required, fmt.Sprintf("%q", a.name()))
			}
		}
		fmt.Fprintf(&b, "\t%q: {%s},\n", kind, strings.Join(required, ", "))
	}
	b.WriteString("}\n")

	return b.String(), nil
}

// eventRequirements splits an event's required attributes into literal keys
// and template attributes. An event satisfies a template requirement with
// any <template>.<key> attribute, never with the bare template name.
func (m *model) eventRequirements(ev group) (required, templates []string) {
	for _, a := range ev.Attributes {
		if a.requirement() != "required" {
			continue
		}
		if strings.HasPrefix(m.typeByName[a.name()], "template") {
			templates = append(templates, a.name())
		} else {
			required = append(required, a.name())
		}
	}
	return required, templates
}

// quoteAll renders names as a comma-separated list of Go string literals.
func quoteAll(names []string) string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = fmt.Sprintf("%q", name)
	}
	return strings.Join(quoted, ", ")
}

func requirementConst(level string) string {
	switch level {
	case "required":
		return "Required"
	case "conditionally_required":
		return "ConditionallyRequired"
	case "opt_in":
		return "OptIn"
	default:
		return "Recommended"
	}
}

// sensitivityConst maps a registry sensitivity class to its generated
// constant. An unknown class is an error, never a guess: falling back to
// any class would misclassify the key at runtime.
func sensitivityConst(class string) (string, error) {
	switch class {
	case "public":
		return "Public", nil
	case "internal":
		return "Internal", nil
	case "pii":
		return "PII", nil
	case "secret":
		return "Secret", nil
	default:
		return "", fmt.Errorf("unknown sensitivity class %q", class)
	}
}

// genSchema renders the OpenTelemetry schema file for the current spec
// version. 1.0.0 is the first versioned release, so it declares no
// transformations; attribute renames made before 1.0.0 are recorded in the
// registry's deprecation tombstones (spectables.LegacyKeys).
//
// A later version's schema file must list every earlier version with its
// transformations, which the registry does not yet record, so any version
// after 1.0.0 is refused rather than rendered without its history.
func genSchema(m *model) (string, error) {
	if m.specVersion != firstSpecVersion {
		return "", fmt.Errorf("schema file for spec %s: only %s is supported until the registry records the version history and its transformations", m.specVersion, firstSpecVersion)
	}
	var b strings.Builder
	b.WriteString("# Code generated by specgen from spec/registry. DO NOT EDIT.\n")
	b.WriteString("file_format: 1.1.0\n")
	// Go's %q escapes are a subset of YAML's double-quoted escapes, so the
	// URL is quoted safely whatever characters it holds.
	fmt.Fprintf(&b, "schema_url: %q\n", m.schemaURL)
	b.WriteString("versions:\n")
	fmt.Fprintf(&b, "  %s:\n", m.specVersion)
	return b.String(), nil
}

// firstSpecVersion is the first versioned spec release, the only one whose
// schema file needs no earlier versions.
const firstSpecVersion = "1.0.0"

// genDocs renders the taxonomy markdown.
func genDocs(m *model) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# libo11y resource taxonomy (spec %s)\n\n", m.specVersion)
	fmt.Fprintf(&b, "Generated from `spec/registry`; do not edit. Semconv pin: v%s.\n", m.semconvVersion)
	for _, tier := range m.tierOrder {
		fmt.Fprintf(&b, "\n## %s\n\n", tier)
		b.WriteString("| Attribute | Requirement | Source | Role | Sensitivity | Signals |\n")
		b.WriteString("|---|---|---|---|---|---|\n")
		for _, a := range m.tiers[tier] {
			fmt.Fprintf(&b, "| `%s` | %s | %s | %s | %s | %s |\n",
				a.name(), a.requirement(), a.Annotations["o11y.source"],
				a.Annotations["o11y.role"], m.classByName[a.name()], a.Annotations["o11y.signals"])
		}
	}
	if len(m.forbidden) > 0 {
		b.WriteString("\n## Forbidden keys\n\n")
		b.WriteString("Never emitted by default. The sensitivity layer drops `secret` keys on\n")
		b.WriteString("every signal and `pii` keys unless a PII mode permits them. These keys\n")
		b.WriteString("are not a tier and have no generated key constants.\n\n")
		b.WriteString("| Attribute | Sensitivity | Reason |\n|---|---|---|\n")
		for _, a := range m.forbidden {
			fmt.Fprintf(&b, "| `%s` | %s | %s |\n", a.name(), m.classByName[a.name()], strings.TrimSpace(a.Brief))
		}
	}
	b.WriteString("\n## Registered events\n\n| Event | Required attributes |\n|---|---|\n")
	for _, ev := range m.events {
		required, templates := m.eventRequirements(ev)
		cells := make([]string, 0, len(required)+len(templates))
		for _, name := range required {
			cells = append(cells, "`"+name+"`")
		}
		for _, name := range templates {
			cells = append(cells, "`"+name+".<key>`")
		}
		fmt.Fprintf(&b, "| `%s` | %s |\n", ev.Name, strings.Join(cells, ", "))
	}
	return b.String()
}
