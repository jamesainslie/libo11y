//! A stream: one instrument's measurements aggregated for one reader
//! under one view, as OTel Go's internal/aggregate package keeps them.
//!
//! A stream holds one series per canonical attribute set, up to its
//! cardinality limit. A measurement for a new set once the stream holds
//! `limit - 1` sets goes to the overflow series, whose only attribute is
//! `otel.metric.overflow=true`, so a stream never exceeds `limit` series
//! (sdk/metric/internal/aggregate/limit.go).
//!
//! Synchronous instruments accumulate across measurements. Delta streams
//! forget every series at each collection; cumulative streams keep them.
//! Observable instruments are precomputed: a collection reports only the
//! sets observed since the previous one, and a delta sum reports the
//! change since the value it last reported.
//!
//! Every call takes the stream's lock, so recording from many threads
//! during a collection is safe.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const ids = @import("../ids.zig");
const span_mod = @import("../span.zig");
const attrset = @import("attrset.zig");
const data = @import("data.zig");
const exemplar = @import("exemplar.zig");
const instrument = @import("instrument.zig");
const InstrumentKind = instrument.InstrumentKind;
const Temporality = instrument.Temporality;

/// The attributes of the overflow series.
pub const overflow_attributes = [_]KeyValue{attribute.kv("otel.metric.overflow", true)};

/// A stream's aggregation, resolved from its view and instrument kind.
pub const Aggregation = union(enum) {
    sum: struct { monotonic: bool },
    last_value,
    histogram: struct {
        bounds: []const f64,
        record_min_max: bool = true,
        record_sum: bool = true,
    },
};

/// What `Stream.create` builds. It copies every string and slice.
pub const Config = struct {
    name: []const u8,
    description: []const u8 = "",
    unit: []const u8 = "",
    kind: InstrumentKind,
    aggregation: Aggregation,
    temporality: Temporality = .cumulative,
    /// Keep only these keys on the stream; null keeps every key.
    attribute_keys: ?[]const []const u8 = null,
    /// The most series the stream holds, the overflow series included.
    /// Zero means no limit.
    cardinality_limit: usize = 2000,
    filter: exemplar.Filter = .trace_based,
    /// The size of a fixed-size exemplar reservoir.
    reservoir_size: usize = 1,
    /// The reader the stream belongs to.
    pipeline: usize = 0,
};

/// A type-erased stream, for the reader's collection.
pub const AnyStream = struct {
    ptr: *anyopaque,
    /// The meter that owns the instrument, which groups the stream's
    /// metric under its scope.
    owner: *const anyopaque,
    collectFn: *const fn (ptr: *anyopaque, arena: Allocator, now: u64) Allocator.Error!?data.Metric,

    /// Collects the stream's points into `arena`. Returns null when the
    /// stream has no points.
    pub fn collect(s: AnyStream, arena: Allocator, now: u64) Allocator.Error!?data.Metric {
        return s.collectFn(s.ptr, arena, now);
    }
};

