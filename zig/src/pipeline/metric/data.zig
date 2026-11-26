//! The data a collection produces, as OTel Go's metricdata package shapes
//! it. A `ResourceMetrics` owns everything it points to in one arena, so
//! it stays valid after the provider changes or goes away.

const std = @import("std");
const Allocator = std.mem.Allocator;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const ids = @import("../ids.zig");
const resource_mod = @import("../resource.zig");
const instrument = @import("instrument.zig");
pub const Temporality = instrument.Temporality;

/// A measured value: an integer for `i64` instruments, a double for `f64`.
pub const Number = union(enum) {
    int: i64,
    double: f64,

    /// Wraps a value of an instrument's number type.
    pub fn of(comptime N: type, value: N) Number {
        return switch (N) {
            i64 => .{ .int = value },
            f64 => .{ .double = value },
            else => @compileError("metric numbers are i64 or f64, not " ++ @typeName(N)),
        };
    }

    /// The value as a double.
    pub fn toDouble(n: Number) f64 {
        return switch (n) {
            .int => |v| @floatFromInt(v),
            .double => |v| v,
        };
    }
};

/// A measurement sampled with its trace context.
pub const Exemplar = struct {
    /// The measurement attributes that the stream's attribute filter
    /// removed.
    filtered_attributes: []const KeyValue = &.{},
    time_unix_nano: u64,
    value: Number,
    /// Invalid when the measurement had no span context.
    trace_id: ids.TraceId = .invalid,
    /// Invalid when the measurement had no span context.
    span_id: ids.SpanId = .invalid,
};

/// One point of a sum or gauge.
pub const NumberDataPoint = struct {
    attributes: []const KeyValue,
    start_time_unix_nano: u64,
    time_unix_nano: u64,
    value: Number,
    exemplars: []const Exemplar = &.{},
};

/// One point of an explicit-bucket histogram.
pub const HistogramDataPoint = struct {
    attributes: []const KeyValue,
    start_time_unix_nano: u64,
    time_unix_nano: u64,
    count: u64,
    /// Null for instruments whose measurements can be negative.
    sum: ?Number,
    /// Null when the stream records no extremes or saw no measurement.
    min: ?Number,
    max: ?Number,
    /// The upper bounds of every bucket but the last.
    bounds: []const f64,
    /// One more count than there are bounds.
    bucket_counts: []const u64,
    exemplars: []const Exemplar = &.{},
};

pub const Sum = struct {
    temporality: Temporality,
    is_monotonic: bool,
    data_points: []const NumberDataPoint,
};

pub const Gauge = struct {
    data_points: []const NumberDataPoint,
};

pub const Histogram = struct {
    temporality: Temporality,
    data_points: []const HistogramDataPoint,
};

pub const Data = union(enum) {
    sum: Sum,
    gauge: Gauge,
    histogram: Histogram,
};

/// One stream's data.
pub const Metric = struct {
    name: []const u8,
    description: []const u8 = "",
    unit: []const u8 = "",
    data: Data,
};

/// The metrics of one meter.
pub const ScopeMetrics = struct {
    scope: resource_mod.InstrumentationScope,
    metrics: []const Metric,
};

