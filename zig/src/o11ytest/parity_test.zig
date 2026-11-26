//! Parity test suite mirroring `go/parity_test.go` and verifying core Go
//! contract invariants in Zig using `o11ytest`.
//!
//! Note: `o11yhttp`, `o11y.detached`, and `o11y.proc` parity tests will be
//! added in step Z5.

const std = @import("std");
const builtin = @import("builtin");
const testing = std.testing;
const o11y = @import("o11y");
const spec = o11y.spec;
const o11ytest = @import("o11ytest.zig");

// ---------------------------------------------------------------------------
// Direct ports of every test in go/parity_test.go
// ---------------------------------------------------------------------------

test "parity: ForceEmit bypasses log level" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .log_level = .err,
    });
    defer rec.deinit();

    rec.logger().info(.background, "filtered", .{});
    rec.logger().info(o11y.forceEmit(.background), "audit event", .{});

    const lines = try rec.consoleLogs(testing.allocator);
    defer testing.allocator.free(lines);
    try testing.expectEqual(@as(usize, 1), lines.len);
    try testing.expect(std.mem.indexOf(u8, lines[0], "\"msg\":\"audit event\"") != null);
    try testing.expectEqual(@as(usize, 1), rec.logs().len);
    try testing.expectEqualStrings("audit event", rec.logs()[0].message);
}

test "parity: EffectiveConfig resolves all expected keys" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "libo11y-test",
        .log_level = .info,
        .log_export = false,
    });
    defer rec.deinit();

    const cfg = rec.telemetry().effectiveConfig();
    const expected = [_][]const u8{
        "service.name=libo11y-test",
        "o11y.config.traces=injected",
        "o11y.config.metrics=injected",
        "o11y.config.logs=none",
        "o11y.config.console=json",
        "o11y.config.level=INFO",
        "traceparent",
        "tracestate",
        "baggage",
        "o11y.config.runtime_metrics=false",
    };
    for (expected) |want| {
        try testing.expect(std.mem.indexOf(u8, cfg, want) != null);
    }
}

const CaptureSink = struct {
    gpa: std.mem.Allocator,
    messages: std.ArrayList([]u8) = .empty,
    service_name: ?[]u8 = null,

    fn deinit(self: *CaptureSink) void {
        for (self.messages.items) |m| self.gpa.free(m);
        self.messages.deinit(self.gpa);
        if (self.service_name) |s| self.gpa.free(s);
    }

    fn sink(self: *CaptureSink) o11y.LogSink {
        return .{ .ptr = self, .vtable = &.{ .enabled = enabled, .emit = emit } };
    }

    fn enabled(_: *anyopaque, _: o11y.Context, _: o11y.Level) bool {
        return true;
    }

    fn emit(ptr: *anyopaque, _: o11y.Context, rec: o11y.SinkRecord) o11y.LogSink.SinkError!void {
        const self: *CaptureSink = @ptrCast(@alignCast(ptr));
        const msg = self.gpa.dupe(u8, rec.message) catch return error.SinkRejected;
        self.messages.append(self.gpa, msg) catch {
            self.gpa.free(msg);
            return error.SinkRejected;
        };
        for (rec.attributes) |kv| {
            if (std.mem.eql(u8, kv.key, "service.name") and kv.value == .string) {
                if (self.service_name) |old| self.gpa.free(old);
                self.service_name = self.gpa.dupe(u8, kv.value.string) catch null;
            }
        }
    }
};

test "parity: Setup emits startup summary even under prohibitive log level" {
    var cap: CaptureSink = .{ .gpa = testing.allocator };
    defer cap.deinit();

    const sdk = try o11y.setup(testing.allocator, testing.io, .{
        .service_name = "summary-test",
        .environment = "test",
        .log_level = .err,
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
        .extra_log_sinks = &.{cap.sink()},
    });
    defer sdk.deinit();

    try testing.expectEqual(@as(usize, 1), cap.messages.items.len);
    try testing.expectEqualStrings(spec.event.telemetry_configured, cap.messages.items[0]);
    try testing.expectEqualStrings("summary-test", cap.service_name.?);
}

