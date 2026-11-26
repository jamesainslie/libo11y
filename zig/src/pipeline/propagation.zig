//! Text map propagation: the W3C trace context and baggage propagators,
//! composites, and the inject-only baggage egress filter. Ported from
//! go.opentelemetry.io/otel/propagation v1.47.0 and libo11y's
//! go/baggagefilter.go.
//!
//! Neither inject nor extract can fail. Inject skips what it cannot
//! write, and extract returns the context without the part it could not
//! read or allocate.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Context = @import("../context.zig").Context;
const ids = @import("ids.zig");
const Baggage = @import("baggage.zig").Baggage;
const TraceState = @import("tracestate.zig").TraceState;

/// The storage a propagator reads and writes: HTTP headers, a map, the
/// environment. Keys are the lowercase field names the propagators use; a
/// case-insensitive store such as HTTP headers matches them itself.
pub const Carrier = struct {
    /// The carrier's state, passed to every function in `vtable`.
    ptr: *anyopaque,
    /// The carrier's functions.
    vtable: *const VTable,

    /// The carrier's functions.
    pub const VTable = struct {
        /// Returns the first value for `key`, or null. The value stays
        /// valid until the carrier changes.
        get: *const fn (ptr: *anyopaque, key: []const u8) ?[]const u8,
        /// Stores `value` for `key`, replacing what was there. `value` is
        /// valid only during the call, so a carrier that keeps it copies it.
        set: *const fn (ptr: *anyopaque, key: []const u8, value: []const u8) void,
        /// Returns the value at `index` among the values for `key`, or null
        /// past the last one. A carrier that holds several values per key,
        /// such as HTTP headers, sets it so the baggage propagator combines
        /// them as Go does for its `ValuesGetter`. Leave it null otherwise.
        valueAt: ?*const fn (ptr: *anyopaque, key: []const u8, index: usize) ?[]const u8 = null,
    };

    /// Returns the first value for `key`, or null.
    pub fn get(c: Carrier, key: []const u8) ?[]const u8 {
        return c.vtable.get(c.ptr, key);
    }

    /// Stores `value` for `key`.
    pub fn set(c: Carrier, key: []const u8, value: []const u8) void {
        c.vtable.set(c.ptr, key, value);
    }
};

/// A propagator: it injects a context into a carrier and extracts one from
/// it.
pub const Propagator = struct {
    /// The propagator's state, passed to every function in `vtable`.
    ptr: *const anyopaque,
    /// The propagator's functions.
    vtable: *const VTable,

    /// The propagator's functions. See the methods of `Propagator`.
    pub const VTable = struct {
        /// Implements `Propagator.inject`.
        inject: *const fn (ptr: *const anyopaque, ctx: Context, gpa: Allocator, carrier: Carrier) void,
        /// Implements `Propagator.extract`.
        extract: *const fn (ptr: *const anyopaque, ctx: Context, arena: Allocator, carrier: Carrier) Context,
        /// Implements `Propagator.fields`.
        fields: *const fn (ptr: *const anyopaque) []const []const u8,
    };

    /// Writes the span context and baggage of `ctx` into `carrier`. `gpa`
    /// is scratch space for building header text; everything allocated in
    /// it is freed before inject returns.
    pub fn inject(p: Propagator, ctx: Context, gpa: Allocator, carrier: Carrier) void {
        p.vtable.inject(p.ptr, ctx, gpa, carrier);
    }

    /// Returns `ctx` with what `carrier` holds: a remote parent span
    /// context, baggage, or both. The trace state and baggage of the result
    /// are allocated in `arena`, which the caller keeps alive for as long
    /// as the result is used. The result never borrows the carrier.
    pub fn extract(p: Propagator, ctx: Context, arena: Allocator, carrier: Carrier) Context {
        return p.vtable.extract(p.ptr, ctx, arena, carrier);
    }

    /// Returns the carrier keys that inject sets.
    pub fn fields(p: Propagator) []const []const u8 {
        return p.vtable.fields(p.ptr);
    }
};

/// The address stateless propagators use for `Propagator.ptr`.
const stateless: u8 = 0;

