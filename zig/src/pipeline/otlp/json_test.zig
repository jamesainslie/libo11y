//! Tests for the OTLP/JSON encoder and decoder in json.zig: hand-written
//! expected payloads for traces, metrics and logs, round trips, payloads
//! as a collector or the OpenTelemetry JS exporter sends them, rejections,
//! and a fuzz target for `decode`.

const std = @import("std");
const proto = @import("opentelemetry-proto");
const json = @import("json.zig");

const common = proto.common_v1;
const resource_v1 = proto.resource_v1;
const trace = proto.trace_v1;
const metrics = proto.metrics_v1;
const logs = proto.logs_v1;
const TraceRequest = proto.collector_trace_v1.ExportTraceServiceRequest;
const MetricsRequest = proto.collector_metrics_v1.ExportMetricsServiceRequest;
const LogsRequest = proto.collector_logs_v1.ExportLogsServiceRequest;

const Allocator = std.mem.Allocator;
const testing = std.testing;

const trace_id = [16]u8{ 0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36 };
const span_id = [8]u8{ 0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7 };
const parent_span_id = [8]u8{ 0x53, 0x99, 0x5c, 0x3f, 0x42, 0xcd, 0x8a, 0xd8 };
const link_trace_id = [16]u8{ 0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31, 0x9c };
const link_span_id = [8]u8{ 0xb7, 0xad, 0x6b, 0x71, 0x69, 0x20, 0x33, 0x31 };
const schema_url = "https://schemas.o11y.ing/2.0.0";
const scope_name = "github.com/jamesainslie/libo11y/zig";
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

fn serviceResource(arena: Allocator) !resource_v1.Resource {
    return .{ .attributes = try list(common.KeyValue, arena, &.{
        kv("service.name", .{ .string_value = "checkout" }),
    }) };
}

fn traceRequest(arena: Allocator) !TraceRequest {
    const event: trace.Span.Event = .{
        .time_unix_nano = start_ns + 1_000,
        .name = "exception",
        .attributes = try list(common.KeyValue, arena, &.{
            kv("exception.type", .{ .string_value = "error.Timeout" }),
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
            kv("http.response.status_code", .{ .int_value = 504 }),
            kv("server.duration.ratio", .{ .double_value = 0.75 }),
            kv("o11y.sampled.forced", .{ .bool_value = true }),
            kv("http.request.header.accept", .{ .array_value = .{ .values = try list(common.AnyValue, arena, &.{
                .{ .value = .{ .string_value = "application/json" } },
                .{ .value = .{ .string_value = "text/plain" } },
            }) } }),
            kv("o11y.request.meta", .{ .kvlist_value = .{ .values = try list(common.KeyValue, arena, &.{
                kv("retry", .{ .int_value = 0 }),
                kv("peer", .{ .string_value = "a\"b\\c\n\x01\u{e9}" }),
            }) } }),
            kv("o11y.payload", .{ .bytes_value = "\x00\x01\xfe\xff" }),
        }),
        .dropped_attributes_count = 2,
        .events = try list(trace.Span.Event, arena, &.{event}),
        .dropped_events_count = 3,
        .links = try list(trace.Span.Link, arena, &.{link}),
        .dropped_links_count = 4,
        .status = .{ .code = .STATUS_CODE_ERROR, .message = "upstream timed out" },
    };
    const scope_spans: trace.ScopeSpans = .{
        .scope = .{
            .name = scope_name,
            .version = "0.0.0",
            .attributes = try list(common.KeyValue, arena, &.{
                kv("o11y.scope.kind", .{ .string_value = "core" }),
            }),
        },
        .spans = try list(trace.Span, arena, &.{span}),
        .schema_url = schema_url,
    };
    const resource_spans: trace.ResourceSpans = .{
        .resource = .{ .attributes = try list(common.KeyValue, arena, &.{
            kv("service.name", .{ .string_value = "checkout" }),
            kv("process.pid", .{ .int_value = 4242 }),
            kv("o11y.build.modified", .{ .bool_value = false }),
        }) },
        .scope_spans = try list(trace.ScopeSpans, arena, &.{scope_spans}),
        .schema_url = schema_url,
    };
    return .{ .resource_spans = try list(trace.ResourceSpans, arena, &.{resource_spans}) };
}

