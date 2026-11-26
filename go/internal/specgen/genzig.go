package main

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

// Where the Zig artifacts land, inside the o11y module. The hand-written
// zig/src/spec.zig defines the types the tables use and re-exports every
// generated declaration.
const (
	zigSpecPath    = "zig/src/spec/generated/spec.zig"
	zigTablesPath  = "zig/src/spec/generated/tables.zig"
	zigGoPrintPath = "zig/src/spec/generated/goprint.zig"
)

// zig fmt keeps a list on one line when it is written without a trailing
// comma and puts one element per line when it ends in one, whatever the
// width. The generator picks between the two by zigMaxWidth so the files
// stay readable, and either choice is already in zig fmt's layout.
const (
	zigMaxWidth = 100
	zigIndent   = "    "
)

// zigReservedTypes are the type names a generated enum may not take: the
// hand-written types of zig/src/spec.zig, which re-exports every generated
// declaration under its own name, and the generated Environment enum.
var zigReservedTypes = map[string]bool{
	"Cardinality": true, "CardinalityEntry": true, "EventInfo": true, "Instrument": true,
	"LegacyKey": true, "MetricInfo": true, "Requirement": true, "ResourceAttr": true,
	"Sensitivity": true, "SensitivityEntry": true, "SpanShape": true,
	"Environment": true,
}

// zigReservedVariants are the tag names that would collide with an enum's
// own declarations.
var zigReservedVariants = map[string]bool{"key": true, "all": true, "parse": true}

// zigKeywords are Zig 0.17's keywords, which an identifier spells as @"name".
var zigKeywords = map[string]bool{
	"addrspace": true, "align": true, "allowzero": true, "and": true, "anyframe": true,
	"anytype": true, "asm": true, "break": true, "callconv": true, "catch": true,
	"comptime": true, "const": true, "continue": true, "defer": true, "else": true,
	"enum": true, "errdefer": true, "error": true, "export": true, "extern": true,
	"fn": true, "for": true, "if": true, "inline": true, "linksection": true,
	"noalias": true, "noinline": true, "nosuspend": true, "opaque": true, "or": true,
	"orelse": true, "packed": true, "pub": true, "resume": true, "return": true,
	"struct": true, "suspend": true, "switch": true, "test": true, "threadlocal": true,
	"try": true, "union": true, "unreachable": true, "var": true, "volatile": true,
	"while": true,
}

// zigPrimitives are Zig 0.17's primitive names other than the integer
// types, which zigPrimitive matches by shape. A declaration of one of these
// names must be spelled @"name"; a field may use the bare name.
var zigPrimitives = map[string]bool{
	"anyerror": true, "anyframe": true, "anyopaque": true, "bool": true, "c_char": true,
	"c_int": true, "c_long": true, "c_longdouble": true, "c_longlong": true, "c_short": true,
	"c_uint": true, "c_ulong": true, "c_ulonglong": true, "c_ushort": true,
	"comptime_float": true, "comptime_int": true, "f128": true, "f16": true, "f32": true,
	"f64": true, "f80": true, "false": true, "isize": true, "noreturn": true, "null": true,
	"true": true, "type": true, "undefined": true, "usize": true, "void": true,
}

var (
	zigIdentPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	zigTypePattern    = regexp.MustCompile(`^[A-Z][A-Za-z0-9_]*$`)
	zigIntegerPattern = regexp.MustCompile(`^[iu][0-9]+$`)
)

// errZigName reports a registry name the Zig module cannot carry.
var errZigName = errors.New("zig name")

// zigPrimitive reports whether name is a Zig primitive, as
// std.zig.primitives.isPrimitive does.
func zigPrimitive(name string) bool {
	return zigPrimitives[name] || zigIntegerPattern.MatchString(name)
}

