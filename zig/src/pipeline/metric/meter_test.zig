//! Tests of the meter provider, instruments, views, exemplars, the
//! cardinality limit, temporality and the readers.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const kv = attribute.kv;
const deadline = @import("../deadline.zig");
const ids = @import("../ids.zig");
const policy_mod = @import("../policy.zig");
const tracer_mod = @import("../tracer.zig");
const data = @import("data.zig");
const instrument = @import("instrument.zig");
const meter_mod = @import("meter.zig");
const MeterProvider = meter_mod.MeterProvider;
const memory_exporter = @import("memory_exporter.zig");
const reader_mod = @import("reader.zig");
const view = @import("view.zig");

const io = testing.io;
const gpa = testing.allocator;

/// A provider with one manual reader.
const Harness = struct {
    reader: reader_mod.ManualReader,
    provider: *MeterProvider,

    fn init(h: *Harness, options: MeterProvider.Options, temporality: instrument.TemporalityPreference) !void {
        h.reader = .init(io, .{ .temporality = temporality });
        var opts = options;
        opts.readers = &.{h.reader.reader()};
        h.provider = try MeterProvider.create(gpa, io, opts);
    }

    fn deinit(h: *Harness) void {
        h.provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        h.provider.destroy();
    }

    fn meter(h: *Harness) *const meter_mod.Meter {
        return h.provider.meter(.{ .name = "github.com/jamesainslie/libo11y/zig/test", .version = "0.0.0" });
    }

    fn collect(h: *Harness) !data.ResourceMetrics {
        return h.reader.collect(gpa);
    }
};

const sampled_sc: ids.SpanContext = .{
    .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
    .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
    .flags = .sampled_flag,
};

fn sampledCtx() Context {
    return Context.background.withSpanContext(sampled_sc);
}

/// Returns the point whose attributes contain `key` with string `value`.
fn pointWith(points: anytype, key: []const u8, value: []const u8) ?@TypeOf(points[0]) {
    for (points) |p| {
        const v = attribute.find(p.attributes, key) orelse continue;
        if (v == .string and std.mem.eql(u8, v.string, value)) return p;
    }
    return null;
}

test "a counter sums per canonical attribute set, cumulatively by default" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    const c = h.meter().counter(i64, "requests", .{ .unit = "{request}", .description = "Requests served." });
    c.add(.background, 2, &.{ kv("route", "/a"), kv("code", 200) });
    // The same set in another order, and with a repeated key whose last
    // value wins.
    c.add(.background, 3, &.{ kv("code", 500), kv("route", "/a"), kv("code", 200) });
    c.add(.background, 4, &.{kv("route", "/b")});

    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(usize, 1), rm.scope_metrics.len);
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig/test", rm.scope_metrics[0].scope.name);
    const m = rm.find("requests").?;
    try testing.expectEqualStrings("{request}", m.unit);
    try testing.expectEqualStrings("Requests served.", m.description);
    const sum = m.data.sum;
    try testing.expect(sum.is_monotonic);
    try testing.expectEqual(instrument.Temporality.cumulative, sum.temporality);
    try testing.expectEqual(@as(usize, 2), sum.data_points.len);
    const a = pointWith(sum.data_points, "route", "/a").?;
    try testing.expectEqual(@as(i64, 5), a.value.int);
    try testing.expectEqual(@as(usize, 2), a.attributes.len);
    try testing.expectEqualStrings("code", a.attributes[0].key);
    try testing.expectEqual(@as(i64, 4), pointWith(sum.data_points, "route", "/b").?.value.int);

    c.add(.background, 1, &.{kv("route", "/b")});
    var rm2 = try h.collect();
    defer rm2.deinit();
    const points = rm2.find("requests").?.data.sum.data_points;
    try testing.expectEqual(@as(usize, 2), points.len);
    try testing.expectEqual(@as(i64, 5), pointWith(points, "route", "/a").?.value.int);
    try testing.expectEqual(@as(i64, 5), pointWith(points, "route", "/b").?.value.int);
    try testing.expectEqual(a.start_time_unix_nano, points[0].start_time_unix_nano);
    try testing.expect(points[0].time_unix_nano >= a.time_unix_nano);
}

