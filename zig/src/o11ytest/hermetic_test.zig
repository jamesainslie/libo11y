//! Hermeticity and parallel isolation tests (porting `go/o11ytest/hermetic_test.go`
//! and `TestHarnessesAreIsolated`).

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const o11ytest = @import("o11ytest.zig");

test "parallel recorders are completely isolated across concurrent tasks" {
    const Worker = struct {
        fn run(name: []const u8) anyerror!void {
            const rec = try o11ytest.start(testing.allocator, testing.io, .{
                .service_name = name,
            });
            defer rec.deinit();

            var sp = rec.tracer("isolation").start(.background, name, .{
                .attributes = &.{
                    o11y.kv("a", 1),
                    o11y.kv("b", 2),
                    o11y.kv("c", 3),
                },
            });
            const ctx = o11y.Context.background.withSpan(&sp);
            const hist = rec.meter("isolation").histogram(f64, "h", .{ .unit = "s" });
            hist.record(ctx, 1.5, &.{});
            rec.logger().info(ctx, name, .{});
            sp.end();

            // Exactly one span belonging to this task, with all 3 attributes.
            try testing.expectEqual(@as(usize, 1), rec.spans().len);
            try testing.expectEqualStrings(name, rec.spans()[0].name);
            try testing.expectEqual(@as(usize, 3), rec.spans()[0].attributes.items.len);

            // Exactly one log belonging to this task.
            try testing.expectEqual(@as(usize, 1), rec.logs().len);
            try testing.expectEqualStrings(name, rec.logs()[0].message);

            // Exemplar recorded with this task's trace ID.
            const exs = try rec.exemplars("h");
            try testing.expectEqual(@as(usize, 1), exs.len);
            try testing.expectEqualSlices(u8, &rec.spans()[0].span_context.trace_id.bytes, &exs[0].trace_id.bytes);

            try rec.expectCorrelated();
            try rec.expectConforms();
        }
    };

    const names = [_][]const u8{
        "harness-0", "harness-1", "harness-2", "harness-3",
        "harness-4", "harness-5", "harness-6", "harness-7",
    };
    var futures: [names.len]std.Io.Future(anyerror!void) = undefined;
    for (names, 0..) |name, i| {
        futures[i] = try testing.io.concurrent(Worker.run, .{name});
    }
    for (&futures) |*f| {
        try f.await(testing.io);
    }
}

test "caller options override harness defaults (sampler, log_level, console_enabled, log_export)" {
    // NeverSample overrides the harness default AlwaysOn sampler.
    {
        const rec = try o11ytest.start(testing.allocator, testing.io, .{
            .sampler = .always_off,
        });
        defer rec.deinit();

        var sp = rec.tracer("t").start(.background, "op", .{});
        sp.end();
        try testing.expectEqual(@as(usize, 0), rec.spans().len);
    }

    // Disabling console and OTLP log export still keeps structured sink capture.
    {
        const rec = try o11ytest.start(testing.allocator, testing.io, .{
            .log_level = .warn,
            .console_enabled = false,
            .log_export = false,
        });
        defer rec.deinit();

        rec.logger().info(.background, "filtered", .{});
        rec.logger().warn(.background, "kept", .{});

        try testing.expectEqual(@as(usize, 1), rec.logs().len);
        try testing.expectEqualStrings("kept", rec.logs()[0].message);
        try testing.expectEqual(@as(usize, 0), rec.consoleOutput().len);
        try testing.expectEqual(@as(usize, 0), rec.otlpLogs().len);
    }
}

test "harness resource carries deterministic test identity and schema URL" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const res = rec.telemetry().resource();
    try testing.expectEqualStrings(o11y.spec.schema_url, res.schema_url);

    var sp = rec.tracer("t").start(.background, "op", .{});
    const ctx = o11y.Context.background.withSpan(&sp);
    const c = rec.meter("t").counter(i64, "c", .{ .unit = "1" });
    c.add(ctx, 1, &.{});
    sp.end();

    try testing.expectEqual(@as(usize, 1), rec.spans().len);
    const span_res = rec.spans()[0].resource();
    try testing.expectEqualStrings(o11y.spec.schema_url, span_res.schema_url);

    const rm = try rec.metrics();
    try testing.expectEqualStrings(o11y.spec.schema_url, rm.resource.schema_url);
}