test "parity: Setup without startup summary emits nothing but keeps EffectiveConfig" {
    var cap: CaptureSink = .{ .gpa = testing.allocator };
    defer cap.deinit();

    const sdk = try o11y.setup(testing.allocator, testing.io, .{
        .service_name = "no-summary",
        .environment = "test",
        .startup_summary = false,
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
        .extra_log_sinks = &.{cap.sink()},
    });
    defer sdk.deinit();

    try testing.expectEqual(@as(usize, 0), cap.messages.items.len);
    try testing.expect(sdk.effectiveConfig().len > 0);
}

test "parity: Setup reentrant from log sink does not deadlock and gets AlreadySetup" {
    const ReentrantSink = struct {
        inner_err: ?o11y.SetupError = null,

        fn sink(self: *@This()) o11y.LogSink {
            return .{ .ptr = self, .vtable = &.{ .enabled = enabled, .emit = emit } };
        }
        fn enabled(_: *anyopaque, _: o11y.Context, _: o11y.Level) bool {
            return true;
        }
        fn emit(ptr: *anyopaque, _: o11y.Context, _: o11y.SinkRecord) o11y.LogSink.SinkError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            _ = o11y.setup(testing.allocator, testing.io, .{
                .service_name = "reentrant-inner",
                .environment = "test",
                .console_enabled = false,
                .runtime_metrics = false,
                .install_std_log = false,
            }) catch |err| {
                self.inner_err = err;
                return;
            };
        }
    };

    var rs: ReentrantSink = .{};
    const sdk = try o11y.setup(testing.allocator, testing.io, .{
        .service_name = "reentrant-outer",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
        .extra_log_sinks = &.{rs.sink()},
    });
    defer sdk.deinit();

    try testing.expectEqual(@as(?o11y.SetupError, error.AlreadySetup), rs.inner_err);
}

test "parity: Setup canary fails fast on rejecting sink and releases guard" {
    const FailingSink = struct {
        fn sink(self: *@This()) o11y.LogSink {
            return .{ .ptr = self, .vtable = &.{ .enabled = enabled, .emit = emit } };
        }
        fn enabled(_: *anyopaque, _: o11y.Context, _: o11y.Level) bool {
            return true;
        }
        fn emit(_: *anyopaque, _: o11y.Context, _: o11y.SinkRecord) o11y.LogSink.SinkError!void {
            return error.SinkRejected;
        }
    };

    var fs: FailingSink = .{};
    try testing.expectError(error.CanaryRejected, o11y.setup(testing.allocator, testing.io, .{
        .service_name = "canary-fail",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
        .extra_log_sinks = &.{fs.sink()},
    }));

    // Guard was released: a subsequent setup succeeds.
    const sdk = try o11y.setup(testing.allocator, testing.io, .{
        .service_name = "canary-retry",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
    });
    defer sdk.deinit();
    try testing.expect(sdk.shutdown(null).ok());
}

test "parity: shutdownOnEvent and shutdownOnSignals run before_shutdown and shut down telemetry" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "signals-parity",
    });
    defer rec.deinit();

    var ran_before = false;
    const Hook = struct {
        fn run(ptr: ?*anyopaque, _: o11y.Deadline) void {
            const flag: *bool = @ptrCast(@alignCast(ptr.?));
            flag.* = true;
        }
    };

    var ev: std.Io.Event = .unset;
    var waiter = try testing.io.concurrent(struct {
        fn run(event: *std.Io.Event, sdk: *o11y.Telemetry, flag: *bool) o11y.ShutdownReport {
            return o11y.shutdownOnEvent(testing.io, event, sdk, .{
                .before_shutdown = .{ .ptr = flag, .func = Hook.run },
            });
        }
    }.run, .{ &ev, rec.telemetry(), &ran_before });

    ev.set(testing.io);
    const report = waiter.await(testing.io);
    try testing.expect(report.ok());
    try testing.expect(ran_before);

    // Also verify real POSIX signal handling on non-Windows hosts using SIGUSR2,
    // synchronizing deterministically on `ready_event` so raise() never races sigaction.
    if (builtin.os.tag != .windows) {
        const rec2 = try o11ytest.start(testing.allocator, testing.io, .{
            .service_name = "signals-posix",
        });
        defer rec2.deinit();

        var ready: std.Io.Event = .unset;
        var sig_waiter = try testing.io.concurrent(struct {
            fn run(sdk: *o11y.Telemetry, ready_ev: *std.Io.Event) o11y.ShutdownReport {
                return o11y.shutdownOnSignals(testing.io, sdk, .{
                    .signals = &.{.USR2},
                    .ready_event = ready_ev,
                });
            }
        }.run, .{ rec2.telemetry(), &ready });

        ready.waitUncancelable(testing.io);
        try std.posix.raise(.USR2);
        const report2 = sig_waiter.await(testing.io);
        try testing.expect(report2.ok());
    }
}