test "delta and cumulative temporality across two collections" {
    var cumulative: Harness = undefined;
    try cumulative.init(.{}, .cumulative);
    defer cumulative.deinit();
    var delta: Harness = undefined;
    try delta.init(.{}, .delta);
    defer delta.deinit();

    for ([_]*Harness{ &cumulative, &delta }) |h| {
        const m = h.meter();
        m.counter(f64, "bytes", .{}).add(.background, 1.5, &.{kv("dir", "in")});
        m.upDownCounter(i64, "active", .{}).add(.background, 3, &.{});
        m.histogram(f64, "latency", .{}).record(.background, 7, &.{});
    }

    var c1 = try cumulative.collect();
    defer c1.deinit();
    var d1 = try delta.collect();
    defer d1.deinit();
    try testing.expectEqual(@as(f64, 1.5), c1.find("bytes").?.data.sum.data_points[0].value.double);
    try testing.expectEqual(@as(f64, 1.5), d1.find("bytes").?.data.sum.data_points[0].value.double);
    try testing.expectEqual(instrument.Temporality.delta, d1.find("bytes").?.data.sum.temporality);
    // The delta preference keeps up-down counters cumulative.
    try testing.expectEqual(instrument.Temporality.cumulative, d1.find("active").?.data.sum.temporality);
    try testing.expectEqual(instrument.Temporality.delta, d1.find("latency").?.data.histogram.temporality);

    for ([_]*Harness{ &cumulative, &delta }) |h| {
        const m = h.meter();
        m.counter(f64, "bytes", .{}).add(.background, 2, &.{kv("dir", "in")});
        m.upDownCounter(i64, "active", .{}).add(.background, -1, &.{});
    }
    var c2 = try cumulative.collect();
    defer c2.deinit();
    var d2 = try delta.collect();
    defer d2.deinit();
    try testing.expectEqual(@as(f64, 3.5), c2.find("bytes").?.data.sum.data_points[0].value.double);
    const delta_bytes = d2.find("bytes").?.data.sum.data_points[0];
    try testing.expectEqual(@as(f64, 2), delta_bytes.value.double);
    // A delta point starts where the previous collection ended.
    try testing.expectEqual(d1.find("bytes").?.data.sum.data_points[0].time_unix_nano, delta_bytes.start_time_unix_nano);
    try testing.expectEqual(@as(i64, 2), c2.find("active").?.data.sum.data_points[0].value.int);
    try testing.expectEqual(@as(i64, 2), d2.find("active").?.data.sum.data_points[0].value.int);
    // A cumulative histogram keeps reporting; a delta one without new
    // measurements has no points, so no metric.
    try testing.expectEqual(@as(u64, 1), c2.find("latency").?.data.histogram.data_points[0].count);
    try testing.expectEqual(null, d2.find("latency"));
}

test "a histogram uses the default bounds and records count, sum, min and max" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    const hist = h.meter().histogram(i64, "size", .{ .unit = "By" });
    for ([_]i64{ 0, 5, 6, 10000, 20000 }) |v| hist.record(.background, v, &.{});
    var rm = try h.collect();
    defer rm.deinit();
    const p = rm.find("size").?.data.histogram.data_points[0];
    try testing.expectEqualSlices(f64, &view.default_boundaries, p.bounds);
    try testing.expectEqual(@as(usize, 16), p.bucket_counts.len);
    try testing.expectEqual(@as(u64, 5), p.count);
    try testing.expectEqual(@as(i64, 30011), p.sum.?.int);
    try testing.expectEqual(@as(i64, 0), p.min.?.int);
    try testing.expectEqual(@as(i64, 20000), p.max.?.int);
    try testing.expectEqual(@as(u64, 1), p.bucket_counts[0]);
    try testing.expectEqual(@as(u64, 1), p.bucket_counts[1]);
    try testing.expectEqual(@as(u64, 1), p.bucket_counts[2]);
    try testing.expectEqual(@as(u64, 1), p.bucket_counts[14]);
    try testing.expectEqual(@as(u64, 1), p.bucket_counts[15]);
}

test "advisory histogram bounds apply unless a view sets the aggregation" {
    var h: Harness = undefined;
    try h.init(.{ .views = &.{.{ .instrument_name = "with.view", .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &.{100} } } }} }, .cumulative);
    defer h.deinit();
    const m = h.meter();
    m.histogram(f64, "advised", .{ .explicit_bucket_boundaries = &.{ 0.1, 1 } }).record(.background, 0.5, &.{});
    m.histogram(f64, "bad.advice", .{ .explicit_bucket_boundaries = &.{ 1, 0.1 } }).record(.background, 0.5, &.{});
    m.histogram(f64, "with.view", .{ .explicit_bucket_boundaries = &.{ 0.1, 1 } }).record(.background, 0.5, &.{});
    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqualSlices(f64, &.{ 0.1, 1 }, rm.find("advised").?.data.histogram.data_points[0].bounds);
    try testing.expectEqual(@as(usize, 15), rm.find("bad.advice").?.data.histogram.data_points[0].bounds.len);
    try testing.expectEqualSlices(f64, &.{100}, rm.find("with.view").?.data.histogram.data_points[0].bounds);
}

test "a gauge reports the last value, and up-down histograms record no sum" {
    var h: Harness = undefined;
    try h.init(.{ .views = &.{.{ .instrument_name = "queue.depth", .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &.{ 1, 10 } } } }} }, .cumulative);
    defer h.deinit();
    const m = h.meter();
    const g = m.gauge(f64, "temperature", .{});
    g.record(.background, 20.5, &.{});
    g.record(.background, 19, &.{});
    m.upDownCounter(i64, "queue.depth", .{}).add(.background, 4, &.{});
    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(f64, 19), rm.find("temperature").?.data.gauge.data_points[0].value.double);
    const p = rm.find("queue.depth").?.data.histogram.data_points[0];
    try testing.expectEqual(null, p.sum);
    try testing.expectEqual(@as(i64, 4), p.max.?.int);
}

