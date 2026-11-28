//! Builds OTLP protobuf messages from pipeline data, as the OTel Go
//! exporters' transforms do (exporters/otlp/otlptrace/internal/
//! tracetransform). The attribute, resource and scope builders are shared
//! by every signal.
//!
//! Every message is built in an arena and borrows the pipeline's strings
//! where they are valid UTF-8. A string with invalid UTF-8 is copied with
//! each invalid sequence replaced by U+FFFD, because the bindings verify
//! UTF-8 on encode and a collector would reject it.

const std = @import("std");
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const common = proto.common_v1;
const resource_v1 = proto.resource_v1;
const trace_v1 = proto.trace_v1;
const collector_trace = proto.collector_trace_v1;
const metrics_v1 = proto.metrics_v1;
const collector_metrics = proto.collector_metrics_v1;
const attribute = @import("../attribute.zig");
const ids = @import("../ids.zig");
const metric_data = @import("../metric/data.zig");
const resource_mod = @import("../resource.zig");
const span_mod = @import("../span.zig");
const SpanData = span_mod.SpanData;

/// Returns `s`, or a copy with invalid UTF-8 replaced by U+FFFD.
pub fn utf8(arena: Allocator, s: []const u8) Allocator.Error![]const u8 {
    if (std.unicode.utf8ValidateSlice(s)) return s;
    var out: std.ArrayList(u8) = try .initCapacity(arena, s.len + 8);
    // As Go's strings.ToValidUTF8 does, a run of invalid bytes becomes one
    // replacement character.
    var in_invalid = false;
    var i: usize = 0;
    while (i < s.len) {
        const len = std.unicode.utf8ByteSequenceLength(s[i]) catch 0;
        if (len > 0 and i + len <= s.len and std.unicode.utf8ValidateSlice(s[i .. i + len])) {
            try out.appendSlice(arena, s[i .. i + len]);
            i += len;
            in_invalid = false;
            continue;
        }
        if (!in_invalid) try out.appendSlice(arena, "\u{fffd}");
        in_invalid = true;
        i += 1;
    }
    return out.items;
}

/// Converts an attribute value.
pub fn anyValue(arena: Allocator, value: attribute.Value) Allocator.Error!common.AnyValue {
    return .{ .value = switch (value) {
        .string => |s| .{ .string_value = try utf8(arena, s) },
        .bool => |b| .{ .bool_value = b },
        .int => |n| .{ .int_value = n },
        .double => |d| .{ .double_value = d },
        .string_array => |a| blk: {
            var values: std.ArrayList(common.AnyValue) = try .initCapacity(arena, a.len);
            for (a) |s| values.appendAssumeCapacity(.{ .value = .{ .string_value = try utf8(arena, s) } });
            break :blk .{ .array_value = .{ .values = values } };
        },
        .bool_array => |a| try array(arena, a, "bool_value"),
        .int_array => |a| try array(arena, a, "int_value"),
        .double_array => |a| try array(arena, a, "double_value"),
    } };
}

fn array(arena: Allocator, items: anytype, comptime field: []const u8) Allocator.Error!common.AnyValue.value_union {
    var values: std.ArrayList(common.AnyValue) = try .initCapacity(arena, items.len);
    for (items) |item| values.appendAssumeCapacity(.{ .value = @unionInit(common.AnyValue.value_union, field, item) });
    return .{ .array_value = .{ .values = values } };
}

/// Converts an attribute list.
pub fn keyValues(arena: Allocator, attrs: []const attribute.KeyValue) Allocator.Error!std.ArrayList(common.KeyValue) {
    var out: std.ArrayList(common.KeyValue) = try .initCapacity(arena, attrs.len);
    for (attrs) |a| out.appendAssumeCapacity(.{ .key = try utf8(arena, a.key), .value = try anyValue(arena, a.value) });
    return out;
}

/// Converts a resource.
pub fn resource(arena: Allocator, r: *const resource_mod.Resource) Allocator.Error!resource_v1.Resource {
    return .{ .attributes = try keyValues(arena, r.attributes) };
}

/// Converts an instrumentation scope.
pub fn scope(arena: Allocator, s: *const resource_mod.InstrumentationScope) Allocator.Error!common.InstrumentationScope {
    return .{
        .name = try utf8(arena, s.name),
        .version = try utf8(arena, s.version),
        .attributes = try keyValues(arena, s.attributes),
    };
}

/// The OTLP span flags: the W3C trace flags in the low byte, the bit that
/// says whether the parent's remoteness is known, and the remote bit.
fn spanFlags(flags: ids.TraceFlags, parent: ids.SpanContext) u32 {
    const has_is_remote: u32 = @intCast(@backingInt(trace_v1.SpanFlags.SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK));
    const is_remote: u32 = @intCast(@backingInt(trace_v1.SpanFlags.SPAN_FLAGS_CONTEXT_IS_REMOTE_MASK));
    var out: u32 = @as(u32, flags.toByte()) | has_is_remote;
    if (parent.remote) out |= is_remote;
    return out;
}

