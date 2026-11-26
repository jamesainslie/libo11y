//! Metric readers and exporters, as OTel Go's sdk/metric builds them
//! (reader.go, manual_reader.go, periodic_reader.go and exporter.go).
//!
//! A reader is registered with one meter provider, which gives it a
//! producer. The manual reader collects when asked, for tests. The
//! periodic reader collects and exports on an `io.concurrent` task every
//! interval, and runs a final collection and export when it shuts down.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const deadline_mod = @import("../deadline.zig");
const Deadline = deadline_mod.Deadline;
const processor = @import("../processor.zig");
const ExportError = processor.ExportError;
const data = @import("data.zig");
const instrument = @import("instrument.zig");
const TemporalityPreference = instrument.TemporalityPreference;

/// Why a collection failed.
pub const CollectError = error{
    OutOfMemory,
    /// The reader has shut down.
    Shutdown,
    /// The reader is not registered with a meter provider.
    NotRegistered,
};

/// The provider side of a reader: it runs the callbacks and collects
/// every stream of the reader into an owned `ResourceMetrics`.
pub const Producer = struct {
    ptr: *anyopaque,
    produceFn: *const fn (ptr: *anyopaque, gpa: Allocator) Allocator.Error!data.ResourceMetrics,

    pub fn produce(p: Producer, gpa: Allocator) Allocator.Error!data.ResourceMetrics {
        return p.produceFn(p.ptr, gpa);
    }
};

/// A reader, as the meter provider sees it.
pub const Reader = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Called once by the provider the reader is given to.
        register: *const fn (ptr: *anyopaque, producer: Producer) void,
        /// The temporality the reader wants per instrument kind.
        temporality: *const fn (ptr: *anyopaque) TemporalityPreference,
        forceFlush: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn register(r: Reader, producer: Producer) void {
        r.vtable.register(r.ptr, producer);
    }

    pub fn temporality(r: Reader) TemporalityPreference {
        return r.vtable.temporality(r.ptr);
    }

    pub fn forceFlush(r: Reader, deadline: Deadline) ExportError!void {
        return r.vtable.forceFlush(r.ptr, deadline);
    }

    pub fn shutdown(r: Reader, deadline: Deadline) ExportError!void {
        return r.vtable.shutdown(r.ptr, deadline);
    }
};