test "views rename, set buckets, keep attribute keys and drop streams" {
    var h: Harness = undefined;
    try h.init(.{
        .views = &.{
            .{ .instrument_name = "http.server.duration", .name = "http.server.request.duration", .unit = "s" },
            .{ .instrument_name = "db.*", .instrument_kind = .histogram, .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &.{ 0.01, 0.1, 1 } } } },
            .{ .instrument_name = "jobs", .attribute_keys = &.{"queue"} },
            .{ .instrument_name = "noisy.*", .aggregation = .drop },
            // A wildcard with a rename matches nothing, as in Go.
            .{ .instrument_name = "kept.*", .name = "collides" },
            // A view with no criteria matches nothing.
            .{ .name = "nothing" },
        },
    }, .cumulative);
    defer h.deinit();
    const m = h.meter();
    m.histogram(f64, "http.server.duration", .{ .unit = "ms" }).record(.background, 0.2, &.{});
    m.histogram(f64, "db.client.duration", .{}).record(.background, 0.05, &.{});
    m.counter(i64, "db.client.calls", .{}).add(.background, 1, &.{});
    const jobs = m.counter(i64, "jobs", .{});
    jobs.add(.background, 1, &.{ kv("queue", "mail"), kv("job.id", "1") });
    jobs.add(.background, 1, &.{ kv("queue", "mail"), kv("job.id", "2") });
    m.counter(i64, "noisy.counter", .{}).add(.background, 1, &.{});
    m.counter(i64, "kept.counter", .{}).add(.background, 1, &.{});

    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(null, rm.find("http.server.duration"));
    try testing.expectEqualStrings("s", rm.find("http.server.request.duration").?.unit);
    try testing.expectEqualSlices(f64, &.{ 0.01, 0.1, 1 }, rm.find("db.client.duration").?.data.histogram.data_points[0].bounds);
    // The kind criterion keeps the bucket view off the counter.
    try testing.expect(rm.find("db.client.calls").?.data == .sum);
    const job_points = rm.find("jobs").?.data.sum.data_points;
    try testing.expectEqual(@as(usize, 1), job_points.len);
    try testing.expectEqual(@as(i64, 2), job_points[0].value.int);
    try testing.expectEqual(@as(usize, 1), job_points[0].attributes.len);
    try testing.expectEqualStrings("queue", job_points[0].attributes[0].key);
    try testing.expectEqual(null, rm.find("noisy.counter"));
    try testing.expect(rm.find("kept.counter") != null);
    try testing.expectEqual(null, rm.find("collides"));
    try testing.expectEqual(null, rm.find("nothing"));
}

test "two matching views give two streams, and an incompatible aggregation gives none" {
    var h: Harness = undefined;
    try h.init(.{ .views = &.{
        .{ .instrument_name = "calls", .name = "calls.a" },
        .{ .instrument_name = "calls", .name = "calls.b", .attribute_keys = &.{} },
        .{ .instrument_name = "level", .aggregation = .sum },
    } }, .cumulative);
    defer h.deinit();
    const m = h.meter();
    m.counter(i64, "calls", .{}).add(.background, 3, &.{kv("k", "v")});
    m.gauge(i64, "level", .{}).record(.background, 3, &.{});
    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(usize, 1), rm.find("calls.a").?.data.sum.data_points[0].attributes.len);
    try testing.expectEqual(@as(usize, 0), rm.find("calls.b").?.data.sum.data_points[0].attributes.len);
    try testing.expectEqual(null, rm.find("calls"));
    try testing.expectEqual(null, rm.find("level"));
}

test "the default cardinality limit is 2000 series, with an overflow series" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    const c = h.meter().counter(i64, "per.user", .{});
    var buf: [16]u8 = undefined;
    for (0..2100) |i| {
        const id = try std.fmt.bufPrint(&buf, "u{d}", .{i});
        c.add(.background, 1, &.{kv("user", id)});
    }
    // A set seen before the limit was reached keeps its own series.
    c.add(.background, 1, &.{kv("user", "u0")});

    var rm = try h.collect();
    defer rm.deinit();
    const points = rm.find("per.user").?.data.sum.data_points;
    try testing.expectEqual(@as(usize, 2000), points.len);
    var overflow: ?i64 = null;
    for (points) |p| {
        if (attribute.find(p.attributes, "otel.metric.overflow")) |v| {
            try testing.expect(v.bool);
            try testing.expectEqual(@as(usize, 1), p.attributes.len);
            overflow = p.value.int;
        }
    }
    // 1999 sets have their own series; the other 101 overflow.
    try testing.expectEqual(@as(i64, 101), overflow.?);
    try testing.expectEqual(@as(i64, 2), pointWith(points, "user", "u0").?.value.int);
}

test "a smaller limit overflows sooner, and a delta stream starts over each collection" {
    var h: Harness = undefined;
    try h.init(.{ .cardinality_limit = 3 }, .delta);
    defer h.deinit();
    const c = h.meter().counter(i64, "c", .{});
    for ([_][]const u8{ "a", "b", "c", "d" }) |v| c.add(.background, 1, &.{kv("k", v)});
    var rm = try h.collect();
    defer rm.deinit();
    const points = rm.find("c").?.data.sum.data_points;
    try testing.expectEqual(@as(usize, 3), points.len);
    try testing.expectEqual(@as(i64, 2), points[2].value.int);
    try testing.expect(attribute.find(points[2].attributes, "otel.metric.overflow") != null);

    for ([_][]const u8{ "c", "d" }) |v| c.add(.background, 1, &.{kv("k", v)});
    var rm2 = try h.collect();
    defer rm2.deinit();
    const again = rm2.find("c").?.data.sum.data_points;
    try testing.expectEqual(@as(usize, 2), again.len);
    try testing.expect(pointWith(again, "k", "c") != null);
    try testing.expect(pointWith(again, "k", "d") != null);
}

