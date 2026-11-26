//! A metric exporter that keeps every export in memory, for tests.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Deadline = @import("../deadline.zig").Deadline;
const processor = @import("../processor.zig");
const data = @import("data.zig");
const reader = @import("reader.zig");
const TemporalityPreference = @import("instrument.zig").TemporalityPreference;

/// Keeps a copy of every exported collection, in export order, until
/// `reset` or `deinit`. It can be told to fail, to test error paths.
pub const InMemoryExporter = struct {
    gpa: Allocator,
    io: Io,
    temporality: TemporalityPreference,
    mutex: Io.Mutex = .init,
    exports: std.ArrayList(data.ResourceMetrics) = .empty,
    export_calls: usize = 0,
    flush_calls: usize = 0,
    is_shutdown: bool = false,
    /// When set, every export fails with this error and keeps nothing.
    fail_with: ?processor.ExportError = null,

    pub const Options = struct {
        temporality: TemporalityPreference = .cumulative,
    };

    pub fn init(gpa: Allocator, io: Io, options: Options) InMemoryExporter {
        return .{ .gpa = gpa, .io = io, .temporality = options.temporality };
    }

    /// Frees every kept export.
    pub fn deinit(e: *InMemoryExporter) void {
        e.reset();
        e.exports.deinit(e.gpa);
    }

    /// The exporter interface. The exporter must outlive its reader.
    pub fn exporter(e: *InMemoryExporter) reader.MetricExporter {
        return .{
            .ptr = e,
            .vtable = &.{ .exportMetrics = exportMetrics, .forceFlush = forceFlush, .shutdown = shutdown },
            .temporality = e.temporality,
        };
    }

    /// The number of kept exports.
    pub fn count(e: *InMemoryExporter) usize {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return e.exports.items.len;
    }

    /// Returns a copy of kept export `i`, which the caller frees.
    pub fn get(e: *InMemoryExporter, gpa: Allocator, i: usize) Allocator.Error!data.ResourceMetrics {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return e.exports.items[i].clone(gpa);
    }

    /// Frees every kept export.
    pub fn reset(e: *InMemoryExporter) void {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        for (e.exports.items) |*rm| rm.deinit();
        e.exports.clearRetainingCapacity();
    }

    fn exportMetrics(ptr: *anyopaque, metrics: *const data.ResourceMetrics, _: Deadline) processor.ExportError!void {
        const e: *InMemoryExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        if (e.is_shutdown) return error.Shutdown;
        e.export_calls += 1;
        if (e.fail_with) |err| return err;
        e.exports.ensureUnusedCapacity(e.gpa, 1) catch return error.ExportFailed;
        e.exports.appendAssumeCapacity(metrics.clone(e.gpa) catch return error.ExportFailed);
    }

    fn forceFlush(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const e: *InMemoryExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        e.flush_calls += 1;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const e: *InMemoryExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        e.is_shutdown = true;
    }
};
