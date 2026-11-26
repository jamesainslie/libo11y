//! The logger provider and its loggers, as the OTel Go log SDK builds
//! them (sdk/log/provider.go and logger.go). This is the internal OTLP log
//! pipeline; the structured logger that applications call sits on top of
//! it in the core.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../context.zig").Context;
const deadline_mod = @import("deadline.zig");
const Deadline = deadline_mod.Deadline;
const log_processor = @import("log_processor.zig");
const log_record = @import("log_record.zig");
const LogData = log_record.LogData;
const policy_mod = @import("policy.zig");
const processor = @import("processor.zig");
const resource_mod = @import("resource.zig");
const span_mod = @import("span.zig");

/// Emits log records for one instrumentation scope.
pub const Logger = struct {
    /// Null for the no-op logger.
    provider: ?*LoggerProvider,
    scope: resource_mod.InstrumentationScope,

    /// A logger that emits nothing.
    pub const noop: Logger = .{ .provider = null, .scope = .{ .name = "" } };

    /// Emits a record. When the record carries no valid trace id, the
    /// trace id, span id and trace flags come from the span context in
    /// `ctx`. An unset observed timestamp becomes now. The record is
    /// copied under the provider's limits, the policy runs over its
    /// attributes, and every processor sees it in order. Never fails:
    /// without processors, after shutdown, or when memory runs out, the
    /// record is dropped.
    pub fn emit(logger: *const Logger, ctx: Context, record: log_record.Record) void {
        const provider = logger.provider orelse return;
        if (provider.processors.len == 0) return;
        if (!provider.beginOperation()) return;
        defer provider.endOperation();

        var r = record;
        if (!r.trace_id.isValid()) {
            const sc = ctx.span_context;
            if (sc.isValid()) {
                r.trace_id = sc.trace_id;
                r.span_id = sc.span_id;
                r.trace_flags = sc.flags;
            }
        }
        if (r.observed_timestamp == 0) r.observed_timestamp = span_mod.nowUnixNano(provider.io);

        const data = LogData.create(provider.gpa, r, &provider.resource, &logger.scope, provider.limits) orelse return;
        defer data.release();
        data.attributes = provider.policy.applyLog(data.attributes, data.allocator());
        for (provider.processors) |p| p.onEmit(ctx, data);
    }

    /// Reports whether a record emitted now would reach a processor. It is
    /// false for the no-op logger, without processors and after shutdown.
    pub fn enabled(logger: *const Logger) bool {
        const provider = logger.provider orelse return false;
        return provider.processors.len > 0 and !provider.is_shutdown.load(.acquire);
    }
};

