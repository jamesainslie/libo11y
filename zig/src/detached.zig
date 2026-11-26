//! Detached work propagation (`o11y.detached`), mirroring `go/detached.go`.
//!
//! Captures the active W3C trace context and egress-filtered baggage into a
//! compact URL-query-encoded `Carrier` (at most 32 KiB) that can be stored
//! with a background job, queue message, or database row. Later, possibly in
//! another process, `startLinked` starts a new root span linked to the
//! captured remote span context and merges the carrier's baggage into the
//! returned context.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Context = @import("context.zig").Context;
const policy_runtime = @import("policy_runtime.zig");
const telemetry_mod = @import("telemetry.zig");
const Baggage = @import("pipeline/baggage.zig").Baggage;
const ids = @import("pipeline/ids.zig");
const propagation = @import("pipeline/propagation.zig");
const span_mod = @import("pipeline/span.zig");
const tracer_mod = @import("pipeline/tracer.zig");
const TraceState = @import("pipeline/tracestate.zig").TraceState;

/// Maximum serialized text size of a `Carrier` (32 KiB, matching Go).
pub const max_carrier_text: usize = 32 << 10;

const field_traceparent = "traceparent";
const field_tracestate = "tracestate";
const field_baggage = "baggage";

/// Closed error set returned by `Carrier.unmarshalText` and `Carrier.unmarshalInto`.
pub const UnmarshalError = error{
    InvalidCarrier,
    OutOfMemory,
};

/// Serialized trace context and egress-filtered baggage for detached work.
///
/// The zero value (`Carrier.zero`) holds no captured context and serializes to
/// empty text. Non-zero carriers own their strings and must be released with
/// `deinit(gpa)`.
pub const Carrier = struct {
    traceparent: []u8 = &.{},
    tracestate: []u8 = &.{},
    baggage: []u8 = &.{},

    /// The empty carrier: nothing captured. Needs no `deinit`.
    pub const zero: Carrier = .{};

    /// Frees the owned strings and resets `self` to `Carrier.zero`.
    pub fn deinit(self: *Carrier, gpa: Allocator) void {
        if (self.traceparent.len > 0) gpa.free(self.traceparent);
        if (self.tracestate.len > 0) gpa.free(self.tracestate);
        if (self.baggage.len > 0) gpa.free(self.baggage);
        self.* = .zero;
    }

    /// Reports whether `self` holds no captured context.
    pub fn isZero(self: Carrier) bool {
        return self.traceparent.len == 0;
    }

    /// Returns the captured span context, marked remote, or `.invalid` for the
    /// zero carrier. The returned `trace_state` borrows `self.tracestate` until
    /// `self.deinit()`.
    pub fn spanContext(self: Carrier) ids.SpanContext {
        if (self.isZero()) return .invalid;
        var sc = propagation.TraceContext.parseTraceparent(self.traceparent) orelse return .invalid;
        if (self.tracestate.len > 0) {
            sc.trace_state = .{ .header = self.tracestate };
        }
        return sc;
    }

    /// Formats the carrier as a compact URL query string with keys sorted
    /// alphabetically (`baggage`, `traceparent`, `tracestate`), matching Go's
    /// `url.Values.Encode()`. Empty for the zero carrier.
    pub fn format(self: Carrier, w: *Io.Writer) Io.Writer.Error!void {
        if (self.isZero()) return;
        if (self.baggage.len > 0) {
            try w.writeAll(field_baggage ++ "=");
            try writeQueryEscaped(w, self.baggage);
            try w.writeByte('&');
        }
        try w.writeAll(field_traceparent ++ "=");
        try writeQueryEscaped(w, self.traceparent);
        if (self.tracestate.len > 0) {
            try w.writeAll("&" ++ field_tracestate ++ "=");
            try writeQueryEscaped(w, self.tracestate);
        }
    }

    /// Serializes `self` to owned UTF-8 text (empty slice for the zero carrier).
    /// Caller owns the returned slice and frees it with `gpa.free`.
    pub fn marshalText(self: Carrier, gpa: Allocator) Allocator.Error![]u8 {
        if (self.isZero()) return gpa.alloc(u8, 0);
        const total = encodedLen(self.traceparent, self.tracestate, self.baggage);
        const buf = try gpa.alloc(u8, total);
        errdefer gpa.free(buf);
        var w: Io.Writer = .fixed(buf);
        self.format(&w) catch return error.OutOfMemory;
        return buf;
    }

    /// Parses text produced by `marshalText` or Go's `Carrier.MarshalText`.
    /// Empty text returns `Carrier.zero`. Text longer than 32 KiB, malformed
    /// query strings, and text without a valid W3C `traceparent` fail with
    /// `error.InvalidCarrier`. Invalid baggage members and members past the
    /// W3C limits (64 members / 8192 bytes) are dropped while preserving the
    /// valid members in original order.
    pub fn unmarshalText(gpa: Allocator, text: []const u8) UnmarshalError!Carrier {
        if (text.len == 0) return .zero;
        if (text.len > max_carrier_text) return error.InvalidCarrier;

        var scratch_state: std.heap.ArenaAllocator = .init(gpa);
        defer scratch_state.deinit();
        const scratch = scratch_state.allocator();

        const parsed = try parseQuery(scratch, text);
        const raw_tp = parsed.traceparent orelse return error.InvalidCarrier;
        var sc = propagation.TraceContext.parseTraceparent(raw_tp) orelse return error.InvalidCarrier;
        if (parsed.tracestate) |raw_ts| {
            if (raw_ts.len > 0) {
                sc.trace_state = TraceState.parse(scratch, raw_ts) catch |err| switch (err) {
                    error.InvalidTraceState => .empty,
                    error.OutOfMemory => return error.OutOfMemory,
                };
            }
        }
        const cleaned_bag = if (parsed.baggage) |raw_bag|
            try validBaggage(scratch, raw_bag)
        else
            "";
        return try newCarrier(gpa, sc, cleaned_bag);
    }

    /// Parses `text` and replaces `self` only on success, leaving `self`
    /// unchanged when `unmarshalText` fails.
    pub fn unmarshalInto(self: *Carrier, gpa: Allocator, text: []const u8) UnmarshalError!void {
        const parsed = try unmarshalText(gpa, text);
        self.deinit(gpa);
        self.* = parsed;
    }
};

