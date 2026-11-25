//! Samplers: always on, always off, trace id ratio, and parent-based with
//! separate delegates for remote and local parents. They follow the OTel
//! Go SDK (sdk/trace/sampling.go and sampler_env.go), including the
//! descriptions the effective configuration reports.

const std = @import("std");
const Context = @import("../context.zig").Context;
const attribute = @import("attribute.zig");
const ids = @import("ids.zig");
const span = @import("span.zig");
const TraceState = @import("tracestate.zig").TraceState;

/// What a sampler decides for a new span.
pub const Decision = enum {
    /// The span is not recorded and not sampled.
    drop,
    /// The span is recorded for processors but not sampled, so it is not
    /// exported.
    record_only,
    /// The span is recorded and sampled.
    record_and_sample,
};

/// What a sampler sees about the span being started.
pub const Parameters = struct {
    /// The context the span starts in. Its span context is the parent.
    parent: Context,
    trace_id: ids.TraceId,
    name: []const u8,
    kind: span.SpanKind,
    attributes: []const attribute.KeyValue,
    links: []const span.Link,
};

/// A sampler's decision, extra attributes for the span, and the trace
/// state the new span carries.
pub const Result = struct {
    decision: Decision,
    attributes: []const attribute.KeyValue = &.{},
    trace_state: TraceState = .empty,
};

/// A sampler supplied by the application.
pub const Custom = struct {
    ptr: ?*const anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        shouldSample: *const fn (ptr: ?*const anyopaque, params: Parameters) Result,
        /// Writes the sampler's description, as `Sampler.Description()`
        /// returns it in Go.
        writeDescription: *const fn (ptr: ?*const anyopaque, w: *std.Io.Writer) std.Io.Writer.Error!void,
    };
};

/// Samples a fraction of traces by trace id, with the OTel Go algorithm:
/// a span is sampled when the trace id's last 8 bytes, read big-endian
/// and shifted right by one, are below `fraction * 2^63`.
pub const TraceIdRatio = struct {
    /// The sampled fraction, clamped to [0, 1].
    fraction: f64,
    upper_bound: u64,

    /// Returns the ratio sampler for `fraction`. A fraction of 1 or more
    /// samples everything and one of 0 or less samples nothing.
    pub fn init(fraction: f64) TraceIdRatio {
        if (!(fraction > 0)) return .{ .fraction = 0, .upper_bound = 0 };
        if (fraction >= 1) return .{ .fraction = 1, .upper_bound = std.math.maxInt(u64) };
        return .{ .fraction = fraction, .upper_bound = @intFromFloat(fraction * 0x1p63) };
    }

    fn sample(r: TraceIdRatio, trace_id: ids.TraceId) Decision {
        if (r.fraction >= 1) return .record_and_sample;
        const x = std.mem.readInt(u64, trace_id.bytes[8..16], .big) >> 1;
        return if (x < r.upper_bound) .record_and_sample else .drop;
    }

    fn writeDescription(r: TraceIdRatio, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll("TraceIDRatioBased{");
        try writeGoFloat(w, r.fraction);
        try w.writeByte('}');
    }
};

/// A sampler a parent-based sampler delegates to.
pub const Delegate = union(enum) {
    always_on,
    always_off,
    trace_id_ratio: TraceIdRatio,
    custom: Custom,

    fn shouldSample(d: Delegate, params: Parameters) Result {
        return switch (d) {
            .always_on => passThrough(.record_and_sample, params),
            .always_off => passThrough(.drop, params),
            .trace_id_ratio => |r| passThrough(r.sample(params.trace_id), params),
            .custom => |c| c.vtable.shouldSample(c.ptr, params),
        };
    }

    fn writeDescription(d: Delegate, w: *std.Io.Writer) std.Io.Writer.Error!void {
        switch (d) {
            .always_on => try w.writeAll("AlwaysOnSampler"),
            .always_off => try w.writeAll("AlwaysOffSampler"),
            .trace_id_ratio => |r| try r.writeDescription(w),
            .custom => |c| try c.vtable.writeDescription(c.ptr, w),
        }
    }
};

