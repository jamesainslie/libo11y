package main

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

// Where the Rust artifacts land, inside the libo11y-spec crate.
const (
	rustSpecPath    = "rust/libo11y-spec/src/generated/spec.rs"
	rustTablesPath  = "rust/libo11y-spec/src/generated/tables.rs"
	rustGoPrintPath = "rust/libo11y-spec/src/generated/goprint.rs"
)

// rustfmt's default limits, which the generated layout reproduces so the
// output is rustfmt-clean without running rustfmt: the line width, the
// widest list (array or tuple) kept on one line, and the widest element
// that still counts as short, which lets a list of short elements fill
// lines instead of going one element per line.
const (
	rustMaxWidth      = 100
	rustListWidth     = 60
	rustShortListItem = 10
	rustIndent        = "    "
)

// rustReservedTypes are the type names a generated enum may not take: the
// hand-written types at the libo11y-spec crate root, which silently shadow
// a glob re-export of the same name, the generated Environment enum, and
// the prelude names the crate and the generated code use unqualified,
// which a glob import would shadow.
var rustReservedTypes = map[string]bool{
	"EventInfo": true, "Instrument": true, "MetricInfo": true, "ParseEnumError": true,
	"Requirement": true, "ResourceAttr": true, "Sensitivity": true, "SpanShape": true,
	"Environment": true,
	"Self":        true, "Box": true, "Err": true, "None": true, "Ok": true, "Option": true,
	"Result": true, "Some": true, "String": true, "Vec": true,
}

// rustReservedVariants are the variant names that would collide with an
// enum's own associated items.
var rustReservedVariants = map[string]bool{"Self": true, "KEY": true, "ALL": true}

// environmentKey is the attribute the generated Environment enum covers.
const environmentKey = "deployment.environment.name"

var rustIdent = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)

// errRustName reports a registry name the Rust crate cannot carry.
var errRustName = errors.New("rust name")

// rustWidth is the width rustfmt gives s: one column per character, which
// holds for the ASCII the registry uses. A wide character would be
// mismeasured, and the rust job's cargo fmt --check would catch it.
func rustWidth(s string) int {
	return utf8.RuneCountInString(s)
}

// rustSegments splits a dotted, snake or kebab name into its words.
func rustSegments(name string) []string {
	return strings.FieldsFunc(name, func(r rune) bool { return r == '.' || r == '_' || r == '-' })
}

// rustTypeName converts a dotted attribute name or an enum member ID to an
// UpperCamelCase Rust identifier, dropping an o11y. prefix. Acronyms are
// one word, as the Rust API guidelines ask: ios becomes Ios.
func rustTypeName(name string) string {
	var b strings.Builder
	for _, segment := range rustSegments(strings.TrimPrefix(name, "o11y.")) {
		first, size := utf8.DecodeRuneInString(segment)
		b.WriteRune(unicode.ToUpper(first))
		b.WriteString(segment[size:])
	}
	return b.String()
}

// rustConstName converts a dotted name to a SCREAMING_SNAKE_CASE Rust
// constant name, dropping an o11y. prefix: o11y.rum.view.name becomes
// RUM_VIEW_NAME.
func rustConstName(name string) string {
	return strings.ToUpper(strings.Join(rustSegments(strings.TrimPrefix(name, "o11y.")), "_"))
}

// rustQuote renders s as a Rust string literal. Printable characters other
// than the quote and the backslash stay as they are; everything else is
// escaped.
func rustQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case 0:
			b.WriteString(`\0`)
		default:
			if unicode.IsPrint(r) {
				b.WriteRune(r)
			} else {
				fmt.Fprintf(&b, `\u{%x}`, r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// rustQuoteAll quotes every name.
func rustQuoteAll(names []string) []string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = rustQuote(name)
	}
	return quoted
}