/// Converts one ended span.
pub fn span(arena: Allocator, d: *const SpanData) Allocator.Error!trace_v1.Span {
    var out: trace_v1.Span = .{
        .trace_id = &d.span_context.trace_id.bytes,
        .span_id = &d.span_context.span_id.bytes,
        .trace_state = d.span_context.trace_state.header,
        .flags = spanFlags(d.span_context.flags, d.parent),
        .name = try utf8(arena, d.name),
        .kind = @fromBackingInt(@intCast(@backingInt(d.kind))),
        .start_time_unix_nano = d.start_time_unix_nano,
        .end_time_unix_nano = d.end_time_unix_nano,
        .attributes = try keyValues(arena, d.attributes.items),
        .dropped_attributes_count = d.dropped_attributes_count,
        .dropped_events_count = d.dropped_events_count,
        .dropped_links_count = d.dropped_links_count,
        .status = .{
            .code = switch (d.status.code) {
                .unset => .STATUS_CODE_UNSET,
                .ok => .STATUS_CODE_OK,
                .@"error" => .STATUS_CODE_ERROR,
            },
            .message = try utf8(arena, d.status.description),
        },
    };
    if (d.parent.span_id.isValid()) out.parent_span_id = &d.parent.span_id.bytes;
    try out.events.ensureTotalCapacity(arena, d.events.items.len);
    for (d.events.items) |e| out.events.appendAssumeCapacity(.{
        .time_unix_nano = e.time_unix_nano,
        .name = try utf8(arena, e.name),
        .attributes = try keyValues(arena, e.attributes),
        .dropped_attributes_count = e.dropped_attributes_count,
    });
    // As in Go, a link carries its ids, attributes and flags but not its
    // trace state.
    try out.links.ensureTotalCapacity(arena, d.links.items.len);
    for (d.links.items) |*l| out.links.appendAssumeCapacity(.{
        .trace_id = &l.span_context.trace_id.bytes,
        .span_id = &l.span_context.span_id.bytes,
        .attributes = try keyValues(arena, l.attributes),
        .dropped_attributes_count = l.dropped_attributes_count,
        .flags = spanFlags(l.span_context.flags, l.span_context),
    });
    return out;
}

/// Builds the export request for a batch of ended spans, grouped by
/// resource and then by scope, each in order of first appearance.
pub fn traceRequest(arena: Allocator, spans: []const *const SpanData) Allocator.Error!collector_trace.ExportTraceServiceRequest {
    var request: collector_trace.ExportTraceServiceRequest = .{};
    var resources: std.ArrayList(*const resource_mod.Resource) = .empty;
    var scopes: std.ArrayList(std.ArrayList(*const resource_mod.InstrumentationScope)) = .empty;
    for (spans) |d| {
        const r_index = indexOf(resource_mod.Resource, resources.items, d.resource()) orelse blk: {
            try resources.append(arena, d.resource());
            try scopes.append(arena, .empty);
            try request.resource_spans.append(arena, .{
                .resource = try resource(arena, d.resource()),
                .schema_url = try utf8(arena, d.resource().schema_url),
            });
            break :blk resources.items.len - 1;
        };
        const rs = &request.resource_spans.items[r_index];
        const scope_list = &scopes.items[r_index];
        const s_index = indexOf(resource_mod.InstrumentationScope, scope_list.items, d.scope()) orelse blk: {
            try scope_list.append(arena, d.scope());
            try rs.scope_spans.append(arena, .{
                .scope = try scope(arena, d.scope()),
                .schema_url = try utf8(arena, d.scope().schema_url),
            });
            break :blk scope_list.items.len - 1;
        };
        try rs.scope_spans.items[s_index].spans.append(arena, try span(arena, d));
    }
    return request;
}

fn indexOf(comptime T: type, items: []const *const T, item: *const T) ?usize {
    for (items, 0..) |x, i| {
        if (x == item) return i;
    }
    return null;
}

/// Builds the export request for one collected `ResourceMetrics`.
/// Returns an empty request when there are no scope metrics.
pub fn metricsRequest(arena: Allocator, rm: *const metric_data.ResourceMetrics) Allocator.Error!collector_metrics.ExportMetricsServiceRequest {
    var request: collector_metrics.ExportMetricsServiceRequest = .{};
    if (rm.scope_metrics.len == 0) return request;
    var scope_metrics: std.ArrayList(metrics_v1.ScopeMetrics) = try .initCapacity(arena, rm.scope_metrics.len);
    for (rm.scope_metrics) |*sm| {
        var metrics: std.ArrayList(metrics_v1.Metric) = try .initCapacity(arena, sm.metrics.len);
        for (sm.metrics) |*m| metrics.appendAssumeCapacity(try encodeMetric(arena, m));
        scope_metrics.appendAssumeCapacity(.{
            .scope = try scope(arena, &sm.scope),
            .schema_url = try utf8(arena, sm.scope.schema_url),
            .metrics = metrics,
        });
    }
    try request.resource_metrics.append(arena, .{
        .resource = try resource(arena, &rm.resource),
        .schema_url = try utf8(arena, rm.resource.schema_url),
        .scope_metrics = scope_metrics,
    });
    return request;
}