/// Result of `startLinked` / `startLinkedWithTracer`: owns the linked root
/// `Span` handle and any merged `Baggage` arena. Call `context()` to obtain
/// the `o11y.Context` for work inside the span, and `defer job.end();` to end
/// the span and release the merged baggage.
pub const LinkedSpan = struct {
    span: span_mod.Span = .noop,
    base_ctx: Context = .background,
    arena: ?std.heap.ArenaAllocator = null,
    merged_baggage: ?Baggage = null,

    /// Returns a `Context` carrying this live span and the merged baggage.
    /// Valid until `end()` or `deinit()`.
    pub fn context(self: *LinkedSpan) Context {
        var c = self.base_ctx.withSpan(&self.span);
        if (self.merged_baggage) |*b| {
            c = c.withBaggage(b);
        }
        return c;
    }

    /// Ends the span and frees any merged baggage memory. Idempotent.
    pub fn end(self: *LinkedSpan) void {
        self.span.end();
        if (self.arena) |*a| {
            a.deinit();
            self.arena = null;
        }
        self.merged_baggage = null;
    }

    /// Alias for `end()`.
    pub fn deinit(self: *LinkedSpan) void {
        self.end();
    }
};

/// Captures the trace context active in `ctx` and the baggage injected by
/// `prop` (so any baggage egress filter wrapping `prop` applies) into an owned
/// `Carrier`. Returns `Carrier.zero` when `ctx` holds no valid span context.
pub fn capture(gpa: Allocator, ctx: Context, prop: propagation.Propagator) Allocator.Error!Carrier {
    const sc = ctx.span_context;
    if (!sc.isValid()) return .zero;

    var cap: BaggageCapture = .{ .gpa = gpa };
    defer cap.deinit();
    prop.inject(ctx, gpa, cap.carrier());

    return try newCarrier(gpa, sc, cap.baggage);
}

/// Captures the trace context and egress-filtered baggage using `telemetry`'s
/// configured propagator.
pub fn captureFrom(gpa: Allocator, telemetry: *const telemetry_mod.Telemetry, ctx: Context) Allocator.Error!Carrier {
    return capture(gpa, ctx, telemetry.propagator());
}

/// Starts a new root span under libo11y's instrumentation scope (`o11y.Telemetry`)
/// linked to `carrier`'s remote span context (when valid), merging `carrier`'s
/// baggage on top of `ctx`'s baggage (carrier keys win on conflict).
///
/// Hot-path call: never fails the host. On allocation failure while restoring
/// baggage, starts the linked root span with the existing context baggage.
pub fn startLinked(
    gpa: Allocator,
    telemetry: *telemetry_mod.Telemetry,
    ctx: Context,
    carrier: Carrier,
    name: []const u8,
    options: tracer_mod.StartOptions,
) LinkedSpan {
    const tr = telemetry.tracer(policy_runtime.scope_name);
    return startLinkedWithTracer(gpa, tr, ctx, carrier, name, options);
}