test "parity: BuildInfo attributes appear in resource and (devel) version falls back" {
    {
        const rec = try o11ytest.start(testing.allocator, testing.io, .{
            .build_info = .{
                .version = "1.4.2",
                .revision = "deadbeef",
                .time = "2026-11-26T00:00:00Z",
                .modified = true,
            },
        });
        defer rec.deinit();

        const attrs = rec.telemetry().resource().attributes;
        try testing.expectEqualStrings("1.4.2", findAttr(attrs, "service.version").?.string);
        try testing.expectEqualStrings("deadbeef", findAttr(attrs, spec.attr.vcs_ref_head_revision).?.string);
        try testing.expectEqualStrings("2026-11-26T00:00:00Z", findAttr(attrs, spec.attr.build_time).?.string);
        try testing.expectEqual(true, findAttr(attrs, spec.attr.build_modified).?.bool);
        try testing.expect(std.mem.indexOf(u8, rec.telemetry().effectiveConfig(), "service_version_fallback") == null);
    }

    {
        const rec = try o11ytest.start(testing.allocator, testing.io, .{
            .build_info = .{ .version = "(devel)" },
        });
        defer rec.deinit();

        const attrs = rec.telemetry().resource().attributes;
        try testing.expectEqualStrings("0.0.0-unknown", findAttr(attrs, "service.version").?.string);
        try testing.expect(std.mem.indexOf(u8, rec.telemetry().effectiveConfig(), "o11y.config.service_version_fallback=true") != null);
    }
}

// ---------------------------------------------------------------------------
// Core contract parity tests using o11ytest
// ---------------------------------------------------------------------------

test "parity: identity enforcement rejects missing/degenerate service name and invalid env, and strict_identity=false counts violations" {
    try testing.expectError(error.NoServiceName, o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "",
    }));
    try testing.expectError(error.NoServiceName, o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "unknown_service",
    }));
    try testing.expectError(error.NoServiceName, o11ytest.start(testing.allocator, testing.io, .{
        .service_name = "unknown_service:binary",
    }));
    try testing.expectError(error.NoEnvironment, o11ytest.start(testing.allocator, testing.io, .{
        .environment = "",
    }));
    try testing.expectError(error.InvalidEnvironment, o11ytest.start(testing.allocator, testing.io, .{
        .environment = "qa",
    }));

    // extra_environments extends the allowed set.
    const extra_ok = try o11ytest.start(testing.allocator, testing.io, .{
        .environment = "qa",
        .extra_environments = &.{"qa"},
    });
    defer extra_ok.deinit();
    try testing.expectEqualStrings("qa", findAttr(extra_ok.telemetry().resource().attributes, spec.Environment.key).?.string);

    // strict_identity=false downgrades identity problems to counted resource violations.
    const relaxed = try o11ytest.start(testing.allocator, testing.io, .{
        .strict_identity = false,
        .service_name = null,
        .environment = "qa",
    });
    defer relaxed.deinit();
    try relaxed.expectViolations(.resource, "identity_service_name", 1);
    try relaxed.expectViolations(.resource, "identity_environment_invalid", 1);
}

