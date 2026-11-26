//! Batching for the export pipeline: a bounded queue drained by one
//! `io.concurrent` task, with the OTel batch processor defaults and
//! behaviour (sdk/trace/batch_span_processor.go). `Batcher` is generic
//! over the queued item, so the log pipeline reuses it;
//! `BatchSpanProcessor` is the span processor built on it.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../context.zig").Context;
const deadline_mod = @import("deadline.zig");
const Deadline = deadline_mod.Deadline;
const proc_mod = @import("processor.zig");
const ExportError = proc_mod.ExportError;
const SpanData = @import("span.zig").SpanData;

/// Batch settings. The defaults are the OpenTelemetry defaults, which
/// `OTEL_BSP_*` and `OTEL_BLRP_*` describe.
pub const Config = struct {
    /// Items queued beyond this are dropped and counted.
    max_queue_size: usize = 2048,
    /// The most items one export carries.
    max_export_batch_size: usize = 512,
    /// The longest an item waits before the next export.
    schedule_delay: Io.Duration = .fromMilliseconds(5000),
    /// Bounds each export.
    export_timeout: Io.Duration = .fromMilliseconds(30000),
};

/// Why `Batcher.create` failed.
pub const CreateError = Allocator.Error || Io.ConcurrentError;

/// A bounded queue of `T` with one background task that exports it in
/// batches: when a full batch is queued, when the schedule delay passes,
/// on `forceFlush` and on `shutdown`.
pub fn Batcher(comptime T: type) type {
    return struct {
        const Self = @This();

        /// Where batches go, and how a dropped or exported item is freed.
        pub const Sink = struct {
            ptr: *anyopaque,
            /// Exports a batch. The items are valid only during the call.
            exportFn: *const fn (ptr: *anyopaque, items: []const T, deadline: Deadline) ExportError!void,
            /// Frees one item once it has been exported or dropped.
            releaseFn: *const fn (ptr: *anyopaque, item: T) void,
        };

        gpa: Allocator,
        io: Io,
        config: Config,
        sink: Sink,
        on_error: proc_mod.ErrorHandler,
        component: []const u8,

        mutex: Io.Mutex = .init,
        /// Signals the worker: a full batch, a flush or shutdown.
        work: Io.Condition = .init,
        /// Signals flushers: a flush finished.
        idle: Io.Condition = .init,
        ring: []T,
        head: usize = 0,
        len: usize = 0,
        batch: []T,
        flush_requested: u64 = 0,
        flush_completed: u64 = 0,
        active_flushers: usize = 0,
        stopping: bool = false,
        dropped: std.atomic.Value(u64) = .init(0),

        worker: Io.Future(void) = undefined,
        worker_done: Io.Event = .unset,
        shutdown_done: Io.Event = .unset,
        shutdown_result: ?ExportError = null,

        /// Starts the background task. `component` names the batcher in
        /// error reports and must outlive it.
        pub fn create(gpa: Allocator, io: Io, config: Config, sink: Sink, on_error: proc_mod.ErrorHandler, component: []const u8) CreateError!*Self {
            const self = try gpa.create(Self);
            errdefer gpa.destroy(self);
            const ring = try gpa.alloc(T, @max(config.max_queue_size, 1));
            errdefer gpa.free(ring);
            const batch = try gpa.alloc(T, @max(config.max_export_batch_size, 1));
            errdefer gpa.free(batch);
            self.* = .{
                .gpa = gpa,
                .io = io,
                .config = config,
                .sink = sink,
                .on_error = on_error,
                .component = component,
                .ring = ring,
                .batch = batch,
            };
            self.worker = try io.concurrent(run, .{self});
            return self;
        }

        /// Shuts down if that has not happened, then frees the batcher.
        pub fn destroy(self: *Self) void {
            self.shutdown(deadline_mod.after(self.io, .zero)) catch {};
            self.gpa.free(self.ring);
            self.gpa.free(self.batch);
            self.gpa.destroy(self);
        }

        /// Queues an item. A full queue drops it and counts the drop.
        /// After shutdown the item is released without counting. Never
        /// blocks on the exporter.
        pub fn enqueue(self: *Self, item: T) void {
            self.mutex.lockUncancelable(self.io);
            if (self.stopping) {
                self.mutex.unlock(self.io);
                self.sink.releaseFn(self.sink.ptr, item);
                return;
            }
            if (self.len == self.ring.len) {
                self.mutex.unlock(self.io);
                _ = self.dropped.fetchAdd(1, .monotonic);
                self.sink.releaseFn(self.sink.ptr, item);
                return;
            }
            self.ring[(self.head + self.len) % self.ring.len] = item;
            self.len += 1;
            const full = self.len >= self.batch.len;
            self.mutex.unlock(self.io);
            if (full) self.work.signal(self.io);
        }

        /// The number of items dropped because the queue was full.
        pub fn droppedCount(self: *const Self) u64 {
            return self.dropped.load(.monotonic);
        }

        /// Exports everything queued, in batches, and waits for it until
        /// `deadline`. Each batch exports under `config.export_timeout`,
        /// so a timed-out flush does not drop batches still queued. A
        /// flush after shutdown is a no-op, as in Go.
        pub fn forceFlush(self: *Self, deadline: Deadline) ExportError!void {
            self.mutex.lock(self.io) catch return error.Canceled;
            defer self.mutex.unlock(self.io);
            if (self.stopping) return;
            self.flush_requested += 1;
            const want = self.flush_requested;
            self.active_flushers += 1;
            defer {
                self.active_flushers -= 1;
                if (self.active_flushers == 0 and self.flush_completed < self.flush_requested) {
                    self.flush_completed = self.flush_requested;
                }
            }
            self.work.signal(self.io);
            while (self.flush_completed < want) {
                self.idle.waitTimeout(self.io, &self.mutex, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                    error.Timeout => return error.Timeout,
                    error.Canceled => return error.Canceled,
                };
            }
        }

        /// Stops accepting items, exports what is queued, and stops the
        /// task. When `deadline` passes first, the task is canceled, the
        /// rest of the queue is released, and the result is
        /// `error.Timeout`. Later calls wait for the first and return its
        /// result.
        pub fn shutdown(self: *Self, deadline: Deadline) ExportError!void {
            self.mutex.lockUncancelable(self.io);
            const first = !self.stopping;
            self.stopping = true;
            self.mutex.unlock(self.io);
            if (!first) {
                self.shutdown_done.waitTimeout(self.io, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                    error.Timeout => return error.Timeout,
                    error.Canceled => return error.Canceled,
                };
                if (self.shutdown_result) |err| return err;
                return;
            }
            self.work.signal(self.io);
            var result: ?ExportError = null;
            if (self.worker_done.waitTimeout(self.io, deadline_mod.timeout(deadline))) |_| {
                self.worker.await(self.io);
            } else |err| {
                result = switch (err) {
                    error.Timeout => error.Timeout,
                    error.Canceled => error.Canceled,
                };
                self.worker.cancel(self.io);
            }
            // A canceled task can leave items behind.
            self.mutex.lockUncancelable(self.io);
            while (self.len > 0) {
                const item = self.ring[self.head];
                self.head = (self.head + 1) % self.ring.len;
                self.len -= 1;
                self.sink.releaseFn(self.sink.ptr, item);
            }
            // Wake any flusher; nothing more will be exported.
            self.flush_completed = self.flush_requested;
            self.mutex.unlock(self.io);
            self.idle.broadcast(self.io);
            self.shutdown_result = result;
            self.shutdown_done.set(self.io);
            if (result) |err| return err;
        }

        fn run(self: *Self) void {
            defer self.worker_done.set(self.io);
            const io = self.io;
            var next_export = deadline_mod.after(io, self.config.schedule_delay);
            while (true) {
                self.mutex.lock(io) catch return;
                while (self.len < self.batch.len and self.flush_completed == self.flush_requested and !self.stopping) {
                    self.work.waitTimeout(io, &self.mutex, deadline_mod.timeout(next_export)) catch |err| switch (err) {
                        error.Timeout => break,
                        error.Canceled => {
                            self.mutex.unlock(io);
                            return;
                        },
                    };
                }
                const flushing = self.flush_completed != self.flush_requested;
                const flush_target = self.flush_requested;
                const n = @min(self.len, self.batch.len);
                for (self.batch[0..n]) |*slot| {
                    slot.* = self.ring[self.head];
                    self.head = (self.head + 1) % self.ring.len;
                }
                self.len -= n;
                self.mutex.unlock(io);

                if (n > 0) {
                    const export_deadline = deadline_mod.after(io, self.config.export_timeout);
                    const outcome = self.sink.exportFn(self.sink.ptr, self.batch[0..n], export_deadline);
                    for (self.batch[0..n]) |item| self.sink.releaseFn(self.sink.ptr, item);
                    if (outcome) |_| {} else |err| switch (err) {
                        error.Canceled => return,
                        else => self.on_error.handle(self.component, err, "exporting a batch failed"),
                    }
                }
                next_export = deadline_mod.after(io, self.config.schedule_delay);

                self.mutex.lockUncancelable(io);
                const empty = self.len == 0;
                const stop = self.stopping and empty;
                if (empty and flushing) {
                    self.flush_completed = flush_target;
                }
                self.mutex.unlock(io);
                if (empty and flushing) self.idle.broadcast(io);
                if (stop) return;
            }
        }
    };
}