// rustList renders items, already rendered as single-line expressions,
// between open and close the way rustfmt lays out an array or a tuple.
// indent is the indentation level of the line the list starts on and lead
// the width of that line before open. Every list the generator writes is
// followed by one character, the comma or semicolon that ends its line.
// The list stays on one line when its items fit in rustListWidth and the
// line fits in rustMaxWidth. Otherwise a list of short literals fills
// lines, and any other list puts one item per line.
func rustList(open, closer string, items []string, indent, lead int) string {
	if len(items) == 0 {
		return open + closer
	}
	oneLine := strings.Join(items, ", ")
	if rustWidth(oneLine) <= rustListWidth && lead+rustWidth(open+oneLine+closer)+1 <= rustMaxWidth {
		return open + oneLine + closer
	}
	inner := strings.Repeat(rustIndent, indent+1)
	var b strings.Builder
	b.WriteString(open)
	b.WriteString("\n")
	short := len(items) > 1
	for _, item := range items {
		short = short && rustWidth(item) <= rustShortListItem && rustLiteral(item)
	}
	if short {
		line := inner
		for _, item := range items {
			next := line
			if next != inner {
				next += " "
			}
			next += item + ","
			if rustWidth(next) > rustMaxWidth && line != inner {
				b.WriteString(line + "\n")
				next = inner + item + ","
			}
			line = next
		}
		b.WriteString(line + "\n")
	} else {
		for _, item := range items {
			b.WriteString(inner + item + ",\n")
		}
	}
	b.WriteString(strings.Repeat(rustIndent, indent) + closer)
	return b.String()
}

// rustAssign renders `decl = &[items];` at the given indentation level.
// When the slice would fit on one line but the declaration leaves it too
// little room, rustfmt moves the slice to its own line rather than break
// it up, and so does rustAssign.
func rustAssign(indent int, decl string, items []string) string {
	pad := strings.Repeat(rustIndent, indent)
	head := pad + decl + " ="
	oneLine := strings.Join(items, ", ")
	if len(items) > 0 && rustWidth(oneLine) <= rustListWidth {
		sameLine := rustWidth(head) + rustWidth(" &["+oneLine+"];")
		nextLine := rustWidth(pad+rustIndent) + rustWidth("&["+oneLine+"];")
		if sameLine > rustMaxWidth && nextLine <= rustMaxWidth {
			return head + "\n" + pad + rustIndent + "&[" + oneLine + "];\n"
		}
	}
	return head + " " + rustList("&[", "]", items, indent, rustWidth(head)+1) + ";\n"
}

// rustLiteral reports whether item is a string or numeric literal, the only
// elements rustfmt lets fill lines.
func rustLiteral(item string) bool {
	return item != "" && (item[0] == '"' || (item[0] >= '0' && item[0] <= '9'))
}

// rustConst renders one `pub const NAME: ty = value;` line at the given
// indentation level, moving the value to its own line when the whole does
// not fit, as rustfmt does.
func rustConst(indent int, name, ty, value string) string {
	pad := strings.Repeat(rustIndent, indent)
	line := fmt.Sprintf("%spub const %s: %s = %s;", pad, name, ty, value)
	if rustWidth(line) <= rustMaxWidth {
		return line + "\n"
	}
	return fmt.Sprintf("%spub const %s: %s =\n%s%s%s;\n", pad, name, ty, pad, rustIndent, value)
}

// rustDocSafe reports whether text can go into a doc comment verbatim:
// rustdoc reads doc comments as Markdown, so anything that could open an
// HTML tag, a link, a code span or an emphasis run, or end the comment
// line, is refused.
func rustDocSafe(text string) bool {
	return text != "" && !strings.ContainsAny(text, "<>[]`\n\r\\*") && !strings.ContainsFunc(text, func(r rune) bool { return !unicode.IsPrint(r) })
}

// rustHeader writes the generated-file banner.
func rustHeader(b *strings.Builder, m *model) {
	fmt.Fprintf(b, "// Code generated by specgen from spec/registry (spec %s). DO NOT EDIT.\n", m.specVersion)
}

// rustEnum is a closed value set rendered as a Rust enum.
type rustEnum struct {
	typeName string
	key      string // the attribute key the values belong to
	members  []enumMember
	variants []string
}