/// Follows the parent's sampled flag, with a separate delegate for each
/// kind of parent and one for root spans. The defaults are Go's.
pub const ParentBased = struct {
    root: Delegate,
    remote_parent_sampled: Delegate = .always_on,
    remote_parent_not_sampled: Delegate = .always_off,
    local_parent_sampled: Delegate = .always_on,
    local_parent_not_sampled: Delegate = .always_off,

    fn delegateFor(pb: ParentBased, parent: ids.SpanContext) Delegate {
        if (!parent.isValid()) return pb.root;
        if (parent.remote) {
            return if (parent.isSampled()) pb.remote_parent_sampled else pb.remote_parent_not_sampled;
        }
        return if (parent.isSampled()) pb.local_parent_sampled else pb.local_parent_not_sampled;
    }
};

/// A sampler.
pub const Sampler = union(enum) {
    always_on,
    always_off,
    trace_id_ratio: TraceIdRatio,
    parent_based: ParentBased,
    custom: Custom,

    /// The SDK default when nothing selects a sampler:
    /// parent-based with an always-on root.
    pub const default: Sampler = .{ .parent_based = .{ .root = .always_on } };

    /// Returns the ratio sampler for `fraction`.
    pub fn traceIdRatio(fraction: f64) Sampler {
        return .{ .trace_id_ratio = .init(fraction) };
    }

    /// Decides whether to record and sample a new span.
    pub fn shouldSample(s: Sampler, params: Parameters) Result {
        return switch (s) {
            .always_on => passThrough(.record_and_sample, params),
            .always_off => passThrough(.drop, params),
            .trace_id_ratio => |r| passThrough(r.sample(params.trace_id), params),
            .parent_based => |pb| pb.delegateFor(params.parent.span_context).shouldSample(params),
            .custom => |c| c.vtable.shouldSample(c.ptr, params),
        };
    }

    /// Writes the description Go's `Sampler.Description()` gives, for
    /// example `ParentBased{root:AlwaysOnSampler,...}`.
    pub fn writeDescription(s: Sampler, w: *std.Io.Writer) std.Io.Writer.Error!void {
        switch (s) {
            .always_on => try w.writeAll("AlwaysOnSampler"),
            .always_off => try w.writeAll("AlwaysOffSampler"),
            .trace_id_ratio => |r| try r.writeDescription(w),
            .custom => |c| try c.vtable.writeDescription(c.ptr, w),
            .parent_based => |pb| {
                try w.writeAll("ParentBased{root:");
                try pb.root.writeDescription(w);
                try w.writeAll(",remoteParentSampled:");
                try pb.remote_parent_sampled.writeDescription(w);
                try w.writeAll(",remoteParentNotSampled:");
                try pb.remote_parent_not_sampled.writeDescription(w);
                try w.writeAll(",localParentSampled:");
                try pb.local_parent_sampled.writeDescription(w);
                try w.writeAll(",localParentNotSampled:");
                try pb.local_parent_not_sampled.writeDescription(w);
                try w.writeByte('}');
            },
        }
    }
};

/// The built-in samplers keep the parent's trace state, as Go's do.
fn passThrough(decision: Decision, params: Parameters) Result {
    return .{ .decision = decision, .trace_state = params.parent.span_context.trace_state };
}

/// Why `fromEnv` fell back to a default.
pub const EnvProblem = enum {
    /// The sampler name is not one OTel defines; the SDK default applies.
    unsupported_sampler,
    /// The ratio argument is not a number; a ratio of 1 applies.
    invalid_argument,
    /// The ratio argument is below 0; a ratio of 1 applies.
    negative_ratio,
    /// The ratio argument is above 1; a ratio of 1 applies.
    ratio_above_one,
};

/// The sampler `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` select.
pub const EnvSampler = struct {
    /// Null when the variable is unset or names no supported sampler,
    /// which leaves the SDK default in place.
    sampler: ?Sampler,
    /// Set when the values were invalid, so the caller can report it.
    problem: ?EnvProblem = null,
};

