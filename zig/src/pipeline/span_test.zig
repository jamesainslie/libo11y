//! Tests for spans and the tracer provider, through the simple processor
//! and the in-memory exporter.

const std = @import("std");
const testing = std.testing;
const Context = @import("../context.zig").Context;
const attribute = @import("attribute.zig");
const kv = attribute.kv;
const ids = @import("ids.zig");
const policy = @import("policy.zig");
const processor = @import("processor.zig");
const InMemoryExporter = @import("memory_exporter.zig").InMemoryExporter;
const resource = @import("resource.zig");
const sampler = @import("sampler.zig");
const span_mod = @import("span.zig");
const SpanData = span_mod.SpanData;
const tracer_mod = @import("tracer.zig");
const deadline = @import("deadline.zig");

const Harness = struct {
    exporter: InMemoryExporter,
    simple: processor.SimpleSpanProcessor,
    provider: *tracer_mod.TracerProvider,

    fn init(h: *Harness, options: tracer_mod.TracerProvider.Options) !void {
        h.exporter = .init(testing.allocator, testing.io);
        h.simple = .init(testing.io, h.exporter.exporter(), .{});
        var opts = options;
        const procs = [_]processor.SpanProcessor{h.simple.processor()};
        if (opts.processors.len == 0) opts.processors = &procs;
        h.provider = try .create(testing.allocator, testing.io, opts);
    }

    fn deinit(h: *Harness) void {
        h.provider.shutdown(deadline.after(testing.io, .fromSeconds(5))) catch {};
        h.exporter.deinit();
        h.provider.destroy();
    }

    fn tracer(h: *Harness) *const tracer_mod.Tracer {
        return h.provider.tracer(.{ .name = "test", .version = "1.0.0" });
    }

    fn only(h: *Harness) !*const SpanData {
        try testing.expectEqual(@as(usize, 1), h.exporter.spans.items.len);
        return h.exporter.spans.items[0];
    }
};

const remote_parent: ids.SpanContext = .{
    .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
    .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
    .flags = .sampled_flag,
    .remote = true,
};

test "a span records its fields and children share its trace" {
    var h: Harness = undefined;
    try h.init(.{ .resource = .{ .attributes = &.{kv("service.name", "svc")}, .schema_url = "https://schemas.o11y.ing/1.1.0" } });
    defer h.deinit();
    const t = h.tracer();

    var parent = t.start(.background, "parent", .{ .kind = .server, .attributes = &.{kv("a", 1)} });
    const ctx = Context.background.withSpan(&parent);
    var child = t.start(ctx, "child", .{});
    try testing.expect(child.spanContext().isValid());
    try testing.expectEqualSlices(u8, &parent.spanContext().trace_id.bytes, &child.spanContext().trace_id.bytes);
    try testing.expect(child.spanContext().isSampled());
    child.end();
    parent.setAttribute("b", "two");
    parent.end();

    try testing.expectEqual(@as(usize, 2), h.exporter.spans.items.len);
    const c = h.exporter.spans.items[0];
    const p = h.exporter.spans.items[1];
    try testing.expectEqualStrings("child", c.name);
    try testing.expectEqualSlices(u8, &p.span_context.span_id.bytes, &c.parent.span_id.bytes);
    try testing.expect(!c.parent.remote);
    try testing.expect(!p.parent.isValid());
    try testing.expectEqual(span_mod.SpanKind.server, p.kind);
    try testing.expectEqual(span_mod.SpanKind.internal, c.kind);
    try testing.expectEqual(@as(i64, 1), attribute.find(p.attributes.items, "a").?.int);
    try testing.expectEqualStrings("two", attribute.find(p.attributes.items, "b").?.string);
    try testing.expect(p.end_time_unix_nano >= p.start_time_unix_nano and p.start_time_unix_nano > 0);
    try testing.expectEqualStrings("svc", p.resource().attributes[0].value.string);
    try testing.expectEqualStrings("test", p.scope().name);
    try testing.expectEqualStrings("1.0.0", p.scope().version);
}