// rustEnums collects every closed enum the spec module declares: one per
// minted enum attribute, then Environment. It refuses names Rust cannot
// carry and names that collide.
func (m *model) rustEnums() ([]rustEnum, error) {
	var enums []rustEnum
	for _, a := range m.minted {
		if members := a.enumMembers(); len(members) > 0 {
			enums = append(enums, rustEnum{typeName: rustTypeName(a.ID), key: a.ID, members: members})
		}
	}
	if env := m.environmentValues(); len(env) > 0 {
		members := make([]enumMember, len(env))
		for i, v := range env {
			members[i] = enumMember{ID: v, Value: v}
		}
		enums = append(enums, rustEnum{typeName: "Environment", key: environmentKey, members: members})
	}
	types := map[string]string{}
	for i, e := range enums {
		if !rustIdent.MatchString(e.typeName) {
			return nil, fmt.Errorf("%w: attribute %s: %q is not a Rust type name", errRustName, e.key, e.typeName)
		}
		if other, dup := types[e.typeName]; dup {
			return nil, fmt.Errorf("%w: attributes %s and %s both become enum %s", errRustName, other, e.key, e.typeName)
		}
		if rustReservedTypes[e.typeName] && e.key != environmentKey {
			return nil, fmt.Errorf("%w: attribute %s: enum %s would shadow the type of that name", errRustName, e.key, e.typeName)
		}
		types[e.typeName] = e.key
		seen := map[string]string{}
		for _, member := range e.members {
			variant := rustTypeName(member.ID)
			if !rustIdent.MatchString(variant) || rustReservedVariants[variant] {
				return nil, fmt.Errorf("%w: attribute %s: member %s: %q is not a Rust variant name", errRustName, e.key, member.ID, variant)
			}
			if other, dup := seen[variant]; dup {
				return nil, fmt.Errorf("%w: attribute %s: members %s and %s both become variant %s", errRustName, e.key, other, member.ID, variant)
			}
			// The value goes into a doc comment inside a code span.
			if strings.Contains(member.Value, "`") || strings.ContainsFunc(member.Value, func(r rune) bool { return !unicode.IsPrint(r) }) {
				return nil, fmt.Errorf("%w: attribute %s: member %s: the value %q holds a backtick or an unprintable character", errRustName, e.key, member.ID, member.Value)
			}
			seen[variant] = member.ID
			enums[i].variants = append(enums[i].variants, variant)
		}
	}
	return enums, nil
}

// rustConsts is one generated module of string constants.
type rustConsts struct {
	module string
	doc    string
	groups []rustConstGroup
}

// rustConstGroup is a run of constants under one comment.
type rustConstGroup struct {
	comment string
	names   []string            // the values; each constant's name derives from its value
	doc     func(string) string // the doc comment text for a value
}

// render writes the module, refusing constant names Rust cannot carry and
// names that collide within the module.
func (c rustConsts) render(b *strings.Builder) error {
	if !slices.ContainsFunc(c.groups, func(g rustConstGroup) bool { return len(g.names) > 0 }) {
		fmt.Fprintf(b, "\n/// %s\npub mod %s {}\n", c.doc, c.module)
		return nil
	}
	fmt.Fprintf(b, "\n/// %s\npub mod %s {\n", c.doc, c.module)
	seen := map[string]string{}
	for i, g := range c.groups {
		if len(g.names) == 0 {
			continue
		}
		if i > 0 {
			b.WriteString("\n")
		}
		if g.comment != "" {
			fmt.Fprintf(b, "%s// %s\n", rustIndent, g.comment)
		}
		for _, value := range g.names {
			name := rustConstName(value)
			if !rustIdent.MatchString(name) {
				return fmt.Errorf("%w: %s %s: %q is not a Rust constant name", errRustName, c.module, value, name)
			}
			if other, dup := seen[name]; dup {
				return fmt.Errorf("%w: %s %s and %s both become constant %s", errRustName, c.module, other, value, name)
			}
			seen[name] = value
			fmt.Fprintf(b, "%s/// %s\n", rustIndent, g.doc(value))
			b.WriteString(rustConst(1, name, "&str", rustQuote(value)))
		}
	}
	b.WriteString("}\n")
	return nil
}