test "exemplars appear only under a sampled span, with the filtered attributes" {
    var h: Harness = undefined;
    try h.init(.{ .views = &.{.{ .instrument_name = "latency", .attribute_keys = &.{"route"} }} }, .cumulative);
    defer h.deinit();
    const hist = h.meter().histogram(f64, "latency", .{});
    var unsampled_sc = sampled_sc;
    unsampled_sc.flags = .{};
    hist.record(.background, 1, &.{kv("route", "/none")});
    hist.record(Context.background.withSpanContext(unsampled_sc), 1, &.{kv("route", "/unsampled")});
    hist.record(sampledCtx(), 42, &.{ kv("route", "/sampled"), kv("user.id", "u-17") });

    var rm = try h.collect();
    defer rm.deinit();
    const points = rm.find("latency").?.data.histogram.data_points;
    try testing.expectEqual(@as(usize, 0), pointWith(points, "route", "/none").?.exemplars.len);
    try testing.expectEqual(@as(usize, 0), pointWith(points, "route", "/unsampled").?.exemplars.len);
    const p = pointWith(points, "route", "/sampled").?;
    try testing.expectEqual(@as(usize, 1), p.attributes.len);
    try testing.expectEqual(@as(usize, 1), p.exemplars.len);
    const e = p.exemplars[0];
    try testing.expectEqualSlices(u8, &sampled_sc.trace_id.bytes, &e.trace_id.bytes);
    try testing.expectEqualSlices(u8, &sampled_sc.span_id.bytes, &e.span_id.bytes);
    try testing.expectEqual(@as(f64, 42), e.value.double);
    try testing.expect(e.time_unix_nano > 0);
    try testing.expectEqual(@as(usize, 1), e.filtered_attributes.len);
    try testing.expectEqualStrings("user.id", e.filtered_attributes[0].key);
    try testing.expectEqualStrings("u-17", e.filtered_attributes[0].value.string);
}

test "exemplars follow a live span from the tracer" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    const tp = try tracer_mod.TracerProvider.create(gpa, io, .{});
    defer tp.destroy();
    var span = tp.tracer(.{ .name = "t" }).start(.background, "op", .{});
    const ctx = Context.background.withSpan(&span);
    h.meter().counter(i64, "ops", .{}).add(ctx, 1, &.{});
    span.end();

    var rm = try h.collect();
    defer rm.deinit();
    const e = rm.find("ops").?.data.sum.data_points[0].exemplars;
    try testing.expectEqual(@as(usize, 1), e.len);
    try testing.expectEqualSlices(u8, &ctx.span_context.trace_id.bytes, &e[0].trace_id.bytes);
}

test "always-off keeps no exemplars and always-on keeps them without a span" {
    var off: Harness = undefined;
    try off.init(.{ .exemplar_filter = .always_off }, .cumulative);
    defer off.deinit();
    var on: Harness = undefined;
    try on.init(.{ .exemplar_filter = .always_on }, .cumulative);
    defer on.deinit();
    off.meter().counter(i64, "c", .{}).add(sampledCtx(), 1, &.{});
    on.meter().counter(i64, "c", .{}).add(.background, 1, &.{});
    var off_rm = try off.collect();
    defer off_rm.deinit();
    var on_rm = try on.collect();
    defer on_rm.deinit();
    try testing.expectEqual(@as(usize, 0), off_rm.find("c").?.data.sum.data_points[0].exemplars.len);
    const e = on_rm.find("c").?.data.sum.data_points[0].exemplars;
    try testing.expectEqual(@as(usize, 1), e.len);
    try testing.expect(!e[0].trace_id.isValid());
}

/// A policy that drops `user.email` from metric attributes, and counts
/// its calls per target.
const DropEmail = struct {
    metric_calls: std.atomic.Value(usize) = .init(0),

    fn policy(self: *DropEmail) policy_mod.AttributePolicy {
        return .{ .ptr = self, .vtable = &.{ .apply = apply } };
    }

    fn apply(ptr: ?*anyopaque, target: policy_mod.Target, attrs: []KeyValue, _: std.mem.Allocator) []KeyValue {
        const self: *DropEmail = @ptrCast(@alignCast(ptr.?));
        if (target != .metric) return attrs;
        _ = self.metric_calls.fetchAdd(1, .monotonic);
        var n: usize = 0;
        for (attrs) |a| {
            if (std.mem.eql(u8, a.key, "user.email")) continue;
            attrs[n] = a;
            n += 1;
        }
        return attrs[0..n];
    }
};

test "the policy classifies measurement attributes once, before streams and exemplars" {
    var drop: DropEmail = .{};
    var h: Harness = undefined;
    try h.init(.{
        .policy = drop.policy(),
        .views = &.{
            .{ .instrument_name = "logins", .name = "logins.by.method", .attribute_keys = &.{"method"} },
            .{ .instrument_name = "logins" },
        },
    }, .cumulative);
    defer h.deinit();
    h.meter().counter(i64, "logins", .{}).add(sampledCtx(), 1, &.{ kv("method", "sso"), kv("user.email", "a@example.com") });
    try testing.expectEqual(@as(usize, 1), drop.metric_calls.load(.monotonic));

    var rm = try h.collect();
    defer rm.deinit();
    const all = rm.find("logins").?.data.sum.data_points[0];
    try testing.expectEqual(null, attribute.find(all.attributes, "user.email"));
    const by_method = rm.find("logins.by.method").?.data.sum.data_points[0];
    // The view filtered nothing else, so the exemplar has no filtered
    // attributes: the email never reached it.
    try testing.expectEqual(@as(usize, 0), by_method.exemplars[0].filtered_attributes.len);
}