/// Maps the values of `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`
/// to a sampler, as the OTel Go SDK does: the name is trimmed and
/// lowercased, a missing ratio argument means 1, and an invalid one gives
/// a ratio of 1 and a problem to report.
pub fn fromEnv(name_value: ?[]const u8, arg_value: ?[]const u8) EnvSampler {
    var name_buf: [32]u8 = undefined;
    const raw_name = std.mem.trim(u8, name_value orelse "", " \t\r\n");
    if (raw_name.len == 0) return .{ .sampler = null };
    if (raw_name.len > name_buf.len) return .{ .sampler = null, .problem = .unsupported_sampler };
    const name = std.ascii.lowerString(&name_buf, raw_name);
    const arg = std.mem.trim(u8, arg_value orelse "", " \t\r\n");

    if (std.mem.eql(u8, name, "always_on")) return .{ .sampler = .always_on };
    if (std.mem.eql(u8, name, "always_off")) return .{ .sampler = .always_off };
    if (std.mem.eql(u8, name, "parentbased_always_on")) return .{ .sampler = .{ .parent_based = .{ .root = .always_on } } };
    if (std.mem.eql(u8, name, "parentbased_always_off")) return .{ .sampler = .{ .parent_based = .{ .root = .always_off } } };
    if (std.mem.eql(u8, name, "traceidratio")) {
        const ratio = parseRatio(arg);
        return .{ .sampler = .{ .trace_id_ratio = ratio.sampler }, .problem = ratio.problem };
    }
    if (std.mem.eql(u8, name, "parentbased_traceidratio")) {
        const ratio = parseRatio(arg);
        return .{ .sampler = .{ .parent_based = .{ .root = .{ .trace_id_ratio = ratio.sampler } } }, .problem = ratio.problem };
    }
    return .{ .sampler = null, .problem = .unsupported_sampler };
}

const ParsedRatio = struct { sampler: TraceIdRatio, problem: ?EnvProblem = null };

fn parseRatio(arg: []const u8) ParsedRatio {
    if (arg.len == 0) return .{ .sampler = .init(1) };
    const v = std.fmt.parseFloat(f64, arg) catch return .{ .sampler = .init(1), .problem = .invalid_argument };
    if (std.math.isNan(v)) return .{ .sampler = .init(v) };
    if (v < 0) return .{ .sampler = .init(1), .problem = .negative_ratio };
    if (v > 1) return .{ .sampler = .init(1), .problem = .ratio_above_one };
    return .{ .sampler = .init(v) };
}

/// Writes `v` as Go's `%g` does for the values a ratio can take: the
/// shortest decimal, in exponent form with a two-digit exponent below
/// 1e-4.
fn writeGoFloat(w: *std.Io.Writer, v: f64) std.Io.Writer.Error!void {
    if (v == 0 or v >= 1e-4) return w.print("{d}", .{v});
    var buf: [64]u8 = undefined;
    const text = std.fmt.bufPrint(&buf, "{e}", .{v}) catch return w.print("{e}", .{v});
    const e = std.mem.indexOfScalar(u8, text, 'e') orelse return w.writeAll(text);
    try w.writeAll(text[0 .. e + 1]);
    var exponent = text[e + 1 ..];
    if (exponent.len > 0 and (exponent[0] == '-' or exponent[0] == '+')) {
        try w.writeByte(exponent[0]);
        exponent = exponent[1..];
    } else try w.writeByte('+');
    if (exponent.len < 2) try w.writeByte('0');
    try w.writeAll(exponent);
}

const testing = std.testing;

fn testParams(parent: ids.SpanContext, trace_id: ids.TraceId) Parameters {
    return .{
        .parent = Context.background.withSpanContext(parent),
        .trace_id = trace_id,
        .name = "op",
        .kind = .internal,
        .attributes = &.{},
        .links = &.{},
    };
}

fn description(s: Sampler) ![]const u8 {
    const State = struct {
        var buf: [512]u8 = undefined;
    };
    var w: std.Io.Writer = .fixed(&State.buf);
    try s.writeDescription(&w);
    return w.buffered();
}

const tid = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?;
const sid = ids.SpanId.parseHex("00f067aa0ba902b7").?;