// genRustSpec renders spec.rs: identity constants, closed enums, and the
// attribute key, event name and metric name modules.
func genRustSpec(m *model) (string, error) {
	enums, err := m.rustEnums()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	rustHeader(&b, m)
	b.WriteString("\nuse crate::ParseEnumError;\n\n")
	b.WriteString("/// The schema URL stamped on every resource libo11y builds.\n")
	b.WriteString(rustConst(0, "SCHEMA_URL", "&str", rustQuote(m.schemaURL)))
	b.WriteString("/// The libo11y specification version this crate implements.\n")
	b.WriteString(rustConst(0, "SPEC_VERSION", "&str", rustQuote(m.specVersion)))
	b.WriteString("/// The pinned OpenTelemetry semantic conventions version.\n")
	b.WriteString(rustConst(0, "SEMCONV_VERSION", "&str", rustQuote(m.semconvVersion)))
	b.WriteString("/// The log attribute that carries an event's name.\n")
	b.WriteString(rustConst(0, "EVENT_NAME_KEY", "&str", rustQuote("event.name")))

	for _, e := range enums {
		writeRustEnum(&b, e)
	}

	minted := make([]string, len(m.minted))
	for i, a := range m.minted {
		minted[i] = a.ID
	}
	events := make([]string, len(m.events))
	for i, ev := range m.events {
		events[i] = ev.Name
	}
	metrics := make([]string, len(m.metrics))
	for i, mt := range m.metrics {
		metrics[i] = mt.MetricName
	}
	modules := []rustConsts{
		{module: "attr", doc: "Attribute keys: the ones the libo11y specification mints, then upstream ones it copies.", groups: []rustConstGroup{
			{comment: "Attribute keys minted by the libo11y specification.", names: minted, doc: rustDocKey("The `%s` attribute key.")},
			{comment: "Upstream attribute keys copied from the pinned registry snapshot.", names: m.copiedRefs(), doc: rustDocKey("The upstream `%s` attribute key.")},
		}},
		{module: "event", doc: "Registered event names.", groups: []rustConstGroup{
			{names: events, doc: rustDocKey("The `%s` event.")},
		}},
		{module: "metric", doc: "Registered metric names.", groups: []rustConstGroup{
			{names: metrics, doc: rustDocKey("The `%s` metric.")},
		}},
	}
	for _, mod := range modules {
		if err := mod.render(&b); err != nil {
			return "", err
		}
	}

	if len(enums) > 0 {
		b.WriteString("\n#[cfg(test)]\nmod tests {\n")
		b.WriteString(rustIndent + "use super::*;\n")
		for _, e := range enums {
			fmt.Fprintf(&b, "\n%s#[test]\n%sfn %s_round_trips() {\n", rustIndent, rustIndent, rustSnakeName(e.typeName))
			fmt.Fprintf(&b, "%s%scrate::assert_round_trips(%s::ALL);\n", rustIndent, rustIndent, e.typeName)
			fmt.Fprintf(&b, "%s}\n", rustIndent)
		}
		b.WriteString("}\n")
	}
	return b.String(), nil
}

// writeRustEnum writes one closed enum with its KEY, ALL, as_str, Display
// and FromStr.
func writeRustEnum(b *strings.Builder, e rustEnum) {
	if e.key == environmentKey {
		fmt.Fprintf(b, "\n/// The base values of `%s`.\n///\n/// libo11y accepts further values an application configures at setup, so a\n/// string that does not parse here is not necessarily an invalid environment.\n", e.key)
	} else {
		fmt.Fprintf(b, "\n/// The closed value set for `%s`.\n", e.key)
	}
	b.WriteString("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\n#[non_exhaustive]\n")
	fmt.Fprintf(b, "pub enum %s {\n", e.typeName)
	for i, member := range e.members {
		fmt.Fprintf(b, "%s/// The value `%s`.\n", rustIndent, member.Value)
		if brief := strings.TrimSpace(member.Brief); rustDocSafe(brief) {
			fmt.Fprintf(b, "%s///\n%s/// %s\n", rustIndent, rustIndent, brief)
		}
		fmt.Fprintf(b, "%s%s,\n", rustIndent, e.variants[i])
	}
	b.WriteString("}\n\n")

	fmt.Fprintf(b, "impl %s {\n", e.typeName)
	fmt.Fprintf(b, "%s/// The attribute key these values belong to.\n", rustIndent)
	b.WriteString(rustConst(1, "KEY", "&'static str", rustQuote(e.key)))
	all := make([]string, len(e.variants))
	for i, v := range e.variants {
		all[i] = "Self::" + v
	}
	fmt.Fprintf(b, "\n%s/// Every value, in registry order.\n", rustIndent)
	b.WriteString(rustAssign(1, "pub const ALL: &'static [Self]", all))
	fmt.Fprintf(b, "\n%s/// Returns the value as the registry spells it.\n", rustIndent)
	fmt.Fprintf(b, "%s#[must_use]\n%spub const fn as_str(self) -> &'static str {\n", rustIndent, rustIndent)
	fmt.Fprintf(b, "%s%smatch self {\n", rustIndent, rustIndent)
	for i, member := range e.members {
		fmt.Fprintf(b, "%sSelf::%s => %s,\n", strings.Repeat(rustIndent, 3), e.variants[i], rustQuote(member.Value))
	}
	fmt.Fprintf(b, "%s%s}\n%s}\n}\n\n", rustIndent, rustIndent, rustIndent)

	fmt.Fprintf(b, "impl core::fmt::Display for %s {\n", e.typeName)
	fmt.Fprintf(b, "%sfn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {\n", rustIndent)
	fmt.Fprintf(b, "%s%sf.write_str(self.as_str())\n%s}\n}\n\n", rustIndent, rustIndent, rustIndent)

	fmt.Fprintf(b, "impl core::str::FromStr for %s {\n", e.typeName)
	fmt.Fprintf(b, "%stype Err = ParseEnumError;\n\n", rustIndent)
	fmt.Fprintf(b, "%sfn from_str(s: &str) -> Result<Self, Self::Err> {\n", rustIndent)
	fmt.Fprintf(b, "%s%smatch s {\n", rustIndent, rustIndent)
	for i, member := range e.members {
		fmt.Fprintf(b, "%s%s => Ok(Self::%s),\n", strings.Repeat(rustIndent, 3), rustQuote(member.Value), e.variants[i])
	}
	fmt.Fprintf(b, "%s_ => Err(ParseEnumError::new(Self::KEY, s)),\n", strings.Repeat(rustIndent, 3))
	fmt.Fprintf(b, "%s%s}\n%s}\n}\n", rustIndent, rustIndent, rustIndent)
}