test "a remote parent is kept as remote and new_root starts a new trace" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    const t = h.tracer();
    const ctx = Context.background.withSpanContext(remote_parent);
    var child = t.start(ctx, "child", .{});
    var root = t.start(ctx, "root", .{ .new_root = true });
    child.end();
    root.end();
    const c = h.exporter.spans.items[0];
    try testing.expect(c.parent.remote);
    try testing.expect(c.parent.eql(.{ .trace_id = remote_parent.trace_id, .span_id = remote_parent.span_id, .flags = remote_parent.flags, .remote = true }));
    const r = h.exporter.spans.items[1];
    try testing.expect(!r.parent.isValid());
    try testing.expect(!std.mem.eql(u8, &r.span_context.trace_id.bytes, &remote_parent.trace_id.bytes));
}

test "a span copies every value it is given" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    var key = "key".*;
    var value = "value".*;
    var name = "name".*;
    var event = "event".*;
    var ts = "k=v".*;
    const parent_sc: ids.SpanContext = .{ .trace_id = remote_parent.trace_id, .span_id = remote_parent.span_id, .flags = .sampled_flag, .remote = true, .trace_state = .{ .header = &ts } };
    var s = h.tracer().start(Context.background.withSpanContext(parent_sc), &name, .{});
    s.setAttribute(&key, @as([]const u8, &value));
    s.addEvent(&event, .{ .attributes = &.{kv(&key, @as([]const u8, &value))} });
    s.addLink(.{ .span_context = parent_sc, .attributes = &.{kv(&key, @as([]const u8, &value))} });
    s.setStatus(.@"error", &value);
    @memset(&key, 'x');
    @memset(&value, 'x');
    @memset(&name, 'x');
    @memset(&event, 'x');
    @memset(&ts, 'x');
    s.end();
    const d = try h.only();
    try testing.expectEqualStrings("name", d.name);
    try testing.expectEqualStrings("key", d.attributes.items[0].key);
    try testing.expectEqualStrings("value", d.attributes.items[0].value.string);
    try testing.expectEqualStrings("event", d.events.items[0].name);
    try testing.expectEqualStrings("value", d.events.items[0].attributes[0].value.string);
    try testing.expectEqualStrings("value", d.links.items[0].attributes[0].value.string);
    try testing.expectEqualStrings("k=v", d.links.items[0].span_context.trace_state.header);
    try testing.expectEqualStrings("k=v", d.span_context.trace_state.header);
    try testing.expectEqualStrings("value", d.status.description);
}

test "the default limits drop and count past 128 attributes, events and links" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    var s = h.tracer().start(.background, "limits", .{});
    var buf: [16]u8 = undefined;
    for (0..130) |i| {
        const key = try std.fmt.bufPrint(&buf, "k{d}", .{i});
        s.setAttribute(key, @as(i64, @intCast(i)));
    }
    // Updating a kept key is not a drop.
    s.setAttribute("k0", "updated");
    s.setAttribute("", 1);
    for (0..130) |i| s.addEvent("e", .{ .timestamp = i });
    const link_sc: ids.SpanContext = .{ .trace_id = remote_parent.trace_id, .span_id = remote_parent.span_id };
    for (0..129) |_| s.addLink(.{ .span_context = link_sc });
    // An empty link is ignored.
    s.addLink(.{ .span_context = .invalid });
    s.end();
    const d = try h.only();
    try testing.expectEqual(@as(usize, 128), d.attributes.items.len);
    try testing.expectEqual(@as(u32, 3), d.dropped_attributes_count);
    try testing.expectEqualStrings("updated", d.attributes.items[0].value.string);
    try testing.expectEqual(@as(usize, 128), d.events.items.len);
    try testing.expectEqual(@as(u32, 2), d.dropped_events_count);
    // The oldest events were evicted.
    try testing.expectEqual(@as(u64, 2), d.events.items[0].time_unix_nano);
    try testing.expectEqual(@as(usize, 128), d.links.items.len);
    try testing.expectEqual(@as(u32, 1), d.dropped_links_count);
}

