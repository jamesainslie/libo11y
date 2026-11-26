//! Log records, as the OpenTelemetry log data model and the OTel Go log
//! SDK define them (sdk/log/record.go, sdk/log/internal/attrnorm).
//!
//! A `Record` is what a caller hands to `Logger.emit`. It borrows every
//! string and slice. The logger copies it into a `LogData`, which owns
//! its own arena, applies the log record limits, and is what processors
//! and exporters read.

const std = @import("std");
const Allocator = std.mem.Allocator;
const ids = @import("ids.zig");
const resource_mod = @import("resource.zig");

/// A log value: the OTLP `AnyValue`. Unlike a span attribute value it
/// nests, so a body or an attribute can hold arrays and maps of values.
/// It borrows its strings and slices.
pub const Value = union(enum) {
    /// No value. OTLP carries it as an `AnyValue` with nothing set.
    empty,
    string: []const u8,
    bool: bool,
    int: i64,
    double: f64,
    bytes: []const u8,
    array: []const Value,
    map: []const KeyValue,

    /// Converts a Zig scalar or string to a `Value`: string slices and
    /// string literals to `string`, `bool`, integers to `int` (saturating
    /// past the `i64` range) and floats to `double`. A `Value` is returned
    /// as it is. Build arrays, maps and bytes with the union fields.
    pub fn from(value: anytype) Value {
        const T = @TypeOf(value);
        if (T == Value) return value;
        switch (@typeInfo(T)) {
            .bool => return .{ .bool = value },
            .int => return .{ .int = std.math.cast(i64, value) orelse if (value < 0) std.math.minInt(i64) else std.math.maxInt(i64) },
            .comptime_int => return .{ .int = value },
            .float, .comptime_float => return .{ .double = value },
            .pointer => |info| switch (info.size) {
                .slice => if (info.child == u8) return .{ .string = value },
                .one => switch (@typeInfo(info.child)) {
                    .array => |array| if (array.child == u8) return .{ .string = value },
                    else => {},
                },
                else => {},
            },
            else => {},
        }
        @compileError("no log value for type " ++ @typeName(T));
    }

    /// Reports whether two values have the same kind and contents, in
    /// order, all the way down.
    pub fn eql(a: Value, b: Value) bool {
        if (std.meta.activeTag(a) != std.meta.activeTag(b)) return false;
        return switch (a) {
            .empty => true,
            .string => |s| std.mem.eql(u8, s, b.string),
            .bytes => |s| std.mem.eql(u8, s, b.bytes),
            .bool => |v| v == b.bool,
            .int => |v| v == b.int,
            .double => |v| v == b.double,
            .array => |items| items.len == b.array.len and for (items, b.array) |x, y| {
                if (!x.eql(y)) break false;
            } else true,
            .map => |pairs| pairs.len == b.map.len and for (pairs, b.map) |x, y| {
                if (!std.mem.eql(u8, x.key, y.key) or !x.value.eql(y.value)) break false;
            } else true,
        };
    }
};

