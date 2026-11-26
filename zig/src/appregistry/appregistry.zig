//! Application attribute registries: the file in which an application
//! declares its own namespaced attributes with their type, sensitivity and
//! cardinality. check parses a registry with libo11y's strict YAML parser
//! and applies the Go validator's rules, in Go's order and with Go's
//! messages, so every implementation agrees on every file in
//! conformance/appregistry.
//!
//! The file is decoded as Go's appregistry.Parse decodes it with
//! gopkg.in/yaml.v3: one YAML 1.1 document, unknown keys refused, scalars
//! read as their text, and the parse failures named by the kinds
//! conformance/README.md lists.

const std = @import("std");
const Allocator = std.mem.Allocator;
const spec = @import("../spec.zig");
const goquote = @import("../goquote.zig");
const reader = @import("../yaml/reader.zig");
const compose = @import("../yaml/compose.zig");
const decode = @import("decode.zig");

/// The only registry schema libo11y reads.
pub const schema_v1 = spec.app_registry_schema;

/// The specification tables the validator checks a registry against.
pub const Tables = struct {
    schema: []const u8 = spec.app_registry_schema,
    /// Sorted. The namespaces an application may not claim.
    reserved_namespaces: []const []const u8 = spec.app_reserved_namespaces,

    fn reserved(t: Tables, namespace: []const u8) bool {
        for (t.reserved_namespaces) |r| if (std.mem.eql(u8, r, namespace)) return true;
        return false;
    }
};

/// Why a registry file did not decode. The names match the conformance
/// cases' `parse:` kinds.
pub const ParseKind = enum {
    empty,
    second_document,
    duplicate_key,
    unknown_key,
    type,
    syntax,

    /// The kind as a conformance case names it, such as "duplicate-key".
    pub fn name(k: ParseKind) []const u8 {
        return switch (k) {
            .empty => "empty",
            .second_document => "second-document",
            .duplicate_key => "duplicate-key",
            .unknown_key => "unknown-key",
            .type => "type",
            .syntax => "syntax",
        };
    }

    fn message(k: ParseKind) []const u8 {
        return switch (k) {
            .empty => "application registry is empty",
            .second_document => "an application registry holds one YAML document, found a second",
            .duplicate_key => "a mapping repeats a key",
            .unknown_key => "a key the schema does not define",
            .type => "a value of the wrong YAML type",
            .syntax => "the file is not valid YAML",
        };
    }
};

pub const ParseError = struct {
    kind: ParseKind,
    /// What went wrong, without a "parsing application registry: " prefix.
    message: []const u8,
    /// The 1-based line of a syntax error, or 0 when it has none.
    line: usize = 0,
};

pub const Attribute = struct {
    name: []const u8,
    type: []const u8,
    sensitivity: []const u8,
    cardinality: []const u8,
    values: []const []const u8,
    brief: []const u8,
};

pub const Registry = struct {
    schema: []const u8,
    namespace: []const u8,
    /// Sorted by name in byte order.
    attributes: []const Attribute,

    /// The attribute's sensitivity class. Only a valid registry guarantees
    /// that every attribute has one.
    pub fn sensitivityOf(r: Registry, key: []const u8) ?spec.Sensitivity {
        for (r.attributes) |a| {
            if (std.mem.eql(u8, a.name, key)) return std.meta.stringToEnum(spec.Sensitivity, a.sensitivity);
        }
        return null;
    }
};

/// One rule a registry breaks. attribute is empty for a rule about the
/// registry as a whole, as in Go, so a rule about an attribute with an
/// empty name renders like a registry rule too.
pub const Violation = struct {
    rule_id: []const u8,
    attribute: []const u8,
    detail: []const u8,

    /// Renders the violation as Go's Violation.String does.
    pub fn format(v: Violation, w: *std.Io.Writer) std.Io.Writer.Error!void {
        if (v.attribute.len == 0) {
            try w.print("{s}: {s}", .{ v.rule_id, v.detail });
        } else {
            try w.print("{s}: attribute {s}: {s}", .{ v.rule_id, v.attribute, v.detail });
        }
    }
};

pub const Outcome = union(enum) {
    /// The registry decoded and breaks no rule.
    valid: Registry,
    /// The registry decoded and breaks these rules, in the validator's order.
    invalid: []const Violation,
    /// The file did not decode.
    parse_error: ParseError,
};