test "custom limits cut values, event and link attributes" {
    var h: Harness = undefined;
    try h.init(.{ .limits = .{ .attribute_value_length = 3, .attributes_per_event = 1, .attributes_per_link = 0, .event_count = 0 } });
    defer h.deinit();
    var s = h.tracer().start(.background, "limits", .{});
    s.setAttribute("long", "abcdef");
    s.addEvent("dropped", .{});
    s.addLink(.{ .span_context = remote_parent, .attributes = &.{ kv("a", 1), kv("b", 2) } });
    s.end();
    const d = try h.only();
    try testing.expectEqualStrings("abc", d.attributes.items[0].value.string);
    try testing.expectEqual(@as(usize, 0), d.events.items.len);
    try testing.expectEqual(@as(u32, 1), d.dropped_events_count);
    try testing.expectEqual(@as(usize, 0), d.links.items[0].attributes.len);
    try testing.expectEqual(@as(u32, 2), d.links.items[0].dropped_attributes_count);

    var h2: Harness = undefined;
    try h2.init(.{ .limits = .{ .attributes_per_event = 1 } });
    defer h2.deinit();
    var s2 = h2.tracer().start(.background, "event attrs", .{});
    s2.addEvent("e", .{ .attributes = &.{ kv("a", 1), kv("a", 2), kv("b", 3) } });
    s2.end();
    const e = (try h2.only()).events.items[0];
    // Deduplicated first (last value wins), then cut.
    try testing.expectEqual(@as(usize, 1), e.attributes.len);
    try testing.expectEqual(@as(i64, 2), e.attributes[0].value.int);
    try testing.expectEqual(@as(u32, 1), e.dropped_attributes_count);
}

test "status follows Go's ordering" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    var s = h.tracer().start(.background, "status", .{});
    s.setStatus(.@"error", "first");
    s.setStatus(.unset, "ignored");
    s.setStatus(.@"error", "second");
    s.end();
    try testing.expectEqual(span_mod.StatusCode.@"error", (try h.only()).status.code);
    try testing.expectEqualStrings("second", (try h.only()).status.description);
    h.exporter.reset();

    var ok = h.tracer().start(.background, "ok", .{});
    ok.setStatus(.ok, "dropped description");
    ok.setStatus(.@"error", "too late");
    ok.end();
    try testing.expectEqual(span_mod.StatusCode.ok, (try h.only()).status.code);
    try testing.expectEqualStrings("", (try h.only()).status.description);
}

test "recordError adds an exception event and leaves the status alone" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    var s = h.tracer().start(.background, "err", .{});
    s.recordError(error.ConnectionRefused, .{ .attributes = &.{kv("retry", true)} });
    s.recordError(error.Timeout, .{ .message = "upstream timed out" });
    s.end();
    const d = try h.only();
    try testing.expectEqual(span_mod.StatusCode.unset, d.status.code);
    const first = d.events.items[0];
    try testing.expectEqualStrings("exception", first.name);
    try testing.expectEqualStrings("error.ConnectionRefused", attribute.find(first.attributes, "exception.type").?.string);
    try testing.expectEqualStrings("error.ConnectionRefused", attribute.find(first.attributes, "exception.message").?.string);
    try testing.expect(attribute.find(first.attributes, "retry").?.bool);
    try testing.expectEqualStrings("upstream timed out", attribute.find(d.events.items[1].attributes, "exception.message").?.string);
}

test "end is idempotent and later changes are ignored" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    var s = h.tracer().start(.background, "once", .{});
    defer s.end();
    s.end();
    s.end();
    s.setAttribute("late", 1);
    try testing.expect(!s.isRecording());
    try testing.expectEqual(@as(usize, 0), (try h.only()).attributes.items.len);
}

test "a dropped span has ids, records nothing and is not exported" {
    var h: Harness = undefined;
    try h.init(.{ .sampler = .always_off });
    defer h.deinit();
    var s = h.tracer().start(Context.background.withSpanContext(remote_parent), "dropped", .{});
    try testing.expect(s.spanContext().isValid());
    try testing.expect(!s.spanContext().isSampled());
    try testing.expect(!s.isRecording());
    s.setAttribute("a", 1);
    s.end();
    try testing.expectEqual(@as(usize, 0), h.exporter.spans.items.len);
}