test "always on and always off keep the parent trace state" {
    const parent: ids.SpanContext = .{ .trace_id = tid, .span_id = sid, .trace_state = .{ .header = "k=v" } };
    const on = Sampler.shouldSample(.always_on, testParams(parent, tid));
    try testing.expectEqual(Decision.record_and_sample, on.decision);
    try testing.expectEqualStrings("k=v", on.trace_state.header);
    const off = Sampler.shouldSample(.always_off, testParams(parent, tid));
    try testing.expectEqual(Decision.drop, off.decision);
    try testing.expectEqualStrings("k=v", off.trace_state.header);
}

test "trace id ratio uses the last 8 bytes shifted right by one" {
    const half = Sampler.traceIdRatio(0.5);
    var low = tid;
    // x = 0x3fff... < 2^62 = 0.5 * 2^63: sampled.
    low.bytes[8..16].* = .{ 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff };
    try testing.expectEqual(Decision.record_and_sample, half.shouldSample(testParams(.invalid, low)).decision);
    var high = tid;
    // x = 0x4000... = 2^62: not below the bound, dropped.
    high.bytes[8..16].* = .{ 0x80, 0, 0, 0, 0, 0, 0, 0 };
    try testing.expectEqual(Decision.drop, half.shouldSample(testParams(.invalid, high)).decision);
    try testing.expectEqual(Decision.record_and_sample, Sampler.traceIdRatio(1).shouldSample(testParams(.invalid, high)).decision);
    try testing.expectEqual(Decision.drop, Sampler.traceIdRatio(0).shouldSample(testParams(.invalid, low)).decision);
    try testing.expectEqual(Decision.drop, Sampler.traceIdRatio(-3).shouldSample(testParams(.invalid, low)).decision);
}

test "trace id ratio samples about the fraction of random ids" {
    const g: ids.IdGenerator = .{ .io = testing.io };
    const s = Sampler.traceIdRatio(0.25);
    var sampled: usize = 0;
    const n = 4000;
    for (0..n) |_| {
        if (s.shouldSample(testParams(.invalid, g.traceId())).decision == .record_and_sample) sampled += 1;
    }
    try testing.expect(sampled > 800 and sampled < 1200);
}

test "parent-based picks the delegate for each kind of parent" {
    const pb: Sampler = .{ .parent_based = .{
        .root = .always_off,
        .remote_parent_sampled = .always_off,
        .remote_parent_not_sampled = .always_on,
        .local_parent_sampled = .always_off,
        .local_parent_not_sampled = .always_on,
    } };
    try testing.expectEqual(Decision.drop, pb.shouldSample(testParams(.invalid, tid)).decision);
    const remote_sampled: ids.SpanContext = .{ .trace_id = tid, .span_id = sid, .flags = .sampled_flag, .remote = true };
    try testing.expectEqual(Decision.drop, pb.shouldSample(testParams(remote_sampled, tid)).decision);
    var remote_unsampled = remote_sampled;
    remote_unsampled.flags = .{};
    try testing.expectEqual(Decision.record_and_sample, pb.shouldSample(testParams(remote_unsampled, tid)).decision);
    var local_sampled = remote_sampled;
    local_sampled.remote = false;
    try testing.expectEqual(Decision.drop, pb.shouldSample(testParams(local_sampled, tid)).decision);
    var local_unsampled = local_sampled;
    local_unsampled.flags = .{};
    try testing.expectEqual(Decision.record_and_sample, pb.shouldSample(testParams(local_unsampled, tid)).decision);

    // The defaults follow the parent.
    const def = Sampler.default;
    try testing.expectEqual(Decision.record_and_sample, def.shouldSample(testParams(.invalid, tid)).decision);
    try testing.expectEqual(Decision.record_and_sample, def.shouldSample(testParams(remote_sampled, tid)).decision);
    try testing.expectEqual(Decision.drop, def.shouldSample(testParams(remote_unsampled, tid)).decision);
    try testing.expectEqual(Decision.record_and_sample, def.shouldSample(testParams(local_sampled, tid)).decision);
    try testing.expectEqual(Decision.drop, def.shouldSample(testParams(local_unsampled, tid)).decision);
}