/// Like `startLinked`, using an explicit `*const Tracer`.
pub fn startLinkedWithTracer(
    gpa: Allocator,
    tr: *const tracer_mod.Tracer,
    ctx: Context,
    carrier: Carrier,
    name: []const u8,
    options: tracer_mod.StartOptions,
) LinkedSpan {
    var result: LinkedSpan = .{
        // Clear any ambient span from `ctx` so even a no-op tracer / disabled
        // SDK never leaks the caller's span into detached work.
        .base_ctx = ctx.withSpanContext(.invalid),
    };

    if (carrier.baggage.len > 0) {
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        if (mergeBaggage(arena_state.allocator(), ctx.baggage, carrier.baggage)) |maybe_bag| {
            if (maybe_bag) |bag| {
                result.arena = arena_state;
                result.merged_baggage = bag;
            } else {
                arena_state.deinit();
            }
        } else |_| {
            arena_state.deinit();
        }
    }

    var start_ctx = result.base_ctx;
    if (result.merged_baggage) |*bag| {
        start_ctx = start_ctx.withBaggage(bag);
    }

    var start_opts = options;
    start_opts.new_root = true;

    const remote_sc = carrier.spanContext();
    if (remote_sc.isValid()) {
        if (options.links.len == 0) {
            const single = [_]span_mod.Link{.{ .span_context = remote_sc }};
            start_opts.links = &single;
            result.span = tr.start(start_ctx, name, start_opts);
            return result;
        }
        var stack_links: [16]span_mod.Link = undefined;
        const total = options.links.len + 1;
        if (total <= stack_links.len) {
            stack_links[0] = .{ .span_context = remote_sc };
            @memcpy(stack_links[1..total], options.links);
            start_opts.links = stack_links[0..total];
            result.span = tr.start(start_ctx, name, start_opts);
            return result;
        }
        if (gpa.alloc(span_mod.Link, total)) |heap_links| {
            defer gpa.free(heap_links);
            heap_links[0] = .{ .span_context = remote_sc };
            @memcpy(heap_links[1..], options.links);
            start_opts.links = heap_links;
            result.span = tr.start(start_ctx, name, start_opts);
            return result;
        } else |_| {
            // Fall back to keeping the detached link if extra links cannot allocate.
            const single = [_]span_mod.Link{.{ .span_context = remote_sc }};
            start_opts.links = &single;
            result.span = tr.start(start_ctx, name, start_opts);
            return result;
        }
    }

    result.span = tr.start(start_ctx, name, start_opts);
    return result;
}

/// Builds a canonical `Carrier` from `sc` and `bag`, dropping `tracestate` and
/// then `baggage` if the serialized query string would exceed 32 KiB.
fn newCarrier(gpa: Allocator, sc: ids.SpanContext, bag: []const u8) Allocator.Error!Carrier {
    const tp_buf = propagation.TraceContext.formatTraceparent(sc);
    const tp_slice: []const u8 = &tp_buf;
    var ts_slice: []const u8 = sc.trace_state.header;
    var bag_slice: []const u8 = bag;

    if (encodedLen(tp_slice, ts_slice, bag_slice) > max_carrier_text) {
        ts_slice = "";
    }
    if (encodedLen(tp_slice, ts_slice, bag_slice) > max_carrier_text) {
        bag_slice = "";
    }

    const tp_owned = try gpa.dupe(u8, tp_slice);
    errdefer gpa.free(tp_owned);
    const ts_owned: []u8 = if (ts_slice.len > 0) try gpa.dupe(u8, ts_slice) else &.{};
    errdefer if (ts_owned.len > 0) gpa.free(ts_owned);
    const bag_owned: []u8 = if (bag_slice.len > 0) try gpa.dupe(u8, bag_slice) else &.{};

    return .{
        .traceparent = tp_owned,
        .tracestate = ts_owned,
        .baggage = bag_owned,
    };
}

const BaggageCapture = struct {
    gpa: Allocator,
    baggage: []u8 = &.{},

    fn deinit(self: *BaggageCapture) void {
        if (self.baggage.len > 0) self.gpa.free(self.baggage);
        self.baggage = &.{};
    }

    fn carrier(self: *BaggageCapture) propagation.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn } };
    }

    fn getFn(_: *anyopaque, _: []const u8) ?[]const u8 {
        return null;
    }

    fn setFn(ptr: *anyopaque, key: []const u8, value: []const u8) void {
        if (!std.mem.eql(u8, key, field_baggage)) return;
        const self: *BaggageCapture = @ptrCast(@alignCast(ptr));
        const copy = self.gpa.dupe(u8, value) catch return;
        if (self.baggage.len > 0) self.gpa.free(self.baggage);
        self.baggage = copy;
    }
};

