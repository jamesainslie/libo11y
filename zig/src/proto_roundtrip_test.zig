//! Round-trip tests for the generated OTLP bindings: each export request
//! libo11y sends is encoded with zig-protobuf, decoded back and compared
//! field by field. The requests carry every field the libo11y pipeline sets.

const std = @import("std");
const proto = @import("opentelemetry-proto");

const common = proto.common_v1;
const resource_v1 = proto.resource_v1;
const trace = proto.trace_v1;
const metrics = proto.metrics_v1;
const logs = proto.logs_v1;

const Allocator = std.mem.Allocator;
const testing = std.testing;

const trace_id = [16]u8{ 0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36 };
const span_id = [8]u8{ 0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7 };
const parent_span_id = [8]u8{ 0x53, 0x99, 0x5c, 0x3f, 0x42, 0xcd, 0x8a, 0xd8 };
const link_trace_id = [16]u8{ 0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31, 0x9c };
const link_span_id = [8]u8{ 0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31 };
const schema_url = "https://schemas.o11y.ing/2.0.0";
const start_ns: u64 = 1_764_000_000_000_000_000;
const end_ns: u64 = start_ns + 25_000_000;

fn list(comptime T: type, arena: Allocator, items: []const T) !std.ArrayList(T) {
    var out: std.ArrayList(T) = .empty;
    try out.appendSlice(arena, items);
    return out;
}

fn kv(key: []const u8, value: common.AnyValue.value_union) common.KeyValue {
    return .{ .key = key, .value = .{ .value = value } };
}

fn resource(arena: Allocator) !resource_v1.Resource {
    return .{ .attributes = try list(common.KeyValue, arena, &.{
        kv("service.name", .{ .string_value = "checkout" }),
        kv("service.version", .{ .string_value = "1.4.2" }),
        kv("deployment.environment.name", .{ .string_value = "production" }),
        kv("service.instance.id", .{ .string_value = "0b7e9a1c-1111-4222-8333-944455556666" }),
        kv("process.pid", .{ .int_value = 4242 }),
        kv("o11y.build.modified", .{ .bool_value = false }),
        kv("telemetry.sdk.language", .{ .string_value = "zig" }),
    }) };
}

fn scope(arena: Allocator) !common.InstrumentationScope {
    return .{
        .name = "github.com/jamesainslie/libo11y/zig",
        .version = "0.0.0",
        .attributes = try list(common.KeyValue, arena, &.{
            kv("o11y.scope.kind", .{ .string_value = "core" }),
        }),
    };
}

fn traceRequest(arena: Allocator) !proto.collector_trace_v1.ExportTraceServiceRequest {
    const event: trace.Span.Event = .{
        .time_unix_nano = start_ns + 1_000,
        .name = "exception",
        .attributes = try list(common.KeyValue, arena, &.{
            kv("exception.type", .{ .string_value = "error.Timeout" }),
            kv("exception.message", .{ .string_value = "upstream timed out" }),
        }),
        .dropped_attributes_count = 1,
    };
    const link: trace.Span.Link = .{
        .trace_id = &link_trace_id,
        .span_id = &link_span_id,
        .trace_state = "vendor=1",
        .attributes = try list(common.KeyValue, arena, &.{
            kv("o11y.link.reason", .{ .string_value = "detached" }),
        }),
        .flags = 0x301,
    };
    const span: trace.Span = .{
        .trace_id = &trace_id,
        .span_id = &span_id,
        .trace_state = "o11y=1,vendor=2",
        .parent_span_id = &parent_span_id,
        .flags = 0x101,
        .name = "GET /orders/{id}",
        .kind = .SPAN_KIND_SERVER,
        .start_time_unix_nano = start_ns,
        .end_time_unix_nano = end_ns,
        .attributes = try list(common.KeyValue, arena, &.{
            kv("http.request.method", .{ .string_value = "GET" }),
            kv("http.route", .{ .string_value = "/orders/{id}" }),
            kv("http.response.status_code", .{ .int_value = 504 }),
            kv("server.duration.ratio", .{ .double_value = 0.75 }),
            kv("o11y.sampled.forced", .{ .bool_value = true }),
            kv("http.request.header.accept", .{ .array_value = .{ .values = try list(common.AnyValue, arena, &.{
                .{ .value = .{ .string_value = "application/json" } },
                .{ .value = .{ .string_value = "text/plain" } },
            }) } }),
        }),
        .dropped_attributes_count = 2,
        .events = try list(trace.Span.Event, arena, &.{event}),
        .dropped_events_count = 3,
        .links = try list(trace.Span.Link, arena, &.{link}),
        .dropped_links_count = 4,
        .status = .{ .code = .STATUS_CODE_ERROR, .message = "upstream timed out" },
    };
    const scope_spans: trace.ScopeSpans = .{
        .scope = try scope(arena),
        .spans = try list(trace.Span, arena, &.{span}),
        .schema_url = schema_url,
    };
    const resource_spans: trace.ResourceSpans = .{
        .resource = try resource(arena),
        .scope_spans = try list(trace.ScopeSpans, arena, &.{scope_spans}),
        .schema_url = schema_url,
    };
    return .{ .resource_spans = try list(trace.ResourceSpans, arena, &.{resource_spans}) };
}