/// The W3C trace context propagator, for the `traceparent` and
/// `tracestate` headers.
pub const TraceContext = struct {
    /// The traceparent header name.
    pub const traceparent_header = "traceparent";
    /// The tracestate header name.
    pub const tracestate_header = "tracestate";

    /// The propagator.
    pub const propagator: Propagator = .{ .ptr = &stateless, .vtable = &vtable };

    const vtable: Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };
    const field_names = [_][]const u8{ traceparent_header, tracestate_header };

    /// The trace flags propagation keeps: sampled (0x01) and random (0x02).
    const kept_flags: u8 = 0x03;

    /// Parses a `traceparent` value as Go's TraceContext propagator does.
    /// Version ff is invalid. Version 00 must be exactly four fields with
    /// no flag above 0x03; later versions may carry more fields after the
    /// flags. Hex must be lowercase, and both ids must be non-zero. Only
    /// the sampled and random flags are kept. The result is remote and has
    /// an empty trace state.
    pub fn parseTraceparent(text: []const u8) ?ids.SpanContext {
        var rest = text;
        var version: [1]u8 = undefined;
        if (!extractPart(&version, &rest)) return null;
        if (version[0] == 0xff) return null;
        var sc: ids.SpanContext = .{ .remote = true };
        if (!extractPart(&sc.trace_id.bytes, &rest)) return null;
        if (!extractPart(&sc.span_id.bytes, &rest)) return null;
        var flags: [1]u8 = undefined;
        if (!extractPart(&flags, &rest)) return null;
        if (version[0] == 0 and (rest.len != 0 or flags[0] > kept_flags)) return null;
        sc.flags = .fromByte(flags[0] & kept_flags);
        if (!sc.isValid()) return null;
        return sc;
    }

    /// Returns the version 00 `traceparent` value for `sc`, keeping only
    /// the sampled and random flags.
    pub fn formatTraceparent(sc: ids.SpanContext) [55]u8 {
        var out: [55]u8 = undefined;
        out[0..3].* = "00-".*;
        out[3..35].* = sc.trace_id.hex();
        out[35] = '-';
        out[36..52].* = sc.span_id.hex();
        out[52] = '-';
        out[53..55].* = std.fmt.bytesToHex([1]u8{sc.flags.toByte() & kept_flags}, .lower);
        return out;
    }

    /// Splits the next dash-separated field off `rest` and decodes it as
    /// lowercase hex into `dst`.
    fn extractPart(dst: []u8, rest: *[]const u8) bool {
        const part, rest.* = std.mem.cutScalar(u8, rest.*, '-') orelse .{ rest.*, "" };
        if (part.len != dst.len * 2) return false;
        for (dst, 0..) |*byte, i| {
            const hi = ids.lowerHexDigit(part[2 * i]) orelse return false;
            const lo = ids.lowerHexDigit(part[2 * i + 1]) orelse return false;
            byte.* = hi << 4 | lo;
        }
        return true;
    }

    fn inject(_: *const anyopaque, ctx: Context, _: Allocator, carrier: Carrier) void {
        const sc = ctx.span_context;
        if (!sc.isValid()) return;
        if (!sc.trace_state.isEmpty()) carrier.set(tracestate_header, sc.trace_state.header);
        const traceparent = formatTraceparent(sc);
        carrier.set(traceparent_header, &traceparent);
    }

    fn extract(_: *const anyopaque, ctx: Context, arena: Allocator, carrier: Carrier) Context {
        const text = carrier.get(traceparent_header) orelse return ctx;
        var sc = parseTraceparent(text) orelse return ctx;
        // An invalid or unallocatable trace state does not affect the
        // traceparent, as the W3C specification requires.
        if (carrier.get(tracestate_header)) |ts_text| sc.trace_state = ownedTraceState(arena, ts_text);
        return ctx.withSpanContext(sc);
    }

    fn ownedTraceState(arena: Allocator, text: []const u8) TraceState {
        const ts = TraceState.parse(arena, text) catch return .empty;
        if (ts.isEmpty() or ts.header.ptr != text.ptr) return ts;
        const copy = arena.dupe(u8, ts.header) catch return .empty;
        return .{ .header = copy };
    }

    fn fields(_: *const anyopaque) []const []const u8 {
        return &field_names;
    }
};

/// The W3C baggage propagator, for the `baggage` header.
pub const BaggagePropagator = struct {
    /// The baggage header name.
    pub const header = "baggage";

    /// The propagator.
    pub const propagator: Propagator = .{ .ptr = &stateless, .vtable = &vtable };

    const vtable: Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };
    const field_names = [_][]const u8{header};

    fn inject(_: *const anyopaque, ctx: Context, gpa: Allocator, carrier: Carrier) void {
        const bag = ctx.baggage orelse return;
        if (bag.len() == 0) return;
        var out: std.Io.Writer.Allocating = .init(gpa);
        defer out.deinit();
        bag.encode(&out.writer) catch return;
        if (out.written().len == 0) return;
        carrier.set(header, out.written());
    }

    fn extract(_: *const anyopaque, ctx: Context, arena: Allocator, carrier: Carrier) Context {
        const bag = if (carrier.vtable.valueAt) |valueAt|
            extractMulti(arena, carrier, valueAt)
        else
            extractSingle(arena, carrier);
        if (bag.len() == 0) return ctx;
        const ptr = arena.create(Baggage) catch return ctx;
        ptr.* = bag;
        return ctx.withBaggage(ptr);
    }

    fn extractSingle(arena: Allocator, carrier: Carrier) Baggage {
        const text = carrier.get(header) orelse return .empty;
        return Baggage.parse(arena, text) catch .empty;
    }

    /// Combines every baggage value as Go's `extractMultiBaggage` does: the
    /// byte limit applies to all values joined by commas, and when they
    /// exceed it no baggage is extracted at all.
    fn extractMulti(
        arena: Allocator,
        carrier: Carrier,
        valueAt: *const fn (ptr: *anyopaque, key: []const u8, index: usize) ?[]const u8,
    ) Baggage {
        var members: std.ArrayList(Baggage.Member) = .empty;
        var total: usize = 0;
        var i: usize = 0;
        while (valueAt(carrier.ptr, header, i)) |text| : (i += 1) {
            if (i > 0) total += 1;
            total += text.len;
            if (total > Baggage.max_bytes) return .empty;
            if (members.items.len > Baggage.max_members) continue;
            const bag = Baggage.parse(arena, text) catch |err| switch (err) {
                error.BaggageTooLarge => continue,
                error.OutOfMemory => return .empty,
            };
            members.appendSlice(arena, bag.members) catch return .empty;
        }
        return Baggage.fromMembers(arena, members.items) catch .empty;
    }

    fn fields(_: *const anyopaque) []const []const u8 {
        return &field_names;
    }
};