test "a record-only span reaches processors but the simple processor does not export it" {
    const RecordOnly = struct {
        fn shouldSample(_: ?*const anyopaque, p: sampler.Parameters) sampler.Result {
            return .{ .decision = .record_only, .trace_state = p.parent.span_context.trace_state };
        }
        fn writeDescription(_: ?*const anyopaque, w: *std.Io.Writer) std.Io.Writer.Error!void {
            try w.writeAll("RecordOnly");
        }
    };
    var h: Harness = undefined;
    try h.init(.{ .sampler = .{ .custom = .{ .ptr = null, .vtable = &.{ .shouldSample = RecordOnly.shouldSample, .writeDescription = RecordOnly.writeDescription } } } });
    defer h.deinit();
    var s = h.tracer().start(.background, "record only", .{});
    try testing.expect(s.isRecording());
    try testing.expect(!s.spanContext().isSampled());
    s.end();
    try testing.expectEqual(@as(usize, 0), h.exporter.spans.items.len);
}

test "onStart sees the live span and onEnd the ended one" {
    const Probe = struct {
        started: usize = 0,
        ended_recording: bool = true,
        kept: ?*const SpanData = null,

        fn onStart(ptr: *anyopaque, parent: Context, span: *SpanData) void {
            const p: *@This() = @ptrCast(@alignCast(ptr));
            p.started += 1;
            if (parent.span_context.isValid()) span.setAttributes(&.{kv("has.parent", true)});
            span.setAttributes(&.{kv("from.start", true)});
        }
        fn onEnd(ptr: *anyopaque, span: *const SpanData) void {
            const p: *@This() = @ptrCast(@alignCast(ptr));
            p.ended_recording = @constCast(span).isRecording();
            span.retain();
            p.kept = span;
        }
        fn forceFlush(_: *anyopaque, _: deadline.Deadline) processor.ExportError!void {}
        fn shutdown(_: *anyopaque, _: deadline.Deadline) processor.ExportError!void {}
    };
    var probe: Probe = .{};
    const sp: processor.SpanProcessor = .{ .ptr = &probe, .vtable = &.{ .onStart = Probe.onStart, .onEnd = Probe.onEnd, .forceFlush = Probe.forceFlush, .shutdown = Probe.shutdown } };
    var h: Harness = undefined;
    try h.init(.{ .processors = &.{sp} });
    defer h.deinit();
    var s = h.tracer().start(Context.background.withSpanContext(remote_parent), "probe", .{});
    s.end();
    try testing.expectEqual(@as(usize, 1), probe.started);
    try testing.expect(!probe.ended_recording);
    const kept = probe.kept.?;
    defer kept.release();
    try testing.expect(attribute.find(kept.attributes.items, "from.start").?.bool);
    try testing.expect(attribute.find(kept.attributes.items, "has.parent").?.bool);
}

test "the policy hook runs over span, event and link attributes at end" {
    const DropSecret = struct {
        calls: [3]usize = .{ 0, 0, 0 },
        fn apply(ptr: ?*anyopaque, target: policy.Target, attrs: []attribute.KeyValue, _: std.mem.Allocator) []attribute.KeyValue {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            self.calls[@backingInt(target)] += 1;
            var n: usize = 0;
            for (attrs) |a| {
                if (std.mem.eql(u8, a.key, "secret")) continue;
                attrs[n] = a;
                n += 1;
            }
            return attrs[0..n];
        }
    };
    var drop: DropSecret = .{};
    var h: Harness = undefined;
    try h.init(.{ .policy = .{ .ptr = &drop, .vtable = &.{ .apply = DropSecret.apply } } });
    defer h.deinit();
    var s = h.tracer().start(.background, "policy", .{ .attributes = &.{ kv("secret", "x"), kv("ok", 1) } });
    s.addEvent("e", .{ .attributes = &.{kv("secret", "y")} });
    s.addLink(.{ .span_context = remote_parent, .attributes = &.{ kv("secret", "z"), kv("ok", 2) } });
    s.end();
    const d = try h.only();
    try testing.expectEqual(@as(usize, 1), d.attributes.items.len);
    try testing.expectEqualStrings("ok", d.attributes.items[0].key);
    try testing.expectEqual(@as(usize, 0), d.events.items[0].attributes.len);
    try testing.expectEqual(@as(usize, 1), d.links.items[0].attributes.len);
    try testing.expectEqual([3]usize{ 1, 1, 1 }, drop.calls);
}