const trace_json =
    \\{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}},
    \\{"key":"process.pid","value":{"intValue":"4242"}},{"key":"o11y.build.modified","value":{"boolValue":false}}]},
    \\"scopeSpans":[{"scope":{"name":"github.com/jamesainslie/libo11y/zig","version":"0.0.0",
    \\"attributes":[{"key":"o11y.scope.kind","value":{"stringValue":"core"}}]},
    \\"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7",
    \\"traceState":"o11y=1,vendor=2","parentSpanId":"53995c3f42cd8ad8","flags":257,"name":"GET /orders/{id}",
    \\"kind":2,"startTimeUnixNano":"1764000000000000000","endTimeUnixNano":"1764000000025000000",
    \\"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},
    \\{"key":"http.response.status_code","value":{"intValue":"504"}},
    \\{"key":"server.duration.ratio","value":{"doubleValue":0.75}},
    \\{"key":"o11y.sampled.forced","value":{"boolValue":true}},
    \\{"key":"http.request.header.accept","value":{"arrayValue":{"values":[{"stringValue":"application/json"},
    \\{"stringValue":"text/plain"}]}}},
    \\{"key":"o11y.request.meta","value":{"kvlistValue":{"values":[{"key":"retry","value":{"intValue":"0"}},
    \\{"key":"peer","value":{"stringValue":"a\"b\\c\n\u0001é"}}]}}},
    \\{"key":"o11y.payload","value":{"bytesValue":"AAH+/w=="}}],"droppedAttributesCount":2,
    \\"events":[{"timeUnixNano":"1764000000000001000","name":"exception",
    \\"attributes":[{"key":"exception.type","value":{"stringValue":"error.Timeout"}}],"droppedAttributesCount":1}],
    \\"droppedEventsCount":3,"links":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331",
    \\"traceState":"vendor=1","attributes":[{"key":"o11y.link.reason","value":{"stringValue":"detached"}}],
    \\"flags":769}],"droppedLinksCount":4,"status":{"message":"upstream timed out","code":2}}],
    \\"schemaUrl":"https://schemas.o11y.ing/2.0.0"}],"schemaUrl":"https://schemas.o11y.ing/2.0.0"}]}
;

fn metricsRequest(arena: Allocator) !MetricsRequest {
    const histogram_point: metrics.HistogramDataPoint = .{
        .attributes = try list(common.KeyValue, arena, &.{
            kv("http.route", .{ .string_value = "/orders/{id}" }),
        }),
        .start_time_unix_nano = start_ns,
        .time_unix_nano = end_ns,
        .count = 6,
        .sum = 1.375,
        .bucket_counts = try list(u64, arena, &.{ 1, 2, 0, 3 }),
        .explicit_bounds = try list(f64, arena, &.{ 0.005, 0.1, 1.0 }),
        .exemplars = try list(metrics.Exemplar, arena, &.{.{
            .time_unix_nano = start_ns + 500,
            .span_id = &span_id,
            .trace_id = &trace_id,
            .value = .{ .as_double = 1.25 },
        }}),
        .min = 0,
        .max = 1.25,
    };
    const sum_point: metrics.NumberDataPoint = .{
        .start_time_unix_nano = start_ns,
        .time_unix_nano = end_ns,
        .value = .{ .as_int = 42 },
    };
    const gauge_points = try list(metrics.NumberDataPoint, arena, &.{
        .{ .time_unix_nano = end_ns, .flags = 1, .value = .{ .as_double = -3.5 } },
        .{ .time_unix_nano = end_ns, .value = .{ .as_double = std.math.nan(f64) } },
        .{ .time_unix_nano = end_ns, .value = .{ .as_double = -std.math.inf(f64) } },
        .{ .time_unix_nano = end_ns, .value = .{ .as_double = 1e300 } },
    });
    const metric_list = try list(metrics.Metric, arena, &.{
        .{
            .name = "http.server.request.duration",
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
            .data = .{ .gauge = .{ .data_points = gauge_points } },
        },
    });
    const scope_metrics: metrics.ScopeMetrics = .{
        .scope = .{ .name = scope_name },
        .metrics = metric_list,
    };
    const resource_metrics: metrics.ResourceMetrics = .{
        .resource = try serviceResource(arena),
        .scope_metrics = try list(metrics.ScopeMetrics, arena, &.{scope_metrics}),
    };
    return .{ .resource_metrics = try list(metrics.ResourceMetrics, arena, &.{resource_metrics}) };
}