/// Returns the members of `bag` that `Baggage.parse` accepts, kept in their
/// original raw segments and original order (matching Go's `validBaggage`).
fn validBaggage(arena: Allocator, bag: []const u8) Allocator.Error![]const u8 {
    if (bag.len == 0 or bag.len > Baggage.max_bytes) return "";
    const parsed = Baggage.parse(arena, bag) catch |err| switch (err) {
        error.BaggageTooLarge => return "",
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (parsed.len() == 0) return "";

    var kept: std.ArrayList([]const u8) = .empty;
    var seen: std.StringHashMapUnmanaged(void) = .empty;
    var it = std.mem.splitScalar(u8, bag, ',');
    while (it.next()) |raw| {
        const seg = Baggage.parse(arena, raw) catch |err| switch (err) {
            error.BaggageTooLarge => continue,
            error.OutOfMemory => return error.OutOfMemory,
        };
        if (seg.len() != 1) continue;
        const m = seg.members[0];
        if (seen.contains(m.key)) continue;
        const kept_member = parsed.member(m.key) orelse continue;
        if (!membersEqual(kept_member, m)) continue;
        try seen.put(arena, m.key, {});
        try kept.append(arena, raw);
    }
    if (kept.items.len == 0) return "";

    var total: usize = kept.items.len - 1;
    for (kept.items) |s| total += s.len;
    const out = try arena.alloc(u8, total);
    var pos: usize = 0;
    for (kept.items, 0..) |s, i| {
        if (i > 0) {
            out[pos] = ',';
            pos += 1;
        }
        @memcpy(out[pos..][0..s.len], s);
        pos += s.len;
    }
    return out;
}

fn membersEqual(a: Baggage.Member, b: Baggage.Member) bool {
    return std.mem.eql(u8, a.key, b.key) and
        std.mem.eql(u8, a.value, b.value) and
        std.mem.eql(u8, a.metadata, b.metadata);
}

/// Restores `carrier_bag` (enforcing W3C parse limits) and merges its members
/// onto `existing`, replacing members with the same key. Returns null when
/// `carrier_bag` yields no valid members (so caller keeps existing baggage).
fn mergeBaggage(arena: Allocator, existing: ?*const Baggage, carrier_bag: []const u8) Allocator.Error!?Baggage {
    const restored = Baggage.parse(arena, carrier_bag) catch |err| switch (err) {
        error.BaggageTooLarge => return null,
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (restored.len() == 0) return null;

    var combined: std.ArrayList(Baggage.Member) = .empty;
    if (existing) |base| {
        for (base.members) |m| {
            try combined.append(arena, try copyMember(arena, m));
        }
    }
    for (restored.members) |m| {
        const found = for (combined.items, 0..) |*slot, i| {
            if (std.mem.eql(u8, slot.key, m.key)) break i;
        } else null;
        if (found) |idx| {
            combined.items[idx] = m;
        } else {
            try combined.append(arena, m);
        }
    }
    return .{ .members = combined.items };
}

fn copyMember(arena: Allocator, m: Baggage.Member) Allocator.Error!Baggage.Member {
    const props = if (m.properties.len > 0) blk: {
        const out = try arena.alloc(Baggage.Property, m.properties.len);
        for (out, m.properties) |*dst, src| {
            dst.* = .{
                .key = try arena.dupe(u8, src.key),
                .value = if (src.value) |v| try arena.dupe(u8, v) else null,
            };
        }
        break :blk out;
    } else &[_]Baggage.Property{};
    return .{
        .key = try arena.dupe(u8, m.key),
        .value = try arena.dupe(u8, m.value),
        .properties = props,
        .metadata = if (m.metadata.len > 0) try arena.dupe(u8, m.metadata) else "",
    };
}

// ---------------------------------------------------------------------------
// Go-compatible URL query encoding/decoding (application/x-www-form-urlencoded)
// ---------------------------------------------------------------------------

fn isQueryUnescaped(c: u8) bool {
    return switch (c) {
        'A'...'Z', 'a'...'z', '0'...'9', '-', '_', '.', '~' => true,
        else => false,
    };
}

fn queryEscapedLen(s: []const u8) usize {
    var n: usize = s.len;
    for (s) |c| {
        if (!isQueryUnescaped(c) and c != ' ') n += 2;
    }
    return n;
}

fn encodedLen(tp: []const u8, ts: []const u8, bag: []const u8) usize {
    if (tp.len == 0) return 0;
    var total: usize = (field_traceparent ++ "=").len + queryEscapedLen(tp);
    if (bag.len > 0) {
        total += (field_baggage ++ "=").len + queryEscapedLen(bag) + 1;
    }
    if (ts.len > 0) {
        total += ("&" ++ field_tracestate ++ "=").len + queryEscapedLen(ts);
    }
    return total;
}

fn writeQueryEscaped(w: *Io.Writer, s: []const u8) Io.Writer.Error!void {
    const upper = "0123456789ABCDEF";
    var start: usize = 0;
    for (s, 0..) |c, i| {
        if (isQueryUnescaped(c)) continue;
        if (i > start) try w.writeAll(s[start..i]);
        if (c == ' ') {
            try w.writeByte('+');
        } else {
            try w.writeAll(&.{ '%', upper[c >> 4], upper[c & 0x0f] });
        }
        start = i + 1;
    }
    if (start < s.len) try w.writeAll(s[start..]);
}

const ParsedQuery = struct {
    traceparent: ?[]const u8 = null,
    tracestate: ?[]const u8 = null,
    baggage: ?[]const u8 = null,
};

fn parseQuery(arena: Allocator, text: []const u8) UnmarshalError!ParsedQuery {
    var out: ParsedQuery = .{};
    var it = std.mem.splitScalar(u8, text, '&');
    while (it.next()) |pair| {
        if (pair.len == 0) continue;
        if (std.mem.indexOfScalar(u8, pair, ';') != null) return error.InvalidCarrier;
        const raw_key, const raw_val = std.mem.cutScalar(u8, pair, '=') orelse .{ pair, "" };
        const key = try queryUnescape(arena, raw_key);
        const val = try queryUnescape(arena, raw_val);
        if (std.mem.eql(u8, key, field_traceparent)) {
            if (out.traceparent == null) out.traceparent = val;
        } else if (std.mem.eql(u8, key, field_tracestate)) {
            if (out.tracestate == null) out.tracestate = val;
        } else if (std.mem.eql(u8, key, field_baggage)) {
            if (out.baggage == null) out.baggage = val;
        }
    }
    return out;
}

fn queryUnescape(arena: Allocator, s: []const u8) UnmarshalError![]const u8 {
    var needs_decode = false;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '+') {
            needs_decode = true;
        } else if (s[i] == '%') {
            if (i + 2 >= s.len) return error.InvalidCarrier;
            if (!std.ascii.isHex(s[i + 1]) or !std.ascii.isHex(s[i + 2])) return error.InvalidCarrier;
            needs_decode = true;
            i += 2;
        }
    }
    if (!needs_decode) return s;

    const out = try arena.alloc(u8, s.len);
    var n: usize = 0;
    i = 0;
    while (i < s.len) : (n += 1) {
        if (s[i] == '+') {
            out[n] = ' ';
            i += 1;
        } else if (s[i] == '%') {
            const hi = hexNibble(s[i + 1]);
            const lo = hexNibble(s[i + 2]);
            out[n] = (hi << 4) | lo;
            i += 3;
        } else {
            out[n] = s[i];
            i += 1;
        }
    }
    return out[0..n];
}

