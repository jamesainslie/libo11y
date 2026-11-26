//! Decodes a registry document into its fields the way gopkg.in/yaml.v3
//! decodes it into Go's appregistry.Registry with KnownFields set. The
//! decoder follows decode.go's control flow, so it collects the same
//! problems in the same order: a duplicate key, an unknown key and a value
//! of the wrong type are collected and decoding goes on, while an alias
//! cycle, too much aliasing, a bad merge, a tag that does not fit its text
//! and bad !!binary data stop it as a syntax error.
//!
//! Go's conformance test names a decode failure by its message: one that
//! mentions "already defined" is a duplicate key, then one that mentions
//! "not found in type" is an unknown key, then any other is a type error.
//! A message can mention those words through a key name or a tag, so the
//! decoder checks those too.

const std = @import("std");
const Allocator = std.mem.Allocator;
const compose = @import("../yaml/compose.zig");
const resolve = @import("../yaml/resolve.zig");

const Node = compose.Node;
pub const Diagnostic = compose.Diagnostic;

pub const Attribute = struct {
    type: []const u8 = "",
    sensitivity: []const u8 = "",
    cardinality: []const u8 = "",
    values: ?std.ArrayList([]const u8) = null,
    brief: []const u8 = "",
};

pub const AttributeMap = std.StringArrayHashMapUnmanaged(Attribute);

pub const Registry = struct {
    schema: []const u8 = "",
    namespace: []const u8 = "",
    /// null as Go's nil map: no attributes key, or a null value for it.
    attributes: ?AttributeMap = null,
};

/// What Go's decode collected without stopping.
pub const Problems = struct {
    duplicate_key: bool = false,
    unknown_key: bool = false,
    wrong_type: bool = false,

    pub fn any(p: Problems) bool {
        return p.duplicate_key or p.unknown_key or p.wrong_type;
    }
};

/// DuplicateKeyMessage is a syntax error whose yaml.v3 message holds the
/// words "already defined", which Go's conformance test names a duplicate
/// key.
pub const Error = error{ Syntax, DuplicateKeyMessage, OutOfMemory };

/// How deep decoding may recurse. Go has no limit, because its stacks grow.
/// Here each level costs about 2.5 KiB of stack in Debug and less in
/// ReleaseSafe, and a thread may have as little as 512 KiB, as macOS gives
/// secondary threads. A registry needs about five levels, plus one for each
/// merge or alias it nests. One nested deeper than this is refused as a
/// syntax error, where Go would decode it.
const max_depth = 128;

/// Decodes root, the content of one document, into a Registry. A syntax
/// error leaves its reason in diag.
pub fn decode(arena: Allocator, root: *Node, diag: *Diagnostic) Error!struct { registry: Registry, problems: Problems } {
    var d: Decoder = .{ .arena = arena, .diag = diag };
    var reg: Registry = .{};
    // yaml.v3 counts the document node, then decodes its content.
    try d.count();
    _ = try d.unmarshal(root, .{ .registry = &reg });
    return .{ .registry = reg, .problems = d.problems };
}

/// What a Go interface{} holds after decoding a merge key's sibling key:
/// only a string can shadow a merged field.
const Iface = union(enum) { string: []const u8, other };

const Target = union(enum) {
    registry: *Registry,
    attribute: *Attribute,
    attributes: *?AttributeMap,
    string: *[]const u8,
    strings: *?std.ArrayList([]const u8),
    iface: *Iface,
};

const StringSet = std.StringHashMapUnmanaged(void);