const metrics_json =
    \\{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}}]},
    \\"scopeMetrics":[{"scope":{"name":"github.com/jamesainslie/libo11y/zig"},
    \\"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"dataPoints":[{
    \\"attributes":[{"key":"http.route","value":{"stringValue":"/orders/{id}"}}],
    \\"startTimeUnixNano":"1764000000000000000","timeUnixNano":"1764000000025000000","count":"6","sum":1.375,
    \\"bucketCounts":["1","2","0","3"],"explicitBounds":[0.005,0.1,1],
    \\"exemplars":[{"timeUnixNano":"1764000000000000500","spanId":"00f067aa0ba902b7",
    \\"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","asDouble":1.25}],"min":0,"max":1.25}],
    \\"aggregationTemporality":2}},
    \\{"name":"o11y.schema.violations","description":"Attributes the sensitivity policy removed.",
    \\"unit":"{violation}","sum":{"dataPoints":[{"startTimeUnixNano":"1764000000000000000",
    \\"timeUnixNano":"1764000000025000000","asInt":"42"}],"aggregationTemporality":1,"isMonotonic":true}},
    \\{"name":"process.memory.usage","unit":"By","gauge":{"dataPoints":[
    \\{"timeUnixNano":"1764000000025000000","flags":1,"asDouble":-3.5},
    \\{"timeUnixNano":"1764000000025000000","asDouble":"NaN"},
    \\{"timeUnixNano":"1764000000025000000","asDouble":"-Infinity"},
    \\{"timeUnixNano":"1764000000025000000","asDouble":1e300}]}}]}]}]}
;

fn logsRequest(arena: Allocator) !LogsRequest {
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
        .scope = .{ .name = scope_name, .version = "0.0.0" },
        .log_records = try list(logs.LogRecord, arena, &.{record}),
        .schema_url = schema_url,
    };
    const resource_logs: logs.ResourceLogs = .{
        .resource = try serviceResource(arena),
        .scope_logs = try list(logs.ScopeLogs, arena, &.{scope_logs}),
        .schema_url = schema_url,
    };
    return .{ .resource_logs = try list(logs.ResourceLogs, arena, &.{resource_logs}) };
}

const logs_json =
    \\{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout"}}]},
    \\"scopeLogs":[{"scope":{"name":"github.com/jamesainslie/libo11y/zig","version":"0.0.0"},
    \\"logRecords":[{"timeUnixNano":"1764000000000000000","observedTimeUnixNano":"1764000000000000010",
    \\"severityNumber":9,"severityText":"INFO","body":{"stringValue":"order placed"},
    \\"attributes":[{"key":"order.id","value":{"stringValue":"o-123"}},
    \\{"key":"order.total","value":{"doubleValue":19.99}},{"key":"order.items","value":{"intValue":"3"}},
    \\{"key":"order.gift","value":{"boolValue":false}},
    \\{"key":"order.shipping","value":{"kvlistValue":{"values":[{"key":"method","value":{"stringValue":"express"}},
    \\{"key":"days","value":{"intValue":"2"}}]}}},{"key":"order.receipt","value":{"bytesValue":"AAH+/w=="}}],
    \\"droppedAttributesCount":1,"flags":1,"traceId":"4bf92f3577b34da6a3ce929d0e0e4736",
    \\"spanId":"00f067aa0ba902b7","eventName":"order.placed"}],"schemaUrl":"https://schemas.o11y.ing/2.0.0"}],
    \\"schemaUrl":"https://schemas.o11y.ing/2.0.0"}]}
