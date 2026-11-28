//! Tests for the OTLP message builders: spans from a real provider are
//! converted, encoded with the vendored bindings and decoded again.

const std = @import("std");
const testing = std.testing;
const proto = @import("opentelemetry-proto");
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const kv = attribute.kv;
const deadline = @import("../deadline.zig");
const ids = @import("../ids.zig");
const InMemoryExporter = @import("../memory_exporter.zig").InMemoryExporter;
const metric_mod = @import("../metric/metric.zig");
const processor = @import("../processor.zig");
const tracer_mod = @import("../tracer.zig");
const encode = @import("encode.zig");

const io = testing.io;

const remote_parent: ids.SpanContext = .{
    .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
    .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
    .flags = .sampled_flag,
    .remote = true,
    .trace_state = .{ .header = "vendor=1" },
};

test "a batch encodes grouped by resource and scope and decodes back" {
    var mem: InMemoryExporter = .init(testing.allocator, io);
    defer mem.deinit();
    var simple: processor.SimpleSpanProcessor = .init(io, mem.exporter(), .{});
    const res_attrs = [_]attribute.KeyValue{ kv("service.name", "checkout"), kv("deployment.environment.name", "test") };
    const provider = try tracer_mod.TracerProvider.create(testing.allocator, io, .{
        .resource = .{ .attributes = &res_attrs, .schema_url = "https://schemas.o11y.ing/1.1.0" },
        .processors = &.{simple.processor()},
    });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(1))) catch {};
    const scope_attrs = [_]attribute.KeyValue{kv("scope.kind", "core")};
    const a = provider.tracer(.{ .name = "a", .version = "1.2.3", .schema_url = "https://example/scope", .attributes = &scope_attrs });
    const b = provider.tracer(.{ .name = "b" });

    var server = a.start(Context.background.withSpanContext(remote_parent), "GET /orders/{id}", .{
        .kind = .server,
        .attributes = &.{ kv("http.response.status_code", 504), kv("ratio", 0.75), kv("tags", @as([]const []const u8, &.{ "x", "y" })), kv("bad.utf8", "a\xffb") },
        .links = &.{.{ .span_context = remote_parent, .attributes = &.{kv("link.reason", "detached")} }},
    });
    server.addEvent("cache miss", .{ .attributes = &.{kv("key", "o-1")}, .timestamp = 1_000 });
    server.setStatus(.@"error", "upstream timed out");
    var other = b.start(Context.background.withSpan(&server), "child", .{ .kind = .client });
    other.end();
    server.end();
    var second = a.start(.background, "second", .{});
    second.end();

    const spans = try mem.snapshot(testing.allocator);
    defer testing.allocator.free(spans);
    try testing.expectEqual(@as(usize, 3), spans.len);

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try encode.traceRequest(arena.allocator(), spans);

    var bytes: std.Io.Writer.Allocating = .init(testing.allocator);
    defer bytes.deinit();
    try request.encode(&bytes.writer, testing.allocator);
    var reader: std.Io.Reader = .fixed(bytes.written());
    var decoded = try proto.collector_trace_v1.ExportTraceServiceRequest.decode(&reader, testing.allocator);
    defer decoded.deinit(testing.allocator);

    try testing.expectEqual(@as(usize, 1), decoded.resource_spans.items.len);
    const rs = decoded.resource_spans.items[0];
    try testing.expectEqualStrings("https://schemas.o11y.ing/1.1.0", rs.schema_url);
    try testing.expectEqualStrings("service.name", rs.resource.?.attributes.items[0].key);
    try testing.expectEqualStrings("checkout", rs.resource.?.attributes.items[0].value.?.value.?.string_value);
    // Scope b's child ended first, then a's two spans.
    try testing.expectEqual(@as(usize, 2), rs.scope_spans.items.len);
    const sb = rs.scope_spans.items[0];
    const sa = rs.scope_spans.items[1];
    try testing.expectEqualStrings("b", sb.scope.?.name);
    try testing.expectEqualStrings("a", sa.scope.?.name);
    try testing.expectEqualStrings("1.2.3", sa.scope.?.version);
    try testing.expectEqualStrings("https://example/scope", sa.schema_url);
    try testing.expectEqualStrings("core", sa.scope.?.attributes.items[0].value.?.value.?.string_value);
    try testing.expectEqual(@as(usize, 2), sa.spans.items.len);

    const s = sa.spans.items[0];
    try testing.expectEqualStrings("GET /orders/{id}", s.name);
    try testing.expectEqualSlices(u8, &remote_parent.trace_id.bytes, s.trace_id);
    try testing.expectEqualSlices(u8, &remote_parent.span_id.bytes, s.parent_span_id);
    try testing.expectEqualStrings("vendor=1", s.trace_state);
    // Sampled, parent remoteness known, parent remote.
    try testing.expectEqual(@as(u32, 0x301), s.flags);
    try testing.expectEqual(proto.trace_v1.Span.SpanKind.SPAN_KIND_SERVER, s.kind);
    try testing.expectEqual(proto.trace_v1.Status.StatusCode.STATUS_CODE_ERROR, s.status.?.code);
    try testing.expectEqualStrings("upstream timed out", s.status.?.message);
    try testing.expectEqual(@as(i64, 504), s.attributes.items[0].value.?.value.?.int_value);
    try testing.expectEqual(@as(f64, 0.75), s.attributes.items[1].value.?.value.?.double_value);
    try testing.expectEqualStrings("y", s.attributes.items[2].value.?.value.?.array_value.values.items[1].value.?.string_value);
    try testing.expectEqualStrings("a\u{fffd}b", s.attributes.items[3].value.?.value.?.string_value);
    try testing.expectEqualStrings("cache miss", s.events.items[0].name);
    try testing.expectEqual(@as(u64, 1_000), s.events.items[0].time_unix_nano);
    try testing.expectEqualStrings("o-1", s.events.items[0].attributes.items[0].value.?.value.?.string_value);
    const link = s.links.items[0];
    try testing.expectEqualSlices(u8, &remote_parent.span_id.bytes, link.span_id);
    try testing.expectEqual(@as(u32, 0x301), link.flags);
    try testing.expectEqualStrings("", link.trace_state);
    try testing.expect(s.end_time_unix_nano >= s.start_time_unix_nano);

    const child = sb.spans.items[0];
    try testing.expectEqualSlices(u8, s.span_id, child.parent_span_id);
    try testing.expectEqual(@as(u32, 0x101), child.flags);
    try testing.expectEqual(proto.trace_v1.Span.SpanKind.SPAN_KIND_CLIENT, child.kind);

    const root = sa.spans.items[1];
    try testing.expectEqual(@as(usize, 0), root.parent_span_id.len);
    try testing.expectEqual(proto.trace_v1.Status.StatusCode.STATUS_CODE_UNSET, root.status.?.code);
}