const Decoder = struct {
    arena: Allocator,
    diag: *Diagnostic,
    problems: Problems = .{},
    decode_count: u64 = 0,
    alias_count: u64 = 0,
    alias_depth: u32 = 0,
    depth: u32 = 0,
    expanding: std.AutoHashMapUnmanaged(*const Node, void) = .empty,
    /// yaml.v3's mergedFields: the keys a merge must not overwrite.
    merged: ?*StringSet = null,
    /// What each scalar resolved to, and whether each mapping repeats a
    /// key. yaml.v3 works both out again on every visit through an alias.
    /// The answers never change, and keeping them stops a file that aliases
    /// one node many times from growing the arena with each visit.
    scalars: std.AutoHashMapUnmanaged(*const Node, Scalar) = .empty,
    duplicates: std.AutoHashMapUnmanaged(*const Node, bool) = .empty,

    fn fail(d: *Decoder, n: *const Node, message: []const u8) Error {
        d.diag.* = .{ .message = message, .mark = n.mark };
        return error.Syntax;
    }

    /// yaml.v3's alias budget (allowedAliasRatio): past 1000 decodes and 100
    /// of them driven by alias expansion, the share driven by aliases may
    /// not exceed a ratio that falls from 0.99 to 0.10 as the document
    /// grows.
    fn count(d: *Decoder) Error!void {
        d.decode_count += 1;
        if (d.alias_depth > 0) d.alias_count += 1;
        if (d.alias_count > 100 and d.decode_count > 1000) {
            const decodes: f64 = @floatFromInt(d.decode_count);
            const aliases: f64 = @floatFromInt(d.alias_count);
            const allowed: f64 = if (d.decode_count <= 400_000)
                0.99
            else if (d.decode_count >= 4_000_000)
                0.10
            else
                0.99 - 0.89 * ((decodes - 400_000) / 3_600_000);
            if (aliases / decodes > allowed) {
                d.diag.* = .{ .message = "document contains excessive aliasing" };
                return error.Syntax;
            }
        }
    }

    fn unmarshal(d: *Decoder, n: *Node, t: Target) Error!bool {
        d.depth += 1;
        defer d.depth -= 1;
        if (d.depth > max_depth) return d.fail(n, "the document nests too deeply");
        try d.count();
        return switch (n.kind) {
            .alias => d.alias(n, t),
            .scalar => d.scalar(n, t),
            .mapping => d.mapping(n, t),
            .sequence => d.sequence(n, t),
        };
    }

    fn alias(d: *Decoder, n: *Node, t: Target) Error!bool {
        if (d.expanding.contains(n)) return d.fail(n, "anchor value contains itself");
        try d.expanding.put(d.arena, n, {});
        d.alias_depth += 1;
        defer {
            d.alias_depth -= 1;
            _ = d.expanding.remove(n);
        }
        const target = n.target orelse return d.fail(n, "unknown anchor referenced");
        return d.unmarshal(target, t);
    }

    /// Records yaml.v3's "cannot unmarshal" type error. Its message names the
    /// node's tag, which can hold the words the conformance test looks for.
    fn typeError(d: *Decoder, n: *const Node, default_tag: []const u8) void {
        d.problems.wrong_type = true;
        const tag = resolve.shortTag(if (n.tag.len > 0) n.tag else default_tag);
        d.mentions(tag);
    }

    fn mentions(d: *Decoder, text: []const u8) void {
        if (std.mem.find(u8, text, "already defined") != null) d.problems.duplicate_key = true;
        if (std.mem.find(u8, text, "not found in type") != null) d.problems.unknown_key = true;
    }

    fn decodeNull(d: *Decoder, t: Target) bool {
        _ = d;
        switch (t) {
            .iface => |p| p.* = .other,
            .strings => |p| p.* = null,
            .attributes => |p| p.* = null,
            .string, .registry, .attribute => return false,
        }
        return true;
    }

    const Scalar = struct { kind: resolve.Kind, tag: []const u8, text: []const u8 };

    /// What a scalar decodes to: its resolved kind and tag, and its text,
    /// decoded from base64 for !!binary.
    fn resolveScalar(d: *Decoder, n: *Node) Error!Scalar {
        if (d.scalars.get(n)) |r| return r;
        var r: Scalar = .{ .kind = .string, .tag = resolve.str, .text = n.value };
        if (!n.indicatedString()) {
            const res = resolve.resolve(d.arena, n.tag, n.value) catch |err| switch (err) {
                error.Mismatch => {
                    // Go's conformance test names a failure by its message,
                    // and yaml.v3's message quotes the value and the tag.
                    if (std.mem.find(u8, n.value, "already defined") != null or
                        std.mem.find(u8, n.tag, "already defined") != null)
                    {
                        d.diag.* = .{ .message = "cannot decode the value as its tag says", .mark = n.mark };
                        return error.DuplicateKeyMessage;
                    }
                    return d.fail(n, "cannot decode the value as its tag says");
                },
                error.OutOfMemory => |e| return e,
            };
            r.kind = res.kind;
            r.tag = res.tag;
            if (std.mem.eql(u8, r.tag, resolve.binary_tag)) {
                r.text = try decodeBase64(d.arena, n.value) orelse
                    return d.fail(n, "!!binary value contains invalid base64 data");
            }
        }
        try d.scalars.put(d.arena, n, r);
        return r;
    }

    /// yaml.v3's Node.ShortTag, with scalars resolved through the cache.
    fn shortTag(d: *Decoder, n: *Node) Error![]const u8 {
        if (n.indicatedString()) return resolve.str;
        if (n.tag.len == 0 or std.mem.eql(u8, n.tag, "!")) {
            return switch (n.kind) {
                .mapping => resolve.map_tag,
                .sequence => resolve.seq_tag,
                .alias => if (n.target) |t| d.shortTag(t) else "",
                .scalar => (try d.resolveScalar(n)).tag,
            };
        }
        return resolve.shortTag(n.tag);
    }

    fn scalar(d: *Decoder, n: *Node, t: Target) Error!bool {
        const r = try d.resolveScalar(n);
        const kind = r.kind;
        const text = r.text;
        const tag = r.tag;
        if (kind == .null) return d.decodeNull(t);
        switch (t) {
            .string => |p| {
                p.* = text;
                return true;
            },
            .iface => |p| {
                p.* = if (kind == .string) .{ .string = text } else .other;
                return true;
            },
            else => {
                d.typeError(n, tag);
                return false;
            },
        }
    }

    fn sequence(d: *Decoder, n: *Node, t: Target) Error!bool {
        switch (t) {
            .strings => |p| {
                var list: std.ArrayList([]const u8) = .empty;
                for (n.children.items) |child| {
                    var s: []const u8 = "";
                    if (try d.unmarshal(child, .{ .string = &s })) try list.append(d.arena, s);
                }
                p.* = list;
                return true;
            },
            // Go would go on to use the sequence as a map key and panic.
            .iface => return d.fail(n, "invalid map key"),
            else => {
                d.typeError(n, resolve.seq_tag);
                return false;
            },
        }
    }

    fn isMerge(n: *const Node) bool {
        return n.kind == .scalar and std.mem.eql(u8, n.value, "<<") and
            (n.tag.len == 0 or std.mem.eql(u8, n.tag, "!") or std.mem.eql(u8, resolve.shortTag(n.tag), resolve.merge_tag));
    }

    fn mapping(d: *Decoder, n: *Node, t: Target) Error!bool {
        // yaml.v3 compares every pair of keys by kind and text first, and
        // decodes nothing in a mapping that repeats a key.
        if (try d.repeatsKey(n)) {
            d.problems.duplicate_key = true;
            return false;
        }
        switch (t) {
            .registry => |p| return d.mappingStruct(n, .{ .registry = p }),
            .attribute => |p| return d.mappingStruct(n, .{ .attribute = p }),
            .attributes => |p| return d.mappingMap(n, p),
            // Go would go on to use the mapping as a map key and panic.
            .iface => return d.fail(n, "invalid map key"),
            .string, .strings => {
                d.typeError(n, resolve.map_tag);
                return false;
            },
        }
    }

    const KeyId = struct { kind: compose.Kind, value: []const u8 };

    const KeyIdContext = struct {
        pub fn hash(_: KeyIdContext, k: KeyId) u64 {
            var h: std.hash.Wyhash = .init(@backingInt(k.kind));
            h.update(k.value);
            return h.final();
        }
        pub fn eql(_: KeyIdContext, a: KeyId, b: KeyId) bool {
            return a.kind == b.kind and std.mem.eql(u8, a.value, b.value);
        }
    };

    /// Whether two of the mapping's keys have the same kind and text.
    fn repeatsKey(d: *Decoder, n: *Node) Error!bool {
        if (d.duplicates.get(n)) |dup| return dup;
        var seen: std.HashMapUnmanaged(KeyId, void, KeyIdContext, std.hash_map.default_max_load_percentage) = .empty;
        var dup = false;
        var i: usize = 0;
        while (i + 1 < n.children.items.len) : (i += 2) {
            const key = n.children.items[i];
            const got = try seen.getOrPut(d.arena, .{ .kind = key.kind, .value = key.value });
            if (got.found_existing) {
                dup = true;
                break;
            }
        }
        try d.duplicates.put(d.arena, n, dup);
        return dup;
    }

    const Struct = union(enum) { registry: *Registry, attribute: *Attribute };

    fn field(s: Struct, name: []const u8) ?struct { index: usize, target: Target } {
        switch (s) {
            .registry => |r| {
                if (std.mem.eql(u8, name, "schema")) return .{ .index = 0, .target = .{ .string = &r.schema } };
                if (std.mem.eql(u8, name, "namespace")) return .{ .index = 1, .target = .{ .string = &r.namespace } };
                if (std.mem.eql(u8, name, "attributes")) return .{ .index = 2, .target = .{ .attributes = &r.attributes } };
            },
            .attribute => |a| {
                if (std.mem.eql(u8, name, "type")) return .{ .index = 0, .target = .{ .string = &a.type } };
                if (std.mem.eql(u8, name, "sensitivity")) return .{ .index = 1, .target = .{ .string = &a.sensitivity } };
                if (std.mem.eql(u8, name, "cardinality")) return .{ .index = 2, .target = .{ .string = &a.cardinality } };
                if (std.mem.eql(u8, name, "values")) return .{ .index = 3, .target = .{ .strings = &a.values } };
                if (std.mem.eql(u8, name, "brief")) return .{ .index = 4, .target = .{ .string = &a.brief } };
            },
        }
        return null;
    }

    fn mappingStruct(d: *Decoder, n: *Node, s: Struct) Error!bool {
        const merged = d.merged;
        d.merged = null;
        var merge_node: ?*Node = null;
        var done: [5]bool = @splat(false);
        // yaml.v3 reuses one string for every key's name.
        var name: []const u8 = "";
        var i: usize = 0;
        while (i + 1 < n.children.items.len) : (i += 2) {
            const key = n.children.items[i];
            const value = n.children.items[i + 1];
            if (isMerge(key)) {
                merge_node = value;
                continue;
            }
            if (!try d.unmarshal(key, .{ .string = &name })) continue;
            if (merged) |m| {
                const got = try m.getOrPut(d.arena, name);
                if (got.found_existing) continue;
            }
            if (field(s, name)) |f| {
                // Two keys that decode to one name, through an alias.
                if (done[f.index]) {
                    d.problems.wrong_type = true;
                    continue;
                }
                done[f.index] = true;
                _ = try d.unmarshal(value, f.target);
            } else {
                d.problems.unknown_key = true;
                d.mentions(name);
            }
        }
        d.merged = merged;
        if (merge_node) |m| try d.merge(n, m, switch (s) {
            .registry => |p| .{ .registry = p },
            .attribute => |p| .{ .attribute = p },
        });
        return true;
    }

    fn mappingMap(d: *Decoder, n: *Node, p: *?AttributeMap) Error!bool {
        const merged = d.merged;
        d.merged = null;
        const is_new = p.* == null;
        if (is_new) p.* = .empty;
        var merge_node: ?*Node = null;
        var i: usize = 0;
        while (i + 1 < n.children.items.len) : (i += 2) {
            const key = n.children.items[i];
            const value = n.children.items[i + 1];
            if (isMerge(key)) {
                merge_node = value;
                continue;
            }
            var name: []const u8 = "";
            if (!try d.unmarshal(key, .{ .string = &name })) continue;
            if (merged) |m| {
                const got = try m.getOrPut(d.arena, name);
                if (got.found_existing) continue;
            }
            var attr: Attribute = .{};
            const ok = try d.unmarshal(value, .{ .attribute = &attr });
            // A null value still declares the attribute, unless it would
            // replace one an earlier decode into this map set.
            if (p.*) |*map| {
                const is_null = std.mem.eql(u8, try d.shortTag(value), resolve.null_tag);
                if (ok or (is_null and (is_new or !map.contains(name)))) try map.put(d.arena, name, attr);
            }
        }
        d.merged = merged;
        if (merge_node) |m| try d.merge(n, m, .{ .attributes = p });
        return true;
    }

    /// yaml.v3's decoder.merge. The first merge at a level collects the
    /// merging mapping's own keys, decoded as a Go interface{} would hold
    /// them, so only string keys shadow merged ones.
    fn merge(d: *Decoder, parent: *Node, source: *Node, t: Target) Error!void {
        const saved = d.merged;
        if (saved == null) {
            const set = try d.arena.create(StringSet);
            set.* = .empty;
            d.merged = set;
            var i: usize = 0;
            while (i + 1 < parent.children.items.len) : (i += 2) {
                var key: Iface = .other;
                if (try d.unmarshal(parent.children.items[i], .{ .iface = &key })) {
                    switch (key) {
                        .string => |s| try set.put(d.arena, s, {}),
                        .other => {},
                    }
                }
            }
        }
        const want_map = "map merge requires map or sequence of maps as the value";
        switch (source.kind) {
            .mapping => _ = try d.unmarshal(source, t),
            .alias => {
                if (source.target) |target| if (target.kind != .mapping) return d.fail(source, want_map);
                _ = try d.unmarshal(source, t);
            },
            .sequence => for (source.children.items) |item| {
                if (item.kind == .alias) {
                    if (item.target) |target| if (target.kind != .mapping) return d.fail(item, want_map);
                } else if (item.kind != .mapping) {
                    return d.fail(item, want_map);
                }
                _ = try d.unmarshal(item, t);
            },
            .scalar => return d.fail(source, want_map),
        }
        d.merged = saved;
    }
};