/// One collection: every stream with data, grouped by meter in the order
/// the meters were created.
pub const ResourceMetrics = struct {
    arena: std.heap.ArenaAllocator,
    resource: resource_mod.Resource,
    scope_metrics: []const ScopeMetrics,

    /// Frees everything.
    pub fn deinit(rm: *ResourceMetrics) void {
        rm.arena.deinit();
        rm.* = undefined;
    }

    /// Returns a deep copy that owns its own memory.
    pub fn clone(rm: *const ResourceMetrics, gpa: Allocator) Allocator.Error!ResourceMetrics {
        var arena: std.heap.ArenaAllocator = .init(gpa);
        errdefer arena.deinit();
        const a = arena.allocator();
        const res = try deepCopy(resource_mod.Resource, a, rm.resource);
        const scopes = try deepCopy([]const ScopeMetrics, a, rm.scope_metrics);
        return .{ .arena = arena, .resource = res, .scope_metrics = scopes };
    }

    /// Returns the first metric named `name`, in any scope.
    pub fn find(rm: *const ResourceMetrics, name: []const u8) ?*const Metric {
        for (rm.scope_metrics) |sm| {
            for (sm.metrics) |*m| if (std.mem.eql(u8, m.name, name)) return m;
        }
        return null;
    }

    /// The number of metrics across every scope.
    pub fn metricCount(rm: *const ResourceMetrics) usize {
        var n: usize = 0;
        for (rm.scope_metrics) |sm| n += sm.metrics.len;
        return n;
    }
};

/// Copies `value` and everything its slices point to into `arena`.
pub fn deepCopy(comptime T: type, arena: Allocator, value: T) Allocator.Error!T {
    switch (@typeInfo(T)) {
        .pointer => |info| {
            if (info.size != .slice) @compileError("deepCopy copies slices, not " ++ @typeName(T));
            const out = try arena.alloc(info.child, value.len);
            switch (@typeInfo(info.child)) {
                .int, .float, .bool => @memcpy(out, value),
                else => for (out, value) |*o, v| {
                    o.* = try deepCopy(info.child, arena, v);
                },
            }
            return out;
        },
        .@"struct" => |info| {
            var out: T = value;
            inline for (info.field_names) |name| {
                @field(out, name) = try deepCopy(@FieldType(T, name), arena, @field(value, name));
            }
            return out;
        },
        .@"union" => switch (value) {
            inline else => |payload, tag| return @unionInit(T, @tagName(tag), try deepCopy(@TypeOf(payload), arena, payload)),
        },
        .optional => |info| return if (value) |v| try deepCopy(info.child, arena, v) else null,
        else => return value,
    }
}

const testing = std.testing;

test "clone copies every string and slice" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    var name = "requests".*;
    var key = "route".*;
    const points = try arena.allocator().dupe(NumberDataPoint, &.{.{
        .attributes = &.{.{ .key = &key, .value = .{ .string = "/a" } }},
        .start_time_unix_nano = 1,
        .time_unix_nano = 2,
        .value = .{ .int = 7 },
        .exemplars = &.{.{ .time_unix_nano = 2, .value = .{ .int = 7 }, .filtered_attributes = &.{attribute.kv("user", "u1")} }},
    }});
    const metrics = try arena.allocator().dupe(Metric, &.{.{ .name = &name, .data = .{ .sum = .{ .temporality = .cumulative, .is_monotonic = true, .data_points = points } } }});
    const scopes = try arena.allocator().dupe(ScopeMetrics, &.{.{ .scope = .{ .name = "m" }, .metrics = metrics }});
    var rm: ResourceMetrics = .{
        .arena = arena,
        .resource = .{ .attributes = &.{attribute.kv("service.name", "svc")} },
        .scope_metrics = scopes,
    };
    defer rm.deinit();
    var copy = try rm.clone(testing.allocator);
    defer copy.deinit();
    name[0] = 'X';
    key[0] = 'X';
    const m = copy.find("requests").?;
    try testing.expectEqualStrings("route", m.data.sum.data_points[0].attributes[0].key);
    try testing.expectEqual(@as(i64, 7), m.data.sum.data_points[0].value.int);
    try testing.expectEqualStrings("u1", m.data.sum.data_points[0].exemplars[0].filtered_attributes[0].value.string);
    try testing.expectEqual(@as(usize, 1), copy.metricCount());
    try testing.expectEqual(null, copy.find("missing"));
}

test "Number wraps both number types" {
    try testing.expectEqual(@as(f64, 3), Number.of(i64, 3).toDouble());
    try testing.expectEqual(@as(f64, 0.5), Number.of(f64, 0.5).toDouble());
}