fn encodeMetric(arena: Allocator, m: *const metric_data.Metric) Allocator.Error!metrics_v1.Metric {
    const d: metrics_v1.Metric.data_union = switch (m.data) {
        .sum => |s| .{ .sum = .{
            .aggregation_temporality = temporality(s.temporality),
            .is_monotonic = s.is_monotonic,
            .data_points = try numberPoints(arena, s.data_points),
        } },
        .gauge => |g| .{ .gauge = .{
            .data_points = try numberPoints(arena, g.data_points),
        } },
        .histogram => |h| .{ .histogram = .{
            .aggregation_temporality = temporality(h.temporality),
            .data_points = try histogramPoints(arena, h.data_points),
        } },
    };
    return .{
        .name = try utf8(arena, m.name),
        .description = try utf8(arena, m.description),
        .unit = try utf8(arena, m.unit),
        .data = d,
    };
}

fn temporality(t: metric_data.Temporality) metrics_v1.AggregationTemporality {
    return switch (t) {
        .cumulative => .AGGREGATION_TEMPORALITY_CUMULATIVE,
        .delta => .AGGREGATION_TEMPORALITY_DELTA,
    };
}

fn numberPoints(arena: Allocator, points: []const metric_data.NumberDataPoint) Allocator.Error!std.ArrayList(metrics_v1.NumberDataPoint) {
    var out: std.ArrayList(metrics_v1.NumberDataPoint) = try .initCapacity(arena, points.len);
    for (points) |*p| {
        out.appendAssumeCapacity(.{
            .attributes = try keyValues(arena, p.attributes),
            .start_time_unix_nano = p.start_time_unix_nano,
            .time_unix_nano = p.time_unix_nano,
            .value = switch (p.value) {
                .int => |v| .{ .as_int = v },
                .double => |v| .{ .as_double = v },
            },
            .exemplars = try metricExemplars(arena, p.exemplars),
        });
    }
    return out;
}

fn histogramPoints(arena: Allocator, points: []const metric_data.HistogramDataPoint) Allocator.Error!std.ArrayList(metrics_v1.HistogramDataPoint) {
    var out: std.ArrayList(metrics_v1.HistogramDataPoint) = try .initCapacity(arena, points.len);
    for (points) |*p| {
        var bucket_counts: std.ArrayList(u64) = try .initCapacity(arena, p.bucket_counts.len);
        bucket_counts.appendSliceAssumeCapacity(p.bucket_counts);
        var explicit_bounds: std.ArrayList(f64) = try .initCapacity(arena, p.bounds.len);
        explicit_bounds.appendSliceAssumeCapacity(p.bounds);
        out.appendAssumeCapacity(.{
            .attributes = try keyValues(arena, p.attributes),
            .start_time_unix_nano = p.start_time_unix_nano,
            .time_unix_nano = p.time_unix_nano,
            .count = p.count,
            .sum = if (p.sum) |s| s.toDouble() else null,
            .min = if (p.min) |mn| mn.toDouble() else null,
            .max = if (p.max) |mx| mx.toDouble() else null,
            .bucket_counts = bucket_counts,
            .explicit_bounds = explicit_bounds,
            .exemplars = try metricExemplars(arena, p.exemplars),
        });
    }
    return out;
}

fn metricExemplars(arena: Allocator, list: []const metric_data.Exemplar) Allocator.Error!std.ArrayList(metrics_v1.Exemplar) {
    var out: std.ArrayList(metrics_v1.Exemplar) = try .initCapacity(arena, list.len);
    for (list) |*e| {
        out.appendAssumeCapacity(.{
            .filtered_attributes = try keyValues(arena, e.filtered_attributes),
            .time_unix_nano = e.time_unix_nano,
            .trace_id = if (e.trace_id.isValid()) try arena.dupe(u8, &e.trace_id.bytes) else &.{},
            .span_id = if (e.span_id.isValid()) try arena.dupe(u8, &e.span_id.bytes) else &.{},
            .value = switch (e.value) {
                .int => |v| .{ .as_int = v },
                .double => |v| .{ .as_double = v },
            },
        });
    }
    return out;
}

test {
    _ = @import("encode_test.zig");
}