/// Exports sampled spans in batches through an exporter, which it shuts
/// down with itself.
pub const BatchSpanProcessor = struct {
    batcher: *Batcher(*const SpanData),
    exporter: proc_mod.SpanExporter,
    gpa: Allocator,

    pub const Options = struct {
        config: Config = .{},
        on_error: proc_mod.ErrorHandler = .ignore,
    };

    /// Starts the processor's background task.
    pub fn create(gpa: Allocator, io: Io, exporter: proc_mod.SpanExporter, options: Options) CreateError!*BatchSpanProcessor {
        const self = try gpa.create(BatchSpanProcessor);
        errdefer gpa.destroy(self);
        self.* = .{ .batcher = undefined, .exporter = exporter, .gpa = gpa };
        self.batcher = try .create(gpa, io, options.config, .{
            .ptr = self,
            .exportFn = exportBatch,
            .releaseFn = releaseSpan,
        }, options.on_error, "batch span processor");
        return self;
    }

    /// Frees the processor, shutting it down first if needed.
    pub fn destroy(self: *BatchSpanProcessor) void {
        self.batcher.destroy();
        self.gpa.destroy(self);
    }

    /// The processor interface. The processor must outlive the provider.
    pub fn processor(self: *BatchSpanProcessor) proc_mod.SpanProcessor {
        return .{ .ptr = self, .vtable = &.{ .onStart = onStart, .onEnd = onEnd, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    /// The number of spans dropped because the queue was full.
    pub fn droppedCount(self: *const BatchSpanProcessor) u64 {
        return self.batcher.droppedCount();
    }

    fn onStart(_: *anyopaque, _: Context, _: *SpanData) void {}

    fn onEnd(ptr: *anyopaque, span: *const SpanData) void {
        const self: *BatchSpanProcessor = @ptrCast(@alignCast(ptr));
        if (!span.span_context.isSampled()) return;
        span.retain();
        self.batcher.enqueue(span);
    }

    fn forceFlush(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const self: *BatchSpanProcessor = @ptrCast(@alignCast(ptr));
        return self.batcher.forceFlush(deadline);
    }

    fn shutdown(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const self: *BatchSpanProcessor = @ptrCast(@alignCast(ptr));
        const drained = self.batcher.shutdown(deadline);
        const closed = self.exporter.shutdown(deadline);
        try drained;
        try closed;
    }

    fn exportBatch(ptr: *anyopaque, spans: []const *const SpanData, deadline: Deadline) ExportError!void {
        const self: *BatchSpanProcessor = @ptrCast(@alignCast(ptr));
        return self.exporter.exportSpans(spans, deadline);
    }

    fn releaseSpan(_: *anyopaque, span: *const SpanData) void {
        span.release();
    }
};

test {
    _ = @import("batch_test.zig");
}