test "parity: sensitivity policy across drop, hash, allow modes and metrics always drop PII" {
    const key = "0123456789abcdef0123456789abcdef";

    // PIIHash requires >= 32-byte key.
    try testing.expectError(error.PIIHashKey, o11ytest.start(testing.allocator, testing.io, .{
        .pii_mode = .hash,
        .pii_hash_key = "short",
    }));

    // Hash mode: span and log tokens agree; secret dropped; metrics ALWAYS drop PII.
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .pii_mode = .hash,
        .pii_hash_key = key,
    });
    defer rec.deinit();

    var sp = rec.tracer("svc").start(.background, "op", .{
        .attributes = &.{
            o11y.kv("host.ip", "192.0.2.1"),
            o11y.kv("http.request.header.authorization", "Bearer secret"),
        },
    });
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "hashed", .{
        .@"host.ip" = "192.0.2.1",
        .@"http.request.header.authorization" = "Bearer secret",
    });
    const c = rec.meter("svc").counter(i64, "hits", .{ .unit = "1" });
    c.add(ctx, 1, &.{
        o11y.kv("host.ip", "192.0.2.1"),
        o11y.kv("http.request.header.authorization", "Bearer secret"),
        o11y.kv("route", "/home"),
    });
    sp.end();

    const got_span = try rec.expectSpan("op");
    const span_tok = findAttr(got_span.attributes.items, "host.ip").?.string;
    try testing.expect(std.mem.startsWith(u8, span_tok, "hmac-sha256:"));
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(got_span.attributes.items, "http.request.header.authorization"));

    const got_log = try rec.expectLog("hashed");
    try testing.expectEqualStrings(span_tok, got_log.attrString("host.ip").?);
    try testing.expectEqual(@as(?o11y.LogValue, null), got_log.attr("http.request.header.authorization"));

    const m = try rec.expectMetric("hits");
    const dp = m.data.sum.data_points[0];
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(dp.attributes, "host.ip"));
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(dp.attributes, "http.request.header.authorization"));
    try testing.expectEqualStrings("/home", findAttr(dp.attributes, "route").?.string);

    // Metrics never increment o11y.schema.violations.
    try testing.expectEqual(@as(i64, 0), try rec.violations(.metrics, null));

    // Allow mode keeps PII on spans, logs, and metrics, while still dropping secrets.
    const allow_rec = try o11ytest.start(testing.allocator, testing.io, .{
        .pii_mode = .allow,
    });
    defer allow_rec.deinit();

    var sp2 = allow_rec.tracer("svc").start(.background, "op2", .{
        .attributes = &.{
            o11y.kv("host.ip", "192.0.2.2"),
            o11y.kv("http.request.header.cookie", "sid=1"),
        },
    });
    const ctx2 = o11y.Context.background.withSpan(&sp2);
    const c2 = allow_rec.meter("svc").counter(i64, "hits2", .{ .unit = "1" });
    c2.add(ctx2, 1, &.{ o11y.kv("host.ip", "192.0.2.2"), o11y.kv("http.request.header.cookie", "sid=1") });
    sp2.end();

    const s2 = try allow_rec.expectSpan("op2");
    try testing.expectEqualStrings("192.0.2.2", findAttr(s2.attributes.items, "host.ip").?.string);
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(s2.attributes.items, "http.request.header.cookie"));
    const m2 = try allow_rec.expectMetric("hits2");
    try testing.expectEqualStrings("192.0.2.2", findAttr(m2.data.sum.data_points[0].attributes, "host.ip").?.string);
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(m2.data.sum.data_points[0].attributes, "http.request.header.cookie"));
}