/// Runs several propagators in order. Its fields are theirs in order, each
/// name once.
pub const Composite = struct {
    /// The propagators, run in order.
    propagators: []const Propagator,
    /// The fields of all the propagators, in order and without repeats.
    field_names: []const []const u8,

    /// Returns a composite of `propagators`, copying the list into `gpa`.
    /// The field names are borrowed from the propagators.
    pub fn init(gpa: Allocator, propagators: []const Propagator) error{OutOfMemory}!Composite {
        const list = try gpa.dupe(Propagator, propagators);
        errdefer gpa.free(list);
        var n: usize = 0;
        for (list, 0..) |p, i| {
            for (0..p.fields().len) |j| n += @intFromBool(firstOccurrence(list, i, j));
        }
        const names = try gpa.alloc([]const u8, n);
        var k: usize = 0;
        for (list, 0..) |p, i| {
            for (p.fields(), 0..) |name, j| {
                if (!firstOccurrence(list, i, j)) continue;
                names[k] = name;
                k += 1;
            }
        }
        return .{ .propagators = list, .field_names = names };
    }

    /// Frees what `init` allocated.
    pub fn deinit(c: Composite, gpa: Allocator) void {
        gpa.free(c.field_names);
        gpa.free(c.propagators);
    }

    /// Returns the composite as a propagator. It points at `c`, which must
    /// outlive it.
    pub fn propagator(c: *const Composite) Propagator {
        return .{ .ptr = c, .vtable = &vtable };
    }

    const vtable: Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };

    /// Reports whether field `j` of propagator `i` is the first field with
    /// its name across the list.
    fn firstOccurrence(list: []const Propagator, i: usize, j: usize) bool {
        const name = list[i].fields()[j];
        for (list[0 .. i + 1], 0..) |p, pi| {
            const names = p.fields();
            const end = if (pi == i) j else names.len;
            for (names[0..end]) |other| {
                if (std.mem.eql(u8, other, name)) return false;
            }
        }
        return true;
    }

    fn cast(ptr: *const anyopaque) *const Composite {
        return @ptrCast(@alignCast(ptr));
    }

    fn inject(ptr: *const anyopaque, ctx: Context, gpa: Allocator, carrier: Carrier) void {
        for (cast(ptr).propagators) |p| p.inject(ctx, gpa, carrier);
    }

    fn extract(ptr: *const anyopaque, ctx: Context, arena: Allocator, carrier: Carrier) Context {
        var out = ctx;
        for (cast(ptr).propagators) |p| out = p.extract(out, arena, carrier);
        return out;
    }

    fn fields(ptr: *const anyopaque) []const []const u8 {
        return cast(ptr).field_names;
    }
};

const default_composite: Composite = .{
    .propagators = &.{ TraceContext.propagator, BaggagePropagator.propagator },
    .field_names = &.{ TraceContext.traceparent_header, TraceContext.tracestate_header, BaggagePropagator.header },
};

/// Returns the default propagator: W3C trace context then W3C baggage,
/// with the fields `traceparent`, `tracestate` and `baggage`. It needs no
/// allocation and is valid for the life of the program.
pub fn default() Propagator {
    return default_composite.propagator();
}

/// Wraps a propagator so that inject sends only the baggage members whose
/// key `allow` accepts, as libo11y's Go `baggageEgress` does. Extract and
/// fields pass through to the inner propagator unchanged.
pub const BaggageEgress = struct {
    /// The wrapped propagator.
    inner: Propagator,
    /// Reports whether a baggage member with this key may leave the process.
    allow: *const fn (key: []const u8) bool = allowAll,

    /// The default predicate: it allows every key.
    pub fn allowAll(_: []const u8) bool {
        return true;
    }

    /// Returns the filter as a propagator. It points at `e`, which must
    /// outlive it.
    pub fn propagator(e: *const BaggageEgress) Propagator {
        return .{ .ptr = e, .vtable = &vtable };
    }

    const vtable: Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };

    fn cast(ptr: *const anyopaque) *const BaggageEgress {
        return @ptrCast(@alignCast(ptr));
    }

    /// Rebuilds the baggage from the allowed members, keeping their
    /// properties, and injects through the inner propagator. When the
    /// filtered list cannot be allocated, it injects no baggage at all
    /// rather than unfiltered baggage.
    fn inject(ptr: *const anyopaque, ctx: Context, gpa: Allocator, carrier: Carrier) void {
        const e = cast(ptr);
        const bag = ctx.baggage orelse return e.inner.inject(ctx, gpa, carrier);
        if (bag.len() == 0) return e.inner.inject(ctx, gpa, carrier);
        const kept = gpa.alloc(Baggage.Member, bag.len()) catch
            return e.inner.inject(ctx.withBaggage(null), gpa, carrier);
        defer gpa.free(kept);
        var n: usize = 0;
        for (bag.members) |m| {
            if (!e.allow(m.key)) continue;
            kept[n] = m;
            n += 1;
        }
        const filtered: Baggage = .{ .members = kept[0..n] };
        e.inner.inject(ctx.withBaggage(&filtered), gpa, carrier);
    }

    fn extract(ptr: *const anyopaque, ctx: Context, arena: Allocator, carrier: Carrier) Context {
        return cast(ptr).inner.extract(ctx, arena, carrier);
    }

    fn fields(ptr: *const anyopaque) []const []const u8 {
        return cast(ptr).inner.fields();
    }
};

