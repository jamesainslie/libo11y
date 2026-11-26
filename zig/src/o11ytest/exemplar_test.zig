//! Exemplar and correlation triangle tests (porting `go/o11ytest/exemplar_test.go`).

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const o11ytest = @import("o11ytest.zig");

test "full correlation triangle: span, log, and counter exemplar share trace and span IDs" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "checkout", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "order accepted", .{});
    const counter = rec.meter("svc").counter(i64, "orders.processed", .{ .unit = "1" });
    counter.add(ctx, 1, &.{});
    sp.end();

    try testing.expectEqual(@as(usize, 1), rec.spans().len);
    const want_trace = rec.spans()[0].span_context.trace_id;
    const want_span = rec.spans()[0].span_context.span_id;

    // Leg 1: log -> trace.
    try testing.expectEqual(@as(usize, 1), rec.logs().len);
    try testing.expectEqualSlices(u8, &want_trace.bytes, &rec.logs()[0].span_context.trace_id.bytes);

    // Leg 2: metric exemplar -> trace.
    const exemplars = try rec.exemplars("orders.processed");
    try testing.expectEqual(@as(usize, 1), exemplars.len);
    try testing.expectEqualSlices(u8, &want_trace.bytes, &exemplars[0].trace_id.bytes);
    try testing.expectEqualSlices(u8, &want_span.bytes, &exemplars[0].span_id.bytes);
    try testing.expectEqual(@as(f64, 1.0), exemplars[0].value);

    const ex = try rec.expectExemplar("orders.processed", want_trace);
    try testing.expectEqual(@as(f64, 1.0), ex.value);

    try rec.expectTriangle("orders.processed");
}

test "histogram and gauge exemplars carry trace identity and measured values" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    const hist = rec.meter("svc").histogram(f64, "request.duration", .{ .unit = "s" });
    hist.record(ctx, 0.25, &.{});
    const gauge = rec.meter("svc").gauge(f64, "queue.depth", .{ .unit = "1" });
    gauge.record(ctx, 42.5, &.{});
    sp.end();

    const want_trace = rec.spans()[0].span_context.trace_id;

    const hist_ex = try rec.exemplars("request.duration");
    try testing.expectEqual(@as(usize, 1), hist_ex.len);
    try testing.expectEqualSlices(u8, &want_trace.bytes, &hist_ex[0].trace_id.bytes);
    try testing.expectEqual(@as(f64, 0.25), hist_ex[0].value);

    const gauge_ex = try rec.exemplars("queue.depth");
    try testing.expectEqual(@as(usize, 1), gauge_ex.len);
    try testing.expectEqualSlices(u8, &want_trace.bytes, &gauge_ex[0].trace_id.bytes);
    try testing.expectEqual(@as(f64, 42.5), gauge_ex[0].value);
}

test "no exemplar recorded outside a span under default trace_based filter" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const counter = rec.meter("svc").counter(i64, "background.work", .{ .unit = "1" });
    counter.add(.background, 1, &.{});

    const exemplars = try rec.exemplars("background.work");
    try testing.expectEqual(@as(usize, 0), exemplars.len);
    try testing.expectError(error.ExemplarNotFound, rec.expectExemplar("background.work", null));
    try testing.expectError(error.TriangleFailed, rec.expectTriangle("background.work"));
}

test "exemplar filter always_off suppresses exemplars even inside a sampled span" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .exemplar_filter = .always_off,
    });
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    const counter = rec.meter("svc").counter(i64, "hits", .{ .unit = "1" });
    counter.add(ctx, 1, &.{});
    sp.end();

    try testing.expectEqual(@as(usize, 0), (try rec.exemplars("hits")).len);
}

test "exemplar filter always_on records exemplars outside a span with invalid trace ID" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .exemplar_filter = .always_on,
    });
    defer rec.deinit();

    const counter = rec.meter("svc").counter(i64, "hits", .{ .unit = "1" });
    counter.add(.background, 5, &.{});

    const exemplars = try rec.exemplars("hits");
    try testing.expectEqual(@as(usize, 1), exemplars.len);
    try testing.expect(!exemplars[0].trace_id.isValid());
    try testing.expectEqual(@as(f64, 5.0), exemplars[0].value);
}

test "exemplar filtered_attributes drop PII and secrets even in hash mode while keeping safe filtered keys" {
    const key = "0123456789abcdef0123456789abcdef";
    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "req.latency",
        .attribute_keys = &keep_keys,
    }};
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .pii_mode = .hash,
        .pii_hash_key = key,
        .views = &views,
    });
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    const hist = rec.meter("svc").histogram(f64, "req.latency", .{ .unit = "s" });
    hist.record(ctx, 0.4, &.{
        o11y.kv("http.request.method", "POST"),
        o11y.kv("order.id", "ord-77"),
        o11y.kv("host.ip", "10.0.0.99"),
        o11y.kv("http.request.header.authorization", "Bearer secret"),
    });
    sp.end();

    const exemplars = try rec.exemplars("req.latency");
    try testing.expectEqual(@as(usize, 1), exemplars.len);
    // order.id was filtered out by the view -> appears in filtered_attributes.
    // host.ip (PII) and authorization (secret) were dropped by sensitivity policy
    // BEFORE reaching the reservoir, so neither appears in filtered_attributes!
    var saw_order = false;
    for (exemplars[0].filtered_attributes) |kv| {
        try testing.expect(!std.mem.eql(u8, kv.key, "host.ip"));
        try testing.expect(!std.mem.eql(u8, kv.key, "http.request.header.authorization"));
        if (std.mem.eql(u8, kv.key, "order.id")) {
            try testing.expectEqualStrings("ord-77", kv.value.string);
            saw_order = true;
        }
    }
    try testing.expect(saw_order);
}