// rustRequirement maps a registry requirement level to its Requirement
// variant; anything unrecognized is recommended, as requirementConst does.
func rustRequirement(level string) string {
	switch level {
	case "required":
		return "Requirement::Required"
	case "conditionally_required":
		return "Requirement::ConditionallyRequired"
	case "opt_in":
		return "Requirement::OptIn"
	default:
		return "Requirement::Recommended"
	}
}

// rustInstrument maps a registry instrument to its Instrument variant. An
// unknown instrument is an error; the policy suite rejects one first.
func rustInstrument(instrument string) (string, error) {
	switch instrument {
	case "counter":
		return "Instrument::Counter", nil
	case "updowncounter":
		return "Instrument::UpDownCounter", nil
	case "histogram":
		return "Instrument::Histogram", nil
	case "gauge":
		return "Instrument::Gauge", nil
	default:
		return "", fmt.Errorf("unknown instrument %q", instrument)
	}
}

// rustLit is a struct literal: the struct name and its fields.
type rustLit struct {
	name   string
	fields []rustField
}

// render writes the literal one field per line, the layout rustfmt keeps
// for any literal wider than its struct-literal limit. indent is the level
// of the line the literal starts on.
func (l rustLit) render(indent int) string {
	pad := strings.Repeat(rustIndent, indent+1)
	var b strings.Builder
	fmt.Fprintf(&b, "%s {\n", l.name)
	for _, f := range l.fields {
		prefix := pad + f.name + ": "
		fmt.Fprintf(&b, "%s%s,\n", prefix, f.value(indent+1, len(prefix)))
	}
	b.WriteString(strings.Repeat(rustIndent, indent) + "}")
	return b.String()
}

// rustField is one field of a struct literal. value renders the field's
// value given the indentation level of its line and the width before it.
type rustField struct {
	name  string
	value func(indent, lead int) string
}

// rustStrField is a field holding one string literal.
func rustStrField(name, value string) rustField {
	return rustField{name: name, value: func(int, int) string { return rustQuote(value) }}
}

// rustExprField is a field holding a fixed expression.
func rustExprField(name, expr string) rustField {
	return rustField{name: name, value: func(int, int) string { return expr }}
}

// rustStrsField is a field holding a slice of string literals.
func rustStrsField(name string, values []string) rustField {
	return rustField{name: name, value: func(indent, lead int) string {
		return rustList("&[", "]", rustQuoteAll(values), indent, lead)
	}}
}

// rustStatic writes `pub static NAME: ty = &[...];` with one struct
// literal per element. rustfmt hugs a lone literal to the brackets, so a
// single element starts on the declaration line.
func rustStatic(b *strings.Builder, doc, name, ty string, literals []rustLit) {
	fmt.Fprintf(b, "\n/// %s\npub static %s: %s = ", doc, name, ty)
	switch len(literals) {
	case 0:
		b.WriteString("&[];\n")
	case 1:
		fmt.Fprintf(b, "&[%s];\n", literals[0].render(0))
	default:
		b.WriteString("&[\n")
		for _, lit := range literals {
			fmt.Fprintf(b, "%s%s,\n", rustIndent, lit.render(1))
		}
		b.WriteString("];\n")
	}
}

