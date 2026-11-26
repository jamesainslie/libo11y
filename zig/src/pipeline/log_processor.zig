//! Log processors and exporters: the simple processor, which exports each
//! record as it is emitted (sdk/log/simple.go), and the batch processor,
//! which queues records for a background task (sdk/log/batch.go). Both
//! follow the OTel Go log SDK, including the `OTEL_BLRP_*` and
//! `OTEL_LOGRECORD_*` environment mappings.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../context.zig").Context;
const batch = @import("batch.zig");
const deadline_mod = @import("deadline.zig");
const Deadline = deadline_mod.Deadline;
const log_record = @import("log_record.zig");
const LogData = log_record.LogData;
const proc_mod = @import("processor.zig");
const ExportError = proc_mod.ExportError;

/// Hooks into the log record lifecycle.
pub const LogProcessor = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Sees each emitted record, which is immutable. To keep it past
        /// the call, it calls `record.retain()` and later
        /// `record.release()`.
        onEmit: *const fn (ptr: *anyopaque, ctx: Context, record: *const LogData) void,
        forceFlush: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn onEmit(p: LogProcessor, ctx: Context, record: *const LogData) void {
        p.vtable.onEmit(p.ptr, ctx, record);
    }

    pub fn forceFlush(p: LogProcessor, deadline: Deadline) ExportError!void {
        return p.vtable.forceFlush(p.ptr, deadline);
    }

    pub fn shutdown(p: LogProcessor, deadline: Deadline) ExportError!void {
        return p.vtable.shutdown(p.ptr, deadline);
    }
};

/// Sends log records to a backend. Exports are never concurrent with
/// each other.
pub const LogExporter = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Exports a batch. The records are valid only during the call; an
        /// exporter that keeps one retains it.
        exportLogs: *const fn (ptr: *anyopaque, records: []const *const LogData, deadline: Deadline) ExportError!void,
        /// Flushes anything the exporter holds.
        forceFlush: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
        /// Releases the exporter's resources. Later exports fail with
        /// `error.Shutdown`; later flushes and shutdowns do nothing.
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn exportLogs(e: LogExporter, records: []const *const LogData, deadline: Deadline) ExportError!void {
        return e.vtable.exportLogs(e.ptr, records, deadline);
    }

    pub fn forceFlush(e: LogExporter, deadline: Deadline) ExportError!void {
        return e.vtable.forceFlush(e.ptr, deadline);
    }

    pub fn shutdown(e: LogExporter, deadline: Deadline) ExportError!void {
        return e.vtable.shutdown(e.ptr, deadline);
    }
};

/// Flushes then shuts down an exporter, as Go's shutdownExporter does, and
/// returns the first error.
fn flushAndShutdown(e: LogExporter, deadline: Deadline) ExportError!void {
    const flushed = e.forceFlush(deadline);
    const closed = e.shutdown(deadline);
    try flushed;
    try closed;
}