const testing = std.testing;

/// A map carrier for tests. It copies keys and values, and holds several
/// values per key when `multi` is set, like an HTTP header map.
const TestCarrier = struct {
    gpa: Allocator,
    multi: bool = false,
    entries: std.ArrayList(Entry) = .empty,

    const Entry = struct { key: []u8, values: std.ArrayList([]u8) };

    fn deinit(c: *TestCarrier) void {
        for (c.entries.items) |*e| {
            for (e.values.items) |v| c.gpa.free(v);
            e.values.deinit(c.gpa);
            c.gpa.free(e.key);
        }
        c.entries.deinit(c.gpa);
    }

    fn find(c: *TestCarrier, key: []const u8) ?*Entry {
        for (c.entries.items) |*e| {
            if (std.mem.eql(u8, e.key, key)) return e;
        }
        return null;
    }

    /// Appends a value for `key`.
    fn add(c: *TestCarrier, key: []const u8, value: []const u8) !void {
        const e = c.find(key) orelse blk: {
            try c.entries.append(c.gpa, .{ .key = try c.gpa.dupe(u8, key), .values = .empty });
            break :blk &c.entries.items[c.entries.items.len - 1];
        };
        try e.values.append(c.gpa, try c.gpa.dupe(u8, value));
    }

    fn first(c: *TestCarrier, key: []const u8) ?[]const u8 {
        const e = c.find(key) orelse return null;
        if (e.values.items.len == 0) return null;
        return e.values.items[0];
    }

    fn count(c: *TestCarrier) usize {
        return c.entries.items.len;
    }

    fn carrier(c: *TestCarrier) Carrier {
        return .{ .ptr = c, .vtable = if (c.multi) &multi_vtable else &single_vtable };
    }

    const single_vtable: Carrier.VTable = .{ .get = getFn, .set = setFn };
    const multi_vtable: Carrier.VTable = .{ .get = getFn, .set = setFn, .valueAt = valueAtFn };

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const c: *TestCarrier = @ptrCast(@alignCast(ptr));
        return c.first(key);
    }

    fn setFn(ptr: *anyopaque, key: []const u8, v: []const u8) void {
        const c: *TestCarrier = @ptrCast(@alignCast(ptr));
        if (c.find(key)) |e| {
            for (e.values.items) |old| c.gpa.free(old);
            e.values.clearRetainingCapacity();
        }
        // A failed copy leaves the key without a value, which the test sees.
        c.add(key, v) catch {};
    }

    fn valueAtFn(ptr: *anyopaque, key: []const u8, index: usize) ?[]const u8 {
        const c: *TestCarrier = @ptrCast(@alignCast(ptr));
        const e = c.find(key) orelse return null;
        if (index >= e.values.items.len) return null;
        return e.values.items[index];
    }
};

const trace_id_hex = "4bf92f3577b34da6a3ce929d0e0e4736";
const span_id_hex = "00f067aa0ba902b7";

fn testSpanContext(flags: u8) ids.SpanContext {
    return .{
        .trace_id = ids.TraceId.parseHex(trace_id_hex).?,
        .span_id = ids.SpanId.parseHex(span_id_hex).?,
        .flags = .fromByte(flags),
        .remote = true,
    };
}

test "TraceContext extracts the Go valid traceparents as remote span contexts" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_]struct { tp: []const u8, ts: ?[]const u8 = null, flags: u8, want_ts: []const u8 = "" }{
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00", .flags = 0 },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01", .flags = 1 },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-02", .flags = 2 },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-03", .flags = 3 },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00", .ts = "key1=value1,key2=value2", .flags = 0, .want_ts = "key1=value1,key2=value2" },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00", .ts = "key1=value1 , key2=value2", .flags = 0, .want_ts = "key1=value1,key2=value2" },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00", .ts = "invalid$@#=invalid", .flags = 0 },
        .{ .tp = "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00", .flags = 0 },
        .{ .tp = "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01", .flags = 1 },
        .{ .tp = "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-09", .flags = 1 },
        .{ .tp = "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-08", .flags = 0 },
        .{ .tp = "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00-XYZxsf09", .flags = 0 },
        .{ .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00-", .flags = 0 },
        .{ .tp = "03-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00-", .flags = 0 },
    };
    for (cases) |c| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator };
        defer carrier.deinit();
        try carrier.add("traceparent", c.tp);
        if (c.ts) |ts| try carrier.add("tracestate", ts);
        const ctx = TraceContext.propagator.extract(.background, arena.allocator(), carrier.carrier());
        var want = testSpanContext(c.flags);
        want.trace_state = .{ .header = c.want_ts };
        try testing.expect(ctx.span_context.eql(want));
        try testing.expectEqual(null, ctx.span);
    }
}