;

/// Removes the line breaks the expected payloads above use for
/// readability. None of them has a line break inside a string.
fn compact(comptime text: []const u8) []const u8 {
    comptime {
        @setEvalBranchQuota(100_000);
        var out: [text.len]u8 = undefined;
        var n: usize = 0;
        for (text) |c| {
            if (c == '\n') continue;
            out[n] = c;
            n += 1;
        }
        const final = out[0..n].*;
        return &final;
    }
}

fn isArrayList(comptime T: type) bool {
    return @typeInfo(T) == .@"struct" and @hasField(T, "items") and @hasField(T, "capacity");
}

/// Compares two messages field by field, as proto_roundtrip_test.zig
/// does, except that floats compare by bit pattern so NaN equals NaN and
/// -0 differs from 0. Repeated fields compare their items.
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
        .float => if (@as(u64, @bitCast(want)) != @as(u64, @bitCast(got))) return error.TestExpectedEqual,
        .int, .bool, .@"enum" => if (want != got) return error.TestExpectedEqual,
        else => @compileError("unexpected field type " ++ @typeName(T)),
    }
}

fn encodeAlloc(comptime T: type, gpa: Allocator, message: T) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    try json.encode(T, message, &out.writer);
    return out.toOwnedSlice();
}

fn expectEncodes(comptime T: type, message: T, want: []const u8) !void {
    const got = try encodeAlloc(T, testing.allocator, message);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(want, got);
}

/// Encodes `message`, decodes the JSON and checks that the result equals
/// the original and encodes to the same JSON.
fn expectRoundTrip(comptime T: type, message: T) !void {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const encoded = try encodeAlloc(T, a, message);
    const decoded = try json.decode(T, a, encoded);
    try expectMessageEqual(T, message, decoded);
    try testing.expectEqualStrings(encoded, try encodeAlloc(T, a, decoded));
}

test "encode writes a trace request as OTLP/JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectEncodes(TraceRequest, try traceRequest(arena.allocator()), comptime compact(trace_json));
}

test "encode writes a metrics request as OTLP/JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectEncodes(MetricsRequest, try metricsRequest(arena.allocator()), comptime compact(metrics_json));
}

test "encode writes a logs request as OTLP/JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try expectEncodes(LogsRequest, try logsRequest(arena.allocator()), comptime compact(logs_json));
}

test "encode omits default fields and keeps set but empty messages" {
    try expectEncodes(TraceRequest, .{}, "{}");
    try expectEncodes(trace.Span, .{}, "{}");
    try expectEncodes(trace.Span, .{ .status = .{} }, "{\"status\":{}}");
    try expectEncodes(common.KeyValue, .{ .key = "k", .value = .{} }, "{\"key\":\"k\",\"value\":{}}");
    // A oneof member is written even when it holds its zero value.
    try expectEncodes(common.AnyValue, .{ .value = .{ .string_value = "" } }, "{\"stringValue\":\"\"}");
    try expectEncodes(metrics.NumberDataPoint, .{ .value = .{ .as_double = 0 } }, "{\"asDouble\":0}");
    // Optional scalars are written when set, even to zero.
    try expectEncodes(metrics.HistogramDataPoint, .{ .sum = 0, .max = -0.0 }, "{\"sum\":0,\"max\":-0}");
}

