//! Conformance and correlation assertion tests (porting
//! `go/o11ytest/conforms_test.go` and `go/o11ytest/conforms_internal_test.go`).

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const spec = o11y.spec;
const o11ytest = @import("o11ytest.zig");

test "expectConforms passes on a clean service including grouped event attributes" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    rec.logger().info(.background, "ok", .{ .safe = "v" });

    // Flat registered event satisfying all required keys.
    rec.telemetry().event(.background, spec.event.request_summary, .{
        .@"http.request.method" = "GET",
        .@"http.response.status_code" = 200,
        .@"o11y.outcome" = spec.Outcome.success.asStr(),
        .@"o11y.duration" = 0.01,
    });

    // Nested map event satisfying http.request.method and http.response.status_code
    // under dotted group keys, matching Go's slog.Group test.
    const http_group = [_]o11y.LogAttribute{
        o11y.logKv("request.method", "GET"),
        o11y.logKv("response.status_code", 200),
    };
    const grouped_event = [_]o11y.LogAttribute{
        .{ .key = "http", .value = .{ .map = &http_group } },
        o11y.logKv(spec.Outcome.key, spec.Outcome.success.asStr()),
        o11y.logKv(spec.attr.duration, 0.01),
    };
    rec.telemetry().event(.background, spec.event.request_summary, @as([]const o11y.LogAttribute, &grouped_event));

    // Unregistered event has no contract and passes.
    rec.telemetry().event(.background, "app.custom.event", .{ .detail = "ok" });

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(report.ok());
    try rec.expectConforms();
}

test "checkConforms catches secret in flat log" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    rec.logger().info(.background, "m", .{
        .@"http.request.header.authorization" = "Bearer x",
    });

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("emitted secret-classified attributes on logs"));
    try testing.expectError(error.ConformanceFailed, rec.expectConforms());
}

test "checkConforms catches grouped secret in nested map log" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const header_map = [_]o11y.LogAttribute{
        o11y.logKv("authorization", "Bearer x"),
    };
    const attrs = [_]o11y.LogAttribute{
        .{ .key = "http.request.header", .value = .{ .map = &header_map } },
    };
    rec.logger().info(.background, "m", @as([]const o11y.LogAttribute, &attrs));

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("emitted secret-classified attributes on logs"));
}

test "checkConforms catches secret on span and on exported span" {
    // 1. Span processor only (default harness).
    {
        const rec = try o11ytest.start(testing.allocator, testing.io, .{});
        defer rec.deinit();

        var sp = rec.tracer("t").start(.background, "op", .{
            .attributes = &.{o11y.kv("http.request.header.cookie", "c")},
        });
        sp.end();

        var report = try rec.checkConforms(testing.allocator);
        defer report.deinit();
        try testing.expect(!report.ok());
        try testing.expect(report.contains("emitted secret-classified attributes on traces"));
    }

    // 2. With an extra span exporter attached (batch path flushed by checkConforms).
    {
        const SinkExp = struct {
            count: usize = 0,
            fn exporter(self: *@This()) o11y.SpanExporter {
                return .{ .ptr = self, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdownFn } };
            }
            fn exportSpans(ptr: *anyopaque, spans: []const *const o11y.SpanData, _: o11y.Deadline) o11y.ExportError!void {
                const self: *@This() = @ptrCast(@alignCast(ptr));
                self.count += spans.len;
            }
            fn shutdownFn(_: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {}
        };
        var extra_exp: SinkExp = .{};
        const rec = try o11ytest.start(testing.allocator, testing.io, .{
            .span_exporter = extra_exp.exporter(),
        });
        defer rec.deinit();

        var sp = rec.tracer("t").start(.background, "op", .{
            .attributes = &.{o11y.kv("http.request.header.cookie", "c")},
        });
        sp.end();

        var report = try rec.checkConforms(testing.allocator);
        defer report.deinit();
        try testing.expect(!report.ok());
        try testing.expect(report.contains("emitted secret-classified attributes on traces"));
        try testing.expectEqual(@as(usize, 1), extra_exp.count);
    }
}

test "checkConforms catches secret on resource with distinct resource message" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .resource_attributes = &.{
            o11y.kv("http.request.header.authorization", "Bearer x"),
        },
    });
    defer rec.deinit();

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("options passed to start put a secret"));
}

