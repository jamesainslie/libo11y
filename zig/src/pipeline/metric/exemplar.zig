//! Exemplars: the filter that decides which measurements are offered, and
//! the two reservoirs that keep a sample of them, ported from OTel Go
//! (sdk/metric/exemplar).
//!
//! A reservoir is not thread-safe: its stream calls it under the stream's
//! lock, with the stream's random source.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const ids = @import("../ids.zig");
const data = @import("data.zig");
const Number = data.Number;

/// Which measurements are offered to a reservoir.
pub const Filter = enum {
    /// Measurements made in a context with a sampled span. The default.
    trace_based,
    /// Every measurement.
    always_on,
    /// None: no stream keeps exemplars.
    always_off,

    /// Reports whether a measurement made in `ctx` is offered.
    pub fn allows(f: Filter, ctx: Context) bool {
        return switch (f) {
            .trace_based => ctx.span_context.isSampled(),
            .always_on => true,
            .always_off => false,
        };
    }
};

/// Reads `OTEL_METRICS_EXEMPLAR_FILTER`, trimmed and compared without
/// case: `trace_based`, `always_on` or `always_off`. Unset and any other
/// value return null, which keeps the default, as sdk/metric config.go
/// does.
pub fn filterFromEnv(env: anytype) ?Filter {
    const raw = env.get("OTEL_METRICS_EXEMPLAR_FILTER") orelse return null;
    const value = std.mem.trim(u8, raw, " \t\r\n\x0b\x0c");
    if (std.ascii.eqlIgnoreCase(value, "trace_based")) return .trace_based;
    if (std.ascii.eqlIgnoreCase(value, "always_on")) return .always_on;
    if (std.ascii.eqlIgnoreCase(value, "always_off")) return .always_off;
    return null;
}

/// Which reservoir a stream uses.
pub const Spec = union(enum) {
    /// No exemplars.
    none,
    /// `SimpleFixedSizeExemplarReservoir` with this many slots.
    fixed: usize,
    /// `AlignedHistogramBucketExemplarReservoir`, one slot per bucket of
    /// these sorted bounds.
    aligned_histogram: []const f64,
};

/// The reservoir defaults of the OpenTelemetry specification, as Go's
/// `DefaultExemplarReservoirProviderSelector` applies them: an aligned
/// histogram reservoir for an explicit-bucket histogram with at least one
/// bound, and otherwise a fixed-size reservoir with one slot per CPU.
pub fn defaultSpec(histogram_bounds: ?[]const f64, cpu_count: usize) Spec {
    if (histogram_bounds) |bounds| if (bounds.len > 0) return .{ .aligned_histogram = bounds };
    return .{ .fixed = @max(cpu_count, 1) };
}

/// Picks the next measurement to keep with Algorithm L (Li 1994), as Go's
/// `nextTracker` does.
const NextTracker = struct {
    count: i64 = 0,
    next: i64 = 0,
    w: f64 = 0,
    k: usize,

    fn reset(t: *NextTracker, rng: std.Random) void {
        t.count = 0;
        if (t.k == 0) return;
        // advance adds at least one, so the first replacement comes after
        // the storage is full.
        t.next = @as(i64, @intCast(t.k)) - 1;
        t.w = @exp(@log(unitOpen(rng)) / kFloat(t.k));
        t.advance(rng);
    }

    fn advance(t: *NextTracker, rng: std.Random) void {
        var step = @log(unitOpen(rng)) / @log(1 - t.w);
        // Mathematically step is positive and finite. Guard the float to
        // int conversion against w rounding to 0 or 1.
        if (!(step >= 0) or step > 9.0e18) step = 9.0e18;
        t.next +|= @as(i64, @intFromFloat(step)) + 1;
        t.w *= @exp(@log(unitOpen(rng)) / kFloat(t.k));
    }

    /// Returns the slot to store the measurement in, or null to skip it.
    fn shouldSample(t: *NextTracker, rng: std.Random) ?usize {
        if (t.k == 0) return null;
        if (t.count < @as(i64, @intCast(t.k))) {
            const idx: usize = @intCast(t.count);
            t.count += 1;
            return idx;
        }
        if (t.count == t.next) {
            const idx = if (t.k > 1) rng.uintLessThan(usize, t.k) else 0;
            t.advance(rng);
            t.count += 1;
            return idx;
        }
        t.count += 1;
        return null;
    }

    fn kFloat(k: usize) f64 {
        return @floatFromInt(k);
    }
};

/// A uniform random value in (0, 1).
fn unitOpen(rng: std.Random) f64 {
    while (true) {
        const f = rng.float(f64);
        if (f != 0) return f;
    }
}

