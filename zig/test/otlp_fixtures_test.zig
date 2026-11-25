//! Decodes OTLP export requests that protoc encoded from the text-format
//! inputs in fixtures/otlp/, so the generated bindings are checked against
//! an independent encoder. See fixtures/otlp/README.md.

const std = @import("std");
const proto = @import("opentelemetry-proto");

const testing = std.testing;

const trace_id = [16]u8{ 0x4b, 0xf9, 0x2f, 0x35, 0x77, 0xb3, 0x4d, 0xa6, 0xa3, 0xce, 0x92, 0x9d, 0x0e, 0x0e, 0x47, 0x36 };
const span_id = [8]u8{ 0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7 };
const parent_span_id = [8]u8{ 0x53, 0x99, 0x5c, 0x3f, 0x42, 0xcd, 0x8a, 0xd8 };
const link_trace_id = [16]u8{ 0x0a, 0xf7, 0x65, 0x19, 0x16, 0xcd, 0x43, 0xdd, 0x84, 0x48, 0xeb, 0x21, 0x1c, 0x80, 0x31, 0x9c };
const schema_url = "https://schemas.o11y.ing/2.0.0";

fn decode(comptime T: type, bytes: []const u8) !T {
    var reader: std.Io.Reader = .fixed(bytes);
    return T.decode(&reader, testing.allocator);
}

fn stringValue(value: ?proto.common_v1.AnyValue) ![]const u8 {
    const v = value orelse return error.TestExpectedEqual;
    const inner = v.value orelse return error.TestExpectedEqual;
    return switch (inner) {
        .string_value => |s| s,
        else => error.TestExpectedEqual,
    };
}

test "a protoc-encoded ExportTraceServiceRequest decodes" {
    var request = try decode(proto.collector_trace_v1.ExportTraceServiceRequest, @embedFile("fixtures/otlp/trace.binpb"));
    defer request.deinit(testing.allocator);

    try testing.expectEqual(1, request.resource_spans.items.len);
    const rs = request.resource_spans.items[0];
    try testing.expectEqualStrings(schema_url, rs.schema_url);
    const resource = rs.resource orelse return error.TestExpectedEqual;
    try testing.expectEqual(2, resource.attributes.items.len);
    try testing.expectEqualStrings("service.name", resource.attributes.items[0].key);
    try testing.expectEqualStrings("checkout", try stringValue(resource.attributes.items[0].value));
    try testing.expectEqual(4242, resource.attributes.items[1].value.?.value.?.int_value);

    const ss = rs.scope_spans.items[0];
    try testing.expectEqualStrings(schema_url, ss.schema_url);
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig", ss.scope.?.name);
    try testing.expectEqualStrings("0.0.0", ss.scope.?.version);

    try testing.expectEqual(1, ss.spans.items.len);
    const span = ss.spans.items[0];
    try testing.expectEqualSlices(u8, &trace_id, span.trace_id);
    try testing.expectEqualSlices(u8, &span_id, span.span_id);
    try testing.expectEqualSlices(u8, &parent_span_id, span.parent_span_id);
    try testing.expectEqualStrings("o11y=1", span.trace_state);
    try testing.expectEqual(0x101, span.flags);
    try testing.expectEqualStrings("GET /orders/{id}", span.name);
    try testing.expectEqual(.SPAN_KIND_SERVER, span.kind);
    try testing.expectEqual(1_764_000_000_000_000_000, span.start_time_unix_nano);
    try testing.expectEqual(1_764_000_000_025_000_000, span.end_time_unix_nano);
    try testing.expectEqualStrings("http.response.status_code", span.attributes.items[0].key);
    try testing.expectEqual(504, span.attributes.items[0].value.?.value.?.int_value);

    try testing.expectEqual(1, span.events.items.len);
    const event = span.events.items[0];
    try testing.expectEqualStrings("exception", event.name);
    try testing.expectEqual(1_764_000_000_000_001_000, event.time_unix_nano);
    try testing.expectEqualStrings("error.Timeout", try stringValue(event.attributes.items[0].value));

    try testing.expectEqual(1, span.links.items.len);
    try testing.expectEqualSlices(u8, &link_trace_id, span.links.items[0].trace_id);
    try testing.expectEqual(0x301, span.links.items[0].flags);

    const status = span.status orelse return error.TestExpectedEqual;
    try testing.expectEqual(.STATUS_CODE_ERROR, status.code);
    try testing.expectEqualStrings("upstream timed out", status.message);
}