test "checkConforms catches app-registry secret emitted on logs or spans" {
    const app_yaml =
        \\schema: libo11y.app-registry/v1
        \\namespace: billing
        \\attributes:
        \\  billing.card.cvv: {type: string, sensitivity: secret, cardinality: unbounded}
        \\
    ;
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .app_registries = &.{.{ .bytes = .{ .path = "billing.yaml", .content = app_yaml } }},
    });
    defer rec.deinit();

    rec.logger().info(.background, "charge", .{ .@"billing.card.cvv" = "999" });

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("emitted secret-classified attributes on logs"));
}

test "checkConforms catches missing event contract attributes and bare template prefix" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    // Missing o11y.config.<key> template attribute (even a bare "o11y.config." does not satisfy it).
    rec.telemetry().event(.background, spec.event.telemetry_configured, .{
        .@"o11y.config." = "not-enough",
    });

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("o11y.config.<key>"));
}

test "checkConforms clear-text scan detects planted grouped secret in log" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const inner = [_]o11y.LogAttribute{
        o11y.logKv("authorization", "Bearer x"),
    };
    const mid = [_]o11y.LogAttribute{
        .{ .key = "request.header", .value = .{ .map = &inner } },
    };
    const top = [_]o11y.LogAttribute{
        .{ .key = "http", .value = .{ .map = &mid } },
    };
    try rec.plantLogForTest(.{
        .time_unix_nano = 1,
        .level = .info,
        .message = "planted",
        .span_context = .invalid,
        .attributes = &top,
    });

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("\"http.request.header.authorization\" in the clear"));
}

test "checkConforms reports missing tier-0 resource attribute when strict_identity is off" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .strict_identity = false,
        .service_name = null,
        .environment = null,
    });
    defer rec.deinit();

    var report = try rec.checkConforms(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("resource missing required tier-0 attribute \"service.name\""));
    try testing.expect(report.contains("resource missing required tier-0 attribute \"deployment.environment.name\""));
}

test "checkCorrelated catches missing or mismatched trace_id on correlated logs" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const sc: o11y.SpanContext = .{
        .trace_id = o11y.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = o11y.SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
    };

    // Plant a record with a valid span context but missing trace_id attribute.
    try rec.plantLogForTest(.{
        .time_unix_nano = 1,
        .level = .info,
        .message = "missing-tid",
        .span_context = sc,
        .attributes = &.{},
    });
    // Plant a record with a mismatched trace_id attribute.
    const bad_attrs = [_]o11y.LogAttribute{
        o11y.logKv("trace_id", "11111111111111111111111111111111"),
        o11y.logKv("span_id", "2222222222222222"),
    };
    try rec.plantLogForTest(.{
        .time_unix_nano = 2,
        .level = .info,
        .message = "wrong-tid",
        .span_context = sc,
        .attributes = &bad_attrs,
    });

    var report = try rec.checkCorrelated(testing.allocator);
    defer report.deinit();
    try testing.expect(!report.ok());
    try testing.expect(report.contains("has no trace_id attribute"));
    try testing.expect(report.contains("does not match its span"));
    try testing.expectError(error.CorrelationFailed, rec.expectCorrelated());
}

test "checkEvent unit behavior matches Go conformance.CheckEvent" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Unregistered event yields empty list.
    const none = try o11ytest.checkEvent(a, "custom.unregistered", &.{});
    try testing.expectEqual(@as(usize, 0), none.len);

    // Missing all 4 required attributes on o11y.request.summary.
    const missing = try o11ytest.checkEvent(a, spec.event.request_summary, &.{});
    try testing.expectEqual(@as(usize, 4), missing.len);

    // Template requirement satisfied by o11y.config.level.
    const ok_tmpl = try o11ytest.checkEvent(a, spec.event.telemetry_configured, &.{"o11y.config.level"});
    try testing.expectEqual(@as(usize, 0), ok_tmpl.len);

    // Bare "o11y.config." does not satisfy template.
    const bad_tmpl = try o11ytest.checkEvent(a, spec.event.telemetry_configured, &.{"o11y.config."});
    try testing.expectEqual(@as(usize, 1), bad_tmpl.len);
}