const Gauges = struct {
    calls: usize = 0,
    value: i64 = 10,

    fn observeOne(ptr: ?*anyopaque, o: meter_mod.Observation(i64)) void {
        const self: *Gauges = @ptrCast(@alignCast(ptr.?));
        self.calls += 1;
        o.observe(self.value, &.{kv("pool", "main")});
    }
};

test "observable instruments report what their callbacks observe" {
    var h: Harness = undefined;
    try h.init(.{}, .delta);
    defer h.deinit();
    const m = h.meter();
    var state: Gauges = .{};
    _ = m.observableGauge(i64, "pool.size", .{ .callbacks = &.{.{ .ptr = &state, .func = Gauges.observeOne }} });
    const total = m.observableCounter(f64, "cpu.time", .{});
    const live = m.observableUpDownCounter(i64, "threads", .{});
    const unregistered = m.observableCounter(i64, "not.registered", .{});

    const Multi = struct {
        cpu: f64 = 1.5,
        total: meter_mod.ObservableCounter(f64),
        live: meter_mod.ObservableUpDownCounter(i64),
        stray: meter_mod.ObservableCounter(i64),

        fn run(ptr: ?*anyopaque, o: meter_mod.Observer) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            o.observe(self.total, self.cpu, &.{kv("state", "user")});
            o.observe(self.live, 4, &.{});
            // Not registered with this callback: ignored.
            o.observe(self.stray, 1, &.{});
        }
    };
    var multi: Multi = .{ .total = total, .live = live, .stray = unregistered };
    var reg = m.registerCallback(.{ .ptr = &multi, .func = Multi.run }, &.{ total.observable(), live.observable() });

    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(usize, 1), state.calls);
    try testing.expectEqual(@as(i64, 10), rm.find("pool.size").?.data.gauge.data_points[0].value.int);
    const cpu = rm.find("cpu.time").?.data.sum;
    try testing.expect(cpu.is_monotonic);
    try testing.expectEqual(instrument.Temporality.delta, cpu.temporality);
    try testing.expectEqual(@as(f64, 1.5), cpu.data_points[0].value.double);
    try testing.expect(!rm.find("threads").?.data.sum.is_monotonic);
    try testing.expectEqual(null, rm.find("not.registered"));

    // A delta observable counter reports the change since the last
    // collection; the up-down counter stays cumulative.
    multi.cpu = 4;
    state.value = 12;
    var rm2 = try h.collect();
    defer rm2.deinit();
    try testing.expectEqual(@as(f64, 2.5), rm2.find("cpu.time").?.data.sum.data_points[0].value.double);
    try testing.expectEqual(@as(i64, 4), rm2.find("threads").?.data.sum.data_points[0].value.int);
    try testing.expectEqual(@as(i64, 12), rm2.find("pool.size").?.data.gauge.data_points[0].value.int);

    // After unregistering, only the instrument callback runs, and the
    // unobserved instruments report nothing.
    reg.unregister();
    reg.unregister();
    var rm3 = try h.collect();
    defer rm3.deinit();
    try testing.expectEqual(null, rm3.find("cpu.time"));
    try testing.expectEqual(null, rm3.find("threads"));
    try testing.expect(rm3.find("pool.size") != null);
    try testing.expectEqual(@as(usize, 3), state.calls);
}

test "cumulative observable counters report the observed total" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    var state: Gauges = .{ .value = 7 };
    _ = h.meter().observableCounter(i64, "page.faults", .{ .callbacks = &.{.{ .ptr = &state, .func = Gauges.observeOne }} });
    var rm = try h.collect();
    defer rm.deinit();
    state.value = 9;
    var rm2 = try h.collect();
    defer rm2.deinit();
    const p1 = rm.find("page.faults").?.data.sum.data_points[0];
    const p2 = rm2.find("page.faults").?.data.sum.data_points[0];
    try testing.expectEqual(@as(i64, 7), p1.value.int);
    try testing.expectEqual(@as(i64, 9), p2.value.int);
    try testing.expectEqual(p1.start_time_unix_nano, p2.start_time_unix_nano);
}

test "observable instruments keep no exemplars under the trace-based filter" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    var state: Gauges = .{};
    _ = h.meter().observableGauge(i64, "g", .{ .callbacks = &.{.{ .ptr = &state, .func = Gauges.observeOne }} });
    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(usize, 0), rm.find("g").?.data.gauge.data_points[0].exemplars.len);
}

test "instruments with the same identity are one instrument" {
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    const m = h.meter();
    const a = m.counter(i64, "Requests", .{});
    const b = m.counter(i64, "requests", .{});
    try testing.expectEqual(a.inst, b.inst);
    const f = m.counter(f64, "requests", .{});
    try testing.expect(@as(*const anyopaque, f.inst.?) != @as(*const anyopaque, a.inst.?));
    try testing.expect(m.upDownCounter(i64, "requests", .{}).inst != null);
    try testing.expectEqual(m, h.provider.meter(.{ .name = "github.com/jamesainslie/libo11y/zig/test", .version = "0.0.0" }));
    a.add(.background, 1, &.{});
    b.add(.background, 1, &.{});
    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqualStrings("Requests", rm.scope_metrics[0].metrics[0].name);
    try testing.expectEqual(@as(i64, 2), rm.scope_metrics[0].metrics[0].data.sum.data_points[0].value.int);
}