/// A stream of `N` measurements, `i64` or `f64`.
pub fn Stream(comptime N: type) type {
    return struct {
        const Self = @This();

        const Map = std.array_hash_map.Custom([]const KeyValue, *Series, attrset.MapContext, true);

        const Series = struct {
            /// Owns the series and its attributes.
            arena: std.heap.ArenaAllocator.State,
            attrs: []const KeyValue,
            /// The sum, the last value, or the histogram's sum.
            value: N = 0,
            /// The value a precomputed delta sum reported last.
            reported: N = 0,
            /// Whether a precomputed series was observed this cycle.
            observed: bool = false,
            counts: []u64 = &.{},
            count: u64 = 0,
            min: N = 0,
            max: N = 0,
            reservoir: ?exemplar.Reservoir = null,
        };

        gpa: Allocator,
        io: Io,
        /// Owns the configuration's strings and bounds.
        config_arena: std.heap.ArenaAllocator,
        config: Config,
        precomputed: bool,
        reservoir_spec: exemplar.Spec,
        mutex: Io.Mutex = .init,
        series: Map = .empty,
        /// Precomputed series observed this cycle.
        active: usize = 0,
        start_time: u64,
        prng: std.Random.DefaultPrng,

        /// Creates a stream. `start_time` is the start of its first
        /// interval, in Unix nanoseconds.
        pub fn create(gpa: Allocator, io: Io, config: Config, start_time: u64) Allocator.Error!*Self {
            const s = try gpa.create(Self);
            errdefer gpa.destroy(s);
            var config_arena: std.heap.ArenaAllocator = .init(gpa);
            errdefer config_arena.deinit();
            const a = config_arena.allocator();
            var copy = config;
            copy.name = try a.dupe(u8, config.name);
            copy.description = try a.dupe(u8, config.description);
            copy.unit = try a.dupe(u8, config.unit);
            if (config.attribute_keys) |keys| {
                const out = try a.alloc([]const u8, keys.len);
                for (out, keys) |*o, k| o.* = try a.dupe(u8, k);
                copy.attribute_keys = out;
            }
            var hist_bounds: ?[]const f64 = null;
            switch (config.aggregation) {
                .histogram => |h| {
                    copy.aggregation.histogram.bounds = try a.dupe(f64, h.bounds);
                    hist_bounds = copy.aggregation.histogram.bounds;
                },
                .sum, .last_value => {},
            }
            // Observable sum and last-value streams are precomputed: each
            // collection reports only the sets observed since the last one.
            // Histograms accumulate observations across collections (or
            // reset in delta mode) even on observable instruments, as in
            // OTel Go's pipeline.go.
            const precomputed = config.kind.isObservable() and config.aggregation != .histogram;
            // As in Go, no reservoir under always-off, and none for an
            // observable instrument under trace-based, whose callbacks
            // have no span context.
            const spec: exemplar.Spec = if (config.filter == .always_off or (config.kind.isObservable() and config.filter == .trace_based))
                .none
            else
                exemplar.defaultSpec(hist_bounds, config.reservoir_size);
            var seed: [8]u8 = undefined;
            io.random(&seed);
            s.* = .{
                .gpa = gpa,
                .io = io,
                .config_arena = config_arena,
                .config = copy,
                .precomputed = precomputed,
                .reservoir_spec = spec,
                .start_time = start_time,
                .prng = .init(std.mem.readInt(u64, &seed, .little)),
            };
            return s;
        }

        /// Frees the stream and every series.
        pub fn destroy(s: *Self) void {
            for (s.series.values()) |series| s.destroySeries(series);
            s.series.deinit(s.gpa);
            s.config_arena.deinit();
            s.gpa.destroy(s);
        }

        /// The type-erased stream.
        pub fn any(s: *Self, owner: *const anyopaque) AnyStream {
            return .{ .ptr = s, .owner = owner, .collectFn = collectErased };
        }

        /// The stream's name.
        pub fn name(s: *const Self) []const u8 {
            return s.config.name;
        }

        /// Aggregates one measurement. `attrs` must be canonical and
        /// classified; the stream copies what it keeps. `scratch` holds
        /// temporary lists for the call. Never fails: a measurement it
        /// cannot store is dropped.
        pub fn record(s: *Self, ctx: Context, value: N, attrs: []const KeyValue, scratch: Allocator) void {
            var kept = attrs;
            var dropped: []const KeyValue = &.{};
            if (s.config.attribute_keys) |keys| {
                const parts = attrset.partition(scratch, attrs, keys) catch return;
                kept = parts.kept;
                dropped = parts.dropped;
            }
            const offer = s.reservoir_spec != .none and s.config.filter.allows(ctx);
            const time = if (offer) span_mod.nowUnixNano(s.io) else 0;

            s.mutex.lockUncancelable(s.io);
            defer s.mutex.unlock(s.io);
            const series = s.seriesFor(kept) orelse return;
            if (s.precomputed and !series.observed) {
                series.observed = true;
                s.active += 1;
            }
            s.update(series, value);
            if (offer) s.offerExemplar(series, ctx.span_context, time, value, dropped);
        }

        fn update(s: *Self, series: *Series, value: N) void {
            switch (s.config.aggregation) {
                .sum => series.value = add(series.value, value),
                .last_value => series.value = value,
                .histogram => |h| {
                    const v: f64 = toDouble(value);
                    const i = exemplar.bucketIndex(h.bounds, v);
                    series.counts[i] +%= 1;
                    if (series.count == 0) {
                        series.min = value;
                        series.max = value;
                    } else {
                        if (value < series.min) series.min = value;
                        if (value > series.max) series.max = value;
                    }
                    series.count +%= 1;
                    if (h.record_sum) series.value = add(series.value, value);
                },
            }
        }

        fn offerExemplar(s: *Self, series: *Series, sc: ids.SpanContext, time: u64, value: N, dropped: []const KeyValue) void {
            if (series.reservoir == null) {
                series.reservoir = exemplar.Reservoir.init(s.gpa, s.reservoir_spec, s.prng.random()) catch return;
            }
            series.reservoir.?.offer(s.gpa, s.prng.random(), sc, time, .of(N, value), dropped);
        }

        fn liveCount(s: *const Self) usize {
            return if (s.precomputed) s.active else s.series.count();
        }

        fn overLimit(s: *const Self) bool {
            const limit = s.config.cardinality_limit;
            return limit > 0 and s.liveCount() >= limit - 1;
        }

        fn seriesFor(s: *Self, attrs: []const KeyValue) ?*Series {
            if (s.series.get(attrs)) |existing| {
                if (!s.precomputed or existing.observed or !s.overLimit()) return existing;
                return s.findOrCreate(&overflow_attributes);
            }
            if (s.overLimit()) return s.findOrCreate(&overflow_attributes);
            return s.newSeries(attrs);
        }

        fn findOrCreate(s: *Self, attrs: []const KeyValue) ?*Series {
            if (s.series.get(attrs)) |existing| return existing;
            return s.newSeries(attrs);
        }

        fn newSeries(s: *Self, attrs: []const KeyValue) ?*Series {
            var arena: std.heap.ArenaAllocator = .init(s.gpa);
            const a = arena.allocator();
            const series = a.create(Series) catch {
                arena.deinit();
                return null;
            };
            series.* = .{ .arena = .init, .attrs = attrset.clone(a, attrs) catch {
                arena.deinit();
                return null;
            } };
            switch (s.config.aggregation) {
                .histogram => |h| {
                    series.counts = a.alloc(u64, h.bounds.len + 1) catch {
                        arena.deinit();
                        return null;
                    };
                    @memset(series.counts, 0);
                },
                .sum, .last_value => {},
            }
            s.series.put(s.gpa, series.attrs, series) catch {
                arena.deinit();
                return null;
            };
            series.arena = arena.state;
            return series;
        }

        fn destroySeries(s: *Self, series: *Series) void {
            if (series.reservoir) |*r| r.deinit(s.gpa);
            const state = series.arena;
            state.promote(s.gpa).deinit();
        }

        fn collectErased(ptr: *anyopaque, arena: Allocator, now: u64) Allocator.Error!?data.Metric {
            const s: *Self = @ptrCast(@alignCast(ptr));
            return s.collect(arena, now);
        }

        /// Collects the points into `arena` at time `now`, then resets
        /// what the temporality says to reset. Returns null when there are
        /// no points.
        pub fn collect(s: *Self, arena: Allocator, now: u64) Allocator.Error!?data.Metric {
            s.mutex.lockUncancelable(s.io);
            defer s.mutex.unlock(s.io);
            const start = s.start_time;
            const delta = s.config.temporality == .delta;

            const series_list = s.series.values();
            var count: usize = 0;
            for (series_list) |series| {
                if (s.reports(series)) count += 1;
            }
            if (count == 0) {
                if (delta) s.start_time = now;
                s.reset();
                return null;
            }

            const metric_data: data.Data = switch (s.config.aggregation) {
                .sum => |sum| .{ .sum = .{
                    .temporality = s.config.temporality,
                    .is_monotonic = sum.monotonic,
                    .data_points = try s.numberPoints(arena, count, start, now),
                } },
                .last_value => .{ .gauge = .{ .data_points = try s.numberPoints(arena, count, start, now) } },
                .histogram => .{ .histogram = .{
                    .temporality = s.config.temporality,
                    .data_points = try s.histogramPoints(arena, count, start, now),
                } },
            };
            const out: data.Metric = .{
                .name = try arena.dupe(u8, s.config.name),
                .description = try arena.dupe(u8, s.config.description),
                .unit = try arena.dupe(u8, s.config.unit),
                .data = metric_data,
            };
            if (delta) s.start_time = now;
            s.reset();
            return out;
        }

        fn reports(s: *const Self, series: *const Series) bool {
            return !s.precomputed or series.observed;
        }

        fn numberPoints(s: *Self, arena: Allocator, count: usize, start: u64, now: u64) Allocator.Error![]const data.NumberDataPoint {
            const points = try arena.alloc(data.NumberDataPoint, count);
            var i: usize = 0;
            for (s.series.values()) |series| {
                if (!s.reports(series)) continue;
                var value = series.value;
                if (s.precomputed and s.config.temporality == .delta and s.config.aggregation == .sum) {
                    value = sub(series.value, series.reported);
                }
                points[i] = .{
                    .attributes = try attrset.clone(arena, series.attrs),
                    .start_time_unix_nano = start,
                    .time_unix_nano = now,
                    .value = .of(N, value),
                    .exemplars = try s.exemplars(arena, series),
                };
                i += 1;
            }
            return points;
        }

        fn histogramPoints(s: *Self, arena: Allocator, count: usize, start: u64, now: u64) Allocator.Error![]const data.HistogramDataPoint {
            const h = s.config.aggregation.histogram;
            const points = try arena.alloc(data.HistogramDataPoint, count);
            var i: usize = 0;
            for (s.series.values()) |series| {
                if (!s.reports(series)) continue;
                const has_extremes = h.record_min_max and series.count > 0;
                points[i] = .{
                    .attributes = try attrset.clone(arena, series.attrs),
                    .start_time_unix_nano = start,
                    .time_unix_nano = now,
                    .count = series.count,
                    .sum = if (h.record_sum) .of(N, series.value) else null,
                    .min = if (has_extremes) .of(N, series.min) else null,
                    .max = if (has_extremes) .of(N, series.max) else null,
                    .bounds = try arena.dupe(f64, h.bounds),
                    .bucket_counts = try arena.dupe(u64, series.counts),
                    .exemplars = try s.exemplars(arena, series),
                };
                i += 1;
            }
            return points;
        }

        fn exemplars(s: *Self, arena: Allocator, series: *Series) Allocator.Error![]const data.Exemplar {
            const r = if (series.reservoir) |*r| r else return &.{};
            return r.collect(arena, s.prng.random());
        }

        /// Applies the end-of-collection reset.
        fn reset(s: *Self) void {
            if (!s.precomputed) {
                if (s.config.temporality == .cumulative) return;
                for (s.series.values()) |series| s.destroySeries(series);
                s.series.clearRetainingCapacity();
                return;
            }
            // A precomputed delta sum keeps the observed series for their
            // reported value; everything else starts the next cycle empty.
            const keep_reported = s.config.temporality == .delta and s.config.aggregation == .sum;
            var i = s.series.count();
            while (i > 0) {
                i -= 1;
                const series = s.series.values()[i];
                if (keep_reported and series.observed) {
                    series.reported = series.value;
                    series.observed = false;
                    series.value = 0;
                    if (series.reservoir) |*r| r.clear();
                    continue;
                }
                s.destroySeries(series);
                s.series.swapRemoveAt(i);
            }
            s.active = 0;
        }

        fn add(a: N, b: N) N {
            return if (N == i64) a +% b else a + b;
        }

        fn sub(a: N, b: N) N {
            return if (N == i64) a -% b else a - b;
        }

        fn toDouble(v: N) f64 {
            return if (N == i64) @floatFromInt(v) else v;
        }
    };
}

test {
    _ = @import("aggregate_test.zig");
}