fn hexNibble(c: u8) u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => c - 'A' + 10,
    };
}

// ---------------------------------------------------------------------------
// Tests (ported from go/detached_test.go)
// ---------------------------------------------------------------------------

const testing = std.testing;
const memory_exporter = @import("pipeline/memory_exporter.zig");

fn makeRemoteCtx(tracestate_header: []const u8) struct { ctx: Context, sc: ids.SpanContext } {
    const sc: ids.SpanContext = .{
        .trace_id = ids.TraceId.parseHex("0af7651916cd43dd8448eb211c80319c").?,
        .span_id = ids.SpanId.parseHex("b7ad6b7169203331").?,
        .flags = .sampled_flag,
        .trace_state = .{ .header = tracestate_header },
        .remote = true,
    };
    return .{ .ctx = Context.background.withSpanContext(sc), .sc = sc };
}

fn initTestSdk(
    exp: *memory_exporter.InMemoryExporter,
    egress: ?*const fn (key: []const u8) bool,
) !*telemetry_mod.Telemetry {
    return telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "detached-test",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
        .span_exporter = exp.exporter(),
        .baggage_egress_allow = egress,
    });
}

test "Carrier round trips through text and preserves remote span context and baggage" {
    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try initTestSdk(&exp, null);
    defer sdk.deinit();

    var sp = sdk.tracer("test").start(.background, "request", .{});
    defer sp.end();
    const bag: Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    const ctx = Context.background.withSpan(&sp).withBaggage(&bag);

    var carrier = try captureFrom(testing.allocator, sdk, ctx);
    defer carrier.deinit(testing.allocator);
    try testing.expect(!carrier.isZero());

    const text = try carrier.marshalText(testing.allocator);
    defer testing.allocator.free(text);
    try testing.expect(std.mem.indexOf(u8, text, "tenant%3Dacme") != null);

    var back = try Carrier.unmarshalText(testing.allocator, text);
    defer back.deinit(testing.allocator);

    const got = back.spanContext();
    const want = sp.spanContext();
    try testing.expectEqualSlices(u8, &want.trace_id.bytes, &got.trace_id.bytes);
    try testing.expectEqualSlices(u8, &want.span_id.bytes, &got.span_id.bytes);
    try testing.expect(got.remote);

    const formatted = try std.fmt.allocPrint(testing.allocator, "{f}", .{back});
    defer testing.allocator.free(formatted);
    try testing.expectEqualStrings(text, formatted);
}

test "Zero carrier serializes empty and unmarshals empty text" {
    var c = try capture(testing.allocator, .background, propagation.default());
    defer c.deinit(testing.allocator);
    try testing.expect(c.isZero());
    try testing.expect(!c.spanContext().isValid());

    const text = try c.marshalText(testing.allocator);
    defer testing.allocator.free(text);
    try testing.expectEqual(@as(usize, 0), text.len);

    var back = try Carrier.unmarshalText(testing.allocator, "");
    defer back.deinit(testing.allocator);
    try testing.expect(back.isZero());
}

