//! Views: rules that change the streams an instrument produces, as OTel
//! Go's `NewView` builds them (sdk/metric view.go).
//!
//! A view has criteria and a mask. An instrument matches when every set
//! criterion equals the instrument's value; unset (empty or null)
//! criteria match anything, and a view with no criteria matches nothing.
//! The instrument name criterion may use `*` for any run of characters
//! and `?` for one character. A view whose name criterion has a wildcard
//! and whose mask renames the stream matches nothing, because one name
//! cannot serve several instruments.
//!
//! Every instrument a view matches gets one stream per matching view, with
//! the mask's set fields replacing the instrument's defaults. An
//! instrument no view matches gets the default stream.

const std = @import("std");
const InstrumentKind = @import("instrument.zig").InstrumentKind;

/// How a stream aggregates measurements.
pub const Aggregation = union(enum) {
    /// The instrument kind's default: a sum for counters and up-down
    /// counters, last value for gauges, an explicit-bucket histogram for
    /// histograms.
    default,
    /// No stream.
    drop,
    sum,
    last_value,
    explicit_bucket_histogram: ExplicitBuckets,

    pub const ExplicitBuckets = struct {
        /// Strictly increasing upper bounds. An empty list gives one
        /// bucket.
        boundaries: []const f64 = &default_boundaries,
        /// Skip recording the minimum and maximum.
        no_min_max: bool = false,

        /// Reports whether the bounds are non-NaN and strictly increasing,
        /// as Go's `AggregationExplicitBucketHistogram.err` requires.
        pub fn valid(b: ExplicitBuckets) bool {
            if (b.boundaries.len == 0) return true;
            if (std.math.isNan(b.boundaries[0])) return false;
            var prev = b.boundaries[0];
            for (b.boundaries[1..]) |next| {
                if (!(prev < next)) return false;
                prev = next;
            }
            return true;
        }
    };

    /// Reports whether an instrument of `kind` can use the aggregation, as
    /// Go's `isAggregatorCompatible` decides.
    pub fn compatible(a: Aggregation, kind: InstrumentKind) bool {
        return switch (a) {
            .default, .drop, .explicit_bucket_histogram => true,
            .sum => switch (kind) {
                .counter, .up_down_counter, .histogram, .observable_counter, .observable_up_down_counter => true,
                .gauge, .observable_gauge => false,
            },
            .last_value => switch (kind) {
                .gauge, .observable_gauge => true,
                else => false,
            },
        };
    }
};

/// The OTel default histogram bounds.
pub const default_boundaries = [_]f64{ 0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000 };

/// The default aggregation of an instrument kind.
pub fn defaultAggregation(kind: InstrumentKind) Aggregation {
    return switch (kind) {
        .counter, .up_down_counter, .observable_counter, .observable_up_down_counter => .sum,
        .gauge, .observable_gauge => .last_value,
        .histogram => .{ .explicit_bucket_histogram = .{} },
    };
}

/// What a view matches on: the instrument and its meter.
pub const Instrument = struct {
    name: []const u8,
    description: []const u8 = "",
    kind: InstrumentKind,
    unit: []const u8 = "",
    meter_name: []const u8 = "",
    meter_version: []const u8 = "",
    meter_schema_url: []const u8 = "",
};

/// A view. Its strings and slices are borrowed and must outlive the
/// meter provider.
pub const View = struct {
    // Criteria.
    /// The instrument name, with `*` and `?` wildcards.
    instrument_name: []const u8 = "",
    instrument_description: []const u8 = "",
    instrument_kind: ?InstrumentKind = null,
    instrument_unit: []const u8 = "",
    meter_name: []const u8 = "",
    meter_version: []const u8 = "",
    meter_schema_url: []const u8 = "",

    // Mask.
    /// Renames the stream.
    name: []const u8 = "",
    description: []const u8 = "",
    unit: []const u8 = "",
    /// Replaces the aggregation. `.drop` drops the stream. Invalid
    /// histogram bounds are ignored, as in Go, and the default is used.
    aggregation: ?Aggregation = null,
    /// Keeps only these attribute keys on the stream. The measurement
    /// attributes it removes are kept on exemplars.
    attribute_keys: ?[]const []const u8 = null,

    /// Reports whether the view applies to `inst`.
    pub fn matches(v: View, inst: Instrument) bool {
        if (v.isEmpty()) return false;
        const wildcard = std.mem.indexOfAny(u8, v.instrument_name, "*?") != null;
        if (wildcard and v.name.len > 0) return false;
        if (v.instrument_name.len > 0) {
            const ok = if (wildcard) wildcardMatch(v.instrument_name, inst.name) else std.mem.eql(u8, v.instrument_name, inst.name);
            if (!ok) return false;
        }
        if (v.instrument_kind) |k| if (k != inst.kind) return false;
        return matchString(v.instrument_description, inst.description) and
            matchString(v.instrument_unit, inst.unit) and
            matchString(v.meter_name, inst.meter_name) and
            matchString(v.meter_version, inst.meter_version) and
            matchString(v.meter_schema_url, inst.meter_schema_url);
    }

    fn isEmpty(v: View) bool {
        return v.instrument_name.len == 0 and v.instrument_description.len == 0 and v.instrument_kind == null and
            v.instrument_unit.len == 0 and v.meter_name.len == 0 and v.meter_version.len == 0 and v.meter_schema_url.len == 0;
    }
};

fn matchString(criterion: []const u8, value: []const u8) bool {
    return criterion.len == 0 or std.mem.eql(u8, criterion, value);
}