test "encode writes floats in the shortest form and special values as strings" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const point: metrics.HistogramDataPoint = .{
        .explicit_bounds = try list(f64, a, &.{
            0.1,               1e21, 1e20, 1e-7, 0.000001, -2.5, 5e-324,
            std.math.inf(f64), -0.0,
        }),
    };
    try expectEncodes(
        metrics.HistogramDataPoint,
        point,
        "{\"explicitBounds\":[0.1,1e21,100000000000000000000,1e-7,0.000001,-2.5,5e-324,\"Infinity\",-0]}",
    );
}

test "encode replaces invalid UTF-8 in strings" {
    try expectEncodes(common.KeyValue, .{ .key = "ok\xffend\xc3" }, "{\"key\":\"ok\\ufffdend\\ufffd\"}");
}

test "encode writes 64-bit integers as strings and 32-bit integers as numbers" {
    try expectEncodes(
        common.AnyValue,
        .{ .value = .{ .int_value = std.math.minInt(i64) } },
        "{\"intValue\":\"-9223372036854775808\"}",
    );
    try expectEncodes(trace.Span, .{
        .end_time_unix_nano = std.math.maxInt(u64),
        .dropped_links_count = std.math.maxInt(u32),
    }, "{\"endTimeUnixNano\":\"18446744073709551615\",\"droppedLinksCount\":4294967295}");
}

test "trace, metrics and logs requests round-trip through OTLP/JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectRoundTrip(TraceRequest, try traceRequest(a));
    try expectRoundTrip(MetricsRequest, try metricsRequest(a));
    try expectRoundTrip(LogsRequest, try logsRequest(a));
}

test "decode reads the hand-written expected payloads" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try expectMessageEqual(TraceRequest, try traceRequest(a), try json.decode(TraceRequest, a, trace_json));
    try expectMessageEqual(MetricsRequest, try metricsRequest(a), try json.decode(MetricsRequest, a, metrics_json));
    try expectMessageEqual(LogsRequest, try logsRequest(a), try json.decode(LogsRequest, a, logs_json));
}

test "decode reads a payload as a collector or the JS exporter sends it" {
    const payload =
        \\{
        \\  "resourceSpans": [{
        \\    "resource": {
        \\      "attributes": [{"key": "service.name", "value": {"stringValue": "web"}}],
        \\      "droppedAttributesCount": 0
        \\    },
        \\    "scopeSpans": [{
        \\      "scope": {"name": "@opentelemetry/instrumentation-fetch", "version": "0.57.0"},
        \\      "spans": [{
        \\        "traceId": "4BF92F3577B34DA6A3CE929D0E0E4736",
        \\        "spanId": "00f067aa0ba902b7",
        \\        "parentSpanId": "",
        \\        "name": "HTTP GET",
        \\        "kind": 3,
        \\        "startTimeUnixNano": "1764000000000000000",
        \\        "endTimeUnixNano": 1764000000025000000,
        \\        "attributes": [
        \\          {"key": "http.response.status_code", "value": {"intValue": 200}},
        \\          {"key": "ratio", "value": {"doubleValue": "NaN"}},
        \\          {"key": "big", "value": {"doubleValue": "Infinity"}},
        \\          {"key": "small", "value": {"doubleValue": "-Infinity"}},
        \\          {"key": "quoted", "value": {"doubleValue": "2.5"}},
        \\          {"key": "blob", "value": {"bytesValue": "AAH-_w"}},
        \\          {"key": "empty", "value": {}},
        \\          {"key": "none"}
        \\        ],
        \\        "droppedAttributesCount": 0,
        \\        "events": [],
        \\        "links": [],
        \\        "status": {"code": 1},
        \\        "unknownField": {"nested": [1, 2.5, "x", null, true]}
        \\      }]
        \\    }]
        \\  }],
        \\  "unknownTopLevel": true
        \\}
    ;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try json.decode(TraceRequest, arena.allocator(), payload);

    try testing.expectEqual(1, request.resource_spans.items.len);
    const rs = request.resource_spans.items[0];
    try testing.expectEqualStrings("service.name", rs.resource.?.attributes.items[0].key);
    try testing.expectEqualStrings("web", rs.resource.?.attributes.items[0].value.?.value.?.string_value);
    const ss = rs.scope_spans.items[0];
    try testing.expectEqualStrings("@opentelemetry/instrumentation-fetch", ss.scope.?.name);
    try testing.expectEqualStrings("0.57.0", ss.scope.?.version);

    const span = ss.spans.items[0];
    try testing.expectEqualSlices(u8, &trace_id, span.trace_id);
    try testing.expectEqualSlices(u8, &span_id, span.span_id);
    try testing.expectEqual(0, span.parent_span_id.len);
    try testing.expectEqualStrings("HTTP GET", span.name);
    try testing.expectEqual(trace.Span.SpanKind.SPAN_KIND_CLIENT, span.kind);
    try testing.expectEqual(start_ns, span.start_time_unix_nano);
    try testing.expectEqual(end_ns, span.end_time_unix_nano);
    try testing.expectEqual(trace.Status.StatusCode.STATUS_CODE_OK, span.status.?.code);
    try testing.expectEqual(0, span.events.items.len);

    const attrs = span.attributes.items;
    try testing.expectEqual(8, attrs.len);
    try testing.expectEqual(200, attrs[0].value.?.value.?.int_value);
    try testing.expect(std.math.isNan(attrs[1].value.?.value.?.double_value));
    try testing.expectEqual(std.math.inf(f64), attrs[2].value.?.value.?.double_value);
    try testing.expectEqual(-std.math.inf(f64), attrs[3].value.?.value.?.double_value);
    try testing.expectEqual(2.5, attrs[4].value.?.value.?.double_value);
    try testing.expectEqualSlices(u8, "\x00\x01\xfe\xff", attrs[5].value.?.value.?.bytes_value);
    try testing.expectEqual(null, attrs[6].value.?.value);
    try testing.expectEqual(null, attrs[7].value);
}

