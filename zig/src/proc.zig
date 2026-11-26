//! Child-process and framed-socket trace context propagation (`o11y.proc`),
//! mirroring `go/o11yproc/o11yproc.go`.
//!
//! For child processes, `injectEnvMap` / `envEntries` and `extractEnv` /
//! `extractEnvMap` carry `TRACEPARENT` and `TRACESTATE` explicitly without
//! touching process globals. Baggage does not travel through environment
//! variables because other host tools can inspect a process's environment and
//! baggage is not classified by the sensitivity policy.
//!
//! For framed socket protocols, `inject` and `extract` carry W3C trace context
//! and baggage in a string map using an explicit `*Telemetry`'s propagator
//! (including its baggage egress filter) or an explicit `Propagator`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Context = @import("context.zig").Context;
const resource_mod = @import("resource.zig");
const telemetry_mod = @import("telemetry.zig");
const Baggage = @import("pipeline/baggage.zig").Baggage;
const propagation = @import("pipeline/propagation.zig");
const TraceState = @import("pipeline/tracestate.zig").TraceState;

/// Environment variable name for the W3C traceparent header.
pub const env_traceparent = "TRACEPARENT";

/// Environment variable name for the W3C tracestate header.
pub const env_tracestate = "TRACESTATE";

/// Two owned `"KEY=VALUE"` environment entries (`TRACEPARENT=...` and
/// `TRACESTATE=...`) ready to append to a child process environment list.
pub const EnvEntries = struct {
    traceparent: []u8,
    tracestate: []u8,
    items: [2][]const u8,

    /// Returns the slice of two `"KEY=VALUE"` entries.
    pub fn slice(self: *const EnvEntries) []const []const u8 {
        return &self.items;
    }

    /// Frees both owned strings.
    pub fn deinit(self: *EnvEntries, gpa: Allocator) void {
        gpa.free(self.traceparent);
        gpa.free(self.tracestate);
        self.* = undefined;
    }
};

/// Returns `"TRACEPARENT=..."` and `"TRACESTATE=..."` entries for the span
/// context active in `ctx`, or `null` when `ctx` holds no valid span context.
///
/// `TRACESTATE=` is emitted empty when the context has no tracestate so that
/// appending these entries after an inherited environment overrides any stale
/// `TRACESTATE`.
pub fn envEntries(gpa: Allocator, ctx: Context) Allocator.Error!?EnvEntries {
    const sc = ctx.span_context;
    if (!sc.isValid()) return null;

    const tp_val = propagation.TraceContext.formatTraceparent(sc);
    const tp = try std.fmt.allocPrint(gpa, "{s}={s}", .{ env_traceparent, &tp_val });
    errdefer gpa.free(tp);
    const ts = try std.fmt.allocPrint(gpa, "{s}={s}", .{ env_tracestate, sc.trace_state.header });
    return .{
        .traceparent = tp,
        .tracestate = ts,
        .items = .{ tp, ts },
    };
}

/// Writes `TRACEPARENT` and `TRACESTATE` into `map` (for example a cloned
/// `std.process.Environ.Map` passed to `std.process.spawn`).
///
/// Does nothing when `ctx` holds no valid span context, and never modifies
/// unrelated environment variables. When the active span has no tracestate,
/// `TRACESTATE` is set to `""` so an inherited `TRACESTATE` never leaks to the
/// child alongside a new `TRACEPARENT`.
pub fn injectEnvMap(ctx: Context, map: *std.process.Environ.Map) Allocator.Error!void {
    const sc = ctx.span_context;
    if (!sc.isValid()) return;
    const tp_val = propagation.TraceContext.formatTraceparent(sc);
    try map.put(env_traceparent, &tp_val);
    try map.put(env_tracestate, sc.trace_state.header);
}

/// Removes `TRACEPARENT` and `TRACESTATE` from `map`, so a child process
/// starts with no inherited trace parent.
pub fn clearEnvMap(map: *std.process.Environ.Map) void {
    _ = map.swapRemove(env_traceparent);
    _ = map.swapRemove(env_tracestate);
}