test "Carrier rejects invalid text and >32 KiB payloads without mutating existing value" {
    const too_long = try testing.allocator.alloc(u8, 40 << 10);
    defer testing.allocator.free(too_long);
    @memcpy(too_long[0.."traceparent=".len], "traceparent=");
    @memset(too_long["traceparent=".len..], 'a');

    const bad_cases = [_][]const u8{
        "%zz",
        "traceparent=00-xyz",
        "baggage=a%3Db",
        "traceparent=00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01;foo=bar",
        too_long,
    };
    for (bad_cases) |raw| {
        try testing.expectError(error.InvalidCarrier, Carrier.unmarshalText(testing.allocator, raw));
    }

    // unmarshalInto leaves existing carrier unchanged on error.
    const r = makeRemoteCtx("vendor=abc");
    var c = try capture(testing.allocator, r.ctx, propagation.default());
    defer c.deinit(testing.allocator);
    const before = try c.marshalText(testing.allocator);
    defer testing.allocator.free(before);

    try testing.expectError(error.InvalidCarrier, c.unmarshalInto(testing.allocator, "traceparent=00-xyz"));
    const after = try c.marshalText(testing.allocator);
    defer testing.allocator.free(after);
    try testing.expectEqualStrings(before, after);

    // Empty text resets to zero.
    try c.unmarshalInto(testing.allocator, "");
    try testing.expect(c.isZero());
}

test "Capture applies baggage egress filter" {
    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try initTestSdk(&exp, struct {
        fn allow(key: []const u8) bool {
            return !std.mem.eql(u8, key, "session");
        }
    }.allow);
    defer sdk.deinit();

    var sp = sdk.tracer("test").start(.background, "request", .{});
    defer sp.end();
    const bag: Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "session", .value = "s-1" },
    } };
    const ctx = Context.background.withSpan(&sp).withBaggage(&bag);

    var carrier = try sdk.captureDetached(testing.allocator, ctx);
    defer carrier.deinit(testing.allocator);
    const text = try carrier.marshalText(testing.allocator);
    defer testing.allocator.free(text);
    try testing.expect(std.mem.indexOf(u8, text, "session") == null);
    try testing.expect(std.mem.indexOf(u8, text, "tenant") != null);
}

test "startLinked starts a linked root span, merges baggage, and uses library scope" {
    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try initTestSdk(&exp, null);
    defer sdk.deinit();

    const tr = sdk.tracer("test");
    var origin = tr.start(.background, "request", .{});
    const origin_bag: Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "region", .value = "eu" },
    } };
    var carrier = try sdk.captureDetached(testing.allocator, Context.background.withSpan(&origin).withBaggage(&origin_bag));
    defer carrier.deinit(testing.allocator);
    origin.end();

    var loop_sp = tr.start(.background, "worker-loop", .{});
    const worker_bag: Baggage = .{ .members = &.{
        .{ .key = "worker", .value = "pool-1" },
        .{ .key = "region", .value = "us" },
    } };
    const worker_ctx = Context.background.withSpan(&loop_sp).withBaggage(&worker_bag);

    var job = sdk.startLinked(testing.allocator, worker_ctx, carrier, "send-email", .{ .kind = .consumer });
    const job_ctx = job.context();
    try testing.expectEqualStrings("acme", job_ctx.baggage.?.member("tenant").?.value);
    try testing.expectEqualStrings("eu", job_ctx.baggage.?.member("region").?.value);
    try testing.expectEqualStrings("pool-1", job_ctx.baggage.?.member("worker").?.value);
    job.end();
    loop_sp.end();

    try testing.expect(sdk.forceFlush(null).ok());
    const spans = try exp.snapshot(testing.allocator);
    defer testing.allocator.free(spans);

    const job_span = for (spans) |s| {
        if (std.mem.eql(u8, s.name, "send-email")) break s;
    } else return error.TestUnexpectedResult;

    try testing.expect(!job_span.parent.isValid());
    try testing.expect(!std.mem.eql(u8, &job_span.span_context.trace_id.bytes, &origin.spanContext().trace_id.bytes));
    try testing.expectEqual(@as(usize, 1), job_span.links.items.len);
    try testing.expectEqualSlices(u8, &origin.spanContext().span_id.bytes, &job_span.links.items[0].span_context.span_id.bytes);
    try testing.expect(job_span.links.items[0].span_context.remote);
    try testing.expectEqual(span_mod.SpanKind.consumer, job_span.kind);
    try testing.expectEqualStrings(policy_runtime.scope_name, job_span.scope().name);
}