test "tracers are cached per scope and the provider shuts down once" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    const a = h.provider.tracer(.{ .name = "a" });
    try testing.expectEqual(a, h.provider.tracer(.{ .name = "a" }));
    try testing.expect(a != h.provider.tracer(.{ .name = "a", .version = "2" }));
    try h.provider.shutdown(deadline.after(testing.io, .fromSeconds(1)));
    try h.provider.shutdown(deadline.after(testing.io, .fromSeconds(1)));
    var s = a.start(.background, "after shutdown", .{});
    try testing.expect(!s.spanContext().isValid());
    s.end();
    try testing.expectEqual(@as(usize, 0), h.exporter.spans.items.len);
    var n = tracer_mod.Tracer.noop.start(.background, "noop", .{});
    n.end();
}

test "the sampler sees the start attributes and adds its own" {
    const Tagging = struct {
        const saw = [_]attribute.KeyValue{kv("sampler.saw.start", true)};
        fn shouldSample(_: ?*const anyopaque, p: sampler.Parameters) sampler.Result {
            const seen = attribute.find(p.attributes, "start") != null;
            return .{ .decision = .record_and_sample, .attributes = if (seen) &saw else &.{} };
        }
        fn writeDescription(_: ?*const anyopaque, w: *std.Io.Writer) std.Io.Writer.Error!void {
            try w.writeAll("Tagging");
        }
    };
    var h: Harness = undefined;
    try h.init(.{ .sampler = .{ .custom = .{ .ptr = null, .vtable = &.{ .shouldSample = Tagging.shouldSample, .writeDescription = Tagging.writeDescription } } } });
    defer h.deinit();
    var s = h.tracer().start(.background, "tagged", .{ .attributes = &.{kv("start", 1)} });
    s.end();
    try testing.expect(attribute.find((try h.only()).attributes.items, "sampler.saw.start").?.bool);
}

test "ending a span clears its trace state so spanContext never dangles" {
    var h: Harness = undefined;
    try h.init(.{ .sampler = .always_off });
    defer h.deinit();
    var parent = remote_parent;
    parent.trace_state = .{ .header = "vendor=val" };
    var s = h.tracer().start(Context.background.withSpanContext(parent), "dropped", .{});
    try testing.expectEqualStrings("vendor=val", s.spanContext().trace_state.header);
    const tid = s.spanContext().trace_id;
    const sid = s.spanContext().span_id;
    s.end();
    try testing.expectEqualStrings("", s.spanContext().trace_state.header);
    try testing.expectEqual(tid, s.spanContext().trace_id);
    try testing.expectEqual(sid, s.spanContext().span_id);
}

test "concurrent provider shutdown callers wait for the first and share its result" {
    const BlockingProc = struct {
        entered: std.Io.Event = .unset,
        release: std.Io.Event = .unset,

        fn onStart(_: *anyopaque, _: Context, _: *SpanData) void {}
        fn onEnd(_: *anyopaque, _: *const SpanData) void {}
        fn forceFlush(_: *anyopaque, _: deadline.Deadline) processor.ExportError!void {}
        fn shutdown(ptr: *anyopaque, _: deadline.Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.entered.set(testing.io);
            self.release.wait(testing.io) catch return error.Canceled;
            return error.ExportFailed;
        }
    };
    var proc: BlockingProc = .{};
    const sp: processor.SpanProcessor = .{ .ptr = &proc, .vtable = &.{
        .onStart = BlockingProc.onStart,
        .onEnd = BlockingProc.onEnd,
        .forceFlush = BlockingProc.forceFlush,
        .shutdown = BlockingProc.shutdown,
    } };
    const provider = try tracer_mod.TracerProvider.create(testing.allocator, testing.io, .{ .processors = &.{sp} });
    defer provider.destroy();

    const Runner = struct {
        fn call(p: *tracer_mod.TracerProvider) processor.ExportError!void {
            return p.shutdown(deadline.after(testing.io, .fromSeconds(5)));
        }
    };
    var f1 = try testing.io.concurrent(Runner.call, .{provider});
    try proc.entered.wait(testing.io);
    var f2 = try testing.io.concurrent(Runner.call, .{provider});
    try testing.io.sleep(.fromMilliseconds(10), .awake);
    proc.release.set(testing.io);
    try testing.expectError(error.ExportFailed, f1.await(testing.io));
    try testing.expectError(error.ExportFailed, f2.await(testing.io));
}