/// Extracts the remote span context from `TRACEPARENT` and `TRACESTATE` in
/// `env` (never reading the ambient process environment). Allocated trace
/// state text lives in `arena`. Returns `ctx` unchanged when `TRACEPARENT` is
/// missing, empty, or invalid.
pub fn extractEnv(ctx: Context, arena: Allocator, env: resource_mod.Env) Context {
    const tp = env.get(env_traceparent) orelse return ctx;
    if (tp.len == 0) return ctx;
    const ts = blk: {
        const raw = env.get(env_tracestate) orelse break :blk null;
        break :blk if (raw.len > 0) raw else null;
    };
    var carrier: EnvReadCarrier = .{ .traceparent = tp, .tracestate = ts };
    return propagation.TraceContext.propagator.extract(ctx, arena, carrier.carrier());
}

/// Convenience wrapper for `extractEnv` reading from a `std.process.Environ.Map`.
pub fn extractEnvMap(ctx: Context, arena: Allocator, map: *const std.process.Environ.Map) Context {
    return extractEnv(ctx, arena, .{ .map = map });
}

/// Injects trace context and egress-filtered baggage from `ctx` into `frame`
/// using `telemetry`'s propagator. Does nothing when `telemetry` is null.
/// Hot-path safe: never fails the host.
pub fn inject(
    ctx: Context,
    gpa: Allocator,
    frame: *std.StringHashMapUnmanaged([]u8),
    telemetry: ?*const telemetry_mod.Telemetry,
) void {
    const t = telemetry orelse return;
    injectWithPropagator(ctx, gpa, frame, t.propagator());
}

/// Extracts trace context and baggage from `frame` into `ctx` using
/// `telemetry`'s propagator. Returns `ctx` unchanged when `telemetry` is null.
pub fn extract(
    ctx: Context,
    arena: Allocator,
    frame: *const std.StringHashMapUnmanaged([]u8),
    telemetry: ?*const telemetry_mod.Telemetry,
) Context {
    const t = telemetry orelse return ctx;
    return extractWithPropagator(ctx, arena, frame, t.propagator());
}

/// Injects `ctx` into `frame` using an explicit `Propagator`.
pub fn injectWithPropagator(
    ctx: Context,
    gpa: Allocator,
    frame: *std.StringHashMapUnmanaged([]u8),
    prop: propagation.Propagator,
) void {
    var carrier: FrameWriteCarrier = .{ .gpa = gpa, .frame = frame };
    prop.inject(ctx, gpa, carrier.carrier());
}

/// Extracts from `frame` into `ctx` using an explicit `Propagator`.
pub fn extractWithPropagator(
    ctx: Context,
    arena: Allocator,
    frame: *const std.StringHashMapUnmanaged([]u8),
    prop: propagation.Propagator,
) Context {
    var carrier: FrameReadCarrier = .{ .frame = frame };
    return prop.extract(ctx, arena, carrier.carrier());
}

/// Frees all owned keys and values in a framed-protocol string map.
pub fn freeFrame(gpa: Allocator, frame: *std.StringHashMapUnmanaged([]u8)) void {
    var it = frame.iterator();
    while (it.next()) |e| {
        gpa.free(e.key_ptr.*);
        gpa.free(e.value_ptr.*);
    }
    frame.deinit(gpa);
    frame.* = .empty;
}

const EnvReadCarrier = struct {
    traceparent: []const u8,
    tracestate: ?[]const u8,

    fn carrier(self: *EnvReadCarrier) propagation.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const self: *EnvReadCarrier = @ptrCast(@alignCast(ptr));
        if (std.mem.eql(u8, key, propagation.TraceContext.traceparent_header)) return self.traceparent;
        if (std.mem.eql(u8, key, propagation.TraceContext.tracestate_header)) return self.tracestate;
        return null;
    }

    fn setFn(_: *anyopaque, _: []const u8, _: []const u8) void {}
};

const FrameWriteCarrier = struct {
    gpa: Allocator,
    frame: *std.StringHashMapUnmanaged([]u8),

    fn carrier(self: *FrameWriteCarrier) propagation.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const self: *FrameWriteCarrier = @ptrCast(@alignCast(ptr));
        return self.frame.get(key);
    }

    fn setFn(ptr: *anyopaque, key: []const u8, value: []const u8) void {
        const self: *FrameWriteCarrier = @ptrCast(@alignCast(ptr));
        const val_copy = self.gpa.dupe(u8, value) catch return;
        if (self.frame.getEntry(key)) |entry| {
            self.gpa.free(entry.value_ptr.*);
            entry.value_ptr.* = val_copy;
            return;
        }
        const key_copy = self.gpa.dupe(u8, key) catch {
            self.gpa.free(val_copy);
            return;
        };
        self.frame.put(self.gpa, key_copy, val_copy) catch {
            self.gpa.free(key_copy);
            self.gpa.free(val_copy);
        };
    }
};