test "no-op instruments, instruments with no data, and shutdown" {
    meter_mod.Meter.noop.counter(i64, "x", .{}).add(.background, 1, &.{});
    meter_mod.Counter(f64).noop.add(.background, 1, &.{});
    var h: Harness = undefined;
    try h.init(.{}, .cumulative);
    defer h.deinit();
    _ = h.meter().counter(i64, "unused", .{});
    var rm = try h.collect();
    try testing.expectEqual(@as(usize, 0), rm.scope_metrics.len);
    rm.deinit();

    const c = h.meter().counter(i64, "late", .{});
    try h.provider.shutdown(deadline.after(io, .fromSeconds(1)));
    c.add(.background, 1, &.{});
    try testing.expectError(error.Shutdown, h.reader.collect(gpa));
    try testing.expectEqual(null, h.meter().counter(i64, "after", .{}).inst);
}

test "an unregistered manual reader reports NotRegistered" {
    var r: reader_mod.ManualReader = .init(io, .{});
    try testing.expectError(error.NotRegistered, r.collect(gpa));
}

test "instrument names follow Go's validation" {
    try testing.expect(meter_mod.validInstrumentName("http.server.request.duration"));
    try testing.expect(meter_mod.validInstrumentName("a"));
    try testing.expect(meter_mod.validInstrumentName("a_b-c/d.e1"));
    try testing.expect(!meter_mod.validInstrumentName(""));
    try testing.expect(!meter_mod.validInstrumentName("1abc"));
    try testing.expect(!meter_mod.validInstrumentName("a b"));
    const too_long: [256]u8 = @splat('a');
    try testing.expect(!meter_mod.validInstrumentName(&too_long));
    const max_len: [255]u8 = @splat('a');
    try testing.expect(meter_mod.validInstrumentName(&max_len));
}

test "recording from several threads during collection loses nothing" {
    var h: Harness = undefined;
    try h.init(.{ .exemplar_filter = .always_on }, .delta);
    defer h.deinit();
    const c = h.meter().counter(i64, "work", .{});
    const hist = h.meter().histogram(f64, "work.size", .{});

    const threads = 4;
    const per_thread = 5000;
    var finished: std.atomic.Value(usize) = .init(0);
    const Worker = struct {
        fn run(counter: meter_mod.Counter(i64), histogram: meter_mod.Histogram(f64), done: *std.atomic.Value(usize), id: usize) void {
            defer _ = done.fetchAdd(1, .release);
            var buf: [8]u8 = undefined;
            for (0..per_thread) |i| {
                const key = std.fmt.bufPrint(&buf, "w{d}", .{(i + id) % 8}) catch unreachable;
                counter.add(.background, 1, &.{kv("shard", key)});
                histogram.record(sampledCtx(), @floatFromInt(i % 100), &.{});
            }
        }
    };
    var handles: [threads]std.Thread = undefined;
    for (&handles, 0..) |*t, i| t.* = try std.Thread.spawn(.{}, Worker.run, .{ c, hist, &finished, i });

    var total: i64 = 0;
    var hist_total: u64 = 0;
    while (finished.load(.acquire) < threads) {
        var rm = try h.collect();
        defer rm.deinit();
        if (rm.find("work")) |m| for (m.data.sum.data_points) |p| {
            total += p.value.int;
        };
        if (rm.find("work.size")) |m| for (m.data.histogram.data_points) |p| {
            hist_total += p.count;
        };
    }
    for (handles) |t| t.join();
    var last = try h.collect();
    defer last.deinit();
    if (last.find("work")) |m| for (m.data.sum.data_points) |p| {
        total += p.value.int;
    };
    if (last.find("work.size")) |m| for (m.data.histogram.data_points) |p| {
        hist_total += p.count;
    };
    try testing.expectEqual(@as(i64, threads * per_thread), total);
    try testing.expectEqual(@as(u64, threads * per_thread), hist_total);
}

test "the periodic reader exports on its interval, on flush and at shutdown" {
    var exporter: memory_exporter.InMemoryExporter = .init(gpa, io, .{ .temporality = .delta });
    defer exporter.deinit();
    const r = try reader_mod.PeriodicReader.create(gpa, io, exporter.exporter(), .{ .interval = .fromMilliseconds(30), .timeout = .fromSeconds(5) });
    defer r.destroy();
    const p = try MeterProvider.create(gpa, io, .{ .readers = &.{r.reader()} });
    defer p.destroy();
    const c = p.meter(.{ .name = "m" }).counter(i64, "ticks", .{});
    c.add(.background, 1, &.{});

    // The background task exports on its own.
    const until = deadline.after(io, .fromSeconds(5));
    while (exporter.count() < 2 and !deadline.expired(io, until)) try io.sleep(.fromMilliseconds(5), .awake);
    try testing.expect(exporter.count() >= 2);

    exporter.reset();
    c.add(.background, 2, &.{});
    try p.forceFlush(deadline.after(io, .fromSeconds(5)));
    try testing.expect(exporter.count() >= 1);
    try testing.expect(exporter.flush_calls >= 1);

    exporter.reset();
    c.add(.background, 5, &.{});
    try p.shutdown(deadline.after(io, .fromSeconds(5)));
    // The final collection carries what was recorded before shutdown.
    var found = false;
    for (0..exporter.count()) |i| {
        var rm = try exporter.get(gpa, i);
        defer rm.deinit();
        if (rm.find("ticks")) |m| {
            try testing.expectEqual(instrument.Temporality.delta, m.data.sum.temporality);
            if (m.data.sum.data_points[0].value.int == 5) found = true;
        }
    }
    try testing.expect(found);
    try testing.expect(exporter.is_shutdown);
    try testing.expectError(error.Shutdown, r.forceFlush(deadline.after(io, .fromSeconds(1))));
    // A second shutdown returns the first result.
    try r.shutdown(deadline.after(io, .fromSeconds(1)));
}

