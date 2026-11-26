//! Instrument kinds, aggregation temporality, and the pure mappings of the
//! metric environment variables, as the OTel Go SDK reads them
//! (sdk/metric reader.go, env.go and config.go, and otlpmetrichttp
//! internal/oconf/envconfig.go).
//!
//! Each mapping takes any value with a method
//! `get(self, key: []const u8) ?[]const u8`, such as
//! `std.process.Environ.Map` or a test map, and reads nothing else.

const std = @import("std");
const Io = std.Io;

/// The kind of an instrument.
pub const InstrumentKind = enum {
    counter,
    up_down_counter,
    histogram,
    gauge,
    observable_counter,
    observable_up_down_counter,
    observable_gauge,

    /// Reports whether the kind is observed through callbacks.
    pub fn isObservable(kind: InstrumentKind) bool {
        return switch (kind) {
            .observable_counter, .observable_up_down_counter, .observable_gauge => true,
            .counter, .up_down_counter, .histogram, .gauge => false,
        };
    }

    /// Reports whether measurements can be negative, which is when a
    /// histogram of the instrument records no sum (sdk/metric pipeline.go).
    pub fn canBeNegative(kind: InstrumentKind) bool {
        return switch (kind) {
            .up_down_counter, .observable_up_down_counter, .gauge, .observable_gauge => true,
            .counter, .histogram, .observable_counter => false,
        };
    }
};

/// How sums and histograms accumulate across collections.
pub const Temporality = enum {
    /// Each point covers the time since the stream started.
    cumulative,
    /// Each point covers the time since the previous collection.
    delta,
};

/// A temporality choice per instrument kind, as
/// `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` names it.
pub const TemporalityPreference = enum {
    /// Cumulative for every kind, the default.
    cumulative,
    /// Delta for counters, histograms and observable counters; cumulative
    /// for up-down counters, observable up-down counters and gauges.
    delta,
    /// Delta for counters and histograms; cumulative for the rest.
    low_memory,

    /// The temporality of a stream of `kind`.
    pub fn temporality(pref: TemporalityPreference, kind: InstrumentKind) Temporality {
        return switch (pref) {
            .cumulative => .cumulative,
            .delta => switch (kind) {
                .counter, .histogram, .observable_counter => .delta,
                .up_down_counter, .observable_up_down_counter, .gauge, .observable_gauge => .cumulative,
            },
            .low_memory => switch (kind) {
                .counter, .histogram => .delta,
                .observable_counter, .up_down_counter, .observable_up_down_counter, .gauge, .observable_gauge => .cumulative,
            },
        };
    }
};

const space = " \t\r\n\x0b\x0c";

/// Reads `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. The value is
/// trimmed and compared without case: `cumulative`, `delta` and
/// `lowmemory`. Unset, empty and any other value return null, which keeps
/// the default, as the Go exporter ignores an invalid value.
pub fn temporalityPreferenceFromEnv(env: anytype) ?TemporalityPreference {
    const raw = env.get("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE") orelse return null;
    const value = std.mem.trim(u8, raw, space);
    if (std.ascii.eqlIgnoreCase(value, "cumulative")) return .cumulative;
    if (std.ascii.eqlIgnoreCase(value, "delta")) return .delta;
    if (std.ascii.eqlIgnoreCase(value, "lowmemory")) return .low_memory;
    return null;
}

/// The periodic reader's settings from the environment.
pub const PeriodicSettings = struct {
    /// `OTEL_METRIC_EXPORT_INTERVAL`: the time between the start of two
    /// collections.
    interval: Io.Duration = default_interval,
    /// `OTEL_METRIC_EXPORT_TIMEOUT`: bounds each collect and export.
    timeout: Io.Duration = default_timeout,
};

/// The default export interval, 60 seconds.
pub const default_interval: Io.Duration = .fromSeconds(60);
/// The default export timeout, 30 seconds.
pub const default_timeout: Io.Duration = .fromSeconds(30);

/// Reads `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_METRIC_EXPORT_TIMEOUT`,
/// each an integer number of milliseconds. As in Go's `envDuration`, the
/// value is not trimmed, and one that is empty, not a base-10 integer, not
/// positive, or too large for a duration keeps the default.
pub fn periodicFromEnv(env: anytype) PeriodicSettings {
    return .{
        .interval = envMillis(env.get("OTEL_METRIC_EXPORT_INTERVAL")) orelse default_interval,
        .timeout = envMillis(env.get("OTEL_METRIC_EXPORT_TIMEOUT")) orelse default_timeout,
    };
}

/// The largest millisecond count Go's `time.Duration` holds.
const max_millis: i64 = std.math.maxInt(i64) / std.time.ns_per_ms;