const FrameReadCarrier = struct {
    frame: *const std.StringHashMapUnmanaged([]u8),

    fn carrier(self: *FrameReadCarrier) propagation.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const self: *FrameReadCarrier = @ptrCast(@alignCast(ptr));
        return self.frame.get(key);
    }

    fn setFn(_: *anyopaque, _: []const u8, _: []const u8) void {}
};

// ---------------------------------------------------------------------------
// Tests (ported from go/o11yproc/o11yproc_test.go and sdk_test.go)
// ---------------------------------------------------------------------------

const testing = std.testing;
const memory_exporter = @import("pipeline/memory_exporter.zig");

test "injectEnvMap and extractEnvMap round-trip trace context and preserve unrelated env vars" {
    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "proc-test",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
        .span_exporter = exp.exporter(),
    });
    defer sdk.deinit();

    const tr = sdk.tracer("test");
    var parent = tr.start(.background, "parent", .{});
    var sc = parent.spanContext();
    sc.trace_state = .{ .header = "vendor=abc" };
    const ctx = Context.background.withSpanContext(sc);

    var env_map: std.process.Environ.Map = .init(testing.allocator);
    defer env_map.deinit();
    try env_map.put("APP_MODE", "worker");
    try injectEnvMap(ctx, &env_map);

    try testing.expectEqualStrings("worker", env_map.get("APP_MODE").?);
    try testing.expect(env_map.get(env_traceparent) != null);
    try testing.expectEqualStrings("vendor=abc", env_map.get(env_tracestate).?);
    try testing.expectEqual(@as(?[]const u8, null), env_map.get("BAGGAGE"));

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const child_ctx = extractEnvMap(.background, arena.allocator(), &env_map);
    try testing.expectEqualSlices(u8, &parent.spanContext().trace_id.bytes, &child_ctx.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &parent.spanContext().span_id.bytes, &child_ctx.span_context.span_id.bytes);
    try testing.expect(child_ctx.span_context.remote);
    try testing.expectEqualStrings("abc", child_ctx.span_context.trace_state.get("vendor").?);

    var child = tr.start(child_ctx, "child", .{});
    child.end();
    parent.end();
    try testing.expect(sdk.forceFlush(null).ok());

    const spans = try exp.snapshot(testing.allocator);
    defer testing.allocator.free(spans);
    try testing.expectEqual(@as(usize, 2), spans.len);
    const child_span = for (spans) |s| {
        if (std.mem.eql(u8, s.name, "child")) break s;
    } else return error.TestUnexpectedResult;
    try testing.expectEqualSlices(u8, &parent.spanContext().span_id.bytes, &child_span.parent.span_id.bytes);
}

test "envEntries returns null outside a span and overrides stale TRACESTATE" {
    try testing.expectEqual(@as(?EnvEntries, null), try envEntries(testing.allocator, .background));

    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "proc-stale",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
        .span_exporter = exp.exporter(),
    });
    defer sdk.deinit();

    var sp = sdk.tracer("test").start(.background, "spawn", .{});
    defer sp.end();
    const ctx = Context.background.withSpan(&sp);

    // Env entries list overrides an inherited stale TRACESTATE when appended.
    var entries = (try envEntries(testing.allocator, ctx)).?;
    defer entries.deinit(testing.allocator);
    try testing.expect(std.mem.startsWith(u8, entries.slice()[0], "TRACEPARENT=00-"));
    try testing.expectEqualStrings("TRACESTATE=", entries.slice()[1]);

    const combined = [_][]const u8{
        "TRACEPARENT=00-11111111111111111111111111111111-1111111111111111-01",
        "TRACESTATE=vendor=stale",
        entries.slice()[0],
        entries.slice()[1],
    };
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const adopted = extractEnv(.background, arena.allocator(), .{ .entries = &combined });
    try testing.expectEqualSlices(u8, &sp.spanContext().trace_id.bytes, &adopted.span_context.trace_id.bytes);
    try testing.expectEqualStrings("", adopted.span_context.trace_state.header);

    // Same with Environ.Map: stale TRACESTATE is overwritten with "".
    var map: std.process.Environ.Map = .init(testing.allocator);
    defer map.deinit();
    try map.put(env_traceparent, "00-11111111111111111111111111111111-1111111111111111-01");
    try map.put(env_tracestate, "vendor=stale");
    try injectEnvMap(ctx, &map);
    const adopted_map = extractEnvMap(.background, arena.allocator(), &map);
    try testing.expectEqualSlices(u8, &sp.spanContext().trace_id.bytes, &adopted_map.span_context.trace_id.bytes);
    try testing.expectEqualStrings("", adopted_map.span_context.trace_state.header);

    clearEnvMap(&map);
    try testing.expectEqual(@as(?[]const u8, null), map.get(env_traceparent));
    try testing.expectEqual(@as(?[]const u8, null), map.get(env_tracestate));
}