/// Go's base64.StdEncoding.DecodeString: padded standard base64, with CR and
/// LF ignored and unused trailing bits not checked. Returns null for data Go
/// rejects.
fn decodeBase64(arena: Allocator, text: []const u8) Allocator.Error!?[]const u8 {
    var compact: std.ArrayList(u8) = .empty;
    for (text) |c| {
        if (c != '\r' and c != '\n') try compact.append(arena, c);
    }
    const s = compact.items;
    if (s.len % 4 != 0) return null;
    var out: std.ArrayList(u8) = .empty;
    var q: usize = 0;
    while (q < s.len) : (q += 4) {
        const last = q + 4 == s.len;
        var vals: [4]u8 = undefined;
        var n: usize = 4;
        for (0..4) |k| {
            const c = s[q + k];
            if (c == '=') {
                if (!last or k < 2) return null;
                if (k == 2 and s[q + 3] != '=') return null;
                n = k;
                break;
            }
            vals[k] = switch (c) {
                'A'...'Z' => c - 'A',
                'a'...'z' => c - 'a' + 26,
                '0'...'9' => c - '0' + 52,
                '+' => 62,
                '/' => 63,
                else => return null,
            };
        }
        try out.append(arena, (vals[0] << 2) | (vals[1] >> 4));
        if (n > 2) try out.append(arena, (vals[1] << 4) | (vals[2] >> 2));
        if (n > 3) try out.append(arena, (vals[2] << 6) | vals[3]);
    }
    return out.items;
}

test "base64 as Go's StdEncoding decodes it" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try std.testing.expectEqualStrings("hello", (try decodeBase64(a, "aGVsbG8=")).?);
    try std.testing.expectEqualStrings("hello", (try decodeBase64(a, "aGVs\nbG8=")).?);
    try std.testing.expectEqualStrings("", (try decodeBase64(a, "")).?);
    try std.testing.expectEqualStrings("hi", (try decodeBase64(a, "aGk=")).?);
    try std.testing.expectEqualStrings("hi", (try decodeBase64(a, "aGl=")).?);
    try std.testing.expect((try decodeBase64(a, "aGVsbG8")) == null);
    try std.testing.expect((try decodeBase64(a, "aG=k")) == null);
    try std.testing.expect((try decodeBase64(a, "a===")) == null);
    try std.testing.expect((try decodeBase64(a, "aGk=aGk=")) == null);
    try std.testing.expect((try decodeBase64(a, "aG k")) == null);
}