/// The result of check. Everything it refers to lives in its arena.
pub const Result = struct {
    arena: std.heap.ArenaAllocator,
    outcome: Outcome,

    pub fn deinit(r: *Result) void {
        r.arena.deinit();
    }

    /// Writes the outcome in the conformance cases' .want format: `ok
    /// <attributes> <namespace>`, one violation per line, or `parse:
    /// <kind>`, with no final line break.
    pub fn writeWant(r: *const Result, w: *std.Io.Writer) std.Io.Writer.Error!void {
        switch (r.outcome) {
            .valid => |reg| try w.print("ok {d} {s}", .{ reg.attributes.len, reg.namespace }),
            .invalid => |vs| for (vs, 0..) |v, i| {
                if (i > 0) try w.writeByte('\n');
                try v.format(w);
            },
            .parse_error => |e| try w.print("parse: {s}", .{e.kind.name()}),
        }
    }
};

/// Parses raw as a registry file and validates it against tables.
pub fn check(gpa: Allocator, raw: []const u8, tables: Tables) Allocator.Error!Result {
    var result: Result = .{ .arena = .init(gpa), .outcome = undefined };
    errdefer result.arena.deinit();
    const arena = result.arena.allocator();
    const reg = switch (try parse(arena, raw)) {
        .registry => |reg| reg,
        .failure => |e| {
            result.outcome = .{ .parse_error = e };
            return result;
        },
    };
    const violations = try validate(arena, reg, tables);
    result.outcome = if (violations.len == 0) .{ .valid = reg } else .{ .invalid = violations };
    return result;
}

/// What parse makes of a file: the decoded registry, or why it did not decode.
pub const Parsed = union(enum) { registry: Registry, failure: ParseError };

fn syntaxError(diag: compose.Diagnostic) Parsed {
    return .{ .failure = .{ .kind = .syntax, .message = diag.message, .line = diag.mark.line + 1 } };
}

fn parseFailure(kind: ParseKind) Parsed {
    return .{ .failure = .{ .kind = kind, .message = kind.message() } };
}

/// Decodes raw strictly, as Go's appregistry.Parse does. It applies no
/// policy rule. Everything it returns lives in arena.
pub fn parse(arena: Allocator, raw: []const u8) Allocator.Error!Parsed {
    var diag: compose.Diagnostic = .{};
    const text = reader.decode(arena, raw, &diag) catch |err| switch (err) {
        error.Syntax => return syntaxError(diag),
        error.OutOfMemory => |e| return e,
    };
    var composer: compose.Composer = .init(arena, text, &diag);
    const root = composer.next() catch |err| switch (err) {
        error.Syntax => return syntaxError(diag),
        error.OutOfMemory => |e| return e,
    } orelse return parseFailure(.empty);
    const decoded = decode.decode(arena, root, &diag) catch |err| switch (err) {
        error.Syntax => return syntaxError(diag),
        error.DuplicateKeyMessage => return parseFailure(.duplicate_key),
        error.OutOfMemory => |e| return e,
    };
    const p = decoded.problems;
    if (p.duplicate_key) return parseFailure(.duplicate_key);
    if (p.unknown_key) return parseFailure(.unknown_key);
    if (p.wrong_type) return parseFailure(.type);
    // A second document is an error even when it is empty, as a trailing
    // --- makes it, and an error in it is a syntax error.
    const second = composer.next() catch |err| switch (err) {
        error.Syntax => return syntaxError(diag),
        error.OutOfMemory => |e| return e,
    };
    if (second != null) return parseFailure(.second_document);
    return .{ .registry = try collect(arena, decoded.registry) };
}

fn lessThan(_: void, a: Attribute, b: Attribute) bool {
    return std.mem.lessThan(u8, a.name, b.name);
}

fn collect(arena: Allocator, reg: decode.Registry) Allocator.Error!Registry {
    var attrs: std.ArrayList(Attribute) = .empty;
    if (reg.attributes) |map| {
        var it = map.iterator();
        while (it.next()) |e| {
            const a = e.value_ptr.*;
            try attrs.append(arena, .{
                .name = e.key_ptr.*,
                .type = a.type,
                .sensitivity = a.sensitivity,
                .cardinality = a.cardinality,
                .values = if (a.values) |v| v.items else &.{},
                .brief = a.brief,
            });
        }
    }
    std.mem.sort(Attribute, attrs.items, {}, lessThan);
    return .{ .schema = reg.schema, .namespace = reg.namespace, .attributes = attrs.items };
}