test "extractEnv ignores missing, empty, and invalid TRACEPARENT even when TRACESTATE is set" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();

    const cases = [_]resource_mod.Env{
        .{ .pairs = &.{.{ env_tracestate, "vendor=abc" }} },
        .{ .pairs = &.{ .{ env_traceparent, "" }, .{ env_tracestate, "vendor=abc" } } },
        .{ .pairs = &.{ .{ env_traceparent, "00-not-a-traceparent" }, .{ env_tracestate, "vendor=abc" } } },
    };
    for (cases) |env| {
        const ctx = extractEnv(.background, arena.allocator(), env);
        try testing.expect(!ctx.span_context.isValid());
        try testing.expect(ctx.span_context.trace_state.isEmpty());
    }
}

test "SDK-scoped inject and extract use the SDK propagator without globals and respect egress filter" {
    const sdk_full = try telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "proc-sdk-a",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
        .baggage_egress_allow = struct {
            fn allow(k: []const u8) bool {
                return std.mem.eql(u8, k, "tenant");
            }
        }.allow,
    });
    defer sdk_full.deinit();

    const sdk_tc_only = try telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "proc-sdk-b",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
        .propagators = &.{propagation.TraceContext.propagator},
    });
    defer sdk_tc_only.deinit();

    var sp = sdk_full.tracer("test").start(.background, "send", .{});
    defer sp.end();
    const bag: Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "secret_key", .value = "nope" },
    } };
    const ctx = Context.background.withSpan(&sp).withBaggage(&bag);

    // Full SDK injects traceparent + filtered baggage; another SDK extracts cleanly.
    var frame: std.StringHashMapUnmanaged([]u8) = .empty;
    defer freeFrame(testing.allocator, &frame);
    inject(ctx, testing.allocator, &frame, sdk_full);
    try testing.expect(frame.get("traceparent") != null);
    try testing.expectEqualStrings("tenant=acme", frame.get("baggage").?);

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const out = extract(.background, arena.allocator(), &frame, sdk_full);
    try testing.expectEqualSlices(u8, &sp.spanContext().span_id.bytes, &out.span_context.span_id.bytes);
    try testing.expect(out.span_context.remote);
    try testing.expectEqualStrings("acme", out.baggage.?.member("tenant").?.value);

    // Trace-context-only SDK writes no baggage and extracts no baggage.
    var frame2: std.StringHashMapUnmanaged([]u8) = .empty;
    defer freeFrame(testing.allocator, &frame2);
    inject(ctx, testing.allocator, &frame2, sdk_tc_only);
    try testing.expect(frame2.get("traceparent") != null);
    try testing.expectEqual(@as(?[]u8, null), frame2.get("baggage"));

    const out2 = extract(.background, arena.allocator(), &frame, sdk_tc_only);
    try testing.expectEqualSlices(u8, &sp.spanContext().span_id.bytes, &out2.span_context.span_id.bytes);
    try testing.expectEqual(@as(?*const Baggage, null), out2.baggage);

    // Null SDK is a safe no-op.
    var frame3: std.StringHashMapUnmanaged([]u8) = .empty;
    defer freeFrame(testing.allocator, &frame3);
    inject(ctx, testing.allocator, &frame3, null);
    try testing.expectEqual(@as(usize, 0), frame3.count());
    const out3 = extract(.background, arena.allocator(), &frame, null);
    try testing.expect(!out3.span_context.isValid());
}