test "TraceContext extract does not borrow the carrier's trace state" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var carrier: TestCarrier = .{ .gpa = testing.allocator };
    defer carrier.deinit();
    try carrier.add("traceparent", "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01");
    try carrier.add("tracestate", "a=1,b=2");
    const ctx = TraceContext.propagator.extract(.background, arena.allocator(), carrier.carrier());
    const held = carrier.first("tracestate").?;
    try testing.expect(held.ptr != ctx.span_context.trace_state.header.ptr);
    try testing.expectEqualStrings("a=1,b=2", ctx.span_context.trace_state.header);
}

test "TraceContext extract returns the context unchanged for the Go invalid traceparents" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_][]const u8{
        "",
        "0000-00000000000000000000000000000000-0000000000000000-01",
        "00-ab00000000000000000000000000000000-cd00000000000000-01",
        "00-ab000000000000000000000000000000-cd0000000000000000-01",
        "00-ab000000000000000000000000000000-cd00000000000000-0100",
        "qw-00000000000000000000000000000000-0000000000000000-01",
        "00-qw000000000000000000000000000000-cd00000000000000-01",
        "00-ab000000000000000000000000000000-qw00000000000000-01",
        "00-ab000000000000000000000000000000-cd00000000000000-qw",
        "A0-00000000000000000000000000000000-0000000000000000-01",
        "00-AB000000000000000000000000000000-cd00000000000000-01",
        "00-ab000000000000000000000000000000-CD00000000000000-01",
        "00-ab000000000000000000000000000000-cd00000000000000-A1",
        "00-00000000000000000000000000000000-0000000000000000-01",
        "00-" ++ trace_id_hex ++ "-0000000000000000-01",
        "00-00000000000000000000000000000000-" ++ span_id_hex ++ "-01",
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex,
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-",
        "00-ab000000000000000000000000000000-cd00000000000000-09",
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01-extra",
        "ff-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01",
    };
    var prior = testSpanContext(1);
    prior.span_id = ids.SpanId.parseHex("53995c3f42cd8ad8").?;
    const base = Context.background.withSpanContext(prior);
    for (cases) |tp| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator };
        defer carrier.deinit();
        try carrier.add("traceparent", tp);
        try carrier.add("tracestate", "a=1");
        const ctx = TraceContext.propagator.extract(base, arena.allocator(), carrier.carrier());
        try testing.expect(ctx.span_context.eql(prior));
    }
    var none: TestCarrier = .{ .gpa = testing.allocator };
    defer none.deinit();
    try testing.expect(TraceContext.propagator.extract(base, arena.allocator(), none.carrier()).span_context.eql(prior));
}

test "TraceContext inject writes traceparent with only the spec flags, and tracestate" {
    const cases = [_]struct { flags: u8, ts: []const u8 = "", tp: []const u8 }{
        .{ .flags = 0, .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00" },
        .{ .flags = 1, .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01" },
        .{ .flags = 0xff, .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-03" },
        .{ .flags = 2, .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-02" },
        .{ .flags = 0, .ts = "key1=value1,key2=value2", .tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00" },
    };
    for (cases) |c| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator };
        defer carrier.deinit();
        var sc = testSpanContext(c.flags);
        sc.trace_state = .{ .header = c.ts };
        TraceContext.propagator.inject(Context.background.withSpanContext(sc), testing.allocator, carrier.carrier());
        try testing.expectEqualStrings(c.tp, carrier.first("traceparent").?);
        if (c.ts.len > 0) {
            try testing.expectEqualStrings(c.ts, carrier.first("tracestate").?);
        } else {
            try testing.expectEqual(null, carrier.first("tracestate"));
        }
    }
    var empty: TestCarrier = .{ .gpa = testing.allocator };
    defer empty.deinit();
    TraceContext.propagator.inject(.background, testing.allocator, empty.carrier());
    try testing.expectEqual(@as(usize, 0), empty.count());
}

fn expectFields(want: []const []const u8, got: []const []const u8) !void {
    try testing.expectEqual(want.len, got.len);
    for (want, got) |w, g| try testing.expectEqualStrings(w, g);
}

test "fields of each propagator and of the default composite" {
    try expectFields(&[_][]const u8{ "traceparent", "tracestate" }, TraceContext.propagator.fields());
    try expectFields(&[_][]const u8{"baggage"}, BaggagePropagator.propagator.fields());
    try expectFields(&[_][]const u8{ "traceparent", "tracestate", "baggage" }, default().fields());

    const composite: Composite = try .init(testing.allocator, &.{ BaggagePropagator.propagator, TraceContext.propagator, BaggagePropagator.propagator });
    defer composite.deinit(testing.allocator);
    try expectFields(&[_][]const u8{ "baggage", "traceparent", "tracestate" }, composite.propagator().fields());

    const egress: BaggageEgress = .{ .inner = default() };
    try expectFields(default().fields(), egress.propagator().fields());
}

const Bag = struct { key: []const u8, value: []const u8 };

fn expectBaggage(want: []const Bag, got: ?*const Baggage) !void {
    const b = got orelse return testing.expectEqual(@as(usize, 0), want.len);
    try testing.expectEqual(want.len, b.len());
    for (want, b.members) |w, m| {
        try testing.expectEqualStrings(w.key, m.key);
        try testing.expectEqualStrings(w.value, m.value);
    }
}

test "BaggagePropagator extracts a single header as Go does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const cases = [_]struct { header: []const u8, want: []const Bag }{
        .{ .header = "key1=val1,key2=val2", .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .header = "key1 =   val1,  key2 =val2   ", .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .header = "key1=val1,key2=val2;prop=1", .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .header = "key1=val1,key2=val2,a,val3", .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .header = "key1=,key2=val2", .want = &.{ .{ .key = "key1", .value = "" }, .{ .key = "key2", .value = "val2" } } },
        .{ .header = "key1=val%252", .want = &.{.{ .key = "key1", .value = "val%2" }} },
        .{ .header = "", .want = &.{} },
    };
    for (cases) |c| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator };
        defer carrier.deinit();
        try carrier.add("baggage", c.header);
        const ctx = BaggagePropagator.propagator.extract(.background, arena.allocator(), carrier.carrier());
        try expectBaggage(c.want, ctx.baggage);
    }
}