test "a trace request replaces invalid UTF-8 in schema URLs, as metrics and logs do" {
    var mem: InMemoryExporter = .init(testing.allocator, io);
    defer mem.deinit();
    var simple: processor.SimpleSpanProcessor = .init(io, mem.exporter(), .{});
    const provider = try tracer_mod.TracerProvider.create(testing.allocator, io, .{
        .resource = .{ .attributes = &.{}, .schema_url = "https://res/\xff" },
        .processors = &.{simple.processor()},
    });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(1))) catch {};
    var span = provider.tracer(.{ .name = "a", .schema_url = "https://scope/\xff" }).start(.background, "op", .{});
    span.end();

    const spans = try mem.snapshot(testing.allocator);
    defer testing.allocator.free(spans);
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try encode.traceRequest(arena.allocator(), spans);
    const rs = request.resource_spans.items[0];
    try testing.expectEqualStrings("https://res/\u{fffd}", rs.schema_url);
    try testing.expectEqualStrings("https://scope/\u{fffd}", rs.scope_spans.items[0].schema_url);
}

test "utf8 replaces each invalid sequence" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const ok = "héllo";
    try testing.expectEqual(@as([*]const u8, ok.ptr), (try encode.utf8(a, ok)).ptr);
    try testing.expectEqualStrings("\u{fffd}x\u{fffd}", try encode.utf8(a, "\xc3x\xff"));
    try testing.expectEqualStrings("é\u{fffd}", try encode.utf8(a, "é\xe2\x82"));
}

