//! Tests for the batcher and the batch span processor.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const batch = @import("batch.zig");
const deadline = @import("deadline.zig");
const Deadline = deadline.Deadline;
const processor = @import("processor.zig");
const InMemoryExporter = @import("memory_exporter.zig").InMemoryExporter;
const tracer_mod = @import("tracer.zig");
const Context = @import("../context.zig").Context;

const io = testing.io;

/// A sink of integers that records batches and can block until released.
const IntSink = struct {
    mutex: Io.Mutex = .init,
    exported: std.ArrayList(u32) = .empty,
    batches: usize = 0,
    released: usize = 0,
    block: bool = false,
    entered: Io.Event = .unset,
    unblock: Io.Event = .unset,

    fn sink(s: *IntSink) batch.Batcher(u32).Sink {
        return .{ .ptr = s, .exportFn = exportFn, .releaseFn = releaseFn };
    }

    fn deinit(s: *IntSink) void {
        s.exported.deinit(testing.allocator);
    }

    fn exportFn(ptr: *anyopaque, items: []const u32, _: Deadline) processor.ExportError!void {
        const s: *IntSink = @ptrCast(@alignCast(ptr));
        if (s.block) {
            s.entered.set(io);
            // Cancelable: a shutdown past its deadline cancels this wait.
            s.unblock.wait(io) catch return error.Canceled;
        }
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        s.batches += 1;
        s.exported.appendSlice(testing.allocator, items) catch return error.ExportFailed;
    }

    fn releaseFn(ptr: *anyopaque, _: u32) void {
        const s: *IntSink = @ptrCast(@alignCast(ptr));
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        s.released += 1;
    }

    fn count(s: *IntSink) usize {
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        return s.exported.items.len;
    }
};

const B = batch.Batcher(u32);

fn waitFor(s: *IntSink, n: usize, timeout_ms: i64) !void {
    const end = deadline.after(io, .fromMilliseconds(timeout_ms));
    while (s.count() < n) {
        if (deadline.expired(io, end)) return error.TestTimeout;
        try io.sleep(.fromMilliseconds(2), .awake);
    }
}

test "the defaults are the OpenTelemetry batch defaults" {
    const c: batch.Config = .{};
    try testing.expectEqual(@as(usize, 2048), c.max_queue_size);
    try testing.expectEqual(@as(usize, 512), c.max_export_batch_size);
    try testing.expectEqual(@as(i64, 5000), c.schedule_delay.toMilliseconds());
    try testing.expectEqual(@as(i64, 30000), c.export_timeout.toMilliseconds());
}

test "a full batch is exported without waiting for the delay" {
    var s: IntSink = .{};
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .max_export_batch_size = 2, .schedule_delay = .fromSeconds(60) }, s.sink(), .ignore, "test");
    defer b.destroy();
    b.enqueue(1);
    b.enqueue(2);
    try waitFor(&s, 2, 2000);
    try testing.expectEqual(@as(usize, 1), s.batches);
}

test "the schedule delay exports a partial batch" {
    var s: IntSink = .{};
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .schedule_delay = .fromMilliseconds(20) }, s.sink(), .ignore, "test");
    defer b.destroy();
    b.enqueue(7);
    try waitFor(&s, 1, 2000);
}

test "forceFlush exports everything queued, in batches" {
    var s: IntSink = .{};
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .max_export_batch_size = 3, .schedule_delay = .fromSeconds(60) }, s.sink(), .ignore, "test");
    defer b.destroy();
    for (0..7) |i| b.enqueue(@intCast(i));
    try b.forceFlush(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 7), s.count());
    try testing.expectEqualSlices(u32, &.{ 0, 1, 2, 3, 4, 5, 6 }, s.exported.items);
    try testing.expectEqual(@as(usize, 7), s.released);
}

test "a full queue drops the item and counts the drop" {
    var s: IntSink = .{ .block = true };
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .max_queue_size = 2, .max_export_batch_size = 1, .schedule_delay = .fromSeconds(60) }, s.sink(), .ignore, "test");
    defer b.destroy();
    b.enqueue(1);
    // The worker takes 1 and blocks in the export, so the queue is empty.
    try s.entered.wait(io);
    b.enqueue(2);
    b.enqueue(3);
    b.enqueue(4);
    b.enqueue(5);
    try testing.expectEqual(@as(u64, 2), b.droppedCount());
    s.unblock.set(io);
    try b.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqualSlices(u32, &.{ 1, 2, 3 }, s.exported.items);
    // Every item was released: three exported, two dropped.
    try testing.expectEqual(@as(usize, 5), s.released);
}

test "a full queue under drop_oldest drops the oldest item and counts the drop" {
    var s: IntSink = .{ .block = true };
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .max_queue_size = 2, .max_export_batch_size = 1, .schedule_delay = .fromSeconds(60), .overflow = .drop_oldest }, s.sink(), .ignore, "test");
    defer b.destroy();
    b.enqueue(1);
    try s.entered.wait(io);
    b.enqueue(2);
    b.enqueue(3);
    b.enqueue(4);
    b.enqueue(5);
    try testing.expectEqual(@as(u64, 2), b.droppedCount());
    s.unblock.set(io);
    try b.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqualSlices(u32, &.{ 1, 4, 5 }, s.exported.items);
    try testing.expectEqual(@as(usize, 5), s.released);
}