test "BaggagePropagator keeps the existing baggage when the header gives none" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const existing: Baggage = .{ .members = &.{.{ .key = "key1", .value = "val1" }} };
    const base = Context.background.withBaggage(&existing);
    const oversized: [Baggage.max_bytes]u8 = @splat('v');
    for ([_][]const u8{ "header1", "", "key=" ++ oversized }) |header| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator };
        defer carrier.deinit();
        try carrier.add("baggage", header);
        const ctx = BaggagePropagator.propagator.extract(base, arena.allocator(), carrier.carrier());
        try testing.expectEqual(&existing, ctx.baggage.?);
    }
    // A header with members replaces the existing baggage.
    var carrier: TestCarrier = .{ .gpa = testing.allocator };
    defer carrier.deinit();
    try carrier.add("baggage", "key2=val2");
    const ctx = BaggagePropagator.propagator.extract(base, arena.allocator(), carrier.carrier());
    try expectBaggage(&.{.{ .key = "key2", .value = "val2" }}, ctx.baggage);
}

fn fixedWidthHeader(gpa: Allocator, n: usize, prefix: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    for (0..n) |i| {
        if (i > 0) try out.append(gpa, ',');
        try out.print(gpa, "{s}{d:0>2}=v{d:0>2}", .{ prefix, i, i });
    }
    return out.toOwnedSlice(gpa);
}

test "BaggagePropagator combines multiple header values as Go does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const half = Baggage.max_bytes / 2;
    const v_half = try a.alloc(u8, half - 2);
    @memset(v_half, 'v');
    const v_half1 = v_half[0 .. half - 3];
    const v_max = try a.alloc(u8, Baggage.max_bytes - 2);
    @memset(v_max, 'v');
    const k_half = try std.mem.concat(a, u8, &.{ "k=", v_half });
    const y_half1 = try std.mem.concat(a, u8, &.{ "y=", v_half1 });
    const y_half = try std.mem.concat(a, u8, &.{ "y=", v_half });
    const k_max = try std.mem.concat(a, u8, &.{ "k=", v_max });
    const y_max = try std.mem.concat(a, u8, &.{ "y=", v_max });
    const k_over = try std.mem.concat(a, u8, &.{ "k=", v_max, "v" });

    var gen65: std.ArrayList(u8) = .empty;
    for (0..65) |i| {
        if (i > 0) try gen65.append(a, ',');
        try gen65.print(a, "k{d}=v{d}", .{ i, i });
    }
    var want64: [64]Bag = undefined;
    for (&want64, 0..) |*w, i| w.* = .{ .key = try std.fmt.allocPrint(a, "k{d}", .{i}), .value = try std.fmt.allocPrint(a, "v{d}", .{i}) };

    const Case = struct { values: []const []const u8, want: []const Bag };
    const cases = [_]Case{
        .{ .values = &.{ "key1=val1", "key2=val2" }, .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .values = &.{ "key1=val1", "key1=val2" }, .want = &.{.{ .key = "key1", .value = "val2" }} },
        .{ .values = &.{ "", "key1=val1" }, .want = &.{.{ .key = "key1", .value = "val1" }} },
        .{ .values = &.{ "", "" }, .want = &.{} },
        .{ .values = &.{}, .want = &.{} },
        .{ .values = &.{"key1=val1,invalid-no-equals,key2=val2"}, .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .values = &.{ "key1=val1", "invalid-no-equals", "key2=val2" }, .want = &.{ .{ .key = "key1", .value = "val1" }, .{ .key = "key2", .value = "val2" } } },
        .{ .values = &.{gen65.items[0..std.mem.lastIndexOfScalar(u8, gen65.items, ',').?]}, .want = &want64 },
        .{ .values = &.{gen65.items}, .want = &want64 },
        .{ .values = &.{k_max}, .want = &.{.{ .key = "k", .value = v_max }} },
        .{ .values = &.{k_over}, .want = &.{} },
        .{ .values = &.{ k_max, y_max }, .want = &.{} },
        .{ .values = &.{ k_half, y_half1 }, .want = &.{ .{ .key = "k", .value = v_half }, .{ .key = "y", .value = v_half1 } } },
        .{ .values = &.{ k_half, "", "", y_half1 }, .want = &.{} },
        .{ .values = &.{ "", k_half, y_half1 }, .want = &.{} },
        .{ .values = &.{ k_half, y_half }, .want = &.{} },
        .{ .values = &.{ "bad0", "bad1", "good=val" }, .want = &.{.{ .key = "good", .value = "val" }} },
    };
    for (cases) |c| {
        var carrier: TestCarrier = .{ .gpa = testing.allocator, .multi = true };
        defer carrier.deinit();
        for (c.values) |v| try carrier.add("baggage", v);
        const ctx = BaggagePropagator.propagator.extract(.background, a, carrier.carrier());
        try expectBaggage(c.want, ctx.baggage);
    }

    // Three headers of 32, 32 and 1 members keep 64 members.
    var carrier: TestCarrier = .{ .gpa = testing.allocator, .multi = true };
    defer carrier.deinit();
    try carrier.add("baggage", try fixedWidthHeader(a, 32, "a"));
    try carrier.add("baggage", try fixedWidthHeader(a, 32, "b"));
    try carrier.add("baggage", try fixedWidthHeader(a, 1, "c"));
    const ctx = BaggagePropagator.propagator.extract(.background, a, carrier.carrier());
    try testing.expectEqual(@as(usize, 64), ctx.baggage.?.len());

    // 100 headers of 10 members each exceed the byte budget.
    var many: TestCarrier = .{ .gpa = testing.allocator, .multi = true };
    defer many.deinit();
    for (0..100) |i| {
        try many.add("baggage", try fixedWidthHeader(a, 10, try std.fmt.allocPrint(a, "h{d:0>2}_k", .{i})));
    }
    try testing.expectEqual(null, BaggagePropagator.propagator.extract(.background, a, many.carrier()).baggage);
}

