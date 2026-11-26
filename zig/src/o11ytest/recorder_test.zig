//! Unit tests for `o11ytest.Recorder` (porting `go/o11ytest/o11ytest_test.go`
//! plus coverage for console JSON, OTLP logs, reset, and assertion helpers).

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const o11ytest = @import("o11ytest.zig");

test "recorder captures all three signals (spans, metrics, structured/console/OTLP logs)" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "operation", .{
        .attributes = &.{o11y.kv("order.id", "ord-42")},
    });
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "working", .{ .step = 1 });

    const counter = rec.meter("svc").counter(i64, "work.done", .{ .unit = "1" });
    counter.add(ctx, 1, &.{});
    sp.end();

    // Spans recorded synchronously on end().
    try testing.expectEqual(@as(usize, 1), rec.spans().len);
    const got_span = try rec.expectSpan("operation");
    try testing.expectEqualStrings("operation", got_span.name);
    try rec.expectNoSpan("other-operation");
    try testing.expectError(error.UnexpectedSpan, rec.expectNoSpan("operation"));
    try testing.expectError(error.SpanNotFound, rec.requireSpan("missing"));

    // Structured logs captured synchronously.
    try testing.expectEqual(@as(usize, 1), rec.logs().len);
    const got_log = try rec.expectLog("working");
    try testing.expectEqual(o11y.Level.info, got_log.level);
    try testing.expectEqual(@as(i64, 1), got_log.attr("step").?.int);
    try testing.expectError(error.LogNotFound, rec.requireLog("missing"));

    // Console JSON buffer captured the log line without writing to stdout.
    const console_lines = try rec.consoleLogs(testing.allocator);
    defer testing.allocator.free(console_lines);
    try testing.expectEqual(@as(usize, 1), console_lines.len);
    try testing.expect(std.mem.indexOf(u8, console_lines[0], "\"msg\":\"working\"") != null);
    try testing.expect(std.mem.indexOf(u8, console_lines[0], "\"step\":1") != null);

    // OTLP log leg captured the LogData with native trace_id and span_id.
    const otlp_logs = rec.otlpLogs();
    try testing.expectEqual(@as(usize, 1), otlp_logs.len);
    try testing.expectEqualStrings("working", otlp_logs[0].body.string);
    try testing.expectEqualSlices(u8, &got_span.span_context.trace_id.bytes, &otlp_logs[0].trace_id.bytes);
    try testing.expectEqualSlices(u8, &got_span.span_context.span_id.bytes, &otlp_logs[0].span_id.bytes);

    // Metrics collected on demand from the manual reader.
    const names = try rec.metricNames();
    const has_work_done = for (names) |n| {
        if (std.mem.eql(u8, n, "work.done")) break true;
    } else false;
    try testing.expect(has_work_done);
    const m = try rec.expectMetric("work.done");
    try testing.expectEqual(@as(i64, 1), m.data.sum.data_points[0].value.int);
    try testing.expectError(error.MetricNotFound, rec.requireMetric("no.such.metric"));

    // Independent collectMetrics() caller-owned snapshot works too.
    var owned_rm = try rec.collectMetrics(testing.allocator);
    defer owned_rm.deinit();
    try testing.expect(owned_rm.find("work.done") != null);

    try rec.expectNoViolations();
}

test "log-span correlation captures trace_id and span_id on structured and console logs" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "inside", .{});
    sp.end();

    try testing.expectEqual(@as(usize, 1), rec.logs().len);
    const want_trace = rec.spans()[0].span_context.trace_id;
    const want_span = rec.spans()[0].span_context.span_id;
    const lr = &rec.logs()[0];

    try testing.expectEqualSlices(u8, &want_trace.bytes, &lr.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &want_span.bytes, &lr.span_context.span_id.bytes);

    const want_trace_hex = want_trace.hex();
    const want_span_hex = want_span.hex();
    try testing.expectEqualStrings(&want_trace_hex, lr.attrString("trace_id").?);
    try testing.expectEqualStrings(&want_span_hex, lr.attrString("span_id").?);

    try rec.expectCorrelated();
}

test "user options override recorder defaults" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "custom-name",
        .environment = "staging",
        .service_version = "2.1.0",
    });
    defer rec.deinit();

    const attrs = rec.telemetry().resource().attributes;
    var found_name: ?[]const u8 = null;
    var found_env: ?[]const u8 = null;
    var found_ver: ?[]const u8 = null;
    for (attrs) |kv| {
        if (std.mem.eql(u8, kv.key, "service.name")) found_name = kv.value.string;
        if (std.mem.eql(u8, kv.key, o11y.spec.Environment.key)) found_env = kv.value.string;
        if (std.mem.eql(u8, kv.key, "service.version")) found_ver = kv.value.string;
    }
    try testing.expectEqualStrings("custom-name", found_name.?);
    try testing.expectEqualStrings("staging", found_env.?);
    try testing.expectEqualStrings("2.1.0", found_ver.?);
}

test "debug logs are captured by default" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    rec.logger().debug(.background, "verbose detail", .{});
    try testing.expectEqual(@as(usize, 1), rec.logs().len);
    try testing.expectEqual(o11y.Level.debug, rec.logs()[0].level);
}