test "parity: events, wide-event Record, and bare event.name not force-exempt" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .log_level = .err,
    });
    defer rec.deinit();

    // A bare log carrying event.name without forceEmit is still gated by log_level.
    rec.logger().info(.background, "not forced", .{ .@"event.name" = "app.test" });
    try testing.expectEqual(@as(usize, 0), rec.logs().len);

    // RecordFromContext on background context is a safe no-op.
    const noop_rec = o11y.recordFromContext(.background);
    noop_rec.set("ignored", "x");
    noop_rec.add("count", 1);
    noop_rec.max("peak", 9.9);

    // Active Record accumulates set/add/max and emits wide event via forceEmit.
    var wide = o11y.Record.init(testing.allocator, testing.io);
    defer wide.deinit();
    var sp = rec.tracer("svc").start(.background, "req", .{});
    const ctx = o11y.startRecord(o11y.Context.background.withSpan(&sp), &wide);
    const h = o11y.recordFromContext(ctx);
    h.set("http.request.method", "GET");
    h.add("db.queries", 2);
    h.add("db.queries", 3);
    h.max("db.slowest_ms", 12.5);
    h.max("db.slowest_ms", 4.0);
    h.max("db.slowest_ms", 25.0);

    wide.emitEvent(ctx, rec.telemetry(), spec.event.request_summary, .{
        .@"http.response.status_code" = 200,
        .@"o11y.outcome" = spec.Outcome.success.asStr(),
        .@"o11y.duration" = 0.05,
    });
    sp.end();

    const ev = try rec.expectEvent(spec.event.request_summary);
    try testing.expectEqualStrings("GET", ev.attrString("http.request.method").?);
    try testing.expectEqual(@as(i64, 5), ev.attr("db.queries").?.int);
    try testing.expectEqual(@as(f64, 25.0), ev.attr("db.slowest_ms").?.double);
    try rec.expectCorrelated();
    try rec.expectConforms();
}

test "parity: propagation round-trip and inject-only baggage egress filter" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .baggage_egress_allow = struct {
            fn allow(key: []const u8) bool {
                return std.mem.eql(u8, key, "tenant");
            }
        }.allow,
    });
    defer rec.deinit();

    const MapCarrier = struct {
        gpa: std.mem.Allocator,
        map: std.StringHashMapUnmanaged([]u8) = .empty,

        fn deinit(self: *@This()) void {
            var it = self.map.iterator();
            while (it.next()) |e| {
                self.gpa.free(e.key_ptr.*);
                self.gpa.free(e.value_ptr.*);
            }
            self.map.deinit(self.gpa);
        }

        fn carrier(self: *@This()) o11y.Carrier {
            return .{ .ptr = self, .vtable = &.{ .get = get, .set = set } };
        }

        fn get(ptr: *anyopaque, key: []const u8) ?[]const u8 {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            return self.map.get(key);
        }

        fn set(ptr: *anyopaque, key: []const u8, val: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            const k = self.gpa.dupe(u8, key) catch return;
            const v = self.gpa.dupe(u8, val) catch {
                self.gpa.free(k);
                return;
            };
            if (self.map.fetchPut(self.gpa, k, v) catch null) |old| {
                self.gpa.free(old.key);
                self.gpa.free(old.value);
            }
        }
    };

    var sp = rec.tracer("svc").start(.background, "outbound", .{});
    const bag: o11y.Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "internal_secret", .value = "nope" },
    } };
    const ctx = o11y.Context.background.withSpan(&sp).withBaggage(&bag);

    var wire: MapCarrier = .{ .gpa = testing.allocator };
    defer wire.deinit();
    rec.telemetry().propagator().inject(ctx, testing.allocator, wire.carrier());
    sp.end();

    try testing.expect(wire.map.get("traceparent") != null);
    try testing.expectEqualStrings("tenant=acme", wire.map.get("baggage").?);

    // Extract restores the span context and baggage on the receiving side.
    var extract_arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer extract_arena.deinit();
    const extracted = rec.telemetry().propagator().extract(.background, extract_arena.allocator(), wire.carrier());
    try testing.expectEqualSlices(u8, &sp.spanContext().trace_id.bytes, &extracted.span_context.trace_id.bytes);
    try testing.expect(extracted.span_context.remote);
    try testing.expectEqualStrings("acme", extracted.baggage.?.member("tenant").?.value);
}