// zigIdent renders name as a Zig identifier: bare when Zig accepts it as
// one, as @"name" when it is a keyword or, for a declaration, a primitive.
// field reports whether the name is an enum tag or a field, where zig fmt
// unquotes a primitive. It refuses a name that is not identifier-shaped,
// and the discard name _.
func zigIdent(name string, field bool) (string, bool) {
	if !zigIdentPattern.MatchString(name) || name == "_" {
		return "", false
	}
	if zigKeywords[name] || (!field && zigPrimitive(name)) {
		return `@"` + name + `"`, true
	}
	return name, true
}

// zigSnakeName converts a dotted, snake or kebab name to a lower snake_case
// Zig name, dropping an o11y. prefix: o11y.rum.view.name becomes
// rum_view_name.
func zigSnakeName(name string) string {
	return strings.ToLower(strings.Join(rustSegments(strings.TrimPrefix(name, "o11y.")), "_"))
}

// zigQuote renders s as a Zig string literal. Printable characters other
// than the quote and the backslash stay as they are; everything else is
// escaped, as \xNN below U+0080 and \u{NNNN} above. A byte that is not
// valid UTF-8 is written as \xNN, so the literal holds exactly s's bytes.
func zigQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			fmt.Fprintf(&b, `\x%02x`, s[i])
			i++
			continue
		}
		i += size
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case unicode.IsPrint(r):
			b.WriteRune(r)
		case r < utf8.RuneSelf:
			fmt.Fprintf(&b, `\x%02x`, r)
		default:
			fmt.Fprintf(&b, `\u{%x}`, r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// zigQuoteAll quotes every name.
func zigQuoteAll(names []string) []string {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = zigQuote(name)
	}
	return quoted
}

// zigList renders items, already rendered as single-line expressions, as
// an anonymous list literal `.{ ... }`, prefixed by prefix (such as "&").
// indent is the indentation level of the line the list starts on, lead the
// width of that line before the list and trail the width after it. The list
// stays on one line, with no trailing comma, when the line fits in
// zigMaxWidth; otherwise it puts one element per line with a trailing
// comma. zig fmt keeps a lone element hugged to its braces.
func zigList(prefix string, items []string, indent, lead, trail int) string {
	switch len(items) {
	case 0:
		return prefix + ".{}"
	case 1:
		if one := prefix + ".{" + items[0] + "}"; lead+utf8.RuneCountInString(one)+trail <= zigMaxWidth {
			return one
		}
	default:
		if one := prefix + ".{ " + strings.Join(items, ", ") + " }"; lead+utf8.RuneCountInString(one)+trail <= zigMaxWidth {
			return one
		}
	}
	inner := strings.Repeat(zigIndent, indent+1)
	var b strings.Builder
	b.WriteString(prefix + ".{\n")
	for _, item := range items {
		b.WriteString(inner + item + ",\n")
	}
	b.WriteString(strings.Repeat(zigIndent, indent) + "}")
	return b.String()
}

// zigAssign renders `decl = &.{items};` at the given indentation level.
func zigAssign(indent int, decl string, items []string) string {
	head := strings.Repeat(zigIndent, indent) + decl + " = "
	return head + zigList("&", items, indent, utf8.RuneCountInString(head), 1) + ";\n"
}

// zigHeader writes the generated-file banner.
func zigHeader(b *strings.Builder, m *model) {
	fmt.Fprintf(b, "// Code generated by specgen from spec/registry (spec %s). DO NOT EDIT.\n", m.specVersion)
}

// zigEnum is a closed value set rendered as a Zig enum.
type zigEnum struct {
	typeName string
	key      string // the attribute key the values belong to
	members  []enumMember
	tags     []string // each member's tag, rendered as a field identifier
}