test "periodic export failures go to the error handler" {
    const Count = struct {
        n: std.atomic.Value(usize) = .init(0),
        fn report(ptr: ?*anyopaque, _: []const u8, _: @import("../processor.zig").ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            _ = self.n.fetchAdd(1, .monotonic);
        }
    };
    var count: Count = .{};
    var exporter: memory_exporter.InMemoryExporter = .init(gpa, io, .{});
    defer exporter.deinit();
    exporter.fail_with = error.ExportFailed;
    const r = try reader_mod.PeriodicReader.create(gpa, io, exporter.exporter(), .{
        .interval = .fromMilliseconds(10),
        .on_error = .{ .ptr = &count, .report = Count.report },
    });
    defer r.destroy();
    const p = try MeterProvider.create(gpa, io, .{ .readers = &.{r.reader()} });
    defer p.destroy();
    const until = deadline.after(io, .fromSeconds(5));
    while (count.n.load(.monotonic) == 0 and !deadline.expired(io, until)) try io.sleep(.fromMilliseconds(5), .awake);
    try testing.expect(count.n.load(.monotonic) > 0);
    try testing.expectError(error.ExportFailed, p.shutdown(deadline.after(io, .fromSeconds(5))));
}

test "the policy classifies observable callback attributes" {
    var drop: DropEmail = .{};
    var h: Harness = undefined;
    try h.init(.{ .policy = drop.policy() }, .cumulative);
    defer h.deinit();

    const Obs = struct {
        fn run(_: ?*anyopaque, o: meter_mod.Observation(i64)) void {
            o.observe(42, &.{ kv("pool", "main"), kv("user.email", "a@example.com") });
        }
    };
    _ = h.meter().observableGauge(i64, "obs.policy", .{ .callbacks = &.{.{ .func = Obs.run }} });

    var rm = try h.collect();
    defer rm.deinit();
    try testing.expectEqual(@as(usize, 1), drop.metric_calls.load(.monotonic));
    const p = rm.find("obs.policy").?.data.gauge.data_points[0];
    try testing.expectEqual(@as(i64, 42), p.value.int);
    try testing.expectEqual(@as(usize, 1), p.attributes.len);
    try testing.expectEqualStrings("pool", p.attributes[0].key);
    try testing.expectEqual(null, attribute.find(p.attributes, "user.email"));
}

test "concurrent MeterProvider.shutdown waits for the first call and shares its result" {
    const ExportError = @import("../processor.zig").ExportError;
    const BlockingReader = struct {
        entered: Io.Event = .unset,
        release: Io.Event = .unset,
        calls: std.atomic.Value(usize) = .init(0),

        fn reader(self: *@This()) reader_mod.Reader {
            return .{ .ptr = self, .vtable = &.{
                .register = register,
                .temporality = temporality,
                .forceFlush = forceFlush,
                .shutdown = shutdown,
            } };
        }
        fn register(_: *anyopaque, _: reader_mod.Producer) void {}
        fn temporality(_: *anyopaque) instrument.TemporalityPreference {
            return .cumulative;
        }
        fn forceFlush(_: *anyopaque, _: deadline.Deadline) ExportError!void {}
        fn shutdown(ptr: *anyopaque, d: deadline.Deadline) ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            _ = self.calls.fetchAdd(1, .monotonic);
            self.entered.set(io);
            self.release.waitTimeout(io, deadline.timeout(d)) catch return error.Timeout;
            return error.ExportFailed;
        }
    };

    var blocking: BlockingReader = .{};
    const p = try MeterProvider.create(gpa, io, .{ .readers = &.{blocking.reader()} });
    defer p.destroy();

    const Runner = struct {
        fn call(provider: *MeterProvider, d: deadline.Deadline) ExportError!void {
            return provider.shutdown(d);
        }
    };

    var first = try io.concurrent(Runner.call, .{ p, deadline.after(io, .fromSeconds(5)) });
    try blocking.entered.waitTimeout(io, deadline.timeout(deadline.after(io, .fromSeconds(5))));

    // A concurrent caller with a short deadline times out while the first is still running.
    try testing.expectError(error.Timeout, p.shutdown(deadline.after(io, .fromMilliseconds(20))));

    // A concurrent caller with enough budget waits for the first and receives its error.
    var second = try io.concurrent(Runner.call, .{ p, deadline.after(io, .fromSeconds(5)) });
    try io.sleep(.fromMilliseconds(10), .awake);
    blocking.release.set(io);

    try testing.expectError(error.ExportFailed, first.await(io));
    try testing.expectError(error.ExportFailed, second.await(io));
    // A subsequent call immediately returns the cached result.
    try testing.expectError(error.ExportFailed, p.shutdown(deadline.after(io, .fromSeconds(1))));
    try testing.expectEqual(@as(usize, 1), blocking.calls.load(.monotonic));
}