fn metricsRequest(arena: Allocator) !proto.collector_metrics_v1.ExportMetricsServiceRequest {
    const route = kv("http.route", .{ .string_value = "/orders/{id}" });
    const histogram_point: metrics.HistogramDataPoint = .{
        .attributes = try list(common.KeyValue, arena, &.{route}),
        .start_time_unix_nano = start_ns,
        .time_unix_nano = end_ns,
        .count = 6,
        .sum = 1.375,
        .bucket_counts = try list(u64, arena, &.{ 1, 2, 0, 3 }),
        .explicit_bounds = try list(f64, arena, &.{ 0.005, 0.1, 1.0 }),
        .exemplars = try list(metrics.Exemplar, arena, &.{.{
            .filtered_attributes = try list(common.KeyValue, arena, &.{
                kv("http.response.status_code", .{ .int_value = 504 }),
            }),
            .time_unix_nano = start_ns + 500,
            .span_id = &span_id,
            .trace_id = &trace_id,
            .value = .{ .as_double = 1.25 },
        }}),
        .flags = 0,
        .min = 0.001,
        .max = 1.25,
    };
    const sum_point: metrics.NumberDataPoint = .{
        .attributes = try list(common.KeyValue, arena, &.{route}),
        .start_time_unix_nano = start_ns,
        .time_unix_nano = end_ns,
        .exemplars = try list(metrics.Exemplar, arena, &.{.{
            .time_unix_nano = start_ns + 700,
            .span_id = &span_id,
            .trace_id = &trace_id,
            .value = .{ .as_int = 1 },
        }}),
        .value = .{ .as_int = 42 },
    };
    const gauge_point: metrics.NumberDataPoint = .{
        .attributes = try list(common.KeyValue, arena, &.{
            kv("otel.metric.overflow", .{ .bool_value = true }),
        }),
        .time_unix_nano = end_ns,
        .flags = 1,
        .value = .{ .as_double = -3.5 },
    };
    const metric_list = try list(metrics.Metric, arena, &.{
        .{
            .name = "http.server.request.duration",
            .description = "Duration of HTTP server requests.",
            .unit = "s",
            .data = .{ .histogram = .{
                .data_points = try list(metrics.HistogramDataPoint, arena, &.{histogram_point}),
                .aggregation_temporality = .AGGREGATION_TEMPORALITY_CUMULATIVE,
            } },
        },
        .{
            .name = "o11y.schema.violations",
            .description = "Attributes the sensitivity policy removed.",
            .unit = "{violation}",
            .data = .{ .sum = .{
                .data_points = try list(metrics.NumberDataPoint, arena, &.{sum_point}),
                .aggregation_temporality = .AGGREGATION_TEMPORALITY_DELTA,
                .is_monotonic = true,
            } },
        },
        .{
            .name = "process.memory.usage",
            .unit = "By",
            .data = .{ .gauge = .{
                .data_points = try list(metrics.NumberDataPoint, arena, &.{gauge_point}),
            } },
        },
    });
    const scope_metrics: metrics.ScopeMetrics = .{
        .scope = try scope(arena),
        .metrics = metric_list,
        .schema_url = schema_url,
    };
    const resource_metrics: metrics.ResourceMetrics = .{
        .resource = try resource(arena),
        .scope_metrics = try list(metrics.ScopeMetrics, arena, &.{scope_metrics}),
        .schema_url = schema_url,
    };
    return .{ .resource_metrics = try list(metrics.ResourceMetrics, arena, &.{resource_metrics}) };
}