// zigEnums collects every closed enum the spec file declares: one per
// minted enum attribute, then Environment. It refuses names Zig cannot
// carry and names that collide.
func (m *model) zigEnums() ([]zigEnum, error) {
	var enums []zigEnum
	for _, a := range m.minted {
		if members := a.enumMembers(); len(members) > 0 {
			enums = append(enums, zigEnum{typeName: rustTypeName(a.ID), key: a.ID, members: members})
		}
	}
	if env := m.environmentValues(); len(env) > 0 {
		members := make([]enumMember, len(env))
		for i, v := range env {
			members[i] = enumMember{ID: v, Value: v}
		}
		enums = append(enums, zigEnum{typeName: "Environment", key: environmentKey, members: members})
	}
	types := map[string]string{}
	for i, e := range enums {
		if !zigTypePattern.MatchString(e.typeName) {
			return nil, fmt.Errorf("%w: attribute %s: %q is not a Zig type name", errZigName, e.key, e.typeName)
		}
		if other, dup := types[e.typeName]; dup {
			return nil, fmt.Errorf("%w: attributes %s and %s both become enum %s", errZigName, other, e.key, e.typeName)
		}
		if zigReservedTypes[e.typeName] && e.key != environmentKey {
			return nil, fmt.Errorf("%w: attribute %s: enum %s would collide with the spec type of that name", errZigName, e.key, e.typeName)
		}
		types[e.typeName] = e.key
		seen := map[string]string{}
		for _, member := range e.members {
			name := zigSnakeName(member.ID)
			tag, ok := zigIdent(name, true)
			if !ok || zigReservedVariants[name] {
				return nil, fmt.Errorf("%w: attribute %s: member %s: %q is not a Zig enum tag", errZigName, e.key, member.ID, name)
			}
			if other, dup := seen[name]; dup {
				return nil, fmt.Errorf("%w: attribute %s: members %s and %s both become tag %s", errZigName, e.key, other, member.ID, name)
			}
			// The value goes into a doc comment inside a code span.
			if strings.Contains(member.Value, "`") || strings.ContainsFunc(member.Value, func(r rune) bool { return !unicode.IsPrint(r) }) {
				return nil, fmt.Errorf("%w: attribute %s: member %s: the value %q holds a backtick or an unprintable character", errZigName, e.key, member.ID, member.Value)
			}
			seen[name] = member.ID
			enums[i].tags = append(enums[i].tags, tag)
		}
	}
	return enums, nil
}

// zigConsts is one generated namespace of string constants.
type zigConsts struct {
	name   string
	doc    string
	groups []rustConstGroup
}

// render writes the namespace as a struct of constants, refusing names Zig
// cannot carry and names that collide within the namespace.
func (c zigConsts) render(b *strings.Builder) error {
	if !slices.ContainsFunc(c.groups, func(g rustConstGroup) bool { return len(g.names) > 0 }) {
		fmt.Fprintf(b, "\n/// %s\npub const %s = struct {};\n", c.doc, c.name)
		return nil
	}
	fmt.Fprintf(b, "\n/// %s\npub const %s = struct {\n", c.doc, c.name)
	seen := map[string]string{}
	first := true
	for _, g := range c.groups {
		if len(g.names) == 0 {
			continue
		}
		if !first {
			b.WriteString("\n")
		}
		first = false
		if g.comment != "" {
			fmt.Fprintf(b, "%s// %s\n", zigIndent, g.comment)
		}
		for _, value := range g.names {
			name := zigSnakeName(value)
			ident, ok := zigIdent(name, false)
			if !ok {
				return fmt.Errorf("%w: %s %s: %q is not a Zig constant name", errZigName, c.name, value, name)
			}
			if other, dup := seen[name]; dup {
				return fmt.Errorf("%w: %s %s and %s both become constant %s", errZigName, c.name, other, value, name)
			}
			seen[name] = value
			fmt.Fprintf(b, "%s/// %s\n%spub const %s = %s;\n", zigIndent, g.doc(value), zigIndent, ident, zigQuote(value))
		}
	}
	b.WriteString("};\n")
	return nil
}