test "BaggagePropagator inject writes the encoded baggage" {
    var carrier: TestCarrier = .{ .gpa = testing.allocator };
    defer carrier.deinit();
    const bag: Baggage = .{ .members = &.{
        .{ .key = "key1", .value = "val1" },
        .{ .key = "key2", .value = "val 2", .properties = &.{ .{ .key = "prop", .value = "1" }, .{ .key = "flag" } } },
    } };
    BaggagePropagator.propagator.inject(Context.background.withBaggage(&bag), testing.allocator, carrier.carrier());
    try testing.expectEqualStrings("key1=val1,key2=val%202;prop=1;flag", carrier.first("baggage").?);

    var none: TestCarrier = .{ .gpa = testing.allocator };
    defer none.deinit();
    BaggagePropagator.propagator.inject(Context.background.withBaggage(&Baggage.empty), testing.allocator, none.carrier());
    BaggagePropagator.propagator.inject(.background, testing.allocator, none.carrier());
    try testing.expectEqual(@as(usize, 0), none.count());
}

fn allowKeep(key: []const u8) bool {
    return std.mem.eql(u8, key, "keep");
}

fn allowNone(_: []const u8) bool {
    return false;
}

test "BaggageEgress filters baggage members on inject only" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const bag: Baggage = .{ .members = &.{
        .{ .key = "keep", .value = "1", .properties = &.{.{ .key = "p", .value = "x" }} },
        .{ .key = "drop", .value = "2" },
    } };
    const egress: BaggageEgress = .{ .inner = default(), .allow = allowKeep };
    const prop = egress.propagator();
    const sc = testSpanContext(1);
    const ctx = Context.background.withSpanContext(sc).withBaggage(&bag);

    var out: TestCarrier = .{ .gpa = testing.allocator };
    defer out.deinit();
    prop.inject(ctx, testing.allocator, out.carrier());
    try testing.expectEqualStrings("keep=1;p=x", out.first("baggage").?);
    try testing.expectEqualStrings("00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01", out.first("traceparent").?);

    // Extract is not filtered.
    var in: TestCarrier = .{ .gpa = testing.allocator };
    defer in.deinit();
    try in.add("baggage", "keep=1,drop=2");
    try expectBaggage(&.{ .{ .key = "keep", .value = "1" }, .{ .key = "drop", .value = "2" } }, prop.extract(.background, arena.allocator(), in.carrier()).baggage);

    // A predicate that rejects everything sends no baggage header.
    const none: BaggageEgress = .{ .inner = BaggagePropagator.propagator, .allow = allowNone };
    var empty: TestCarrier = .{ .gpa = testing.allocator };
    defer empty.deinit();
    none.propagator().inject(ctx, testing.allocator, empty.carrier());
    try testing.expectEqual(@as(usize, 0), empty.count());

    // The default predicate allows every key.
    const all: BaggageEgress = .{ .inner = BaggagePropagator.propagator };
    var every: TestCarrier = .{ .gpa = testing.allocator };
    defer every.deinit();
    all.propagator().inject(ctx, testing.allocator, every.carrier());
    try testing.expectEqualStrings("keep=1;p=x,drop=2", every.first("baggage").?);
}

