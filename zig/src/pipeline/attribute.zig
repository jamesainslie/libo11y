//! Attribute values and key-value pairs, as OpenTelemetry defines them.
//!
//! A `Value` borrows its strings and slices. `dupe` copies one into an
//! allocator, which is how a span takes its own copy of every value a
//! caller passes in.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// An attribute value: a scalar, or a homogeneous array of scalars.
pub const Value = union(enum) {
    string: []const u8,
    bool: bool,
    int: i64,
    double: f64,
    string_array: []const []const u8,
    bool_array: []const bool,
    int_array: []const i64,
    double_array: []const f64,

    /// Converts a Zig value to a `Value` at compile time: string slices and
    /// string literals to `string`, `bool`, integers to `int`, floats to
    /// `double`, and slices of those to the array kinds. An integer that
    /// does not fit in an `i64` is a compile error when it is comptime
    /// known, and saturates otherwise.
    pub fn from(value: anytype) Value {
        const T = @TypeOf(value);
        if (T == Value) return value;
        switch (@typeInfo(T)) {
            .bool => return .{ .bool = value },
            .int => return .{ .int = std.math.cast(i64, value) orelse if (value < 0) std.math.minInt(i64) else std.math.maxInt(i64) },
            .comptime_int => return .{ .int = value },
            .float, .comptime_float => return .{ .double = value },
            .pointer => |info| {
                switch (info.size) {
                    .slice => return fromSlice(info.child, value),
                    .one => switch (@typeInfo(info.child)) {
                        .array => |array| return fromSlice(array.child, value),
                        else => {},
                    },
                    else => {},
                }
            },
            else => {},
        }
        @compileError("no attribute value for type " ++ @typeName(T));
    }

    fn fromSlice(comptime Elem: type, slice: anytype) Value {
        if (Elem == u8) return .{ .string = slice };
        if (Elem == bool) return .{ .bool_array = slice };
        if (Elem == i64) return .{ .int_array = slice };
        if (Elem == f64) return .{ .double_array = slice };
        if (Elem == []const u8) return .{ .string_array = slice };
        @compileError("no attribute array value for element type " ++ @typeName(Elem));
    }

    /// Returns a copy of the value whose strings and slices live in
    /// `gpa`. A string longer than `max_len` bytes is cut to at most
    /// `max_len` bytes on a UTF-8 boundary, as the OpenTelemetry attribute
    /// value length limit requires. A null `max_len` keeps every byte.
    pub fn dupe(value: Value, gpa: Allocator, max_len: ?usize) Allocator.Error!Value {
        return switch (value) {
            .string => |s| .{ .string = try gpa.dupe(u8, truncate(s, max_len)) },
            .bool, .int, .double => value,
            .bool_array => |a| .{ .bool_array = try gpa.dupe(bool, a) },
            .int_array => |a| .{ .int_array = try gpa.dupe(i64, a) },
            .double_array => |a| .{ .double_array = try gpa.dupe(f64, a) },
            .string_array => |a| blk: {
                const out = try gpa.alloc([]const u8, a.len);
                for (out, a) |*o, s| o.* = try gpa.dupe(u8, truncate(s, max_len));
                break :blk .{ .string_array = out };
            },
        };
    }

    /// Reports whether two values have the same kind and contents.
    pub fn eql(a: Value, b: Value) bool {
        if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
        return switch (a) {
            .string => |s| std.mem.eql(u8, s, b.string),
            .bool => |v| v == b.bool,
            .int => |v| v == b.int,
            .double => |v| v == b.double,
            .bool_array => |v| std.mem.eql(bool, v, b.bool_array),
            .int_array => |v| std.mem.eql(i64, v, b.int_array),
            .double_array => |v| std.mem.eql(f64, v, b.double_array),
            .string_array => |v| v.len == b.string_array.len and for (v, b.string_array) |x, y| {
                if (!std.mem.eql(u8, x, y)) break false;
            } else true,
        };
    }
};

/// Cuts `s` to at most `max_len` bytes without splitting a UTF-8 sequence.
/// Invalid UTF-8 is cut at the byte limit.
pub fn truncate(s: []const u8, max_len: ?usize) []const u8 {
    const limit = max_len orelse return s;
    if (s.len <= limit) return s;
    if (!std.unicode.utf8ValidateSlice(s)) return s[0..limit];
    var end = limit;
    // Step back over continuation bytes to the start of the cut sequence.
    while (end > 0 and (s[end] & 0xc0) == 0x80) end -= 1;
    return s[0..end];
}

/// An attribute: a key and its value.
pub const KeyValue = struct {
    key: []const u8,
    value: Value,

    /// Returns a copy of the attribute in `gpa`, applying the value length
    /// limit `max_len` as `Value.dupe` does.
    pub fn dupe(pair: KeyValue, gpa: Allocator, max_len: ?usize) Allocator.Error!KeyValue {
        return .{ .key = try gpa.dupe(u8, pair.key), .value = try pair.value.dupe(gpa, max_len) };
    }
};

/// Builds a `KeyValue`, converting `value` with `Value.from`.
pub fn kv(key: []const u8, value: anytype) KeyValue {
    return .{ .key = key, .value = .from(value) };
}

/// Returns the value of the last attribute in `attrs` with `key`.
pub fn find(attrs: []const KeyValue, key: []const u8) ?Value {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

const testing = std.testing;

test "Value.from converts Zig values" {
    try testing.expect(Value.from("x").eql(.{ .string = "x" }));
    try testing.expect(Value.from(true).eql(.{ .bool = true }));
    try testing.expect(Value.from(@as(u8, 7)).eql(.{ .int = 7 }));
    try testing.expect(Value.from(@as(u64, std.math.maxInt(u64))).eql(.{ .int = std.math.maxInt(i64) }));
    try testing.expect(Value.from(1.5).eql(.{ .double = 1.5 }));
    const ints: []const i64 = &.{ 1, 2 };
    try testing.expect(Value.from(ints).eql(.{ .int_array = &.{ 1, 2 } }));
    const strings: []const []const u8 = &.{ "a", "b" };
    try testing.expect(Value.from(strings).eql(.{ .string_array = &.{ "a", "b" } }));
    try testing.expect(!Value.from(strings).eql(.{ .string_array = &.{ "a", "c" } }));
    try testing.expect(!Value.from(1).eql(.{ .double = 1 }));
}

test "dupe copies every byte and applies the length limit on a UTF-8 boundary" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var buf = "héllo".*;
    const original = kv("k", @as([]const u8, &buf));
    const copy = try original.dupe(arena.allocator(), null);
    buf[0] = 'X';
    try testing.expectEqualStrings("héllo", copy.value.string);

    // "é" is two bytes at offsets 1 and 2; a limit of 2 must not split it.
    const cut = try kv("k", "héllo").dupe(arena.allocator(), 2);
    try testing.expectEqualStrings("h", cut.value.string);
    const strings: []const []const u8 = &.{ "abcdef", "xy" };
    const cut_array = try kv("k", strings).dupe(arena.allocator(), 3);
    try testing.expectEqualStrings("abc", cut_array.value.string_array[0]);
    try testing.expectEqualStrings("xy", cut_array.value.string_array[1]);
}

test "find returns the last value for a key" {
    const attrs = [_]KeyValue{ kv("a", 1), kv("b", 2), kv("a", 3) };
    try testing.expectEqual(@as(i64, 3), find(&attrs, "a").?.int);
    try testing.expectEqual(null, find(&attrs, "z"));
}