test "decode accepts snake_case names, enum names and integral numbers in other forms" {
    const payload =
        \\{"resource_spans":[{"scope_spans":[{"spans":[{"trace_id":"0af7651916cd43dd8448eb211c80319c",
        \\"span_id":"b7ad6b7169203331","start_time_unix_nano":1.764e18,"kind":"SPAN_KIND_PRODUCER",
        \\"dropped_events_count":"7","flags":2.0e2,"status":{"code":"STATUS_CODE_ERROR"},
        \\"attributes":[{"key":"n","value":{"int_value":"-12"}},{"key":"d","value":{"doubleValue":3}},
        \\{"key":"b","value":{"bytesValue":"AAH+/w"}}]}]}]}]}
    ;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try json.decode(TraceRequest, arena.allocator(), payload);
    const span = request.resource_spans.items[0].scope_spans.items[0].spans.items[0];
    try testing.expectEqualSlices(u8, &link_trace_id, span.trace_id);
    try testing.expectEqualSlices(u8, &link_span_id, span.span_id);
    try testing.expectEqual(start_ns, span.start_time_unix_nano);
    try testing.expectEqual(trace.Span.SpanKind.SPAN_KIND_PRODUCER, span.kind);
    try testing.expectEqual(7, span.dropped_events_count);
    try testing.expectEqual(200, span.flags);
    try testing.expectEqual(trace.Status.StatusCode.STATUS_CODE_ERROR, span.status.?.code);
    try testing.expectEqual(-12, span.attributes.items[0].value.?.value.?.int_value);
    try testing.expectEqual(3.0, span.attributes.items[1].value.?.value.?.double_value);
    try testing.expectEqualSlices(u8, "\x00\x01\xfe\xff", span.attributes.items[2].value.?.value.?.bytes_value);
}