test "expectEvent finds named events and reset clears spans, logs, console, and OTLP logs" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "step1", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.telemetry().event(ctx, o11y.spec.event.request_summary, .{
        .@"http.request.method" = "GET",
        .@"http.response.status_code" = 200,
        .@"o11y.outcome" = "success",
        .@"o11y.duration" = 0.015,
    });
    sp.end();

    const ev = try rec.expectEvent(o11y.spec.event.request_summary);
    try testing.expectEqualStrings("GET", ev.attrString("http.request.method").?);
    try testing.expectError(error.EventNotFound, rec.expectEvent("no.such.event"));
    try testing.expectEqual(@as(usize, 1), rec.otlpLogs().len);
    try testing.expect(rec.consoleOutput().len > 0);

    rec.reset();

    try testing.expectEqual(@as(usize, 0), rec.spans().len);
    try testing.expectEqual(@as(usize, 0), rec.logs().len);
    try testing.expectEqual(@as(usize, 0), rec.otlpLogs().len);
    try testing.expectEqual(@as(usize, 0), rec.consoleOutput().len);

    // Recording continues cleanly after reset.
    var sp2 = rec.tracer("svc").start(.background, "step2", .{});
    sp2.end();
    _ = try rec.expectSpan("step2");
    try rec.expectNoSpan("step1");
}

test "expectViolations and expectNoViolations track o11y.schema.violations" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    try rec.expectNoViolations();
    try testing.expectError(error.ExpectedViolations, rec.expectViolations(.traces, "pii_attribute", 1));

    var sp = rec.tracer("svc").start(.background, "op", .{
        .attributes = &.{o11y.kv("host.ip", "10.0.0.1")},
    });
    sp.end();

    try rec.expectViolations(.traces, "pii_attribute", 1);
    try testing.expectError(error.UnexpectedViolations, rec.expectNoViolations());
}

test "expectConforms and expectCorrelated pass on default clean harness" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "inside", .{ .safe = "ok" });
    sp.end();

    try rec.expectConforms();
    try rec.expectCorrelated();
}

test "recorder metric and log pointers remain valid across reallocations and concurrent emissions" {
    const io = testing.io;
    const rec = try o11ytest.start(testing.allocator, io, .{});
    defer rec.deinit();

    // 1. Metric pointers survive repeated collections that grow collected_metrics.
    const counter = rec.meter("svc").counter(i64, "stable.counter", .{ .unit = "1" });
    counter.add(.background, 1, &.{});
    const m1 = try rec.metrics();
    const p1 = try rec.expectMetric("stable.counter");
    try testing.expectEqual(@as(i64, 1), p1.data.sum.data_points[0].value.int);

    for (0..24) |_| {
        counter.add(.background, 1, &.{});
        _ = try rec.metrics();
    }
    // Original pointers still read the original snapshot value without UAF.
    try testing.expectEqual(@as(i64, 1), m1.find("stable.counter").?.data.sum.data_points[0].value.int);
    try testing.expectEqual(@as(i64, 1), p1.data.sum.data_points[0].value.int);
    try testing.expectEqual(@as(i64, 25), (try rec.expectMetric("stable.counter")).data.sum.data_points[0].value.int);

    // 2. LogRecord pointers survive many subsequent log emissions that grow records.
    rec.logger().info(.background, "first-log", .{ .idx = 0 });
    const l1 = try rec.expectLog("first-log");
    for (1..40) |i| {
        rec.logger().info(.background, "later-log", .{ .idx = @as(i64, @intCast(i)) });
    }
    try testing.expectEqualStrings("first-log", l1.message);
    try testing.expectEqual(@as(i64, 0), l1.attr("idx").?.int);

    // 3. Concurrent emission + snapshot/conformance queries do not race or UAF.
    const Emitter = struct {
        fn run(r: *o11ytest.Recorder) anyerror!void {
            const c = r.meter("conc").counter(i64, "conc.hits", .{ .unit = "1" });
            for (0..25) |i| {
                var sp = r.tracer("conc").start(.background, "conc-op", .{});
                const ctx = o11y.Context.background.withSpan(&sp);
                r.logger().info(ctx, "conc-msg", .{ .seq = @as(i64, @intCast(i)) });
                c.add(ctx, 1, &.{});
                sp.end();
            }
        }
    };

    var fut = try io.concurrent(Emitter.run, .{rec});
    var early_spans: []const *const o11y.SpanData = &.{};
    var early_logs: []const o11ytest.LogRecord = &.{};
    for (0..25) |_| {
        const sp_snap = rec.spans();
        const lg_snap = rec.logs();
        _ = rec.consoleOutput();
        _ = rec.otlpLogs();
        if (early_spans.len == 0 and sp_snap.len > 0) early_spans = sp_snap;
        if (early_logs.len == 0 and lg_snap.len > 0) early_logs = lg_snap;
        var rep = try rec.checkConforms(testing.allocator);
        defer rep.deinit();
        try testing.expect(rep.ok());
        var corr = try rec.checkCorrelated(testing.allocator);
        defer corr.deinit();
        try testing.expect(corr.ok());
    }
    try fut.await(io);

    // Earlier snapshots remain intact after the emitter finishes.
    for (early_spans) |sp| try testing.expectEqualStrings("conc-op", sp.name);
    try testing.expect(early_logs.len > 0);
    try testing.expectEqual(@as(usize, 25), rec.spans().len);
}