/// One kept measurement. Its filtered attributes live in its own arena,
/// which is reset each time the slot is overwritten.
const Slot = struct {
    valid: bool = false,
    time_unix_nano: u64 = 0,
    value: Number = .{ .int = 0 },
    trace_id: ids.TraceId = .invalid,
    span_id: ids.SpanId = .invalid,
    filtered: []const KeyValue = &.{},
    arena: std.heap.ArenaAllocator.State = .init,

    fn store(s: *Slot, gpa: Allocator, sc: ids.SpanContext, time: u64, value: Number, filtered: []const KeyValue) void {
        var arena = s.arena.promote(gpa);
        defer s.arena = arena.state;
        _ = arena.reset(.retain_capacity);
        s.filtered = copyAttributes(arena.allocator(), filtered) catch &.{};
        s.time_unix_nano = time;
        s.value = value;
        s.trace_id = sc.trace_id;
        s.span_id = sc.span_id;
        s.valid = true;
    }

    fn deinit(s: *Slot, gpa: Allocator) void {
        s.arena.promote(gpa).deinit();
    }
};

fn copyAttributes(arena: Allocator, attrs: []const KeyValue) Allocator.Error![]const KeyValue {
    if (attrs.len == 0) return &.{};
    const out = try arena.alloc(KeyValue, attrs.len);
    for (out, attrs) |*o, a| o.* = try a.dupe(arena, null);
    return out;
}

/// A reservoir of one series. Kept exemplars survive a collection, but
/// the sampling restarts after it, so newer measurements are preferred,
/// as in Go.
pub const Reservoir = struct {
    slots: []Slot,
    /// One tracker for a fixed-size reservoir, one per bucket for an
    /// aligned histogram reservoir.
    trackers: []NextTracker,
    /// The histogram bounds; empty for a fixed-size reservoir.
    bounds: []const f64,
    /// Whether this is an aligned histogram reservoir.
    aligned: bool,

    /// Creates the reservoir `spec` describes. `spec` must not be `.none`.
    /// The bounds are borrowed and must outlive the reservoir.
    pub fn init(gpa: Allocator, spec: Spec, rng: std.Random) Allocator.Error!Reservoir {
        const slot_count: usize, const tracker_count: usize, const bounds: []const f64 = switch (spec) {
            .none => .{ 0, 0, &.{} },
            .fixed => |k| .{ k, 1, &.{} },
            .aligned_histogram => |b| .{ b.len + 1, b.len + 1, b },
        };
        const slots = try gpa.alloc(Slot, slot_count);
        errdefer gpa.free(slots);
        @memset(slots, .{});
        const trackers = try gpa.alloc(NextTracker, tracker_count);
        const aligned = spec == .aligned_histogram;
        for (trackers) |*t| {
            t.* = .{ .k = if (aligned) 1 else slot_count };
            t.reset(rng);
        }
        return .{ .slots = slots, .trackers = trackers, .bounds = bounds, .aligned = aligned };
    }

    pub fn deinit(r: *Reservoir, gpa: Allocator) void {
        for (r.slots) |*s| s.deinit(gpa);
        gpa.free(r.slots);
        gpa.free(r.trackers);
        r.* = undefined;
    }

    /// Offers one measurement and its filtered attributes, which are
    /// copied only when the measurement is kept.
    pub fn offer(r: *Reservoir, gpa: Allocator, rng: std.Random, sc: ids.SpanContext, time: u64, value: Number, filtered: []const KeyValue) void {
        if (r.slots.len == 0) return;
        if (r.aligned) {
            const i = bucketIndex(r.bounds, value.toDouble());
            if (r.trackers[i].shouldSample(rng) != null) r.slots[i].store(gpa, sc, time, value, filtered);
            return;
        }
        if (r.trackers[0].shouldSample(rng)) |i| r.slots[i].store(gpa, sc, time, value, filtered);
    }

    /// Copies the kept exemplars into `arena` and restarts the sampling.
    pub fn collect(r: *Reservoir, arena: Allocator, rng: std.Random) Allocator.Error![]const data.Exemplar {
        var out: std.ArrayList(data.Exemplar) = .empty;
        for (r.slots) |*s| {
            if (!s.valid) continue;
            try out.append(arena, .{
                .filtered_attributes = try copyAttributes(arena, s.filtered),
                .time_unix_nano = s.time_unix_nano,
                .value = s.value,
                .trace_id = s.trace_id,
                .span_id = s.span_id,
            });
        }
        for (r.trackers) |*t| t.reset(rng);
        return out.items;
    }

    /// Forgets every kept exemplar.
    pub fn clear(r: *Reservoir) void {
        for (r.slots) |*s| s.valid = false;
    }
};

/// The index of the bucket `value` falls in: the first bound at or above
/// it, or the last bucket. NaN falls in the last bucket, as Go's
/// `sort.SearchFloat64s` puts it.
pub fn bucketIndex(bounds: []const f64, value: f64) usize {
    return std.sort.partitionPoint(f64, bounds, value, struct {
        fn below(v: f64, bound: f64) bool {
            return !(bound >= v);
        }
    }.below);
}

const testing = std.testing;

fn testRng(seed: u64) std.Random.DefaultPrng {
    return .init(seed);
}

const sampled: ids.SpanContext = .{
    .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
    .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
    .flags = .sampled_flag,
};