test "unregistered PeriodicReader shuts down cleanly without firing on_error" {
    const Count = struct {
        n: std.atomic.Value(usize) = .init(0),
        fn report(ptr: ?*anyopaque, _: []const u8, _: @import("../processor.zig").ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            _ = self.n.fetchAdd(1, .monotonic);
        }
    };
    var count: Count = .{};
    var exporter: memory_exporter.InMemoryExporter = .init(gpa, io, .{});
    defer exporter.deinit();
    const r = try reader_mod.PeriodicReader.create(gpa, io, exporter.exporter(), .{
        .interval = .fromMilliseconds(10),
        .on_error = .{ .ptr = &count, .report = Count.report },
    });
    defer r.destroy();

    // Let a couple of periodic ticks fire while unregistered.
    try io.sleep(.fromMilliseconds(30), .awake);
    try testing.expectEqual(@as(usize, 0), count.n.load(.monotonic));

    // Shutdown skips collection cleanly and still shuts down the exporter.
    try r.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 0), count.n.load(.monotonic));
    try testing.expect(exporter.is_shutdown);
}

test "PeriodicReader shutdown and forceFlush respect deadlines behind a hanging export" {
    const ExportError = @import("../processor.zig").ExportError;
    const HangingExporter = struct {
        entered: Io.Event = .unset,
        release: Io.Event = .unset,
        shutdown_called: std.atomic.Value(bool) = .init(false),
        export_calls: std.atomic.Value(usize) = .init(0),

        fn exporter(self: *@This()) reader_mod.MetricExporter {
            return .{
                .ptr = self,
                .vtable = &.{ .exportMetrics = exportMetrics, .forceFlush = forceFlush, .shutdown = shutdown },
                .temporality = .delta,
            };
        }
        fn exportMetrics(ptr: *anyopaque, _: *const data.ResourceMetrics, d: deadline.Deadline) ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            _ = self.export_calls.fetchAdd(1, .monotonic);
            self.entered.set(io);
            self.release.waitTimeout(io, deadline.timeout(d)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
        }
        fn forceFlush(_: *anyopaque, _: deadline.Deadline) ExportError!void {}
        fn shutdown(ptr: *anyopaque, _: deadline.Deadline) ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.shutdown_called.store(true, .release);
        }
    };

    var exp: HangingExporter = .{};
    const r = try reader_mod.PeriodicReader.create(gpa, io, exp.exporter(), .{
        .interval = .fromSeconds(60),
        .timeout = .fromSeconds(5),
    });
    defer r.destroy();
    const p = try MeterProvider.create(gpa, io, .{ .readers = &.{r.reader()} });
    defer p.destroy();
    const c = p.meter(.{ .name = "m" }).counter(i64, "c", .{});
    c.add(.background, 1, &.{});

    const FlushTask = struct {
        fn run(reader: *reader_mod.PeriodicReader, d: deadline.Deadline) ExportError!void {
            return reader.forceFlush(d);
        }
    };

    // Start a long-running forceFlush that blocks inside exportMetrics.
    var stuck = try io.concurrent(FlushTask.run, .{ r, deadline.after(io, .fromSeconds(5)) });
    try exp.entered.waitTimeout(io, deadline.timeout(deadline.after(io, .fromSeconds(5))));

    // A second forceFlush with a short deadline times out promptly.
    const flush_start = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, r.forceFlush(deadline.after(io, .fromMilliseconds(40))));
    try testing.expect(-deadline.remaining(io, flush_start).toMilliseconds() < 1000);

    // Queue another forceFlush with a long deadline, then call shutdown with a
    // short deadline: shutdown must time out promptly AND still shut down the
    // exporter, and the queued forceFlush must return Shutdown without
    // starting another export.
    var queued = try io.concurrent(FlushTask.run, .{ r, deadline.after(io, .fromSeconds(5)) });
    try io.sleep(.fromMilliseconds(10), .awake);

    const sd_start = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, r.shutdown(deadline.after(io, .fromMilliseconds(40))));
    try testing.expect(-deadline.remaining(io, sd_start).toMilliseconds() < 1000);
    try testing.expect(exp.shutdown_called.load(.acquire));

    // Unblock the in-flight export and verify the queued forceFlush got Shutdown.
    exp.release.set(io);
    try stuck.await(io);
    try testing.expectError(error.Shutdown, queued.await(io));
    try testing.expectEqual(@as(usize, 1), exp.export_calls.load(.monotonic));
}

test "observable gauge with a cumulative histogram view accumulates across collections" {
    var h: Harness = undefined;
    try h.init(.{ .views = &.{.{
        .instrument_name = "obs.latency",
        .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &.{ 10, 50 } } },
    }} }, .cumulative);
    defer h.deinit();

    var state: Gauges = .{ .value = 5 };
    _ = h.meter().observableGauge(i64, "obs.latency", .{
        .callbacks = &.{.{ .ptr = &state, .func = Gauges.observeOne }},
    });

    var rm1 = try h.collect();
    defer rm1.deinit();
    const p1 = rm1.find("obs.latency").?.data.histogram.data_points[0];
    try testing.expectEqual(@as(u64, 1), p1.count);
    try testing.expectEqualSlices(u64, &.{ 1, 0, 0 }, p1.bucket_counts);

    state.value = 30;
    var rm2 = try h.collect();
    defer rm2.deinit();
    const p2 = rm2.find("obs.latency").?.data.histogram.data_points[0];
    try testing.expectEqual(p1.start_time_unix_nano, p2.start_time_unix_nano);
    try testing.expectEqual(@as(u64, 2), p2.count);
    try testing.expectEqual(@as(i64, 5), p2.min.?.int);
    try testing.expectEqual(@as(i64, 30), p2.max.?.int);
    try testing.expectEqualSlices(u64, &.{ 1, 1, 0 }, p2.bucket_counts);
}