test "shutdown past its deadline cancels a hung export and releases the queue" {
    var s: IntSink = .{ .block = true };
    defer s.deinit();
    const b = try B.create(testing.allocator, io, .{ .max_export_batch_size = 1, .schedule_delay = .fromSeconds(60) }, s.sink(), .ignore, "test");
    defer b.destroy();
    b.enqueue(1);
    try s.entered.wait(io);
    b.enqueue(2);
    const started = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, b.shutdown(deadline.after(io, .fromMilliseconds(100))));
    const took = -deadline.remaining(io, started).toMilliseconds();
    try testing.expect(took >= 90 and took < 2000);
    try testing.expectEqual(@as(usize, 2), s.released);
    try testing.expectEqual(@as(usize, 0), s.count());
    // Later calls return the first result, enqueue releases at once, and
    // forceFlush after shutdown is a no-op.
    try testing.expectError(error.Timeout, b.shutdown(deadline.after(io, .fromSeconds(1))));
    b.enqueue(3);
    try testing.expectEqual(@as(usize, 3), s.released);
    try b.forceFlush(deadline.after(io, .fromSeconds(1)));
}

test "forceFlush gives up at its deadline and later batches still export" {
    const DeadlineSink = struct {
        mutex: Io.Mutex = .init,
        exported: std.ArrayList(u32) = .empty,
        expired_deadlines: usize = 0,
        block_first: bool = true,
        entered: Io.Event = .unset,
        unblock: Io.Event = .unset,

        fn exportFn(ptr: *anyopaque, items: []const u32, dl: Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            if (deadline.expired(io, dl)) {
                self.mutex.lockUncancelable(io);
                self.expired_deadlines += 1;
                self.mutex.unlock(io);
                return error.Timeout;
            }
            if (self.block_first) {
                self.block_first = false;
                self.entered.set(io);
                self.unblock.wait(io) catch return error.Canceled;
            }
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.exported.appendSlice(testing.allocator, items) catch return error.ExportFailed;
        }
        fn releaseFn(_: *anyopaque, _: u32) void {}
    };
    var s: DeadlineSink = .{};
    defer s.exported.deinit(testing.allocator);
    const b = try B.create(
        testing.allocator,
        io,
        .{ .max_export_batch_size = 1, .schedule_delay = .fromSeconds(60) },
        .{ .ptr = &s, .exportFn = DeadlineSink.exportFn, .releaseFn = DeadlineSink.releaseFn },
        .ignore,
        "test",
    );
    defer b.destroy();
    b.enqueue(1);
    try s.entered.wait(io);
    b.enqueue(2);
    b.enqueue(3);
    try testing.expectError(error.Timeout, b.forceFlush(deadline.after(io, .fromMilliseconds(50))));
    s.unblock.set(io);
    try b.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 0), s.expired_deadlines);
    try testing.expectEqualSlices(u32, &.{ 1, 2, 3 }, s.exported.items);
}

test "export failures go to the error handler" {
    const Failing = struct {
        reports: std.atomic.Value(usize) = .init(0),
        fn exportFn(_: *anyopaque, _: []const u32, _: Deadline) processor.ExportError!void {
            return error.ExportFailed;
        }
        fn releaseFn(_: *anyopaque, _: u32) void {}
        fn report(ptr: ?*anyopaque, component: []const u8, err: processor.ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            std.testing.expectEqualStrings("test", component) catch return;
            if (err == error.ExportFailed) _ = self.reports.fetchAdd(1, .monotonic);
        }
    };
    var f: Failing = .{};
    const b = try B.create(testing.allocator, io, .{}, .{ .ptr = &f, .exportFn = Failing.exportFn, .releaseFn = Failing.releaseFn }, .{ .ptr = &f, .report = Failing.report }, "test");
    defer b.destroy();
    b.enqueue(1);
    try b.forceFlush(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 1), f.reports.load(.monotonic));
}

test "the batch span processor exports sampled spans and shuts its exporter down" {
    var mem: InMemoryExporter = .init(testing.allocator, io);
    defer mem.deinit();
    const bsp = try batch.BatchSpanProcessor.create(testing.allocator, io, mem.exporter(), .{ .config = .{ .schedule_delay = .fromSeconds(60) } });
    defer bsp.destroy();
    const provider = try tracer_mod.TracerProvider.create(testing.allocator, io, .{ .processors = &.{bsp.processor()} });
    defer provider.destroy();
    const t = provider.tracer(.{ .name = "batch" });
    for (0..3) |_| {
        var s = t.start(.background, "op", .{});
        s.end();
    }
    try provider.forceFlush(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 3), mem.count());
    var unsampled = t.start(Context.background.withSpanContext(.{ .trace_id = .{ .bytes = @splat(1) }, .span_id = .{ .bytes = @splat(2) }, .remote = true }), "not sampled", .{});
    unsampled.end();
    try provider.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 3), mem.count());
    try testing.expect(mem.is_shutdown);
    try testing.expectEqual(@as(u64, 0), bsp.droppedCount());
}