test "startLinked with zero carrier starts an unlinked root" {
    var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer exp.deinit();
    const sdk = try initTestSdk(&exp, null);
    defer sdk.deinit();

    var job = startLinked(testing.allocator, sdk, .background, .zero, "job", .{});
    job.end();
    try testing.expect(sdk.forceFlush(null).ok());

    const spans = try exp.snapshot(testing.allocator);
    defer testing.allocator.free(spans);
    try testing.expectEqual(@as(usize, 1), spans.len);
    try testing.expect(!spans[0].parent.isValid());
    try testing.expectEqual(@as(usize, 0), spans[0].links.items.len);
}

test "Carrier round trips tracestate and drops maximal tracestate while keeping baggage" {
    const r = makeRemoteCtx("vendor=abc,other=xyz");
    var c = try capture(testing.allocator, r.ctx, propagation.default());
    defer c.deinit(testing.allocator);
    const text = try c.marshalText(testing.allocator);
    defer testing.allocator.free(text);
    var back = try Carrier.unmarshalText(testing.allocator, text);
    defer back.deinit(testing.allocator);
    try testing.expectEqualStrings("abc", back.spanContext().trace_state.get("vendor").?);

    // Build maximal tracestate (32 members of 256-char '/' keys and values -> >32 KiB URL-encoded).
    var big_ts: std.ArrayList(u8) = .empty;
    defer big_ts.deinit(testing.allocator);
    const slashes_253: [253]u8 = @splat('/');
    const slashes_256: [256]u8 = @splat('/');
    for (0..32) |i| {
        if (i > 0) try big_ts.append(testing.allocator, ',');
        try big_ts.print(testing.allocator, "k{d:0>2}{s}={s}", .{ i, &slashes_253, &slashes_256 });
    }
    const max_r = makeRemoteCtx(big_ts.items);
    const bag: Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    var max_c = try capture(testing.allocator, max_r.ctx.withBaggage(&bag), propagation.default());
    defer max_c.deinit(testing.allocator);

    const max_text = try max_c.marshalText(testing.allocator);
    defer testing.allocator.free(max_text);
    try testing.expect(max_text.len <= max_carrier_text);
    try testing.expect(std.mem.indexOf(u8, max_text, "tenant%3Dacme") != null);
    try testing.expect(std.mem.indexOf(u8, max_text, "tracestate=") == null);

    var max_back = try Carrier.unmarshalText(testing.allocator, max_text);
    defer max_back.deinit(testing.allocator);
    try testing.expectEqualSlices(u8, &max_r.sc.span_id.bytes, &max_back.spanContext().span_id.bytes);
}

test "Carrier drops invalid baggage, keeps valid members in order, and enforces W3C limits" {
    const r = makeRemoteCtx("");
    var base_c = try capture(testing.allocator, r.ctx, propagation.default());
    defer base_c.deinit(testing.allocator);
    const base = try base_c.marshalText(testing.allocator);
    defer testing.allocator.free(base);

    // Pure invalid baggage is dropped while link survives.
    {
        const raw = try std.fmt.allocPrint(testing.allocator, "{s}&baggage=%3D%3D%3D", .{base});
        defer testing.allocator.free(raw);
        var c = try Carrier.unmarshalText(testing.allocator, raw);
        defer c.deinit(testing.allocator);
        const text = try c.marshalText(testing.allocator);
        defer testing.allocator.free(text);
        try testing.expect(std.mem.indexOf(u8, text, "baggage") == null);
        try testing.expectEqualSlices(u8, &r.sc.span_id.bytes, &c.spanContext().span_id.bytes);
    }

    // Valid members survive in exact original order; invalid segments dropped.
    {
        const raw = try std.fmt.allocPrint(testing.allocator, "{s}&baggage=c%3D3%2Ca%3D1%2C%3D%3D%3D%2Cb%3D2", .{base});
        defer testing.allocator.free(raw);
        var c = try Carrier.unmarshalText(testing.allocator, raw);
        defer c.deinit(testing.allocator);
        const text = try c.marshalText(testing.allocator);
        defer testing.allocator.free(text);
        const want = try std.fmt.allocPrint(testing.allocator, "baggage=c%3D3%2Ca%3D1%2Cb%3D2&{s}", .{base});
        defer testing.allocator.free(want);
        try testing.expectEqualStrings(want, text);
    }

    // 70 captured baggage members -> startLinked keeps 64.
    {
        var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
        defer exp.deinit();
        const sdk = try initTestSdk(&exp, null);
        defer sdk.deinit();

        var members: [70]Baggage.Member = undefined;
        var keys: [70][4]u8 = undefined;
        var vals: [70][4]u8 = undefined;
        for (0..70) |i| {
            const k = try std.fmt.bufPrint(&keys[i], "k{d:0>2}", .{i});
            const v = try std.fmt.bufPrint(&vals[i], "v{d:0>2}", .{i});
            members[i] = .{ .key = k, .value = v };
        }
        const bag: Baggage = .{ .members = &members };
        var c = try captureFrom(testing.allocator, sdk, r.ctx.withBaggage(&bag));
        defer c.deinit(testing.allocator);

        var job = startLinked(testing.allocator, sdk, .background, c, "job", .{});
        try testing.expectEqual(@as(usize, 64), job.context().baggage.?.len());
        job.end();
    }

    // Baggage over 8192 bytes is dropped whole on unmarshal and startLinked.
    {
        var exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
        defer exp.deinit();
        const sdk = try initTestSdk(&exp, null);
        defer sdk.deinit();

        var members: [40]Baggage.Member = undefined;
        var keys: [40][4]u8 = undefined;
        const v250: [250]u8 = @splat('v');
        for (0..40) |i| {
            const k = try std.fmt.bufPrint(&keys[i], "k{d:0>2}", .{i});
            members[i] = .{ .key = k, .value = &v250 };
        }
        const bag: Baggage = .{ .members = &members };
        var c = try captureFrom(testing.allocator, sdk, r.ctx.withBaggage(&bag));
        defer c.deinit(testing.allocator);

        const text = try c.marshalText(testing.allocator);
        defer testing.allocator.free(text);
        try testing.expect(std.mem.indexOf(u8, text, "baggage=") != null);

        var back = try Carrier.unmarshalText(testing.allocator, text);
        defer back.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 0), back.baggage.len);
        try testing.expectEqualSlices(u8, &r.sc.span_id.bytes, &back.spanContext().span_id.bytes);

        var job = startLinked(testing.allocator, sdk, .background, c, "job", .{});
        try testing.expectEqual(@as(?*const Baggage, null), job.context().baggage);
        job.end();
    }
}

