//! Canonical attribute sets for metric streams.
//!
//! A measurement's attributes identify its series. Two lists identify the
//! same series when they hold the same keys with the same values in any
//! order, with a repeated key counting once with its last value, as
//! OTel Go's `attribute.NewSet` does. `canonicalize` puts a list in that
//! form: sorted by key, each key once.

const std = @import("std");
const Allocator = std.mem.Allocator;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const Value = attribute.Value;
const attrset = @This();

/// Sorts `attrs` by key, keeping equal keys in their given order, then
/// keeps only the last value of each key. Returns the canonical prefix of
/// `attrs`.
pub fn canonicalize(attrs: []KeyValue) []KeyValue {
    if (attrs.len < 2) return attrs;
    std.sort.insertion(KeyValue, attrs, {}, keyLess);
    var out: usize = 0;
    for (attrs, 0..) |a, i| {
        if (i + 1 < attrs.len and std.mem.eql(u8, a.key, attrs[i + 1].key)) continue;
        attrs[out] = a;
        out += 1;
    }
    return attrs[0..out];
}

fn keyLess(_: void, a: KeyValue, b: KeyValue) bool {
    return std.mem.lessThan(u8, a.key, b.key);
}

/// Hashes a canonical list. Doubles hash by their bits, so a NaN value
/// still finds its series.
pub fn hash(attrs: []const KeyValue) u64 {
    var h: std.hash.Wyhash = .init(0);
    for (attrs) |a| {
        hashBytes(&h, a.key);
        const tag: u8 = @backingInt(std.meta.activeTag(a.value));
        h.update(&.{tag});
        switch (a.value) {
            .string => |s| hashBytes(&h, s),
            .bool => |b| h.update(&.{@intFromBool(b)}),
            .int => |n| h.update(std.mem.asBytes(&n)),
            .double => |d| h.update(std.mem.asBytes(&@as(u64, @bitCast(d)))),
            .string_array => |list| {
                h.update(std.mem.asBytes(&list.len));
                for (list) |s| hashBytes(&h, s);
            },
            .bool_array => |list| {
                h.update(std.mem.asBytes(&list.len));
                for (list) |b| h.update(&.{@intFromBool(b)});
            },
            .int_array => |list| {
                h.update(std.mem.asBytes(&list.len));
                h.update(std.mem.sliceAsBytes(list));
            },
            .double_array => |list| {
                h.update(std.mem.asBytes(&list.len));
                h.update(std.mem.sliceAsBytes(list));
            },
        }
    }
    return h.final();
}

fn hashBytes(h: *std.hash.Wyhash, bytes: []const u8) void {
    h.update(std.mem.asBytes(&bytes.len));
    h.update(bytes);
}

/// Reports whether two canonical lists are the same set. Doubles compare
/// by their bits.
pub fn eql(a: []const KeyValue, b: []const KeyValue) bool {
    if (a.len != b.len) return false;
    for (a, b) |x, y| {
        if (!std.mem.eql(u8, x.key, y.key)) return false;
        if (!valueEql(x.value, y.value)) return false;
    }
    return true;
}

fn valueEql(a: Value, b: Value) bool {
    if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
    return switch (a) {
        .double => |d| @as(u64, @bitCast(d)) == @as(u64, @bitCast(b.double)),
        .double_array => |list| std.mem.eql(u8, std.mem.sliceAsBytes(list), std.mem.sliceAsBytes(b.double_array)),
        else => a.eql(b),
    };
}

/// Copies every key and value of `attrs` into `gpa`. Safe with any
/// allocator: on partial allocation failure, everything allocated so far
/// is freed.
pub fn clone(gpa: Allocator, attrs: []const KeyValue) Allocator.Error![]KeyValue {
    const out = try gpa.alloc(KeyValue, attrs.len);
    var count: usize = 0;
    errdefer {
        for (out[0..count]) |a| freeKeyValue(gpa, a);
        gpa.free(out);
    }
    for (out, attrs) |*o, a| {
        o.* = try dupeKeyValue(gpa, a);
        count += 1;
    }
    return out;
}

/// Frees a slice returned by `clone`.
pub fn free(gpa: Allocator, attrs: []const KeyValue) void {
    for (attrs) |a| freeKeyValue(gpa, a);
    gpa.free(attrs);
}

fn dupeKeyValue(gpa: Allocator, pair: KeyValue) Allocator.Error!KeyValue {
    const key = try gpa.dupe(u8, pair.key);
    errdefer gpa.free(key);
    const val: Value = switch (pair.value) {
        .string => |s| .{ .string = try gpa.dupe(u8, s) },
        .bool, .int, .double => pair.value,
        .bool_array => |a| .{ .bool_array = try gpa.dupe(bool, a) },
        .int_array => |a| .{ .int_array = try gpa.dupe(i64, a) },
        .double_array => |a| .{ .double_array = try gpa.dupe(f64, a) },
        .string_array => |a| blk: {
            const items = try gpa.alloc([]const u8, a.len);
            var n: usize = 0;
            errdefer {
                for (items[0..n]) |s| gpa.free(s);
                gpa.free(items);
            }
            for (items, a) |*o, s| {
                o.* = try gpa.dupe(u8, s);
                n += 1;
            }
            break :blk .{ .string_array = items };
        },
    };
    return .{ .key = key, .value = val };
}