fn logsRequest(arena: Allocator) !proto.collector_logs_v1.ExportLogsServiceRequest {
    const record: logs.LogRecord = .{
        .time_unix_nano = start_ns,
        .observed_time_unix_nano = start_ns + 10,
        .severity_number = .SEVERITY_NUMBER_INFO,
        .severity_text = "INFO",
        .body = .{ .value = .{ .string_value = "order placed" } },
        .attributes = try list(common.KeyValue, arena, &.{
            kv("order.id", .{ .string_value = "o-123" }),
            kv("order.total", .{ .double_value = 19.99 }),
            kv("order.items", .{ .int_value = 3 }),
            kv("order.gift", .{ .bool_value = false }),
            kv("order.shipping", .{ .kvlist_value = .{ .values = try list(common.KeyValue, arena, &.{
                kv("method", .{ .string_value = "express" }),
                kv("days", .{ .int_value = 2 }),
            }) } }),
            kv("order.receipt", .{ .bytes_value = "\x00\x01\xfe\xff" }),
        }),
        .dropped_attributes_count = 1,
        .flags = 1,
        .trace_id = &trace_id,
        .span_id = &span_id,
        .event_name = "order.placed",
    };
    const scope_logs: logs.ScopeLogs = .{
        .scope = try scope(arena),
        .log_records = try list(logs.LogRecord, arena, &.{record}),
        .schema_url = schema_url,
    };
    const resource_logs: logs.ResourceLogs = .{
        .resource = try resource(arena),
        .scope_logs = try list(logs.ScopeLogs, arena, &.{scope_logs}),
        .schema_url = schema_url,
    };
    return .{ .resource_logs = try list(logs.ResourceLogs, arena, &.{resource_logs}) };
}

fn isArrayList(comptime T: type) bool {
    return @typeInfo(T) == .@"struct" and @hasField(T, "items") and @hasField(T, "capacity");
}

/// Compares two decoded messages field by field. Repeated fields compare
/// their items and ignore capacity. It returns error.TestExpectedEqual on
/// the first difference and prints nothing, so a test can expect a failure.
fn expectMessageEqual(comptime T: type, want: T, got: T) error{TestExpectedEqual}!void {
    switch (@typeInfo(T)) {
        .@"struct" => |info| {
            if (comptime isArrayList(T)) {
                const Elem = @typeInfo(@FieldType(T, "items")).pointer.child;
                return expectMessageEqual([]const Elem, want.items, got.items);
            }
            inline for (info.field_names, info.field_types) |name, Field| {
                try expectMessageEqual(Field, @field(want, name), @field(got, name));
            }
        },
        .pointer => |info| {
            if (info.size != .slice) @compileError("unexpected pointer type " ++ @typeName(T));
            if (want.len != got.len) return error.TestExpectedEqual;
            for (want, got) |w, g| try expectMessageEqual(info.child, w, g);
        },
        .optional => |info| {
            const w = want orelse return if (got == null) {} else error.TestExpectedEqual;
            const g = got orelse return error.TestExpectedEqual;
            try expectMessageEqual(info.child, w, g);
        },
        .@"union" => {
            if (std.meta.activeTag(want) != std.meta.activeTag(got)) return error.TestExpectedEqual;
            switch (want) {
                inline else => |w, tag| try expectMessageEqual(@TypeOf(w), w, @field(got, @tagName(tag))),
            }
        },
        .int, .float, .bool, .@"enum" => if (want != got) return error.TestExpectedEqual,
        else => @compileError("unexpected field type " ++ @typeName(T)),
    }
}

/// Encodes `message`, decodes the bytes, and checks that the decoded
/// message equals the original and encodes to the same bytes.
fn expectRoundTrip(comptime T: type, message: T) !void {
    const gpa = testing.allocator;

    var encoded: std.Io.Writer.Allocating = .init(gpa);
    defer encoded.deinit();
    try message.encode(&encoded.writer, gpa);
    try testing.expect(encoded.written().len > 0);

    var reader: std.Io.Reader = .fixed(encoded.written());
    var decoded = try T.decode(&reader, gpa);
    defer decoded.deinit(gpa);

    try expectMessageEqual(T, message, decoded);

    var reencoded: std.Io.Writer.Allocating = .init(gpa);
    defer reencoded.deinit();
    try decoded.encode(&reencoded.writer, gpa);
    try testing.expectEqualSlices(u8, encoded.written(), reencoded.written());
}

test "ExportTraceServiceRequest round-trips through the OTLP bindings" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectRoundTrip(proto.collector_trace_v1.ExportTraceServiceRequest, try traceRequest(arena.allocator()));
}

test "ExportMetricsServiceRequest round-trips through the OTLP bindings" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectRoundTrip(proto.collector_metrics_v1.ExportMetricsServiceRequest, try metricsRequest(arena.allocator()));
}

test "ExportLogsServiceRequest round-trips through the OTLP bindings" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectRoundTrip(proto.collector_logs_v1.ExportLogsServiceRequest, try logsRequest(arena.allocator()));
}

test "expectMessageEqual reports a difference deep in a message" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const want = try traceRequest(a);
    var got = try traceRequest(a);
    try expectMessageEqual(@TypeOf(want), want, got);
    got.resource_spans.items[0].scope_spans.items[0].spans.items[0].links.items[0].flags = 0x101;
    try testing.expectError(error.TestExpectedEqual, expectMessageEqual(@TypeOf(want), want, got));
}
