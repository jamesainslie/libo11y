//! Span processors and exporters, and the simple processor that exports
//! each sampled span as it ends (sdk/trace/simple_span_processor.go).

const std = @import("std");
const Io = std.Io;
const Context = @import("../context.zig").Context;
const deadline_mod = @import("deadline.zig");
const Deadline = deadline_mod.Deadline;
const SpanData = @import("span.zig").SpanData;

/// Why an export, flush or shutdown failed.
pub const ExportError = error{
    /// The deadline passed first.
    Timeout,
    /// The backend rejected the data or could not be reached.
    ExportFailed,
    /// The exporter or processor has shut down.
    Shutdown,
    /// The calling task was canceled.
    Canceled,
};

/// Receives the failures that the pipeline cannot return to a caller,
/// such as a batch export from the background task. The core installs a
/// handler that writes to stderr; the default ignores them.
pub const ErrorHandler = struct {
    ptr: ?*anyopaque,
    report: *const fn (ptr: ?*anyopaque, component: []const u8, err: ExportError, detail: []const u8) void,

    /// Drops every report.
    pub const ignore: ErrorHandler = .{ .ptr = null, .report = ignoreReport };

    /// Reports one failure. `detail` is valid only during the call.
    pub fn handle(h: ErrorHandler, component: []const u8, err: ExportError, detail: []const u8) void {
        h.report(h.ptr, component, err, detail);
    }

    fn ignoreReport(_: ?*anyopaque, _: []const u8, _: ExportError, _: []const u8) void {}
};

/// Hooks into the span lifecycle.
pub const SpanProcessor = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Sees the live span, which it may still change, as it starts.
        onStart: *const fn (ptr: *anyopaque, parent: Context, span: *SpanData) void,
        /// Sees the ended, immutable span. To keep it past the call, it
        /// calls `span.retain()` and later `span.release()`.
        onEnd: *const fn (ptr: *anyopaque, span: *const SpanData) void,
        forceFlush: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn onStart(p: SpanProcessor, parent: Context, span: *SpanData) void {
        p.vtable.onStart(p.ptr, parent, span);
    }

    pub fn onEnd(p: SpanProcessor, span: *const SpanData) void {
        p.vtable.onEnd(p.ptr, span);
    }

    pub fn forceFlush(p: SpanProcessor, deadline: Deadline) ExportError!void {
        return p.vtable.forceFlush(p.ptr, deadline);
    }

    pub fn shutdown(p: SpanProcessor, deadline: Deadline) ExportError!void {
        return p.vtable.shutdown(p.ptr, deadline);
    }
};

/// Sends ended spans to a backend.
pub const SpanExporter = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Exports a batch. The spans are valid only during the call; an
        /// exporter that keeps one retains it.
        exportSpans: *const fn (ptr: *anyopaque, spans: []const *const SpanData, deadline: Deadline) ExportError!void,
        /// Releases the exporter's resources. Later exports fail with
        /// `error.Shutdown`.
        shutdown: *const fn (ptr: *anyopaque, deadline: Deadline) ExportError!void,
    };

    pub fn exportSpans(e: SpanExporter, spans: []const *const SpanData, deadline: Deadline) ExportError!void {
        return e.vtable.exportSpans(e.ptr, spans, deadline);
    }

    pub fn shutdown(e: SpanExporter, deadline: Deadline) ExportError!void {
        return e.vtable.shutdown(e.ptr, deadline);
    }
};

/// Exports each sampled span synchronously as it ends. Exports are
/// serialized. Meant for tests and debugging; production uses the batch
/// processor.
pub const SimpleSpanProcessor = struct {
    io: Io,
    exporter: SpanExporter,
    export_timeout: Io.Duration,
    on_error: ErrorHandler,
    mutex: Io.Mutex = .init,
    is_shutdown: bool = false,

    pub const Options = struct {
        /// Bounds each export.
        export_timeout: Io.Duration = .fromSeconds(30),
        on_error: ErrorHandler = .ignore,
    };

    pub fn init(io: Io, exporter: SpanExporter, options: Options) SimpleSpanProcessor {
        return .{ .io = io, .exporter = exporter, .export_timeout = options.export_timeout, .on_error = options.on_error };
    }

    /// The processor interface. The processor must outlive the provider.
    pub fn processor(s: *SimpleSpanProcessor) SpanProcessor {
        return .{ .ptr = s, .vtable = &.{ .onStart = onStart, .onEnd = onEnd, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    fn onStart(_: *anyopaque, _: Context, _: *SpanData) void {}

    fn onEnd(ptr: *anyopaque, span: *const SpanData) void {
        const s: *SimpleSpanProcessor = @ptrCast(@alignCast(ptr));
        if (!span.span_context.isSampled()) return;
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        if (s.is_shutdown) return;
        s.exporter.exportSpans(&.{span}, deadline_mod.after(s.io, s.export_timeout)) catch |err| {
            s.on_error.handle("simple span processor", err, "exporting a span failed");
        };
    }

    fn forceFlush(_: *anyopaque, _: Deadline) ExportError!void {}

    fn shutdown(ptr: *anyopaque, deadline: Deadline) ExportError!void {
        const s: *SimpleSpanProcessor = @ptrCast(@alignCast(ptr));
        s.mutex.lockUncancelable(s.io);
        defer s.mutex.unlock(s.io);
        if (s.is_shutdown) return;
        s.is_shutdown = true;
        return s.exporter.shutdown(deadline);
    }
};