test "BaggageEgress injects no baggage when filtering cannot allocate" {
    const bag: Baggage = .{ .members = &.{ .{ .key = "keep", .value = "1" }, .{ .key = "drop", .value = "2" } } };
    const egress: BaggageEgress = .{ .inner = BaggagePropagator.propagator, .allow = allowKeep };
    var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = 0 });
    var out: TestCarrier = .{ .gpa = testing.allocator };
    defer out.deinit();
    egress.propagator().inject(Context.background.withBaggage(&bag), failing.allocator(), out.carrier());
    try testing.expectEqual(@as(usize, 0), out.count());
}

test "extract into a context then inject gives the same headers" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const tp = "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01";
    var in: TestCarrier = .{ .gpa = testing.allocator };
    defer in.deinit();
    try in.add("traceparent", tp);
    try in.add("tracestate", "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE");
    try in.add("baggage", "userId=alice,serverNode=DF%2028;p=1,isProduction=false");

    const prop = default();
    const ctx = prop.extract(.background, arena.allocator(), in.carrier());
    try testing.expect(ctx.span_context.remote);

    var out: TestCarrier = .{ .gpa = testing.allocator };
    defer out.deinit();
    prop.inject(ctx, testing.allocator, out.carrier());
    try testing.expectEqualStrings(tp, out.first("traceparent").?);
    try testing.expectEqualStrings("rojo=00f067aa0ba902b7,congo=t61rcWkgMzE", out.first("tracestate").?);
    try testing.expectEqualStrings("userId=alice,serverNode=DF%2028;p=1,isProduction=false", out.first("baggage").?);
}

test "extract drops only the part whose allocation failed" {
    var in: TestCarrier = .{ .gpa = testing.allocator };
    defer in.deinit();
    try in.add("traceparent", "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01");
    try in.add("tracestate", "a=1");
    try in.add("baggage", "k=v");
    var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = 0 });
    const ctx = default().extract(.background, failing.allocator(), in.carrier());
    try testing.expect(ctx.span_context.eql(testSpanContext(1)));
    try testing.expectEqual(null, ctx.baggage);

    // With one allocation allowed, the trace state survives and baggage fails.
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var one: std.testing.FailingAllocator = .init(arena.allocator(), .{ .fail_index = 1 });
    const ctx2 = default().extract(.background, one.allocator(), in.carrier());
    try testing.expectEqualStrings("a=1", ctx2.span_context.trace_state.header);
    try testing.expectEqual(null, ctx2.baggage);
}

test "Composite injects and extracts in order" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const composite: Composite = try .init(testing.allocator, &.{ TraceContext.propagator, BaggagePropagator.propagator });
    defer composite.deinit(testing.allocator);
    var in: TestCarrier = .{ .gpa = testing.allocator };
    defer in.deinit();
    try in.add("traceparent", "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01");
    try in.add("baggage", "k=v");
    const ctx = composite.propagator().extract(.background, arena.allocator(), in.carrier());
    try testing.expect(ctx.span_context.isValid());
    try expectBaggage(&.{.{ .key = "k", .value = "v" }}, ctx.baggage);
}

test "parseTraceparent and formatTraceparent round-trip" {
    const sc = TraceContext.parseTraceparent("00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01").?;
    try testing.expect(sc.remote and sc.isSampled());
    try testing.expectEqualStrings("00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01", &TraceContext.formatTraceparent(sc));
    try testing.expectEqual(null, TraceContext.parseTraceparent("garbage"));
}

fn fuzzTraceparent(_: void, smith: *testing.Smith) anyerror!void {
    var buf: [256]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];
    const sc = TraceContext.parseTraceparent(input) orelse return;
    try testing.expect(sc.isValid() and sc.remote);
    try testing.expect(sc.flags.toByte() <= 0x03);
    // The formatted form parses back to the same span context, and a
    // version 00 input of the exact length is already in that form. Go also
    // accepts version 00 with a trailing dash, which formatting drops.
    const text = TraceContext.formatTraceparent(sc);
    const again = TraceContext.parseTraceparent(&text) orelse return error.TestUnexpectedResult;
    try testing.expect(sc.eql(again));
    if (input.len == text.len and std.mem.startsWith(u8, input, "00-")) try testing.expectEqualStrings(input, &text);

    // Extract into a context and inject it again.
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var in: TestCarrier = .{ .gpa = testing.allocator };
    defer in.deinit();
    try in.add("traceparent", input);
    const ctx = TraceContext.propagator.extract(.background, arena.allocator(), in.carrier());
    var out: TestCarrier = .{ .gpa = testing.allocator };
    defer out.deinit();
    TraceContext.propagator.inject(ctx, testing.allocator, out.carrier());
    try testing.expectEqualStrings(&text, out.first("traceparent").?);
}

test "fuzz the traceparent parser" {
    try testing.fuzz({}, fuzzTraceparent, .{ .corpus = &.{
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01",
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-00-",
        "02-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-09-XYZxsf09",
        "ff-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01",
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex ++ "-01-extra",
        "00-00000000000000000000000000000000-0000000000000000-01",
        "00-AB000000000000000000000000000000-cd00000000000000-01",
        "00-" ++ trace_id_hex ++ "-" ++ span_id_hex,
    } });
}