// rustStaticStrs writes `pub static NAME: &[&str] = &[...];` holding names
// as string literals.
func rustStaticStrs(b *strings.Builder, doc, name string, names []string) {
	fmt.Fprintf(b, "\n/// %s\n%s", doc, rustAssign(0, "pub static "+name+": &[&str]", rustQuoteAll(names)))
}

// rustStaticPairs writes `pub static NAME: ty = &[...];` with one tuple
// per pair of rendered elements. rustfmt hugs a lone tuple that is too
// wide for one line to the brackets, as it does a lone struct literal.
func rustStaticPairs(b *strings.Builder, doc, name, ty string, pairs [][2]string) {
	decl := fmt.Sprintf("pub static %s: %s", name, ty)
	if len(pairs) == 1 {
		// The lead counts the closing bracket that follows the tuple.
		tuple := rustList("(", ")", pairs[0][:], 0, rustWidth(decl+" = &[")+1)
		if strings.Contains(tuple, "\n") {
			fmt.Fprintf(b, "\n/// %s\n%s = &[%s];\n", doc, decl, tuple)
			return
		}
	}
	items := make([]string, len(pairs))
	for i, p := range pairs {
		items[i] = rustList("(", ")", p[:], 1, len(rustIndent))
	}
	fmt.Fprintf(b, "\n/// %s\n%s", doc, rustAssign(0, decl, items))
}

// rustSpanShapes renders span shapes, keyed by the annotation that names
// each, as SpanShape literals.
func rustSpanShapes(groups []group, annotation string) []rustLit {
	shapes := make([]rustLit, len(groups))
	for i, g := range groups {
		shapes[i] = rustLit{name: "SpanShape", fields: []rustField{
			rustStrField("name", g.Annotations[annotation]),
			rustStrsField("required", requiredNames(g)),
		}}
	}
	return shapes
}

// genRustTables renders tables.rs: the resource taxonomy, the sensitivity
// classes, the legacy keys, the metric resource labels, the event, metric
// and span contracts, and the application registry rules.
func genRustTables(m *model) (string, error) {
	var b strings.Builder
	rustHeader(&b, m)
	b.WriteString("\n")
	for _, typ := range []string{"EventInfo", "Instrument", "MetricInfo", "Requirement", "ResourceAttr", "Sensitivity", "SpanShape"} {
		fmt.Fprintf(&b, "use crate::%s;\n", typ)
	}

	var resource []rustLit
	for _, tier := range m.tierOrder {
		for _, a := range m.tiers[tier] {
			resource = append(resource, rustLit{name: "ResourceAttr", fields: []rustField{
				rustStrField("key", a.name()),
				rustStrField("tier", tier),
				rustExprField("requirement", rustRequirement(a.requirement())),
				rustStrField("source", a.Annotations["o11y.source"]),
				rustStrField("role", a.Annotations["o11y.role"]),
			}})
		}
	}
	rustStatic(&b, "The tiered resource-attribute taxonomy, in registry order.", "RESOURCE", "&[ResourceAttr]", resource)

	var tier0 []string
	for _, a := range m.tiers["tier0"] {
		if a.requirement() == "required" {
			tier0 = append(tier0, a.name())
		}
	}
	rustStaticStrs(&b, "The attributes setup requires at init.", "REQUIRED_TIER0", tier0)
	rustStaticStrs(&b, "The base allowed set for `deployment.environment.name`.", "ENVIRONMENT_VALUES", m.environmentValues())

	var classes [][2]string
	for _, name := range slices.Sorted(maps.Keys(m.classByName)) {
		class, err := sensitivityConst(m.classByName[name])
		if err != nil {
			return "", fmt.Errorf("attribute %s: %w", name, err)
		}
		if class == "PII" {
			class = "Pii"
		}
		classes = append(classes, [2]string{rustQuote(name), "Sensitivity::" + class})
	}
	rustStaticPairs(&b, "Every attribute the spec classifies, sorted by key.", "SENSITIVITY", "&[(&str, Sensitivity)]", classes)

	var legacy [][2]string
	for _, name := range slices.Sorted(maps.Keys(m.legacyKeys)) {
		legacy = append(legacy, [2]string{rustQuote(name), rustQuote(m.legacyKeys[name])})
	}
	rustStaticPairs(&b, "Each key a pre-spec release emitted and the spec key that replaces it, sorted by the old key.", "LEGACY_KEYS", "&[(&str, &str)]", legacy)

	labels := make([]string, len(m.metricLabels))
	for i, a := range m.metricLabels {
		labels[i] = a.name()
	}
	rustStaticStrs(&b, "The only resource attributes permitted as effective metric labels.", "METRIC_RESOURCE_LABELS", labels)

	events := make([]rustLit, len(m.events))
	for i, ev := range m.events {
		required, templates := m.eventRequirements(ev)
		events[i] = rustLit{name: "EventInfo", fields: []rustField{
			rustStrField("name", ev.Name),
			rustStrsField("required", required),
			rustStrsField("required_templates", templates),
		}}
	}
	rustStatic(&b, "Registered events and their contracts, in registry order.", "EVENTS", "&[EventInfo]", events)

	metrics := make([]rustLit, len(m.metrics))
	for i, mt := range m.metrics {
		instrument, err := rustInstrument(mt.Instrument)
		if err != nil {
			return "", fmt.Errorf("metric %s: %w", mt.MetricName, err)
		}
		metrics[i] = rustLit{name: "MetricInfo", fields: []rustField{
			rustStrField("name", mt.MetricName),
			rustExprField("instrument", instrument),
			rustStrField("unit", mt.Unit),
		}}
	}
	rustStatic(&b, "Registered metrics, in registry order.", "METRICS", "&[MetricInfo]", metrics)

	rustStatic(&b, "Span kinds registered by the spec and the attributes required on them.", "SPAN_REQUIRED", "&[SpanShape]", rustSpanShapes(m.spans, "o11y.span.kind"))

	b.WriteString("\n/// The schema an application registry file declares.\n")
	b.WriteString(rustConst(0, "APP_REGISTRY_SCHEMA", "&str", rustQuote(appregistry.SchemaV1)))
	rustStaticStrs(&b, "Namespaces an application registry may not claim, sorted: libo11y's, OpenTelemetry's and the pinned semconv release's.", "APP_RESERVED_NAMESPACES", appregistry.ReservedNamespaces())

	rustStatic(&b, "RUM span shapes and the attributes required on them.", "RUM_SPAN_REQUIRED", "&[SpanShape]", rustSpanShapes(m.rumSpans, "o11y.rum.span"))
	return b.String(), nil
}