/// A log attribute, or one entry of a map value.
pub const KeyValue = struct {
    key: []const u8,
    value: Value,
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

/// The severity number. The values are the OTLP `SeverityNumber` values.
pub const Severity = enum(u8) {
    unspecified = 0,
    trace = 1,
    trace2 = 2,
    trace3 = 3,
    trace4 = 4,
    debug = 5,
    debug2 = 6,
    debug3 = 7,
    debug4 = 8,
    info = 9,
    info2 = 10,
    info3 = 11,
    info4 = 12,
    warn = 13,
    warn2 = 14,
    warn3 = 15,
    warn4 = 16,
    @"error" = 17,
    error2 = 18,
    error3 = 19,
    error4 = 20,
    fatal = 21,
    fatal2 = 22,
    fatal3 = 23,
    fatal4 = 24,
};

/// A log record to emit. It borrows everything; `Logger.emit` copies it.
pub const Record = struct {
    /// When the event happened, in Unix nanoseconds. Zero is unset.
    timestamp: u64 = 0,
    /// When the pipeline saw the event, in Unix nanoseconds. Zero means
    /// the time of the emit, as Go sets it.
    observed_timestamp: u64 = 0,
    severity: Severity = .unspecified,
    severity_text: []const u8 = "",
    body: Value = .empty,
    attributes: []const KeyValue = &.{},
    /// The trace identity. When the trace id is invalid, `Logger.emit`
    /// takes the trace id, span id and flags from the context instead.
    trace_id: ids.TraceId = .invalid,
    span_id: ids.SpanId = .invalid,
    trace_flags: ids.TraceFlags = .{},
    /// A non-empty event name makes the record an event record.
    event_name: []const u8 = "",
};

/// Log record limits. A null limit is unlimited. The defaults are the
/// OTel Go SDK defaults.
pub const Limits = struct {
    /// The most attributes a record keeps. Attributes past the limit are
    /// dropped and counted. Zero keeps none.
    attribute_count: ?u32 = 128,
    /// The most characters (Unicode code points) a string attribute value
    /// keeps, and the most bytes a bytes value keeps, at any depth. As in
    /// Go, cutting a string that holds invalid UTF-8 also removes its
    /// invalid bytes. The body is never cut.
    attribute_value_length: ?usize = null,
    /// The deepest an attribute value nests. The attribute's own value is
    /// at depth one, and each step into an array element or a map value
    /// adds one. An array or map past the limit is replaced by an empty
    /// value. The body is not limited.
    attribute_value_depth: ?u32 = 64,
};

/// The record of one emitted log. `Logger.emit` creates it, and it is
/// immutable once processors see it. A processor that keeps it past
/// `onEmit` calls `retain` and later `release`; the record is freed when
/// the last reference is released.
pub const LogData = struct {
    gpa: Allocator,
    arena: std.heap.ArenaAllocator,
    refs: std.atomic.Value(u32) = .init(1),

    /// Borrowed from the logger provider, which outlives the record.
    resource: *const resource_mod.Resource,
    /// Borrowed from the logger, which outlives the record.
    scope: *const resource_mod.InstrumentationScope,

    timestamp: u64,
    observed_timestamp: u64,
    severity: Severity,
    severity_text: []const u8,
    body: Value,
    /// The attributes after the limits and the policy. The policy may
    /// rewrite them in place before processors see the record.
    attributes: []KeyValue,
    dropped_attributes_count: u32,
    trace_id: ids.TraceId,
    span_id: ids.SpanId,
    trace_flags: ids.TraceFlags,
    event_name: []const u8,

    /// Copies `record` into a new record with its own arena and applies
    /// `limits`. Attributes with an empty key are ignored and not counted,
    /// as in Go. Repeated keys keep the last value at the first key's
    /// position, at the top level and inside every map, in attributes and
    /// in the body. Null when out of memory.
    pub fn create(
        gpa: Allocator,
        record: Record,
        resource: *const resource_mod.Resource,
        scope: *const resource_mod.InstrumentationScope,
        limits: Limits,
    ) ?*LogData {
        const data = gpa.create(LogData) catch return null;
        data.* = .{
            .gpa = gpa,
            .arena = .init(gpa),
            .resource = resource,
            .scope = scope,
            .timestamp = record.timestamp,
            .observed_timestamp = record.observed_timestamp,
            .severity = record.severity,
            .severity_text = "",
            .body = .empty,
            .attributes = &.{},
            .dropped_attributes_count = 0,
            .trace_id = record.trace_id,
            .span_id = record.span_id,
            .trace_flags = record.trace_flags,
            .event_name = "",
        };
        data.fill(record, limits) catch {
            data.arena.deinit();
            gpa.destroy(data);
            return null;
        };
        return data;
    }

    fn fill(data: *LogData, record: Record, limits: Limits) Allocator.Error!void {
        const arena = data.arena.allocator();
        data.severity_text = try arena.dupe(u8, record.severity_text);
        data.event_name = try arena.dupe(u8, record.event_name);
        data.body = try copyValue(arena, record.body, .{});
        const copied = try copyAttributes(arena, record.attributes, limits);
        data.attributes = copied.attributes;
        data.dropped_attributes_count = copied.dropped;
    }

    /// Takes a reference.
    pub fn retain(data: *const LogData) void {
        _ = @constCast(data).refs.fetchAdd(1, .monotonic);
    }

    /// Drops a reference, freeing the record when it was the last one.
    pub fn release(data: *const LogData) void {
        const self = @constCast(data);
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        const gpa = self.gpa;
        self.arena.deinit();
        gpa.destroy(self);
    }

    /// The arena that owns the record's memory. The policy hook allocates
    /// any replacement attributes in it.
    pub fn allocator(data: *LogData) Allocator {
        return data.arena.allocator();
    }
};

/// How deep values are cut and how long their strings may be.
const CopyRules = struct {
    /// Arrays and maps at this many more levels down become empty. Null
    /// is unlimited.
    remaining_depth: ?u32 = null,
    max_len: ?usize = null,
};

const Copied = struct { attributes: []KeyValue, dropped: u32 };

fn indexOfKey(pairs: []const KeyValue, key: []const u8) ?usize {
    for (pairs, 0..) |p, i| {
        if (std.mem.eql(u8, p.key, key)) return i;
    }
    return null;
}

/// Copies the attributes: drop empty keys, deduplicate with the last
/// value winning, cut to the count limit, then copy each value under the
/// depth and length limits.
fn copyAttributes(arena: Allocator, attrs: []const KeyValue, limits: Limits) Allocator.Error!Copied {
    var unique: std.ArrayList(KeyValue) = try .initCapacity(arena, attrs.len);
    for (attrs) |a| {
        if (a.key.len == 0) continue;
        if (indexOfKey(unique.items, a.key)) |i| {
            unique.items[i].value = a.value;
        } else {
            unique.appendAssumeCapacity(a);
        }
    }
    var dropped: u32 = 0;
    if (limits.attribute_count) |max| if (unique.items.len > max) {
        dropped = std.math.cast(u32, unique.items.len - max) orelse std.math.maxInt(u32);
        unique.shrinkRetainingCapacity(max);
    };
    const rules: CopyRules = .{ .remaining_depth = limits.attribute_value_depth, .max_len = limits.attribute_value_length };
    for (unique.items) |*a| a.* = .{
        .key = try arena.dupe(u8, a.key),
        .value = try copyValue(arena, a.value, rules),
    };
    return .{ .attributes = unique.items, .dropped = dropped };
}

/// Copies a value into `arena` with its maps deduplicated, applying the
/// depth and length rules.
fn copyValue(arena: Allocator, value: Value, rules: CopyRules) Allocator.Error!Value {
    switch (value) {
        .empty, .bool, .int, .double => return value,
        .string => |s| return .{ .string = try truncateChars(arena, s, rules.max_len) },
        .bytes => |b| return .{ .bytes = try arena.dupe(u8, if (rules.max_len) |max| b[0..@min(b.len, max)] else b) },
        .array, .map => {},
    }
    var inner = rules;
    if (rules.remaining_depth) |depth| {
        if (depth == 0) return .empty;
        inner.remaining_depth = depth - 1;
    }
    switch (value) {
        .array => |items| {
            const out = try arena.alloc(Value, items.len);
            for (out, items) |*o, item| o.* = try copyValue(arena, item, inner);
            return .{ .array = out };
        },
        .map => |pairs| {
            var unique: std.ArrayList(KeyValue) = try .initCapacity(arena, pairs.len);
            for (pairs) |p| {
                if (indexOfKey(unique.items, p.key)) |i| {
                    unique.items[i].value = p.value;
                } else {
                    unique.appendAssumeCapacity(p);
                }
            }
            for (unique.items) |*p| p.* = .{
                .key = try arena.dupe(u8, p.key),
                .value = try copyValue(arena, p.value, inner),
            };
            return .{ .map = unique.items };
        },
        else => return value,
    }
}

/// The length of the valid UTF-8 sequence at the start of `s`, or null
/// when `s` starts with an invalid byte, as Go's decoder sees it.
fn sequenceLength(s: []const u8) ?usize {
    const len = std.unicode.utf8ByteSequenceLength(s[0]) catch return null;
    if (len > s.len) return null;
    _ = std.unicode.utf8Decode(s[0..len]) catch return null;
    return len;
}

/// Copies `s` cut to at most `limit` characters, as Go's attrnorm
/// truncate does. A string no longer than `limit` bytes is kept as it is.
/// A longer one keeps its first `limit` code points; when it holds
/// invalid UTF-8, the invalid bytes are removed first.
pub fn truncateChars(arena: Allocator, s: []const u8, max_len: ?usize) Allocator.Error![]const u8 {
    const limit = max_len orelse return arena.dupe(u8, s);
    if (s.len <= limit) return arena.dupe(u8, s);
    var count: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const len = sequenceLength(s[i..]) orelse {
            if (limit == 0) return "";
            break;
        };
        count += 1;
        if (count > limit) return arena.dupe(u8, s[0..i]);
        i += len;
    }
    if (i == s.len) return arena.dupe(u8, s);
    // An invalid byte at `i`: keep the valid prefix, then copy valid code
    // points, skipping invalid bytes, up to the limit.
    var out: std.ArrayList(u8) = try .initCapacity(arena, s.len - 1);
    out.appendSliceAssumeCapacity(s[0..i]);
    while (i < s.len and count < limit) {
        const len = sequenceLength(s[i..]) orelse {
            i += 1;
            continue;
        };
        out.appendSliceAssumeCapacity(s[i .. i + len]);
        i += len;
        count += 1;
    }
    return out.items;
}

test {
    _ = @import("log_record_test.zig");
}