test "descriptions match Go" {
    try testing.expectEqualStrings("AlwaysOnSampler", try description(.always_on));
    try testing.expectEqualStrings("AlwaysOffSampler", try description(.always_off));
    try testing.expectEqualStrings("TraceIDRatioBased{0.25}", try description(.traceIdRatio(0.25)));
    try testing.expectEqualStrings("TraceIDRatioBased{1}", try description(.traceIdRatio(3)));
    try testing.expectEqualStrings("TraceIDRatioBased{0}", try description(.traceIdRatio(-1)));
    try testing.expectEqualStrings("TraceIDRatioBased{1e-05}", try description(.traceIdRatio(0.00001)));
    try testing.expectEqualStrings("TraceIDRatioBased{1.5e-07}", try description(.traceIdRatio(1.5e-7)));
    try testing.expectEqualStrings("TraceIDRatioBased{0.0001}", try description(.traceIdRatio(0.0001)));
    try testing.expectEqualStrings(
        "ParentBased{root:AlwaysOnSampler,remoteParentSampled:AlwaysOnSampler,remoteParentNotSampled:AlwaysOffSampler,localParentSampled:AlwaysOnSampler,localParentNotSampled:AlwaysOffSampler}",
        try description(.default),
    );
}

test "a custom sampler is called with the parameters" {
    const Impl = struct {
        fn shouldSample(_: ?*const anyopaque, p: Parameters) Result {
            const keep = std.mem.eql(u8, p.name, "keep");
            return .{ .decision = if (keep) .record_only else .drop, .attributes = &.{attribute.kv("sampler", "custom")} };
        }
        fn writeDescription(_: ?*const anyopaque, w: *std.Io.Writer) std.Io.Writer.Error!void {
            try w.writeAll("Custom");
        }
    };
    const s: Sampler = .{ .custom = .{ .ptr = null, .vtable = &.{ .shouldSample = Impl.shouldSample, .writeDescription = Impl.writeDescription } } };
    var p = testParams(.invalid, tid);
    p.name = "keep";
    const r = s.shouldSample(p);
    try testing.expectEqual(Decision.record_only, r.decision);
    try testing.expectEqualStrings("custom", r.attributes[0].value.string);
    const pb: Sampler = .{ .parent_based = .{ .root = .{ .custom = s.custom } } };
    try testing.expectEqualStrings(
        "ParentBased{root:Custom,remoteParentSampled:AlwaysOnSampler,remoteParentNotSampled:AlwaysOffSampler,localParentSampled:AlwaysOnSampler,localParentNotSampled:AlwaysOffSampler}",
        try description(pb),
    );
}

test "fromEnv maps OTEL_TRACES_SAMPLER as Go does" {
    try testing.expectEqual(null, fromEnv(null, null).sampler);
    try testing.expectEqual(null, fromEnv("  ", "0.5").sampler);
    try testing.expectEqualStrings("AlwaysOnSampler", try description(fromEnv(" Always_On ", null).sampler.?));
    try testing.expectEqualStrings("AlwaysOffSampler", try description(fromEnv("always_off", null).sampler.?));
    try testing.expectEqualStrings("TraceIDRatioBased{1}", try description(fromEnv("traceidratio", null).sampler.?));
    try testing.expectEqualStrings("TraceIDRatioBased{0.5}", try description(fromEnv("traceidratio", " 0.5 ").sampler.?));
    const bad = fromEnv("traceidratio", "half");
    try testing.expectEqual(EnvProblem.invalid_argument, bad.problem.?);
    try testing.expectEqualStrings("TraceIDRatioBased{1}", try description(bad.sampler.?));
    try testing.expectEqual(EnvProblem.negative_ratio, fromEnv("traceidratio", "-0.1").problem.?);
    try testing.expectEqual(EnvProblem.ratio_above_one, fromEnv("traceidratio", "1.1").problem.?);
    const pbr = fromEnv("parentbased_traceidratio", "0.25");
    try testing.expectEqual(null, pbr.problem);
    try testing.expect(std.mem.startsWith(u8, try description(pbr.sampler.?), "ParentBased{root:TraceIDRatioBased{0.25},"));
    try testing.expect(std.mem.startsWith(u8, try description(fromEnv("parentbased_always_off", null).sampler.?), "ParentBased{root:AlwaysOffSampler,"));
    const unknown = fromEnv("jaeger_remote", null);
    try testing.expectEqual(null, unknown.sampler);
    try testing.expectEqual(EnvProblem.unsupported_sampler, unknown.problem.?);
}