// genZigSpec renders spec.zig: identity constants, closed enums, and the
// attribute key, event name and metric name namespaces.
func genZigSpec(m *model) (string, error) {
	enums, err := m.zigEnums()
	if err != nil {
		return "", err
	}
	var b strings.Builder
	zigHeader(&b, m)
	if len(enums) > 0 {
		b.WriteString("\nconst std = @import(\"std\");\n")
	}
	b.WriteString("\n/// The schema URL stamped on every resource libo11y builds.\n")
	fmt.Fprintf(&b, "pub const schema_url = %s;\n", zigQuote(m.schemaURL))
	b.WriteString("/// The libo11y specification version this module implements.\n")
	fmt.Fprintf(&b, "pub const spec_version = %s;\n", zigQuote(m.specVersion))
	b.WriteString("/// The pinned OpenTelemetry semantic conventions version.\n")
	fmt.Fprintf(&b, "pub const semconv_version = %s;\n", zigQuote(m.semconvVersion))
	b.WriteString("/// The log attribute that carries an event's name.\n")
	fmt.Fprintf(&b, "pub const event_name_key = %s;\n", zigQuote("event.name"))

	for _, e := range enums {
		writeZigEnum(&b, e)
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
	namespaces := []zigConsts{
		{name: "attr", doc: "Attribute keys: the ones the libo11y specification mints, then upstream ones it copies.", groups: []rustConstGroup{
			{comment: "Attribute keys minted by the libo11y specification.", names: minted, doc: rustDocKey("The `%s` attribute key.")},
			{comment: "Upstream attribute keys copied from the pinned registry snapshot.", names: m.copiedRefs(), doc: rustDocKey("The upstream `%s` attribute key.")},
		}},
		{name: "event", doc: "Registered event names.", groups: []rustConstGroup{
			{names: events, doc: rustDocKey("The `%s` event.")},
		}},
		{name: "metric", doc: "Registered metric names.", groups: []rustConstGroup{
			{names: metrics, doc: rustDocKey("The `%s` metric.")},
		}},
	}
	for _, ns := range namespaces {
		if err := ns.render(&b); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

// writeZigEnum writes one closed enum with its key, all, asStr and parse.
func writeZigEnum(b *strings.Builder, e zigEnum) {
	if e.key == environmentKey {
		fmt.Fprintf(b, "\n/// The base values of `%s`.\n///\n/// libo11y accepts further values an application configures at setup, so a\n/// string that does not parse here is not necessarily an invalid environment.\n", e.key)
	} else {
		fmt.Fprintf(b, "\n/// The closed value set for `%s`.\n", e.key)
	}
	fmt.Fprintf(b, "pub const %s = enum {\n", e.typeName)
	for i, member := range e.members {
		fmt.Fprintf(b, "%s/// The value `%s`.\n", zigIndent, member.Value)
		if brief := strings.TrimSpace(member.Brief); rustDocSafe(brief) {
			fmt.Fprintf(b, "%s///\n%s/// %s\n", zigIndent, zigIndent, brief)
		}
		fmt.Fprintf(b, "%s%s,\n", zigIndent, e.tags[i])
	}

	fmt.Fprintf(b, "\n%s/// The attribute key these values belong to.\n", zigIndent)
	fmt.Fprintf(b, "%spub const key = %s;\n", zigIndent, zigQuote(e.key))
	all := make([]string, len(e.tags))
	for i, tag := range e.tags {
		all[i] = "." + tag
	}
	fmt.Fprintf(b, "%s/// Every value, in registry order.\n", zigIndent)
	b.WriteString(zigAssign(1, "pub const all: []const "+e.typeName, all))

	fmt.Fprintf(b, "\n%s/// Returns the value as the registry spells it.\n", zigIndent)
	fmt.Fprintf(b, "%spub fn asStr(self: %s) []const u8 {\n", zigIndent, e.typeName)
	fmt.Fprintf(b, "%sreturn switch (self) {\n", strings.Repeat(zigIndent, 2))
	for i, member := range e.members {
		fmt.Fprintf(b, "%s.%s => %s,\n", strings.Repeat(zigIndent, 3), e.tags[i], zigQuote(member.Value))
	}
	fmt.Fprintf(b, "%s};\n%s}\n", strings.Repeat(zigIndent, 2), zigIndent)

	fmt.Fprintf(b, "\n%s/// Returns the value the registry spells `s`, or null when `s` is not one.\n", zigIndent)
	fmt.Fprintf(b, "%spub fn parse(s: []const u8) ?%s {\n", zigIndent, e.typeName)
	fmt.Fprintf(b, "%sfor (all) |value| {\n", strings.Repeat(zigIndent, 2))
	fmt.Fprintf(b, "%sif (std.mem.eql(u8, value.asStr(), s)) return value;\n", strings.Repeat(zigIndent, 3))
	fmt.Fprintf(b, "%s}\n", strings.Repeat(zigIndent, 2))
	fmt.Fprintf(b, "%sreturn null;\n%s}\n};\n", strings.Repeat(zigIndent, 2), zigIndent)
}

// zigRequirement maps a registry requirement level to its Requirement tag;
// anything unrecognized is recommended, as requirementConst does.
func zigRequirement(level string) string {
	switch level {
	case "required", "conditionally_required", "opt_in":
		return "." + level
	default:
		return ".recommended"
	}
}

// zigInstrument maps a registry instrument to its Instrument tag. An
// unknown instrument is an error; the policy suite rejects one first.
func zigInstrument(instrument string) (string, error) {
	switch instrument {
	case "counter", "histogram", "gauge":
		return "." + instrument, nil
	case "updowncounter":
		return ".up_down_counter", nil
	default:
		return "", fmt.Errorf("unknown instrument %q", instrument)
	}
}

// zigSensitivity maps a registry sensitivity class to its Sensitivity tag.
// An unknown class is an error, never a guess, as in sensitivityConst.
func zigSensitivity(class string) (string, error) {
	if _, err := sensitivityConst(class); err != nil {
		return "", err
	}
	return "." + class, nil
}

// zigCardinality maps a registry cardinality class to its Cardinality tag.
// An unknown class is an error, never a guess.
func zigCardinality(class string) (string, error) {
	switch class {
	case "enum":
		return `.@"enum"`, nil
	case "bounded", "unbounded":
		return "." + class, nil
	default:
		return "", fmt.Errorf("unknown cardinality class %q", class)
	}
}

// zigField is one field of a struct literal. value renders the field's
// value given the indentation level of its line and the width before it.
type zigField struct {
	name  string
	value func(indent, lead int) string
}

// zigStrField is a field holding one string literal.
func zigStrField(name, value string) zigField {
	return zigField{name: name, value: func(int, int) string { return zigQuote(value) }}
}

// zigExprField is a field holding a fixed expression.
func zigExprField(name, expr string) zigField {
	return zigField{name: name, value: func(int, int) string { return expr }}
}

// zigStrsField is a field holding a slice of string literals.
func zigStrsField(name string, values []string) zigField {
	return zigField{name: name, value: func(indent, lead int) string {
		return zigList("&", zigQuoteAll(values), indent, lead, 1)
	}}
}

// zigLit renders a struct literal one field per line, with a trailing
// comma. indent is the level of the line the literal starts on.
func zigLit(fields []zigField, indent int) string {
	pad := strings.Repeat(zigIndent, indent+1)
	var b strings.Builder
	b.WriteString(".{\n")
	for _, f := range fields {
		prefix := pad + "." + f.name + " = "
		fmt.Fprintf(&b, "%s%s,\n", prefix, f.value(indent+1, len(prefix)))
	}
	b.WriteString(strings.Repeat(zigIndent, indent) + "}")
	return b.String()
}

// zigTable writes `pub const name: []const ty = &.{...};` with one struct
// literal per element.
func zigTable(b *strings.Builder, doc, name, ty string, literals [][]zigField) {
	fmt.Fprintf(b, "\n/// %s\npub const %s: []const %s = ", doc, name, ty)
	if len(literals) == 0 {
		b.WriteString("&.{};\n")
		return
	}
	b.WriteString("&.{\n")
	for _, lit := range literals {
		fmt.Fprintf(b, "%s%s,\n", zigIndent, zigLit(lit, 1))
	}
	b.WriteString("};\n")
}

// zigStrs writes `pub const name: []const []const u8 = &.{...};` holding
// names as string literals.
func zigStrs(b *strings.Builder, doc, name string, names []string) {
	fmt.Fprintf(b, "\n/// %s\n%s", doc, zigAssign(0, "pub const "+name+": []const []const u8", zigQuoteAll(names)))
}

// zigEntries writes `pub const name: []const ty = &.{...};` with one
// single-line struct literal per element, each already rendered.
func zigEntries(b *strings.Builder, doc, name, ty string, entries []string) {
	fmt.Fprintf(b, "\n/// %s\npub const %s: []const %s = ", doc, name, ty)
	if len(entries) == 0 {
		b.WriteString("&.{};\n")
		return
	}
	b.WriteString("&.{\n")
	for _, entry := range entries {
		fmt.Fprintf(b, "%s%s,\n", zigIndent, entry)
	}
	b.WriteString("};\n")
}

// zigSpanShapes renders span shapes, keyed by the annotation that names
// each, as SpanShape literals.
func zigSpanShapes(groups []group, annotation string) [][]zigField {
	shapes := make([][]zigField, len(groups))
	for i, g := range groups {
		shapes[i] = []zigField{
			zigStrField("name", g.Annotations[annotation]),
			zigStrsField("required", requiredNames(g)),
		}
	}
	return shapes
}

// zigClassEntries renders one `.{ .key = ..., .class = ... }` entry per
// classified key, sorted by key, with tag mapping each class to its tag.
func zigClassEntries(classes map[string]string, tag func(string) (string, error)) ([]string, error) {
	entries := make([]string, 0, len(classes))
	for _, name := range slices.Sorted(maps.Keys(classes)) {
		class, err := tag(classes[name])
		if err != nil {
			return nil, fmt.Errorf("attribute %s: %w", name, err)
		}
		entries = append(entries, fmt.Sprintf(".{ .key = %s, .class = %s }", zigQuote(name), class))
	}
	return entries, nil
}

// zigTableTypes are the spec.zig types tables.zig names, imported in this
// order.
var zigTableTypes = []string{"CardinalityEntry", "EventInfo", "LegacyKey", "MetricInfo", "ResourceAttr", "SensitivityEntry", "SpanShape"}

// genZigTables renders tables.zig: the resource taxonomy, the sensitivity
// and cardinality classes, the legacy keys, the metric resource labels, the
// event, metric and span contracts, and the application registry rules.
func genZigTables(m *model) (string, error) {
	var b strings.Builder
	zigHeader(&b, m)
	b.WriteString("\nconst spec = @import(\"../../spec.zig\");\n")
	for _, typ := range zigTableTypes {
		fmt.Fprintf(&b, "const %s = spec.%s;\n", typ, typ)
	}

	var resource [][]zigField
	for _, tier := range m.tierOrder {
		for _, a := range m.tiers[tier] {
			resource = append(resource, []zigField{
				zigStrField("key", a.name()),
				zigStrField("tier", tier),
				zigExprField("requirement", zigRequirement(a.requirement())),
				zigStrField("source", a.Annotations["o11y.source"]),
				zigStrField("role", a.Annotations["o11y.role"]),
			})
		}
	}
	zigTable(&b, "The tiered resource-attribute taxonomy, in registry order.", "resource", "ResourceAttr", resource)

	var tier0 []string
	for _, a := range m.tiers["tier0"] {
		if a.requirement() == "required" {
			tier0 = append(tier0, a.name())
		}
	}
	zigStrs(&b, "The attributes setup requires at init.", "required_tier0", tier0)
	zigStrs(&b, "The base allowed set for `deployment.environment.name`.", "environment_values", m.environmentValues())

	sensitivity, err := zigClassEntries(m.classByName, zigSensitivity)
	if err != nil {
		return "", err
	}
	zigEntries(&b, "Every attribute the spec classifies by sensitivity, sorted by key.", "sensitivity", "SensitivityEntry", sensitivity)
	cardinality, err := zigClassEntries(m.cardByName, zigCardinality)
	if err != nil {
		return "", err
	}
	zigEntries(&b, "Every attribute the spec gives a cardinality class, sorted by key.", "cardinality", "CardinalityEntry", cardinality)

	legacy := make([]string, 0, len(m.legacyKeys))
	for _, name := range slices.Sorted(maps.Keys(m.legacyKeys)) {
		legacy = append(legacy, fmt.Sprintf(".{ .key = %s, .replacement = %s }", zigQuote(name), zigQuote(m.legacyKeys[name])))
	}
	zigEntries(&b, "Each key a pre-spec release emitted and the spec key that replaces it, sorted by the old key.", "legacy_keys", "LegacyKey", legacy)

	labels := make([]string, len(m.metricLabels))
	for i, a := range m.metricLabels {
		labels[i] = a.name()
	}
	zigStrs(&b, "The only resource attributes permitted as effective metric labels.", "metric_resource_labels", labels)

	events := make([][]zigField, len(m.events))
	for i, ev := range m.events {
		required, templates := m.eventRequirements(ev)
		events[i] = []zigField{
			zigStrField("name", ev.Name),
			zigStrsField("required", required),
			zigStrsField("required_templates", templates),
		}
	}
	zigTable(&b, "Registered events and their contracts, in registry order.", "events", "EventInfo", events)

	metrics := make([][]zigField, len(m.metrics))
	for i, mt := range m.metrics {
		instrument, err := zigInstrument(mt.Instrument)
		if err != nil {
			return "", fmt.Errorf("metric %s: %w", mt.MetricName, err)
		}
		metrics[i] = []zigField{
			zigStrField("name", mt.MetricName),
			zigExprField("instrument", instrument),
			zigStrField("unit", mt.Unit),
		}
	}
	zigTable(&b, "Registered metrics, in registry order.", "metrics", "MetricInfo", metrics)

	zigTable(&b, "Span kinds registered by the spec and the attributes required on them.", "span_required", "SpanShape", zigSpanShapes(m.spans, "o11y.span.kind"))

	b.WriteString("\n/// The schema an application registry file declares.\n")
	fmt.Fprintf(&b, "pub const app_registry_schema = %s;\n", zigQuote(appregistry.SchemaV1))
	zigStrs(&b, "Namespaces an application registry may not claim, sorted: libo11y's, OpenTelemetry's and the pinned semconv release's.", "app_reserved_namespaces", appregistry.ReservedNamespaces())

	zigTable(&b, "RUM span shapes and the attributes required on them.", "rum_span_required", "SpanShape", zigSpanShapes(m.rumSpans, "o11y.rum.span"))
	return b.String(), nil
}

// genZigGoPrint renders goprint.zig: the goPrintRanges bounds as a slice of
// inclusive [lo, hi] pairs, one pair per line.
func genZigGoPrint() string {
	ranges := goPrintRanges()
	var b strings.Builder
	b.WriteString("// Code generated by specgen from Go's unicode.IsPrint (Unicode " + unicode.Version + "). DO NOT EDIT.\n\n")
	b.WriteString("/// The code points Go's `unicode.IsPrint` accepts, as sorted, inclusive `[lo, hi]` pairs.\n")
	b.WriteString("/// Go's `strconv.Quote` escapes everything outside them, and also `\"` and `\\`.\n")
	b.WriteString("pub const go_print_ranges: []const [2]u21 = &.{\n")
	for i := 0; i+1 < len(ranges); i += 2 {
		fmt.Fprintf(&b, "%s.{ %d, %d },\n", zigIndent, ranges[i], ranges[i+1])
	}
	b.WriteString("};\n")
	return b.String()
}