fn envMillis(raw: ?[]const u8) ?Io.Duration {
    const value = raw orelse return null;
    if (value.len == 0) return null;
    // std.fmt.parseInt accepts digit separators, which Go's
    // strconv.ParseInt rejects in base 10.
    if (std.mem.indexOfScalar(u8, value, '_') != null) return null;
    const ms = std.fmt.parseInt(i64, value, 10) catch return null;
    if (ms <= 0 or ms > max_millis) return null;
    return .fromMilliseconds(ms);
}

const testing = std.testing;

/// A test environment.
pub const TestEnv = struct {
    pairs: []const [2][]const u8,

    /// Returns the value of `key`, if set.
    pub fn get(e: TestEnv, key: []const u8) ?[]const u8 {
        for (e.pairs) |p| if (std.mem.eql(u8, p[0], key)) return p[1];
        return null;
    }
};

test "temporality preferences map each kind as OTel Go does" {
    const kinds = std.enums.values(InstrumentKind);
    for (kinds) |k| try testing.expectEqual(Temporality.cumulative, TemporalityPreference.cumulative.temporality(k));

    const Case = struct { kind: InstrumentKind, delta: Temporality, low_memory: Temporality };
    const cases = [_]Case{
        .{ .kind = .counter, .delta = .delta, .low_memory = .delta },
        .{ .kind = .histogram, .delta = .delta, .low_memory = .delta },
        .{ .kind = .observable_counter, .delta = .delta, .low_memory = .cumulative },
        .{ .kind = .up_down_counter, .delta = .cumulative, .low_memory = .cumulative },
        .{ .kind = .observable_up_down_counter, .delta = .cumulative, .low_memory = .cumulative },
        .{ .kind = .gauge, .delta = .cumulative, .low_memory = .cumulative },
        .{ .kind = .observable_gauge, .delta = .cumulative, .low_memory = .cumulative },
    };
    for (cases) |c| {
        try testing.expectEqual(c.delta, TemporalityPreference.delta.temporality(c.kind));
        try testing.expectEqual(c.low_memory, TemporalityPreference.low_memory.temporality(c.kind));
    }
}

test "the temporality preference variable is trimmed, case-insensitive and ignored when invalid" {
    const key = "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE";
    const Case = struct { value: []const u8, want: ?TemporalityPreference };
    const cases = [_]Case{
        .{ .value = "cumulative", .want = .cumulative },
        .{ .value = "delta", .want = .delta },
        .{ .value = " Delta\t", .want = .delta },
        .{ .value = "LOWMEMORY", .want = .low_memory },
        .{ .value = "lowMemory", .want = .low_memory },
        .{ .value = "low_memory", .want = null },
        .{ .value = "", .want = null },
        .{ .value = "deltas", .want = null },
    };
    for (cases) |c| {
        try testing.expectEqual(c.want, temporalityPreferenceFromEnv(TestEnv{ .pairs = &.{.{ key, c.value }} }));
    }
    try testing.expectEqual(null, temporalityPreferenceFromEnv(TestEnv{ .pairs = &.{} }));
}

test "the periodic reader variables follow Go's envDuration" {
    const defaults = periodicFromEnv(TestEnv{ .pairs = &.{} });
    try testing.expectEqual(Io.Duration.fromSeconds(60), defaults.interval);
    try testing.expectEqual(Io.Duration.fromSeconds(30), defaults.timeout);

    const set = periodicFromEnv(TestEnv{ .pairs = &.{
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "1500" },
        .{ "OTEL_METRIC_EXPORT_TIMEOUT", "+250" },
    } });
    try testing.expectEqual(Io.Duration.fromMilliseconds(1500), set.interval);
    try testing.expectEqual(Io.Duration.fromMilliseconds(250), set.timeout);

    const ignored = [_][]const u8{ "", "0", "-5", " 100", "100 ", "1_000", "1.5", "10s", "9223372036854776" };
    for (ignored) |value| {
        const s = periodicFromEnv(TestEnv{ .pairs = &.{
            .{ "OTEL_METRIC_EXPORT_INTERVAL", value },
            .{ "OTEL_METRIC_EXPORT_TIMEOUT", value },
        } });
        try testing.expectEqual(default_interval, s.interval);
        try testing.expectEqual(default_timeout, s.timeout);
    }
    // The largest value Go accepts.
    const max = periodicFromEnv(TestEnv{ .pairs = &.{.{ "OTEL_METRIC_EXPORT_INTERVAL", "9223372036854" }} });
    try testing.expectEqual(Io.Duration.fromMilliseconds(9223372036854), max.interval);
}

test "observable and negative kinds" {
    try testing.expect(InstrumentKind.observable_gauge.isObservable());
    try testing.expect(!InstrumentKind.histogram.isObservable());
    try testing.expect(InstrumentKind.up_down_counter.canBeNegative());
    try testing.expect(!InstrumentKind.counter.canBeNegative());
}