/// One snake_case segment: ^[a-z][a-z0-9]*(_[a-z0-9]+)*$
fn isSegment(s: []const u8) bool {
    if (s.len == 0 or !std.ascii.isLower(s[0])) return false;
    var prev_underscore = false;
    for (s[1..]) |c| {
        if (c == '_') {
            if (prev_underscore) return false;
            prev_underscore = true;
        } else if (std.ascii.isLower(c) or std.ascii.isDigit(c)) {
            prev_underscore = false;
        } else return false;
    }
    return !prev_underscore;
}

/// Go's specrules.ValidName: dotted snake_case segments, at least two.
fn validName(s: []const u8) bool {
    var it = std.mem.splitScalar(u8, s, '.');
    var n: usize = 0;
    while (it.next()) |segment| : (n += 1) {
        if (!isSegment(segment)) return false;
    }
    return n >= 2;
}

fn oneOf(s: []const u8, set: []const []const u8) bool {
    for (set) |x| if (std.mem.eql(u8, s, x)) return true;
    return false;
}

const attribute_types = [_][]const u8{ "string", "boolean", "int", "double", "string[]", "boolean[]", "int[]", "double[]" };
const sensitivities = [_][]const u8{ "public", "internal", "pii", "secret" };
const cardinalities = [_][]const u8{ "enum", "bounded", "unbounded" };

const Collector = struct {
    arena: Allocator,
    list: std.ArrayList(Violation) = .empty,

    fn fail(c: *Collector, rule: []const u8, attr: []const u8, comptime fmt: []const u8, args: anytype) Allocator.Error!void {
        var detail: std.Io.Writer.Allocating = .init(c.arena);
        detail.writer.print(fmt, args) catch return error.OutOfMemory;
        try c.list.append(c.arena, .{ .rule_id = rule, .attribute = attr, .detail = detail.written() });
    }
};

/// Go's %q, for the validator's messages.
const Quoted = struct {
    s: []const u8,
    pub fn format(q: Quoted, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try goquote.writeQuoted(w, q.s);
    }
};

fn quoted(s: []const u8) Quoted {
    return .{ .s = s };
}

/// Applies the policy rules and returns every violation: registry-level
/// rules first, then each attribute in name order, each attribute's rules
/// in a fixed order.
pub fn validate(arena: Allocator, r: Registry, tables: Tables) Allocator.Error![]const Violation {
    var c: Collector = .{ .arena = arena };
    if (!std.mem.eql(u8, r.schema, tables.schema)) {
        try c.fail("libo11y_app_schema_unknown", "", "schema {f}, want {f}", .{ quoted(r.schema), quoted(tables.schema) });
    }
    if (!isSegment(r.namespace)) {
        try c.fail("libo11y_app_namespace_invalid", "", "namespace {f} is not one snake_case segment", .{quoted(r.namespace)});
    } else if (tables.reserved(r.namespace)) {
        try c.fail("libo11y_app_namespace_reserved", "", "namespace {f} belongs to libo11y, OpenTelemetry, or semconv", .{quoted(r.namespace)});
    }
    if (r.attributes.len == 0) try c.fail("libo11y_app_attributes_empty", "", "the registry declares no attributes", .{});

    for (r.attributes) |a| {
        const name = a.name;
        const under = name.len > r.namespace.len and std.mem.startsWith(u8, name, r.namespace) and name[r.namespace.len] == '.';
        if (!under) try c.fail("libo11y_app_attr_outside_namespace", name, "not under the {s} namespace", .{r.namespace});
        if (!validName(name)) try c.fail("libo11y_attr_naming", name, "not a dotted snake_case name with at least two segments", .{});
        if (!oneOf(a.type, &attribute_types)) try c.fail("libo11y_app_type_unknown", name, "type {f}", .{quoted(a.type)});
        if (a.sensitivity.len == 0) {
            try c.fail("libo11y_sensitivity_missing", name, "no sensitivity class", .{});
        } else if (!oneOf(a.sensitivity, &sensitivities)) {
            try c.fail("libo11y_sensitivity_unknown", name, "sensitivity {f}", .{quoted(a.sensitivity)});
        }
        if (a.cardinality.len == 0) {
            try c.fail("libo11y_cardinality_missing", name, "no cardinality budget", .{});
        } else if (!oneOf(a.cardinality, &cardinalities)) {
            try c.fail("libo11y_cardinality_unknown", name, "cardinality {f}", .{quoted(a.cardinality)});
        }
        const is_enum = std.mem.eql(u8, a.cardinality, "enum");
        if (is_enum and a.values.len == 0) {
            try c.fail("libo11y_app_enum_values_missing", name, "an enum declares its values", .{});
        } else if (!is_enum and a.values.len > 0) {
            try c.fail("libo11y_app_values_without_enum", name, "values need cardinality enum", .{});
        }
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        for (a.values) |v| {
            const trimmed = goquote.trimSpace(v);
            if (trimmed.len != v.len) try c.fail("libo11y_enum_value_whitespace", name, "value {f}", .{quoted(v)});
            const got = try seen.getOrPut(arena, trimmed);
            if (got.found_existing) try c.fail("libo11y_enum_duplicate_value", name, "value {f}", .{quoted(v)});
        }
    }
    return c.list.items;
}