// genRustGoPrint renders goprint.rs: the goPrintRanges bounds as one u32
// slice, in rustfmt's fill layout for short elements. Bounds of six digits or
// more are grouped in threes, as clippy::unreadable_literal asks.
func genRustGoPrint() string {
	ranges := goPrintRanges()
	items := make([]string, len(ranges))
	for i, r := range ranges {
		items[i] = rustDigits(int(r))
	}
	var b strings.Builder
	b.WriteString("// Code generated by specgen from Go's unicode.IsPrint (Unicode " + unicode.Version + "). DO NOT EDIT.\n\n")
	b.WriteString("/// The code points Go's `unicode.IsPrint` accepts, as sorted, inclusive `[lo, hi]` pairs\n")
	b.WriteString("/// flattened into one slice. Go's `strconv.Quote` escapes everything outside them, and also\n")
	b.WriteString("/// `\"` and `\\`.\n")
	lead := "pub static GO_PRINT_RANGES: &[u32] = "
	fmt.Fprintf(&b, "%s%s;\n", lead, rustList("&[", "]", items, 0, len(lead)))
	return b.String()
}

// rustSnakeName converts an UpperCamelCase type name to snake_case:
// RumPlatform becomes rum_platform.
func rustSnakeName(typeName string) string {
	var b strings.Builder
	for i, r := range typeName {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('_')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

// rustDigits renders n as a decimal literal, grouping the digits of a
// number of six digits or more in threes with underscores (100_000).
func rustDigits(n int) string {
	digits := strconv.Itoa(n)
	if len(digits) < 6 {
		return digits
	}
	var b strings.Builder
	for i, d := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte('_')
		}
		b.WriteRune(d)
	}
	return b.String()
}

// rustDocKey returns a doc function that puts a name into format, which
// holds one %s verb. Every name the constant modules carry is a registry
// key, which the policy suite limits to characters that are safe in a
// Markdown code span.
func rustDocKey(format string) func(string) string {
	return func(name string) string { return fmt.Sprintf(format, name) }
}