test "a protoc-encoded ExportMetricsServiceRequest decodes" {
    var request = try decode(proto.collector_metrics_v1.ExportMetricsServiceRequest, @embedFile("fixtures/otlp/metrics.binpb"));
    defer request.deinit(testing.allocator);

    const metrics = request.resource_metrics.items[0].scope_metrics.items[0].metrics.items;
    try testing.expectEqual(3, metrics.len);

    try testing.expectEqualStrings("http.server.request.duration", metrics[0].name);
    try testing.expectEqualStrings("s", metrics[0].unit);
    const histogram = metrics[0].data.?.histogram;
    try testing.expectEqual(.AGGREGATION_TEMPORALITY_CUMULATIVE, histogram.aggregation_temporality);
    const point = histogram.data_points.items[0];
    try testing.expectEqualStrings("/orders/{id}", try stringValue(point.attributes.items[0].value));
    try testing.expectEqual(6, point.count);
    try testing.expectEqual(1.375, point.sum.?);
    try testing.expectEqualSlices(u64, &.{ 1, 2, 0, 3 }, point.bucket_counts.items);
    try testing.expectEqualSlices(f64, &.{ 0.005, 0.1, 1.0 }, point.explicit_bounds.items);
    try testing.expectEqual(0.001, point.min.?);
    try testing.expectEqual(1.25, point.max.?);
    try testing.expectEqual(1, point.exemplars.items.len);
    const exemplar = point.exemplars.items[0];
    try testing.expectEqualSlices(u8, &trace_id, exemplar.trace_id);
    try testing.expectEqualSlices(u8, &span_id, exemplar.span_id);
    try testing.expectEqual(1_764_000_000_000_000_500, exemplar.time_unix_nano);
    try testing.expectEqual(1.25, exemplar.value.?.as_double);

    try testing.expectEqualStrings("o11y.schema.violations", metrics[1].name);
    const sum = metrics[1].data.?.sum;
    try testing.expectEqual(.AGGREGATION_TEMPORALITY_DELTA, sum.aggregation_temporality);
    try testing.expect(sum.is_monotonic);
    try testing.expectEqual(42, sum.data_points.items[0].value.?.as_int);

    try testing.expectEqualStrings("process.memory.usage", metrics[2].name);
    try testing.expectEqual(-3.5, metrics[2].data.?.gauge.data_points.items[0].value.?.as_double);
}

test "a protoc-encoded ExportLogsServiceRequest decodes" {
    var request = try decode(proto.collector_logs_v1.ExportLogsServiceRequest, @embedFile("fixtures/otlp/logs.binpb"));
    defer request.deinit(testing.allocator);

    const records = request.resource_logs.items[0].scope_logs.items[0].log_records.items;
    try testing.expectEqual(1, records.len);
    const record = records[0];
    try testing.expectEqual(1_764_000_000_000_000_000, record.time_unix_nano);
    try testing.expectEqual(1_764_000_000_000_000_010, record.observed_time_unix_nano);
    try testing.expectEqual(.SEVERITY_NUMBER_INFO, record.severity_number);
    try testing.expectEqualStrings("INFO", record.severity_text);
    try testing.expectEqualStrings("order placed", try stringValue(record.body));
    try testing.expectEqualStrings("o-123", try stringValue(record.attributes.items[0].value));
    const shipping = record.attributes.items[1].value.?.value.?.kvlist_value;
    try testing.expectEqualStrings("method", shipping.values.items[0].key);
    try testing.expectEqualStrings("express", try stringValue(shipping.values.items[0].value));
    try testing.expectEqual(1, record.flags);
    try testing.expectEqualSlices(u8, &trace_id, record.trace_id);
    try testing.expectEqualSlices(u8, &span_id, record.span_id);
    try testing.expectEqualStrings("order.placed", record.event_name);
}