/// Owns the loggers, the log record limits, the processors and the
/// attribute policy hook.
pub const LoggerProvider = struct {
    gpa: Allocator,
    io: Io,
    resource: resource_mod.Resource,
    limits: log_record.Limits,
    processors: []const log_processor.LogProcessor,
    policy: policy_mod.AttributePolicy,
    mutex: Io.Mutex = .init,
    loggers: std.ArrayList(*Logger) = .empty,
    is_shutdown: std.atomic.Value(bool) = .init(false),
    shutdown_done: Io.Event = .unset,
    shutdown_result: ?processor.ExportError = null,

    // Emits in progress, so shutdown waits for them before it shuts the
    // processors down, as Go's provider does.
    ops_mutex: Io.Mutex = .init,
    ops_idle: Io.Condition = .init,
    ops_active: usize = 0,
    ops_stopped: bool = false,

    pub const Options = struct {
        /// Borrowed: it must outlive the provider.
        resource: resource_mod.Resource = .empty,
        limits: log_record.Limits = .{},
        /// Copied; the processors themselves must outlive the provider.
        processors: []const log_processor.LogProcessor = &.{},
        policy: policy_mod.AttributePolicy = .noop,
    };

    /// Creates a provider.
    pub fn create(gpa: Allocator, io: Io, options: Options) Allocator.Error!*LoggerProvider {
        const p = try gpa.create(LoggerProvider);
        errdefer gpa.destroy(p);
        p.* = .{
            .gpa = gpa,
            .io = io,
            .resource = options.resource,
            .limits = options.limits,
            .processors = try gpa.dupe(log_processor.LogProcessor, options.processors),
            .policy = options.policy,
        };
        return p;
    }

    /// Frees the provider and its loggers. Shut it down first, so the
    /// processors have released every record. Records must not outlive it.
    pub fn destroy(p: *LoggerProvider) void {
        const gpa = p.gpa;
        for (p.loggers.items) |l| {
            gpa.free(l.scope.name);
            gpa.free(l.scope.version);
            gpa.free(l.scope.schema_url);
            gpa.destroy(l);
        }
        p.loggers.deinit(gpa);
        gpa.free(p.processors);
        gpa.destroy(p);
    }

    /// Returns the logger for a scope, creating it on first use. Loggers
    /// with the same name, version and schema URL are the same logger.
    /// The scope's attributes are not copied and must outlive the
    /// provider. Returns the no-op logger when out of memory.
    pub fn logger(p: *LoggerProvider, scope: resource_mod.InstrumentationScope) *const Logger {
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        for (p.loggers.items) |l| {
            if (std.mem.eql(u8, l.scope.name, scope.name) and
                std.mem.eql(u8, l.scope.version, scope.version) and
                std.mem.eql(u8, l.scope.schema_url, scope.schema_url)) return l;
        }
        return p.addLogger(scope) catch &Logger.noop;
    }

    fn addLogger(p: *LoggerProvider, scope: resource_mod.InstrumentationScope) Allocator.Error!*Logger {
        const gpa = p.gpa;
        const l = try gpa.create(Logger);
        errdefer gpa.destroy(l);
        const name = try gpa.dupe(u8, scope.name);
        errdefer gpa.free(name);
        const version = try gpa.dupe(u8, scope.version);
        errdefer gpa.free(version);
        const schema_url = try gpa.dupe(u8, scope.schema_url);
        errdefer gpa.free(schema_url);
        l.* = .{ .provider = p, .scope = .{ .name = name, .version = version, .schema_url = schema_url, .attributes = scope.attributes } };
        try p.loggers.append(gpa, l);
        return l;
    }

    fn beginOperation(p: *LoggerProvider) bool {
        p.ops_mutex.lockUncancelable(p.io);
        defer p.ops_mutex.unlock(p.io);
        if (p.ops_stopped) return false;
        p.ops_active += 1;
        return true;
    }

    fn endOperation(p: *LoggerProvider) void {
        p.ops_mutex.lockUncancelable(p.io);
        p.ops_active -= 1;
        const wake = p.ops_stopped and p.ops_active == 0;
        p.ops_mutex.unlock(p.io);
        if (wake) p.ops_idle.broadcast(p.io);
    }

    /// Flushes every processor in order, under one deadline, and returns
    /// the first error. After shutdown it does nothing, as in Go.
    pub fn forceFlush(p: *LoggerProvider, deadline: Deadline) processor.ExportError!void {
        if (p.is_shutdown.load(.acquire)) return;
        var first: ?processor.ExportError = null;
        for (p.processors) |lp| {
            lp.forceFlush(deadline) catch |err| {
                if (first == null) first = err;
            };
        }
        if (first) |err| return err;
    }

    /// Stops new emits, waits for the emits in progress, then shuts every
    /// processor down in order, all under one deadline. Later emits are
    /// dropped. Concurrent and later calls wait for the first shutdown to
    /// finish and return its result.
    pub fn shutdown(p: *LoggerProvider, deadline: Deadline) processor.ExportError!void {
        if (p.is_shutdown.swap(true, .acq_rel)) {
            p.shutdown_done.waitTimeout(p.io, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
            if (p.shutdown_result) |err| return err;
            return;
        }
        const drained = p.waitForEmits(deadline);
        var first: ?processor.ExportError = null;
        if (drained) |_| {
            for (p.processors) |lp| {
                lp.shutdown(deadline) catch |err| {
                    if (first == null) first = err;
                };
            }
        } else |err| first = err;
        p.shutdown_result = first;
        p.shutdown_done.set(p.io);
        if (first) |err| return err;
    }

    fn waitForEmits(p: *LoggerProvider, deadline: Deadline) processor.ExportError!void {
        p.ops_mutex.lockUncancelable(p.io);
        defer p.ops_mutex.unlock(p.io);
        p.ops_stopped = true;
        while (p.ops_active > 0) {
            p.ops_idle.waitTimeout(p.io, &p.ops_mutex, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
        }
    }
};