test "startLinked passes merged baggage to samplers and onStart span processors" {
    const processor_mod = @import("pipeline/processor.zig");
    const sampler_mod = @import("pipeline/sampler.zig");

    const BaggageObserver = struct {
        sampler_saw_tenant: bool = false,
        sampler_saw_worker: bool = false,
        on_start_saw_tenant: bool = false,
        on_start_saw_worker: bool = false,
        on_start_parent_invalid: bool = false,

        fn sampler(self: *@This()) sampler_mod.Sampler {
            return .{ .custom = .{ .ptr = self, .vtable = &.{ .shouldSample = shouldSample, .writeDescription = writeDesc } } };
        }

        fn shouldSample(ptr: ?*const anyopaque, params: sampler_mod.Parameters) sampler_mod.Result {
            const self: *@This() = @ptrCast(@alignCast(@constCast(ptr.?)));
            if (params.parent.baggage) |bag| {
                if (bag.member("tenant")) |m| self.sampler_saw_tenant = std.mem.eql(u8, m.value, "acme");
                if (bag.member("worker")) |m| self.sampler_saw_worker = std.mem.eql(u8, m.value, "w-1");
            }
            return .{ .decision = .record_and_sample };
        }

        fn writeDesc(_: ?*const anyopaque, w: *Io.Writer) Io.Writer.Error!void {
            try w.writeAll("BaggageObserverSampler");
        }

        fn spanProcessor(self: *@This()) processor_mod.SpanProcessor {
            return .{ .ptr = self, .vtable = &.{
                .onStart = onStart,
                .onEnd = onEnd,
                .forceFlush = noopFlush,
                .shutdown = noopFlush,
            } };
        }

        fn onStart(ptr: *anyopaque, parent_ctx: Context, _: *span_mod.SpanData) void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.on_start_parent_invalid = !parent_ctx.span_context.isValid();
            if (parent_ctx.baggage) |bag| {
                if (bag.member("tenant")) |m| self.on_start_saw_tenant = std.mem.eql(u8, m.value, "acme");
                if (bag.member("worker")) |m| self.on_start_saw_worker = std.mem.eql(u8, m.value, "w-1");
            }
        }

        fn onEnd(_: *anyopaque, _: *const span_mod.SpanData) void {}
        fn noopFlush(_: *anyopaque, _: @import("pipeline/deadline.zig").Deadline) processor_mod.ExportError!void {}
    };

    var obs: BaggageObserver = .{};
    const sdk = try telemetry_mod.init(testing.allocator, testing.io, .{
        .service_name = "detached-obs",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = obs.sampler(),
        .span_processor = obs.spanProcessor(),
    });
    defer sdk.deinit();

    const r = makeRemoteCtx("");
    const origin_bag: Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    var carrier = try captureFrom(testing.allocator, sdk, r.ctx.withBaggage(&origin_bag));
    defer carrier.deinit(testing.allocator);

    const worker_bag: Baggage = .{ .members = &.{.{ .key = "worker", .value = "w-1" }} };
    var job = startLinked(testing.allocator, sdk, Context.background.withBaggage(&worker_bag), carrier, "job", .{});
    job.end();

    try testing.expect(obs.sampler_saw_tenant);
    try testing.expect(obs.sampler_saw_worker);
    try testing.expect(obs.on_start_saw_tenant);
    try testing.expect(obs.on_start_saw_worker);
    try testing.expect(obs.on_start_parent_invalid);
}