test "the filters follow the span context" {
    const ctx: Context = Context.background.withSpanContext(sampled);
    var unsampled = sampled;
    unsampled.flags = .{};
    try testing.expect(Filter.trace_based.allows(ctx));
    try testing.expect(!Filter.trace_based.allows(.background));
    try testing.expect(!Filter.trace_based.allows(Context.background.withSpanContext(unsampled)));
    try testing.expect(Filter.always_on.allows(.background));
    try testing.expect(!Filter.always_off.allows(ctx));
}

test "the exemplar filter variable is trimmed and case-insensitive" {
    const Env = @import("instrument.zig").TestEnv;
    const key = "OTEL_METRICS_EXEMPLAR_FILTER";
    try testing.expectEqual(Filter.always_on, filterFromEnv(Env{ .pairs = &.{.{ key, " ALWAYS_ON " }} }).?);
    try testing.expectEqual(Filter.always_off, filterFromEnv(Env{ .pairs = &.{.{ key, "always_off" }} }).?);
    try testing.expectEqual(Filter.trace_based, filterFromEnv(Env{ .pairs = &.{.{ key, "Trace_Based" }} }).?);
    try testing.expectEqual(null, filterFromEnv(Env{ .pairs = &.{.{ key, "sometimes" }} }));
    try testing.expectEqual(null, filterFromEnv(Env{ .pairs = &.{} }));
}

test "bucketIndex puts a bound in its own bucket and NaN last" {
    const bounds = [_]f64{ 0, 5, 10 };
    try testing.expectEqual(@as(usize, 0), bucketIndex(&bounds, -1));
    try testing.expectEqual(@as(usize, 0), bucketIndex(&bounds, 0));
    try testing.expectEqual(@as(usize, 1), bucketIndex(&bounds, 0.5));
    try testing.expectEqual(@as(usize, 1), bucketIndex(&bounds, 5));
    try testing.expectEqual(@as(usize, 3), bucketIndex(&bounds, 11));
    try testing.expectEqual(@as(usize, 3), bucketIndex(&bounds, std.math.nan(f64)));
    try testing.expectEqual(@as(usize, 0), bucketIndex(&.{}, 3));
}

test "a fixed-size reservoir keeps the first k measurements, then samples" {
    var prng = testRng(1);
    const rng = prng.random();
    var r: Reservoir = try .init(testing.allocator, .{ .fixed = 2 }, rng);
    defer r.deinit(testing.allocator);
    r.offer(testing.allocator, rng, sampled, 10, .{ .int = 1 }, &.{attribute.kv("user", "a")});
    r.offer(testing.allocator, rng, .invalid, 11, .{ .int = 2 }, &.{});
    for (0..1000) |i| r.offer(testing.allocator, rng, sampled, 12 + i, .{ .int = 3 }, &.{attribute.kv("user", "b")});

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const got = try r.collect(arena.allocator(), rng);
    try testing.expectEqual(@as(usize, 2), got.len);
    // Algorithm L replaces kept measurements as more arrive.
    var replaced: usize = 0;
    for (got) |e| {
        if (e.value.int == 3) {
            replaced += 1;
            try testing.expectEqualStrings("b", e.filtered_attributes[0].value.string);
            try testing.expectEqualSlices(u8, &sampled.trace_id.bytes, &e.trace_id.bytes);
        }
    }
    try testing.expect(replaced > 0);

    // The kept exemplars survive a collection.
    const again = try r.collect(arena.allocator(), rng);
    try testing.expectEqual(@as(usize, 2), again.len);
    r.clear();
    try testing.expectEqual(@as(usize, 0), (try r.collect(arena.allocator(), rng)).len);
}

test "an aligned histogram reservoir keeps one measurement per bucket" {
    var prng = testRng(2);
    const rng = prng.random();
    const bounds = [_]f64{ 1, 10 };
    var r: Reservoir = try .init(testing.allocator, .{ .aligned_histogram = &bounds }, rng);
    defer r.deinit(testing.allocator);
    r.offer(testing.allocator, rng, sampled, 1, .{ .double = 0.5 }, &.{});
    r.offer(testing.allocator, rng, sampled, 2, .{ .double = 50 }, &.{});
    r.offer(testing.allocator, rng, sampled, 3, .{ .double = 60 }, &.{});

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const got = try r.collect(arena.allocator(), rng);
    try testing.expectEqual(@as(usize, 2), got.len);
    try testing.expectEqual(@as(f64, 0.5), got[0].value.double);
    try testing.expect(got[1].value.double >= 50);
}

test "defaultSpec follows the specification defaults" {
    const bounds = [_]f64{ 0, 5 };
    try testing.expectEqual(@as(usize, 2), defaultSpec(&bounds, 8).aligned_histogram.len);
    try testing.expectEqual(@as(usize, 8), defaultSpec(&.{}, 8).fixed);
    try testing.expectEqual(@as(usize, 4), defaultSpec(null, 4).fixed);
    try testing.expectEqual(@as(usize, 1), defaultSpec(null, 0).fixed);
}