test "metrics encode sums, gauges, histograms and exemplars and decode back" {
    var reader: metric_mod.reader.ManualReader = .init(io, .{ .temporality = .delta });
    const res_attrs = [_]attribute.KeyValue{ kv("service.name", "billing"), kv("deployment.environment.name", "test") };
    const provider = try metric_mod.meter.MeterProvider.create(testing.allocator, io, .{
        .resource = .{ .attributes = &res_attrs, .schema_url = "https://schemas.o11y.ing/1.1.0" },
        .readers = &.{reader.reader()},
        .views = &.{
            .{ .instrument_name = "latency", .attribute_keys = &.{"route"}, .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &.{ 1, 10, 100 } } } },
        },
    });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(1))) catch {};

    // An empty collection encodes to an empty request.
    {
        var empty_rm = try reader.collect(testing.allocator);
        defer empty_rm.deinit();
        var arena: std.heap.ArenaAllocator = .init(testing.allocator);
        defer arena.deinit();
        const empty_req = try encode.metricsRequest(arena.allocator(), &empty_rm);
        try testing.expectEqual(@as(usize, 0), empty_req.resource_metrics.items.len);
    }

    const m = provider.meter(.{ .name = "billing.meter", .version = "2.0.0", .schema_url = "https://example/m" });
    const ctx = Context.background.withSpanContext(remote_parent);
    m.counter(i64, "requests", .{ .unit = "{req}", .description = "Total requests." }).add(ctx, 5, &.{kv("method", "POST")});
    m.upDownCounter(f64, "queue.delta", .{}).add(.background, -2.5, &.{});
    m.gauge(f64, "temp", .{ .unit = "Cel" }).record(.background, 21.5, &.{});
    m.histogram(f64, "latency", .{ .unit = "ms" }).record(ctx, 42.5, &.{ kv("route", "/pay"), kv("user.id", "u-9") });

    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const request = try encode.metricsRequest(arena.allocator(), &rm);

    var bytes: std.Io.Writer.Allocating = .init(testing.allocator);
    defer bytes.deinit();
    try request.encode(&bytes.writer, testing.allocator);
    var wire: std.Io.Reader = .fixed(bytes.written());
    var decoded = try proto.collector_metrics_v1.ExportMetricsServiceRequest.decode(&wire, testing.allocator);
    defer decoded.deinit(testing.allocator);

    try testing.expectEqual(@as(usize, 1), decoded.resource_metrics.items.len);
    const drm = decoded.resource_metrics.items[0];
    try testing.expectEqualStrings("https://schemas.o11y.ing/1.1.0", drm.schema_url);
    try testing.expectEqualStrings("billing", drm.resource.?.attributes.items[0].value.?.value.?.string_value);
    try testing.expectEqual(@as(usize, 1), drm.scope_metrics.items.len);
    const sm = drm.scope_metrics.items[0];
    try testing.expectEqualStrings("billing.meter", sm.scope.?.name);
    try testing.expectEqualStrings("2.0.0", sm.scope.?.version);
    try testing.expectEqualStrings("https://example/m", sm.schema_url);
    try testing.expectEqual(@as(usize, 4), sm.metrics.items.len);

    // Counter: delta monotonic i64 sum with exemplar.
    const c_m = sm.metrics.items[0];
    try testing.expectEqualStrings("requests", c_m.name);
    try testing.expectEqualStrings("{req}", c_m.unit);
    try testing.expectEqualStrings("Total requests.", c_m.description);
    const c_sum = c_m.data.?.sum;
    try testing.expect(c_sum.is_monotonic);
    try testing.expectEqual(proto.metrics_v1.AggregationTemporality.AGGREGATION_TEMPORALITY_DELTA, c_sum.aggregation_temporality);
    try testing.expectEqual(@as(i64, 5), c_sum.data_points.items[0].value.?.as_int);
    try testing.expectEqualSlices(u8, &remote_parent.trace_id.bytes, c_sum.data_points.items[0].exemplars.items[0].trace_id);

    // UpDownCounter: cumulative non-monotonic f64 sum.
    const u_sum = sm.metrics.items[1].data.?.sum;
    try testing.expect(!u_sum.is_monotonic);
    try testing.expectEqual(proto.metrics_v1.AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE, u_sum.aggregation_temporality);
    try testing.expectEqual(@as(f64, -2.5), u_sum.data_points.items[0].value.?.as_double);

    // Gauge: f64.
    const g = sm.metrics.items[2].data.?.gauge;
    try testing.expectEqual(@as(f64, 21.5), g.data_points.items[0].value.?.as_double);

    // Histogram: delta, explicit bounds, bucket counts, min/max/sum/count, exemplar with filtered attrs.
    const h = sm.metrics.items[3].data.?.histogram;
    try testing.expectEqual(proto.metrics_v1.AggregationTemporality.AGGREGATION_TEMPORALITY_DELTA, h.aggregation_temporality);
    const hp = h.data_points.items[0];
    try testing.expectEqual(@as(u64, 1), hp.count);
    try testing.expectEqual(@as(f64, 42.5), hp.sum.?);
    try testing.expectEqual(@as(f64, 42.5), hp.min.?);
    try testing.expectEqual(@as(f64, 42.5), hp.max.?);
    try testing.expectEqualSlices(f64, &.{ 1, 10, 100 }, hp.explicit_bounds.items);
    try testing.expectEqualSlices(u64, &.{ 0, 0, 1, 0 }, hp.bucket_counts.items);
    const ex = hp.exemplars.items[0];
    try testing.expectEqualSlices(u8, &remote_parent.trace_id.bytes, ex.trace_id);
    try testing.expectEqualSlices(u8, &remote_parent.span_id.bytes, ex.span_id);
    try testing.expectEqual(@as(f64, 42.5), ex.value.?.as_double);
    try testing.expectEqualStrings("user.id", ex.filtered_attributes.items[0].key);
    try testing.expectEqualStrings("u-9", ex.filtered_attributes.items[0].value.?.value.?.string_value);
}