test "decode keeps unknown enum values and treats null as the default" {
    const payload =
        \\{"resourceSpans":[{"resource":null,"scopeSpans":[{"spans":[{"kind":42,"name":null,
        \\"attributes":null,"status":null}]}]}]}
    ;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try json.decode(TraceRequest, arena.allocator(), payload);
    try testing.expectEqual(null, request.resource_spans.items[0].resource);
    const span = request.resource_spans.items[0].scope_spans.items[0].spans.items[0];
    try testing.expectEqual(42, @backingInt(span.kind));
    try testing.expectEqual(0, span.name.len);
    try testing.expectEqual(0, span.attributes.items.len);
    try testing.expectEqual(null, span.status);
}

test "decode copies strings out of the input" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var input = "{\"key\":\"abc\"}".*;
    const kvp = try json.decode(common.KeyValue, arena.allocator(), &input);
    @memset(&input, 'x');
    try testing.expectEqualStrings("abc", kvp.key);
}

fn expectDecodeError(comptime T: type, want: json.DecodeError, payload: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectError(want, json.decode(T, arena.allocator(), payload));
}

test "decode rejects malformed ids" {
    const cases = [_][]const u8{
        "{\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e473\"}",
        "{\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e47360\"}",
        "{\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e47zz\"}",
        "{\"traceId\":\"S/kvNXezTaajzpKdDg5HNg==\"}",
        "{\"traceId\":12}",
        "{\"spanId\":\"00f067aa0ba902\"}",
        "{\"spanId\":\"00f067aa0ba902b7ff\"}",
        "{\"parentSpanId\":\"00f067aa0ba902bg\"}",
    };
    for (cases) |payload| try expectDecodeError(trace.Span, error.InvalidField, payload);
    try expectDecodeError(trace.Span.Link, error.InvalidField, "{\"traceId\":\"abc\"}");
    try expectDecodeError(logs.LogRecord, error.InvalidField, "{\"spanId\":\"abc\"}");
    try expectDecodeError(metrics.Exemplar, error.InvalidField, "{\"traceId\":\"abc\"}");
}

test "decode rejects malformed JSON" {
    const cases = [_][]const u8{
        "",
        "{",
        "{\"resourceSpans\":[",
        "{\"resourceSpans\":[]} trailing",
        "{'resourceSpans':[]}",
        "{\"name\":\"\xff\"}",
        "{\"name\":\"a\",\"name\":\"b\"}",
    };
    for (cases) |payload| try expectDecodeError(TraceRequest, error.InvalidJson, payload);
}

test "decode rejects values of the wrong JSON type or out of range" {
    const cases = [_][]const u8{
        "[]",
        "\"x\"",
        "null",
        "{\"name\":5}",
        "{\"name\":true}",
        "{\"attributes\":{}}",
        "{\"attributes\":[null]}",
        "{\"attributes\":[5]}",
        "{\"status\":[]}",
        "{\"kind\":\"SPAN_KIND_NOPE\"}",
        "{\"kind\":1.5}",
        "{\"kind\":2147483648}",
        "{\"kind\":true}",
        "{\"flags\":-1}",
        "{\"flags\":4294967296}",
        "{\"flags\":\"0x10\"}",
        "{\"flags\":\"+1\"}",
        "{\"flags\":\"1_0\"}",
        "{\"flags\":\" 1\"}",
        "{\"startTimeUnixNano\":\"18446744073709551616\"}",
        "{\"startTimeUnixNano\":-1}",
        "{\"startTimeUnixNano\":1.5}",
        "{\"startTimeUnixNano\":1e30}",
        "{\"startTimeUnixNano\":{}}",
        "{\"droppedAttributesCount\":\"\"}",
    };
    for (cases) |payload| {
        expectDecodeError(trace.Span, error.InvalidField, payload) catch |err| {
            std.debug.print("payload: {s}\n", .{payload});
            return err;
        };
    }
    const value_cases = [_][]const u8{
        "{\"boolValue\":\"true\"}",
        "{\"boolValue\":1}",
        "{\"doubleValue\":\"nan\"}",
        "{\"doubleValue\":\"inf\"}",
        "{\"doubleValue\":\"0x10\"}",
        "{\"doubleValue\":1e400}",
        "{\"doubleValue\":true}",
        "{\"bytesValue\":\"!!!!\"}",
        "{\"bytesValue\":\"A\"}",
        "{\"bytesValue\":5}",
        "{\"stringValue\":\"a\",\"intValue\":\"1\"}",
        "{\"stringValue\":\"a\",\"string_value\":\"b\"}",
        "{\"arrayValue\":[]}",
        "{\"kvlistValue\":{\"values\":[{\"key\":1}]}}",
    };
    for (value_cases) |payload| {
        expectDecodeError(common.AnyValue, error.InvalidField, payload) catch |err| {
            std.debug.print("payload: {s}\n", .{payload});
            return err;
        };
    }
}