/// Exports each record synchronously as it is emitted. Exports are
/// serialized. Meant for tests and debugging; production uses the batch
/// processor.
pub const SimpleLogProcessor = struct {
    io: Io,
    exporter: LogExporter,
    export_timeout: Io.Duration,
    on_error: proc_mod.ErrorHandler,
    mutex: Io.Mutex = .init,
    is_shutdown: bool = false,

    pub const Options = struct {
        /// Bounds each export.
        export_timeout: Io.Duration = .fromSeconds(30),
        on_error: proc_mod.ErrorHandler = .ignore,
    };

    pub fn init(io: Io, exporter: LogExporter, options: Options) SimpleLogProcessor {
        return .{ .io = io, .exporter = exporter, .export_timeout = options.export_timeout, .on_error = options.on_error };
    }

    /// The processor interface. The processor must outlive the provider.
    pub fn processor(s: *SimpleLogProcessor) LogProcessor {
        return .{ .ptr = s, .vtable = &.{ .onEmit = onEmit, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    fn onEmit(ptr: *anyopaque, _: Context, record: *const LogData) void {
        const s: *SimpleLogProcessor = @ptrCast(@alignCast(ptr));
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        if (s.is_shutdown) return;
        s.exporter.exportLogs(&.{record}, deadline_mod.after(s.io, s.export_timeout)) catch |err| {
            s.on_error.handle("simple log processor", err, "exporting a log record failed");
        };
    }

    fn forceFlush(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const s: *SimpleLogProcessor = @ptrCast(@alignCast(ptr));
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        if (s.is_shutdown) return;
        return s.exporter.forceFlush(deadline);
    }

    fn shutdown(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const s: *SimpleLogProcessor = @ptrCast(@alignCast(ptr));
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        if (s.is_shutdown) return;
        s.is_shutdown = true;
        return flushAndShutdown(s.exporter, deadline);
    }
};

/// The OTel batch log processor defaults: a 2048 record queue, batches of
/// 512, a 1 second schedule delay and a 30 second export timeout. A full
/// queue drops its oldest record, as Go's does.
pub const default_batch_config: batch.Config = .{
    .max_queue_size = 2048,
    .max_export_batch_size = 512,
    .schedule_delay = .fromSeconds(1),
    .export_timeout = .fromSeconds(30),
    .overflow = .drop_oldest,
};

/// Batch settings set in code. A null field, or one below one, falls back
/// to the environment and then to the default, as Go's options do.
pub const BatchOptions = struct {
    max_queue_size: ?i64 = null,
    max_export_batch_size: ?i64 = null,
    schedule_delay: ?Io.Duration = null,
    export_timeout: ?Io.Duration = null,
};

/// Resolves the batch settings as Go's newBatchConfig does: a code value
/// of at least one wins, then an `OTEL_BLRP_*` variable of at least one,
/// then the default. `OTEL_BLRP_MAX_QUEUE_SIZE` and
/// `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` are counts, and
/// `OTEL_BLRP_SCHEDULE_DELAY` and `OTEL_BLRP_EXPORT_TIMEOUT` are
/// milliseconds. A value that is not a decimal integer is ignored. The
/// batch size never exceeds the queue size. `env` is any value with a
/// method `get(self, key: []const u8) ?[]const u8`, such as
/// `std.process.Environ.Map`.
pub fn batchConfig(options: BatchOptions, env: anytype) batch.Config {
    var config = default_batch_config;
    config.max_queue_size = resolveCount(options.max_queue_size, env, "OTEL_BLRP_MAX_QUEUE_SIZE", config.max_queue_size);
    config.schedule_delay = resolveDuration(options.schedule_delay, env, "OTEL_BLRP_SCHEDULE_DELAY", config.schedule_delay);
    config.export_timeout = resolveDuration(options.export_timeout, env, "OTEL_BLRP_EXPORT_TIMEOUT", config.export_timeout);
    config.max_export_batch_size = resolveCount(options.max_export_batch_size, env, "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", config.max_export_batch_size);
    config.max_export_batch_size = @min(config.max_export_batch_size, config.max_queue_size);
    return config;
}

/// The log record limits from `OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT` and
/// `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT`, over the defaults, as
/// Go reads them. A negative value means no limit. A value that is not a
/// decimal integer is ignored. Go has no variable for the depth limit.
pub fn limitsFromEnv(env: anytype) log_record.Limits {
    var limits: log_record.Limits = .{};
    if (envInt(env, "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT")) |n| {
        limits.attribute_count = if (n < 0) null else std.math.cast(u32, n) orelse std.math.maxInt(u32);
    }
    if (envInt(env, "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT")) |n| {
        limits.attribute_value_length = if (n < 0) null else std.math.cast(usize, n) orelse std.math.maxInt(usize);
    }
    return limits;
}

fn resolveCount(code: ?i64, env: anytype, comptime key: []const u8, default: usize) usize {
    if (code) |n| if (n >= 1) return std.math.cast(usize, n) orelse std.math.maxInt(usize);
    if (envInt(env, key)) |n| if (n >= 1) return std.math.cast(usize, n) orelse std.math.maxInt(usize);
    return default;
}

fn resolveDuration(code: ?Io.Duration, env: anytype, comptime key: []const u8, default: Io.Duration) Io.Duration {
    if (code) |d| if (d.nanoseconds >= 1) return d;
    // An i64 count of milliseconds always fits in i96 nanoseconds.
    if (envInt(env, key)) |ms| if (ms >= 1) return .fromMilliseconds(ms);
    return default;
}

/// The value of `key` as Go's strconv.Atoi reads it: an optional sign and
/// decimal digits, nothing else, in the `i64` range. Unset, empty and
/// malformed values are null.
fn envInt(env: anytype, key: []const u8) ?i64 {
    const text = env.get(key) orelse return null;
    return parseAtoi(text);
}

/// Parses `text` as Go's strconv.Atoi does on a 64-bit platform.
pub fn parseAtoi(text: []const u8) ?i64 {
    var digits = text;
    if (digits.len > 0 and (digits[0] == '+' or digits[0] == '-')) digits = digits[1..];
    if (digits.len == 0) return null;
    for (digits) |c| if (!std.ascii.isDigit(c)) return null;
    return std.fmt.parseInt(i64, text, 10) catch null;
}

/// Exports log records in batches through an exporter, which it flushes
/// and shuts down with itself.
pub const BatchLogProcessor = struct {
    batcher: *batch.Batcher(*const LogData),
    exporter: LogExporter,
    gpa: Allocator,
    io: Io,
    is_shutdown: std.atomic.Value(bool) = .init(false),
    shutdown_done: Io.Event = .unset,

    pub const Options = struct {
        config: batch.Config = default_batch_config,
        on_error: proc_mod.ErrorHandler = .ignore,
    };

    /// Starts the processor's background task.
    pub fn create(gpa: Allocator, io: Io, exporter: LogExporter, options: Options) batch.CreateError!*BatchLogProcessor {
        const self = try gpa.create(BatchLogProcessor);
        errdefer gpa.destroy(self);
        self.* = .{ .batcher = undefined, .exporter = exporter, .gpa = gpa, .io = io };
        self.batcher = try .create(gpa, io, options.config, .{
            .ptr = self,
            .exportFn = exportBatch,
            .releaseFn = releaseRecord,
        }, options.on_error, "batch log processor");
        return self;
    }

    /// Frees the processor, shutting it down first if needed.
    pub fn destroy(self: *BatchLogProcessor) void {
        self.batcher.destroy();
        self.gpa.destroy(self);
    }

    /// The processor interface. The processor must outlive the provider.
    pub fn processor(self: *BatchLogProcessor) LogProcessor {
        return .{ .ptr = self, .vtable = &.{ .onEmit = onEmit, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    /// The number of records dropped because the queue was full.
    pub fn droppedCount(self: *const BatchLogProcessor) u64 {
        return self.batcher.droppedCount();
    }

    fn onEmit(ptr: *anyopaque, _: Context, record: *const LogData) void {
        const self: *BatchLogProcessor = @ptrCast(@alignCast(ptr));
        record.retain();
        self.batcher.enqueue(record);
    }

    /// Exports everything queued, then flushes the exporter. After
    /// shutdown it does nothing, as in Go.
    fn forceFlush(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const self: *BatchLogProcessor = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return;
        self.batcher.forceFlush(deadline) catch |err| switch (err) {
            error.Shutdown => return,
            else => return err,
        };
        return self.exporter.forceFlush(deadline);
    }

    /// Exports everything queued, then flushes and shuts the exporter
    /// down, all under `deadline`. Concurrent callers wait for the first
    /// shutdown to finish; a second call does nothing.
    fn shutdown(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const self: *BatchLogProcessor = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) {
            self.shutdown_done.waitTimeout(self.io, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
            return;
        }
        defer self.shutdown_done.set(self.io);
        const drained = self.batcher.shutdown(deadline);
        const closed = flushAndShutdown(self.exporter, deadline);
        try drained;
        try closed;
    }

    fn exportBatch(ptr: *anyopaque, records: []const *const LogData, deadline: Deadline) ExportError!void {
        const self: *BatchLogProcessor = @ptrCast(@alignCast(ptr));
        return self.exporter.exportLogs(records, deadline);
    }

    fn releaseRecord(_: *anyopaque, record: *const LogData) void {
        record.release();
    }
};

/// Keeps every exported record in memory, in export order, until `reset`
/// or `deinit`. It can be told to fail, to test error paths.
pub const InMemoryLogExporter = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    records: std.ArrayList(*const LogData) = .empty,
    export_calls: usize = 0,
    flush_calls: usize = 0,
    is_shutdown: bool = false,
    /// When set, every export fails with this error and keeps nothing.
    fail_with: ?ExportError = null,

    pub fn init(gpa: Allocator, io: Io) InMemoryLogExporter {
        return .{ .gpa = gpa, .io = io };
    }

    /// Releases every kept record.
    pub fn deinit(e: *InMemoryLogExporter) void {
        e.reset();
        e.records.deinit(e.gpa);
    }

    /// The exporter interface. The exporter must outlive its processor.
    pub fn exporter(e: *InMemoryLogExporter) LogExporter {
        return .{ .ptr = e, .vtable = &.{ .exportLogs = exportLogs, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    /// Returns a copy of the kept records, in export order, allocated in
    /// `gpa`. The records stay valid until `reset` or `deinit`.
    pub fn snapshot(e: *InMemoryLogExporter, gpa: Allocator) Allocator.Error![]*const LogData {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return gpa.dupe(*const LogData, e.records.items);
    }

    /// The number of kept records.
    pub fn count(e: *InMemoryLogExporter) usize {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        return e.records.items.len;
    }

    /// Releases every kept record.
    pub fn reset(e: *InMemoryLogExporter) void {
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        for (e.records.items) |r| r.release();
        e.records.clearRetainingCapacity();
    }

    fn exportLogs(ptr: *anyopaque, records: []const *const LogData, _: Deadline) ExportError!void {
        const e: *InMemoryLogExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        if (e.is_shutdown) return error.Shutdown;
        e.export_calls += 1;
        if (e.fail_with) |err| return err;
        e.records.ensureUnusedCapacity(e.gpa, records.len) catch return error.ExportFailed;
        for (records) |r| {
            r.retain();
            e.records.appendAssumeCapacity(r);
        }
    }

    fn forceFlush(ptr: *anyopaque, _: Deadline) ExportError!void {
        const e: *InMemoryLogExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        e.flush_calls += 1;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) ExportError!void {
        const e: *InMemoryLogExporter = @ptrCast(@alignCast(ptr));
        e.mutex.lockUncancelable(e.io);
        defer e.mutex.unlock(e.io);
        e.is_shutdown = true;
    }
};

test {
    _ = @import("log_test.zig");
}