/// Matches `name` against `pattern`, where `*` matches any run of
/// characters and `?` exactly one. As with the regular expression Go
/// builds, a character is a UTF-8 sequence (an invalid byte counts as one)
/// and neither wildcard matches a newline.
pub fn wildcardMatch(pattern: []const u8, name: []const u8) bool {
    var p: usize = 0;
    var n: usize = 0;
    // Where to resume after the last `*`: the pattern index after it and
    // the name index it has consumed up to.
    var star: ?struct { p: usize, n: usize } = null;
    while (n < name.len) {
        if (p < pattern.len and pattern[p] == '*') {
            star = .{ .p = p + 1, .n = n };
            p += 1;
            continue;
        }
        if (p < pattern.len and pattern[p] == '?' and name[n] != '\n') {
            p += 1;
            n += charLen(name, n);
            continue;
        }
        if (p < pattern.len and pattern[p] != '?' and pattern[p] == name[n]) {
            p += 1;
            n += 1;
            continue;
        }
        if (star) |*s| {
            // Let the `*` take one more character, which must not be a
            // newline.
            if (name[s.n] == '\n') return false;
            s.n += charLen(name, s.n);
            n = s.n;
            p = s.p;
            continue;
        }
        return false;
    }
    while (p < pattern.len and pattern[p] == '*') p += 1;
    return p == pattern.len;
}

fn charLen(s: []const u8, i: usize) usize {
    const len = std.unicode.utf8ByteSequenceLength(s[i]) catch return 1;
    if (i + len > s.len) return 1;
    _ = std.unicode.utf8Decode(s[i .. i + len]) catch return 1;
    return len;
}

const testing = std.testing;

test "wildcards match as Go's view regular expression does" {
    const Case = struct { pattern: []const u8, name: []const u8, want: bool };
    const cases = [_]Case{
        .{ .pattern = "*", .name = "anything", .want = true },
        .{ .pattern = "*", .name = "", .want = true },
        .{ .pattern = "http.*", .name = "http.server.request.duration", .want = true },
        .{ .pattern = "http.*", .name = "db.client", .want = false },
        .{ .pattern = "*.duration", .name = "http.server.request.duration", .want = true },
        .{ .pattern = "*.duration", .name = "duration", .want = false },
        .{ .pattern = "req?", .name = "reqs", .want = true },
        .{ .pattern = "req?", .name = "req", .want = false },
        .{ .pattern = "req?", .name = "reqss", .want = false },
        .{ .pattern = "a*b*c", .name = "aXXbYYc", .want = true },
        .{ .pattern = "a*b*c", .name = "aXXbYY", .want = false },
        .{ .pattern = "?", .name = "é", .want = true },
        .{ .pattern = "??", .name = "é", .want = false },
        .{ .pattern = "a.b", .name = "aXb", .want = false },
        .{ .pattern = "*", .name = "a\nb", .want = false },
        .{ .pattern = "?", .name = "\n", .want = false },
        .{ .pattern = "*x", .name = "aaax", .want = true },
    };
    for (cases) |c| {
        testing.expectEqual(c.want, wildcardMatch(c.pattern, c.name)) catch |err| {
            std.debug.print("pattern {s} name {s}\n", .{ c.pattern, c.name });
            return err;
        };
    }
}

test "view matching follows Go's criteria rules" {
    const inst: Instrument = .{ .name = "requests", .kind = .counter, .unit = "1", .meter_name = "m" };
    try testing.expect(!(View{}).matches(inst));
    try testing.expect((View{ .instrument_name = "requests" }).matches(inst));
    try testing.expect(!(View{ .instrument_name = "Requests" }).matches(inst));
    try testing.expect((View{ .instrument_name = "req*" }).matches(inst));
    try testing.expect(!(View{ .instrument_name = "req*", .name = "renamed" }).matches(inst));
    try testing.expect((View{ .instrument_name = "requests", .name = "renamed" }).matches(inst));
    try testing.expect((View{ .instrument_kind = .counter }).matches(inst));
    try testing.expect(!(View{ .instrument_kind = .histogram }).matches(inst));
    try testing.expect(!(View{ .instrument_name = "requests", .instrument_unit = "s" }).matches(inst));
    try testing.expect((View{ .meter_name = "m" }).matches(inst));
    try testing.expect(!(View{ .meter_name = "other" }).matches(inst));
}

test "aggregation compatibility and bucket validation" {
    try testing.expect((Aggregation{ .sum = {} }).compatible(.histogram));
    try testing.expect(!(Aggregation{ .sum = {} }).compatible(.gauge));
    try testing.expect((Aggregation{ .last_value = {} }).compatible(.observable_gauge));
    try testing.expect(!(Aggregation{ .last_value = {} }).compatible(.counter));
    try testing.expect((Aggregation.ExplicitBuckets{ .boundaries = &.{ 1, 2, 3 } }).valid());
    try testing.expect(!(Aggregation.ExplicitBuckets{ .boundaries = &.{ 1, 1 } }).valid());
    try testing.expect(!(Aggregation.ExplicitBuckets{ .boundaries = &.{ 2, 1 } }).valid());
    try testing.expect(!(Aggregation.ExplicitBuckets{ .boundaries = &.{std.math.nan(f64)} }).valid());
    try testing.expect(!(Aggregation.ExplicitBuckets{ .boundaries = &.{ 1, std.math.nan(f64) } }).valid());
    try testing.expect(!(Aggregation.ExplicitBuckets{ .boundaries = &.{ std.math.nan(f64), 1 } }).valid());
    try testing.expect((Aggregation.ExplicitBuckets{ .boundaries = &.{} }).valid());
    try testing.expectEqual(@as(usize, 15), defaultAggregation(.histogram).explicit_bucket_histogram.boundaries.len);
}