fn expectOutcome(yaml: []const u8, want: []const u8) !void {
    var r = try check(std.testing.allocator, yaml, .{});
    defer r.deinit();
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try r.writeWant(&out.writer);
    try std.testing.expectEqualStrings(want, out.written());
}

test "a valid registry" {
    try expectOutcome(
        \\schema: libo11y.app-registry/v1
        \\namespace: lor
        \\attributes:
        \\  lor.user.id:      {type: string, sensitivity: internal, cardinality: unbounded, brief: The portal's opaque user ID.}
        \\  lor.user.role:    {type: string, sensitivity: public, cardinality: enum, values: [studio, client]}
        \\  lor.client.email: {type: string, sensitivity: pii, cardinality: unbounded}
        \\
    , "ok 3 lor");
}

test "rule violations in Go's order and words" {
    try expectOutcome(
        \\schema: x
        \\namespace: lor
        \\attributes:
        \\  lor.z.last: {type: str, sensitivity: secret, cardinality: enum}
        \\  lor.a.first: {type: string}
        \\  other.key: {type: double, sensitivity: public, cardinality: bounded}
        \\
    ,
        \\libo11y_app_schema_unknown: schema "x", want "libo11y.app-registry/v1"
        \\libo11y_sensitivity_missing: attribute lor.a.first: no sensitivity class
        \\libo11y_cardinality_missing: attribute lor.a.first: no cardinality budget
        \\libo11y_app_type_unknown: attribute lor.z.last: type "str"
        \\libo11y_app_enum_values_missing: attribute lor.z.last: an enum declares its values
        \\libo11y_app_attr_outside_namespace: attribute other.key: not under the lor namespace
    );
    try expectOutcome("schema: libo11y.app-registry/v1\nnamespace: http\nattributes: {http.x: {type: int, sensitivity: public, cardinality: bounded}}\n",
        \\libo11y_app_namespace_reserved: namespace "http" belongs to libo11y, OpenTelemetry, or semconv
    );
    try expectOutcome("schema: libo11y.app-registry/v1\nnamespace: lor\nattributes: {lor.r: {type: string, sensitivity: public, cardinality: enum, values: [\" \\u0007\", \"x\\u0085\", \"\\ufeffy\", x]}}\n",
        \\libo11y_enum_value_whitespace: attribute lor.r: value " \a"
        \\libo11y_enum_value_whitespace: attribute lor.r: value "x\u0085"
        \\libo11y_enum_duplicate_value: attribute lor.r: value "x"
    );
}

test "a null document and null fields decode to empty values" {
    try expectOutcome("schema: libo11y.app-registry/v1\nnamespace: lor\nattributes: {'': {type: int, sensitivity: public, cardinality: bounded}}\n",
        \\libo11y_app_attr_outside_namespace: not under the lor namespace
        \\libo11y_attr_naming: not a dotted snake_case name with at least two segments
    );
    try expectOutcome("---\n",
        \\libo11y_app_schema_unknown: schema "", want "libo11y.app-registry/v1"
        \\libo11y_app_namespace_invalid: namespace "" is not one snake_case segment
        \\libo11y_app_attributes_empty: the registry declares no attributes
    );
    try expectOutcome("schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b:\n",
        \\libo11y_app_type_unknown: attribute lor.a.b: type ""
        \\libo11y_sensitivity_missing: attribute lor.a.b: no sensitivity class
        \\libo11y_cardinality_missing: attribute lor.a.b: no cardinality budget
    );
}

test "parse failures are named by kind" {
    try expectOutcome("# nothing here\n", "parse: empty");
    try expectOutcome("schema: [libo11y\n", "parse: syntax");
    try expectOutcome("schema: a\nschema: b\n", "parse: duplicate-key");
    try expectOutcome("schema: a\nnamespaces: [x]\n", "parse: unknown-key");
    try expectOutcome("schema: [a]\n", "parse: type");
    try expectOutcome("schema: a\n---\n", "parse: second-document");
    try expectOutcome("schema: a\nschema: b\n---\n\"\\q\"\n", "parse: syntax");
    try expectOutcome("schema: [a]\nx: 1\nx: 2\n", "parse: duplicate-key");
    // An unknown key whose name holds Go's duplicate-key words reads as a
    // duplicate key, as Go's conformance test names it.
    try expectOutcome("x already defined: 1\n", "parse: duplicate-key");
}

test "merges and aliases decode as yaml.v3 decodes them" {
    try expectOutcome(
        \\schema: libo11y.app-registry/v1
        \\namespace: shop
        \\attributes:
        \\  shop.x:
        \\    &k type: string
        \\    sensitivity: public
        \\    cardinality: bounded
        \\  shop.y:
        \\    *k : string
        \\    <<: {type: int, sensitivity: public, cardinality: bounded}
        \\
    , "ok 2 shop");
    try expectOutcome("a: &a [*a]\n", "parse: unknown-key");
    try expectOutcome("schema: &a [*a]\n", "parse: type");
    try expectOutcome("attributes: &a {x.y: *a}\n", "parse: unknown-key");
    try expectOutcome("attributes: {shop.a: &a {<<: *a}}\n", "parse: syntax");
    try expectOutcome("schema: libo11y.app-registry/v1\n<<: [x]\n", "parse: syntax");
}

test "the registry's sensitivity classes" {
    var r = try check(std.testing.allocator, "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes: {lor.e: {type: string, sensitivity: pii, cardinality: unbounded}}\n", .{});
    defer r.deinit();
    const reg = r.outcome.valid;
    try std.testing.expectEqual(spec.Sensitivity.pii, reg.sensitivityOf("lor.e").?);
    try std.testing.expectEqual(@as(?spec.Sensitivity, null), reg.sensitivityOf("lor.f"));
}

test "check frees everything when an allocation fails" {
    const run = struct {
        fn run(gpa: Allocator) !void {
            var r = try check(gpa, "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: &a {type: string, sensitivity: public, cardinality: enum, values: [x, \" y\"]}\n  lor.c.d: {<<: *a}\n", .{});
            r.deinit();
        }
    }.run;
    try std.testing.checkAllAllocationFailures(std.testing.allocator, run, .{});
}

/// A fuzz input as std.testing.Smith reads a slice: a little-endian u32
/// length, then the bytes.
fn seed(comptime text: []const u8) []const u8 {
    const len: [4]u8 = @bitCast(std.mem.nativeToLittle(u32, text.len));
    const bytes = len ++ text[0..text.len].*;
    return &bytes;
}

/// Inputs that reach every part of the parser. The conformance suite runs
/// the full set of shared cases.
const fuzz_corpus = [_][]const u8{
    seed("schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded, brief: The portal's opaque user ID.}\n"),
    seed("schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.user.role:\n    type: string\n    sensitivity: public\n    cardinality: enum\n    values:\n    - studio\n    - \"cli\\u00e9nt\"\n    - 'it''s'\n    - |\n      block\n    - >-\n      folded\n"),
    seed("%YAML 1.1\n%TAG !l! tag:yaml.org,2002:\n--- !l!map\nschema: &s !!str x # note\nbase: &b {type: int}\nattributes: {shop.x: {<<: [*b, {sensitivity: pii}], cardinality: bounded}}\n...\n"),
    seed("shop.a0: &a0 {type: int}\nshop.a1: &a1 {<<: [*a0, *a0, *a0, *a0]}\nshop.a2: {<<: [*a1, *a1, *a1, *a1]}\n"),
    seed("schema: [libo11y\n"),
    seed("schema: x\nschema: y\n---\n\"\\q\"\n\t\x00"),
    seed("? [a, {b: c}]\n: *x\n- \"\\ud800\"\n!<tag:x> &y\n"),
    seed("\xFF\xFEa\x00:\x00 \x00b\x00"),
};

fn fuzzCheck(_: void, smith: *std.testing.Smith) anyerror!void {
    var buf: [1 << 14]u8 = undefined;
    const len = smith.slice(&buf);
    var r = try check(std.testing.allocator, buf[0..len], .{});
    defer r.deinit();
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try r.writeWant(&out.writer);
}

test "fuzz the registry parser" {
    try std.testing.fuzz({}, fuzzCheck, .{ .corpus = &fuzz_corpus });
}

fn nestedMerges(gpa: Allocator, depth: usize) ![]u8 {
    var src: std.ArrayList(u8) = .empty;
    errdefer src.deinit(gpa);
    try src.appendSlice(gpa, "schema: libo11y.app-registry/v1\nnamespace: shop\nattributes:\n  shop.x: ");
    for (0..depth) |_| try src.appendSlice(gpa, "{<<: ");
    try src.appendSlice(gpa, "{type: string, sensitivity: public, cardinality: low}");
    for (0..depth) |_| try src.append(gpa, '}');
    try src.append(gpa, '\n');
    return src.toOwnedSlice(gpa);
}

test "nested merges decode up to the depth limit and fail past it" {
    const gpa = std.testing.allocator;
    const shallow = try nestedMerges(gpa, 120);
    defer gpa.free(shallow);
    try expectOutcome(shallow, "libo11y_cardinality_unknown: attribute shop.x: cardinality \"low\"");
    const deep = try nestedMerges(gpa, 9000);
    defer gpa.free(deep);
    try expectOutcome(deep, "parse: syntax");
}

test "a tag mismatch whose message Go names a duplicate key" {
    try expectOutcome("schema: !!int already defined\n", "parse: duplicate-key");
    try expectOutcome("schema: !!int client\n", "parse: syntax");
}

test "an aliased node is resolved once, however often it is visited" {
    const gpa = std.testing.allocator;
    // A scalar that needs a scratch copy to resolve, used by 5000
    // attributes through an alias, costs no more than a plain scalar each
    // would.
    var capacity: [2]usize = undefined;
    var src: std.ArrayList(u8) = .empty;
    defer src.deinit(gpa);
    for ([_][]const u8{ "b", "*a" }, &capacity) |brief, *cap| {
        src.clearRetainingCapacity();
        try src.appendSlice(gpa, "schema: libo11y.app-registry/v1\nnamespace: shop\nattributes:\n  shop.a: {type: int, sensitivity: public, cardinality: bounded, brief: &a ");
        for (0..2000) |_| try src.appendSlice(gpa, "1_");
        try src.appendSlice(gpa, "1}\n");
        for (0..5000) |i| {
            try src.print(gpa, "  shop.x{d}: {{type: string, sensitivity: public, cardinality: bounded, brief: {s}}}\n", .{ i, brief });
        }
        var r = try check(gpa, src.items, .{});
        defer r.deinit();
        try std.testing.expect(r.outcome == .valid);
        cap.* = r.arena.queryCapacity();
    }
    try std.testing.expect(capacity[1] <= capacity[0] + capacity[0] / 10);
    // A mapping that repeats a key, aliased 20000 times.
    src.clearRetainingCapacity();
    try src.appendSlice(gpa, "schema: libo11y.app-registry/v1\nnamespace: shop\nattributes: {shop.x: {brief: &m {");
    for (0..2000) |i| try src.print(gpa, "k{d}: 0, ", .{i});
    try src.appendSlice(gpa, "k0: 0}, values: [");
    for (0..20000) |i| try src.appendSlice(gpa, if (i == 0) "*m" else ", *m");
    try src.appendSlice(gpa, "]}}\n");
    var r = try check(gpa, src.items, .{});
    defer r.deinit();
    try std.testing.expect(r.arena.queryCapacity() < 16 * 1024 * 1024);
    try std.testing.expectEqual(ParseKind.duplicate_key, r.outcome.parse_error.kind);
}