/// Sends collected metrics to a backend.
pub const MetricExporter = struct {
    ptr: *anyopaque,
    vtable: *const VTable,
    /// The temporality the backend wants; the periodic reader uses it.
    temporality: TemporalityPreference = .cumulative,

    pub const VTable = struct {
        /// Exports one collection. The data is valid only during the
        /// call; an exporter that keeps it clones it.
        exportMetrics: *const fn (ptr: *anyopaque, metrics: *const data.ResourceMetrics, deadline: Deadline) ExportError!void,
        forceFlush: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
        /// Releases the exporter's resources. Later exports fail with
        /// `error.Shutdown`.
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn exportMetrics(e: MetricExporter, metrics: *const data.ResourceMetrics, deadline: Deadline) ExportError!void {
        return e.vtable.exportMetrics(e.ptr, metrics, deadline);
    }

    pub fn forceFlush(e: MetricExporter, deadline: Deadline) ExportError!void {
        return e.vtable.forceFlush(e.ptr, deadline);
    }

    pub fn shutdown(e: MetricExporter, deadline: Deadline) ExportError!void {
        return e.vtable.shutdown(e.ptr, deadline);
    }
};

/// A reader that collects only when `collect` is called. For tests.
pub const ManualReader = struct {
    io: Io,
    preference: TemporalityPreference,
    mutex: Io.Mutex = .init,
    producer: ?Producer = null,
    is_shutdown: bool = false,

    pub const Options = struct {
        temporality: TemporalityPreference = .cumulative,
    };

    pub fn init(io: Io, options: Options) ManualReader {
        return .{ .io = io, .preference = options.temporality };
    }

    /// The reader interface. The reader must outlive its provider.
    pub fn reader(r: *ManualReader) Reader {
        return .{ .ptr = r, .vtable = &.{ .register = register, .temporality = temporality, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    /// Runs the callbacks and collects every stream. The caller owns the
    /// result.
    pub fn collect(r: *ManualReader, gpa: Allocator) CollectError!data.ResourceMetrics {
        r.mutex.lockUncancelable(r.io);
        const producer = r.producer;
        const down = r.is_shutdown;
        r.mutex.unlock(r.io);
        if (down) return error.Shutdown;
        const p = producer orelse return error.NotRegistered;
        return p.produce(gpa);
    }

    fn register(ptr: *anyopaque, producer: Producer) void {
        const r: *ManualReader = @ptrCast(@alignCast(ptr));
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        if (r.producer == null) r.producer = producer;
    }

    fn temporality(ptr: *anyopaque) TemporalityPreference {
        const r: *ManualReader = @ptrCast(@alignCast(ptr));
        return r.preference;
    }

    fn forceFlush(_: *anyopaque, _: Deadline) ExportError!void {}

    fn shutdown(ptr: *anyopaque, _: Deadline) ExportError!void {
        const r: *ManualReader = @ptrCast(@alignCast(ptr));
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        r.is_shutdown = true;
    }
};

/// Why `PeriodicReader.create` failed.
pub const CreateError = Allocator.Error || Io.ConcurrentError;

/// Collects and exports every interval on an `io.concurrent` task.
/// Exports never overlap: the task, `forceFlush` and `shutdown` take
/// turns.
pub const PeriodicReader = struct {
    gpa: Allocator,
    io: Io,
    exporter: MetricExporter,
    interval: Io.Duration,
    timeout: Io.Duration,
    on_error: processor.ErrorHandler,

    mutex: Io.Mutex = .init,
    /// Wakes the task to stop.
    wake: Io.Condition = .init,
    /// Signals waiters when an in-flight export finishes or shutdown begins.
    export_done: Io.Condition = .init,
    producer: ?Producer = null,
    stopping: bool = false,
    export_in_progress: bool = false,

    worker: Io.Future(void) = undefined,
    is_shutdown: std.atomic.Value(bool) = .init(false),
    shutdown_done: Io.Event = .unset,
    shutdown_result: ?ExportError = null,

    pub const Options = struct {
        /// The time between the start of two collections. The
        /// environment value comes from `instrument.periodicFromEnv`.
        interval: Io.Duration = instrument.default_interval,
        /// Bounds each collect and export.
        timeout: Io.Duration = instrument.default_timeout,
        /// Receives the failures of periodic exports.
        on_error: processor.ErrorHandler = .ignore,
    };

    /// Starts the background task.
    pub fn create(gpa: Allocator, io: Io, exporter: MetricExporter, options: Options) CreateError!*PeriodicReader {
        const r = try gpa.create(PeriodicReader);
        errdefer gpa.destroy(r);
        r.* = .{
            .gpa = gpa,
            .io = io,
            .exporter = exporter,
            .interval = if (options.interval.nanoseconds > 0) options.interval else instrument.default_interval,
            .timeout = if (options.timeout.nanoseconds > 0) options.timeout else instrument.default_timeout,
            .on_error = options.on_error,
        };
        r.worker = try io.concurrent(run, .{r});
        return r;
    }

    /// Shuts down if that has not happened, then frees the reader.
    pub fn destroy(r: *PeriodicReader) void {
        r.shutdown(deadline_mod.after(r.io, .zero)) catch {};
        r.gpa.destroy(r);
    }

    /// The reader interface. The reader must outlive its provider.
    pub fn reader(r: *PeriodicReader) Reader {
        return .{ .ptr = r, .vtable = &.{ .register = register, .temporality = temporality, .forceFlush = forceFlushErased, .shutdown = shutdownErased } };
    }

    /// Collects and exports now, then flushes the exporter, all under
    /// `deadline`.
    pub fn forceFlush(r: *PeriodicReader, deadline: Deadline) ExportError!void {
        if (r.is_shutdown.load(.acquire)) return error.Shutdown;
        try r.collectAndExport(deadline, .{ .allow_shutdown = false, .skip_unregistered = false });
        return r.exporter.forceFlush(deadline);
    }

    /// Stops the task, cancelling an export in flight, runs a final
    /// collection and export, and shuts the exporter down, all under
    /// `deadline`. Later calls wait for the first and return its result.
    pub fn shutdown(r: *PeriodicReader, deadline: Deadline) ExportError!void {
        if (r.is_shutdown.swap(true, .acq_rel)) {
            r.shutdown_done.waitTimeout(r.io, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
            if (r.shutdown_result) |err| return err;
            return;
        }
        r.mutex.lockUncancelable(r.io);
        r.stopping = true;
        r.mutex.unlock(r.io);
        r.wake.signal(r.io);
        r.export_done.broadcast(r.io);
        r.worker.cancel(r.io);

        var result: ?ExportError = null;
        r.collectAndExport(deadline, .{ .allow_shutdown = true, .skip_unregistered = true }) catch |err| {
            result = err;
        };
        r.exporter.shutdown(deadline) catch |err| {
            if (result == null) result = err;
        };
        r.shutdown_result = result;
        r.shutdown_done.set(r.io);
        if (result) |err| return err;
    }

    const CollectMode = struct {
        allow_shutdown: bool,
        skip_unregistered: bool,
    };

    fn collectAndExport(r: *PeriodicReader, deadline: Deadline, mode: CollectMode) ExportError!void {
        r.mutex.lock(r.io) catch return error.Canceled;
        while (true) {
            if (!mode.allow_shutdown and (r.stopping or r.is_shutdown.load(.acquire))) {
                r.mutex.unlock(r.io);
                return error.Shutdown;
            }
            if (!r.export_in_progress) break;
            r.export_done.waitTimeout(r.io, &r.mutex, deadline_mod.timeout(deadline)) catch |err| {
                r.mutex.unlock(r.io);
                return switch (err) {
                    error.Timeout => error.Timeout,
                    error.Canceled => error.Canceled,
                };
            };
        }
        const producer = r.producer;
        if (producer == null) {
            r.mutex.unlock(r.io);
            if (mode.skip_unregistered) return;
            r.on_error.handle("periodic metric reader", error.ExportFailed, "the reader is not registered with a meter provider");
            return error.ExportFailed;
        }
        if (deadline_mod.expired(r.io, deadline)) {
            r.mutex.unlock(r.io);
            return error.Timeout;
        }
        r.export_in_progress = true;
        r.mutex.unlock(r.io);
        defer {
            r.mutex.lockUncancelable(r.io);
            r.export_in_progress = false;
            r.mutex.unlock(r.io);
            r.export_done.broadcast(r.io);
        }

        var metrics = producer.?.produce(r.gpa) catch {
            r.on_error.handle("periodic metric reader", error.ExportFailed, "collecting metrics ran out of memory");
            return error.ExportFailed;
        };
        defer metrics.deinit();
        return r.exporter.exportMetrics(&metrics, deadline);
    }

    fn run(r: *PeriodicReader) void {
        const io = r.io;
        // Intervals run from the start of one collection to the start of
        // the next, as Go's ticker does.
        var next = deadline_mod.after(io, r.interval);
        while (true) {
            r.mutex.lock(io) catch return;
            while (!r.stopping) {
                r.wake.waitTimeout(io, &r.mutex, deadline_mod.timeout(next)) catch |err| switch (err) {
                    error.Timeout => break,
                    error.Canceled => {
                        r.mutex.unlock(io);
                        return;
                    },
                };
            }
            const stop = r.stopping;
            r.mutex.unlock(io);
            if (stop) return;
            next = deadline_mod.after(io, r.interval);
            r.collectAndExport(deadline_mod.after(io, r.timeout), .{ .allow_shutdown = false, .skip_unregistered = true }) catch |err| switch (err) {
                error.Canceled, error.Shutdown => return,
                else => r.on_error.handle("periodic metric reader", err, "exporting metrics failed"),
            };
        }
    }

    fn register(ptr: *anyopaque, producer: Producer) void {
        const r: *PeriodicReader = @ptrCast(@alignCast(ptr));
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        if (r.producer == null) r.producer = producer;
    }

    fn temporality(ptr: *anyopaque) TemporalityPreference {
        const r: *PeriodicReader = @ptrCast(@alignCast(ptr));
        return r.exporter.temporality;
    }

    fn forceFlushErased(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const r: *PeriodicReader = @ptrCast(@alignCast(ptr));
        return r.forceFlush(deadline);
    }

    fn shutdownErased(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const r: *PeriodicReader = @ptrCast(@alignCast(ptr));
        return r.shutdown(deadline);
    }
};