test "parity: redact types protect values across std.fmt, JSON, and structured logger" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const User = o11y.redact.Struct(struct {
        id: []const u8,
        email: []const u8,
        token: []const u8,
        internal_note: []const u8,

        pub const o11y_tags = .{
            .email = .mask,
            .token = .secret,
            .internal_note = .omit,
        };
    });

    const u: User = .{ .value = .{
        .id = "u-1",
        .email = "alice@example.com",
        .token = "tok-super-secret",
        .internal_note = "private",
    } };

    rec.logger().info(.background, "user loaded", .{
        .api_key = o11y.redact.secret("sk_live_12345"),
        .ssn = o11y.redact.masked("123-45-6789"),
        .user = u,
    });

    const console = rec.consoleOutput();
    try testing.expect(std.mem.indexOf(u8, console, "sk_live_12345") == null);
    try testing.expect(std.mem.indexOf(u8, console, "123-45-6789") == null);
    try testing.expect(std.mem.indexOf(u8, console, "alice@example.com") == null);
    try testing.expect(std.mem.indexOf(u8, console, "tok-super-secret") == null);
    try testing.expect(std.mem.indexOf(u8, console, "private") == null);
    try testing.expect(std.mem.indexOf(u8, console, "REDACTED") != null);
    try testing.expect(std.mem.indexOf(u8, console, "XXXXXXXXXXX") != null);
    try testing.expect(std.mem.indexOf(u8, console, "u-1") != null);
}

test "parity: app registry classifies custom PII and secret attributes on spans and logs" {
    const yaml =
        \\schema: libo11y.app-registry/v1
        \\namespace: checkout
        \\attributes:
        \\  checkout.customer.email: {type: string, sensitivity: pii, cardinality: unbounded}
        \\  checkout.payment.cvv: {type: string, sensitivity: secret, cardinality: unbounded}
        \\
    ;
    const key = "0123456789abcdef0123456789abcdef";
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .pii_mode = .hash,
        .pii_hash_key = key,
        .app_registries = &.{.{ .bytes = .{ .path = "checkout.yaml", .content = yaml } }},
    });
    defer rec.deinit();

    var sp = rec.tracer("shop").start(.background, "pay", .{
        .attributes = &.{
            o11y.kv("checkout.customer.email", "bob@example.com"),
            o11y.kv("checkout.payment.cvv", "123"),
        },
    });
    const ctx = o11y.Context.background.withSpan(&sp);
    rec.logger().info(ctx, "paid", .{
        .@"checkout.customer.email" = "bob@example.com",
        .@"checkout.payment.cvv" = "123",
    });
    sp.end();

    const s = try rec.expectSpan("pay");
    const email_hash = findAttr(s.attributes.items, "checkout.customer.email").?.string;
    try testing.expect(std.mem.startsWith(u8, email_hash, "hmac-sha256:"));
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(s.attributes.items, "checkout.payment.cvv"));

    const l = try rec.expectLog("paid");
    try testing.expectEqualStrings(email_hash, l.attrString("checkout.customer.email").?);
    try testing.expectEqual(@as(?o11y.LogValue, null), l.attr("checkout.payment.cvv"));
}

test "parity: shutdown is idempotent and emits o11y.telemetry.dropped on export failure" {
    const BadExporter = struct {
        fn exporter(self: *@This()) o11y.SpanExporter {
            return .{ .ptr = self, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdownFn } };
        }
        fn exportSpans(_: *anyopaque, _: []const *const o11y.SpanData, _: o11y.Deadline) o11y.ExportError!void {
            return error.ExportFailed;
        }
        fn shutdownFn(_: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {
            return error.ExportFailed;
        }
    };
    var bad: BadExporter = .{};

    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .span_exporter = bad.exporter(),
    });
    defer rec.deinit();

    const r1 = rec.telemetry().shutdown(null);
    const r2 = rec.telemetry().shutdown(null);
    try testing.expect(!r1.ok());
    try testing.expectEqual(r1, r2);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), r1.traces);

    const dropped = try rec.expectEvent(spec.event.telemetry_dropped);
    try testing.expectEqualStrings("traces", dropped.attrString(spec.Signal.key).?);
}

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}