fn freeKeyValue(gpa: Allocator, pair: KeyValue) void {
    gpa.free(pair.key);
    switch (pair.value) {
        .string => |s| gpa.free(s),
        .bool, .int, .double => {},
        .bool_array => |a| gpa.free(a),
        .int_array => |a| gpa.free(a),
        .double_array => |a| gpa.free(a),
        .string_array => |a| {
            for (a) |s| gpa.free(s);
            gpa.free(a);
        },
    }
}

/// Splits a canonical list into the attributes whose keys are in `keys`
/// and the rest, both still canonical, allocated in `arena`.
pub fn partition(arena: Allocator, attrs: []const KeyValue, keys: []const []const u8) Allocator.Error!struct { kept: []KeyValue, dropped: []KeyValue } {
    var kept: std.ArrayList(KeyValue) = try .initCapacity(arena, attrs.len);
    var dropped: std.ArrayList(KeyValue) = try .initCapacity(arena, attrs.len);
    for (attrs) |a| {
        const keep = for (keys) |k| {
            if (std.mem.eql(u8, k, a.key)) break true;
        } else false;
        if (keep) kept.appendAssumeCapacity(a) else dropped.appendAssumeCapacity(a);
    }
    return .{ .kept = kept.items, .dropped = dropped.items };
}

/// The hash map context for canonical lists.
pub const MapContext = struct {
    pub fn hash(_: MapContext, key: []const KeyValue) u32 {
        return @truncate(attrset.hash(key));
    }

    pub fn eql(_: MapContext, a: []const KeyValue, b: []const KeyValue, _: usize) bool {
        return attrset.eql(a, b);
    }
};

const testing = std.testing;
const kv = attribute.kv;

test "canonicalize sorts by key and keeps the last value of a repeated key" {
    var attrs = [_]KeyValue{ kv("b", 1), kv("a", "x"), kv("b", 2), kv("c", true), kv("a", "y") };
    const set = canonicalize(&attrs);
    try testing.expectEqual(@as(usize, 3), set.len);
    try testing.expectEqualStrings("a", set[0].key);
    try testing.expectEqualStrings("y", set[0].value.string);
    try testing.expectEqualStrings("b", set[1].key);
    try testing.expectEqual(@as(i64, 2), set[1].value.int);
    try testing.expectEqualStrings("c", set[2].key);
}

test "equal sets hash and compare equal whatever the input order" {
    var a = [_]KeyValue{ kv("route", "/a"), kv("code", 200), kv("ratio", 0.5) };
    var b = [_]KeyValue{ kv("ratio", 0.5), kv("route", "/a"), kv("code", 200) };
    const sa = canonicalize(&a);
    const sb = canonicalize(&b);
    try testing.expect(eql(sa, sb));
    try testing.expectEqual(hash(sa), hash(sb));

    var c = [_]KeyValue{ kv("route", "/a"), kv("code", 201), kv("ratio", 0.5) };
    try testing.expect(!eql(sa, canonicalize(&c)));
    // The same text as a string and as an array differs.
    const strings: []const []const u8 = &.{"/a"};
    try testing.expect(!eql(&.{kv("route", "/a")}, &.{kv("route", strings)}));
    // A NaN value finds itself.
    const nan = [_]KeyValue{kv("x", std.math.nan(f64))};
    try testing.expect(eql(&nan, &nan));
}

test "partition splits a canonical list by key" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const attrs = [_]KeyValue{ kv("a", 1), kv("b", 2), kv("c", 3) };
    const parts = try partition(arena.allocator(), &attrs, &.{ "c", "a" });
    try testing.expectEqual(@as(usize, 2), parts.kept.len);
    try testing.expectEqualStrings("a", parts.kept[0].key);
    try testing.expectEqualStrings("c", parts.kept[1].key);
    try testing.expectEqual(@as(usize, 1), parts.dropped.len);
    try testing.expectEqualStrings("b", parts.dropped[0].key);
}

test "clone copies every byte and cleans up on allocation failure" {
    const strings: []const []const u8 = &.{ "alpha", "beta" };
    const ints: []const i64 = &.{ 1, 2, 3 };
    var buf = "acme".*;
    const sample = [_]KeyValue{
        kv("tenant", @as([]const u8, &buf)),
        kv("tags", strings),
        kv("ids", ints),
        kv("ok", true),
    };

    const copy = try clone(testing.allocator, &sample);
    defer free(testing.allocator, copy);
    buf[0] = 'X';
    try testing.expectEqualStrings("acme", copy[0].value.string);
    try testing.expectEqualStrings("beta", copy[1].value.string_array[1]);

    const Case = struct {
        fn run(alloc: Allocator, input: []const KeyValue) Allocator.Error!void {
            const c = try clone(alloc, input);
            free(alloc, c);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Case.run, .{&sample});
}