test "decode limits the nesting depth" {
    const gpa = testing.allocator;
    var payload: std.ArrayList(u8) = .empty;
    defer payload.deinit(gpa);
    const levels = json.max_depth + 1;
    for (0..levels) |_| try payload.appendSlice(gpa, "{\"arrayValue\":{\"values\":[");
    try payload.appendSlice(gpa, "{\"intValue\":\"1\"}");
    for (0..levels) |_| try payload.appendSlice(gpa, "]}}");
    try expectDecodeError(common.AnyValue, error.NestingTooDeep, payload.items);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    _ = try json.decode(common.AnyValue, arena.allocator(), "{\"arrayValue\":{\"values\":[{\"arrayValue\":{}}]}}");
}

test "decode reports allocation failure as OutOfMemory" {
    // Fail each allocation in turn until the decode needs no more.
    var fail_index: usize = 0;
    while (fail_index < 1000) : (fail_index += 1) {
        var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = fail_index });
        var arena: std.heap.ArenaAllocator = .init(failing.allocator());
        defer arena.deinit();
        if (json.decode(TraceRequest, arena.allocator(), trace_json)) |_| {
            try testing.expect(fail_index > 0);
            return;
        } else |err| try testing.expectEqual(error.OutOfMemory, err);
    }
    return error.TestUnexpectedResult;
}

const fuzz_corpus = [_][]const u8{
    compact(trace_json),
    "{}",
    "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":\"4bf92f3577b34da6a3ce929d0e0e4736\"," ++
        "\"spanId\":\"00f067aa0ba902b7\",\"kind\":3,\"startTimeUnixNano\":1764000000000000000," ++
        "\"attributes\":[{\"key\":\"d\",\"value\":{\"doubleValue\":\"NaN\"}}," ++
        "{\"key\":\"b\",\"value\":{\"bytesValue\":\"AAH-_w\"}}]}]}]}]}",
    "{\"resource_spans\":[{\"resource\":{\"attributes\":[{\"key\":\"k\",\"value\":{\"kvlistValue\":" ++
        "{\"values\":[{\"key\":\"x\",\"value\":{\"arrayValue\":{\"values\":[{\"boolValue\":true}]}}}]}}}]}}]}",
    "{\"resourceSpans\":[{\"scopeSpans\":[{\"spans\":[{\"traceId\":\"4bf9\"}]}]}]}",
    "[1,2,{\"a\":null}]",
};

fn fuzzDecode(_: void, smith: *std.testing.Smith) anyerror!void {
    var buf: [4096]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const first = json.decode(TraceRequest, a, input) catch |err| switch (err) {
        error.InvalidJson, error.InvalidField, error.NestingTooDeep => return,
        error.OutOfMemory => return err,
    };
    const encoded = try encodeAlloc(TraceRequest, a, first);
    const second = try json.decode(TraceRequest, a, encoded);
    try expectMessageEqual(TraceRequest, first, second);
}

test "fuzz decode" {
    try std.testing.fuzz({}, fuzzDecode, .{ .corpus = &fuzz_corpus });
}
