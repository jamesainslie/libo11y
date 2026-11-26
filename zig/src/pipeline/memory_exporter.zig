//! An exporter that keeps spans in memory, for tests.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Deadline = @import("deadline.zig").Deadline;
const processor = @import("processor.zig");
const SpanData = @import("span.zig").SpanData;

/// Keeps every exported span, in export order, until `reset` or
/// `deinit`. It can be told to fail, to test error paths.
pub const InMemoryExporter = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    spans: std.ArrayList(*const SpanData) = .empty,
    export_calls: usize = 0,
    is_shutdown: bool = false,
    /// When set, every export fails with this error and keeps nothing.
    fail_with: ?processor.ExportError = null,

    pub fn init(gpa: Allocator, io: Io) InMemoryExporter {
        return .{ .gpa = gpa, .io = io };
    }

    /// Releases every kept span.
    pub fn deinit(e: *InMemoryExporter) void {
        e.reset();
        e.spans.deinit(e.gpa);
    }

    /// The exporter interface. The exporter must outlive its processor.
    pub fn exporter(e: *InMemoryExporter) processor.SpanExporter {
        return .{ .ptr = e, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdown } };
    }

    /// Returns a copy of the kept spans, in export order, allocated in
    /// `gpa`. The spans stay valid until `reset` or `deinit`.
    pub fn snapshot(e: *InMemoryExporter, gpa: Allocator) Allocator.Error![]*const SpanData {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return gpa.dupe(*const SpanData, e.spans.items);
    }

    /// The number of kept spans.
    pub fn count(e: *InMemoryExporter) usize {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return e.spans.items.len;
    }

    /// Releases every kept span.
    pub fn reset(e: *InMemoryExporter) void {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        for (e.spans.items) |s| s.release();
        e.spans.clearRetainingCapacity();
    }

    fn exportSpans(ptr: *anyopaque, spans: []const *const SpanData, _: Deadline) processor.ExportError!void {
        const e: *InMemoryExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        if (e.is_shutdown) return error.Shutdown;
        e.export_calls += 1;
        if (e.fail_with) |err| return err;
        e.spans.ensureUnusedCapacity(e.gpa, spans.len) catch return error.ExportFailed;
        for (spans) |s| {
            s.retain();
            e.spans.appendAssumeCapacity(s);
        }
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const e: *InMemoryExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        e.is_shutdown = true;
    }
};
