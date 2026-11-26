//! Structured logger, console JSON/text formatter, OTLP log fan-out,
//! `forceEmit`, and the `std.log` bridge with opt-in `bindThread(ctx)` and
//! thread-local re-entrancy guard.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const Context = @import("context.zig").Context;
const pii = @import("pii.zig");
const policy_runtime = @import("policy_runtime.zig");
const redact = @import("redact.zig");
const spec = @import("spec.zig");
const attribute = @import("pipeline/attribute.zig");
const ids = @import("pipeline/ids.zig");
const log_record = @import("pipeline/log_record.zig");
const pipeline_logger = @import("pipeline/logger.zig");
const span_mod = @import("pipeline/span.zig");

/// Log severity level for the structured logger and level gates.
pub const Level = enum(u8) {
    debug = 0,
    info = 1,
    warn = 2,
    err = 3,

    /// Level name matching Go's `slog.Level.String()`.
    pub fn asStr(l: Level) []const u8 {
        return switch (l) {
            .debug => "DEBUG",
            .info => "INFO",
            .warn => "WARN",
            .err => "ERROR",
        };
    }

    /// Maps to OTLP severity number (Debug=5, Info=9, Warn=13, Error=17).
    pub fn toSeverity(l: Level) log_record.Severity {
        return switch (l) {
            .debug => .debug,
            .info => .info,
            .warn => .warn,
            .err => .@"error",
        };
    }

    /// Maps `std.log.Level` to `o11y.Level`.
    pub fn fromStdLog(l: std.log.Level) Level {
        return switch (l) {
            .debug => .debug,
            .info => .info,
            .warn => .warn,
            .err => .err,
        };
    }
};

/// Console output format.
pub const ConsoleFormat = enum {
    json,
    text,
};

/// Where the console leg writes formatted log lines.
pub const ConsoleWriter = union(enum) {
    stdout,
    stderr,
    custom: Custom,

    pub const WriteError = error{WriteFailed};

    pub const Custom = struct {
        ptr: *anyopaque,
        writeFn: *const fn (ptr: *anyopaque, bytes: []const u8) WriteError!void,
    };

    pub fn writeAll(w: ConsoleWriter, io: Io, bytes: []const u8) WriteError!void {
        switch (w) {
            .stdout => Io.File.stdout().writeStreamingAll(io, bytes) catch return error.WriteFailed,
            .stderr => Io.File.stderr().writeStreamingAll(io, bytes) catch return error.WriteFailed,
            .custom => |c| try c.writeFn(c.ptr, bytes),
        }
    }
};

/// User-supplied attribute replacer. Runs once per leaf attribute at fan-out,
/// BEFORE per-leg sensitivity classification. Returning null or an empty key
/// drops the attribute.
pub const AttrReplacer = struct {
    ptr: ?*anyopaque = null,
    replace: *const fn (ptr: ?*anyopaque, groups: []const []const u8, attr: log_record.KeyValue, arena: Allocator) ?log_record.KeyValue,
};

/// Record handed to extra log sinks (such as `o11ytest`'s capture sink).
/// Already replaced, classified, and prefixed with `trace_id`/`span_id` when
/// emitted inside a valid span context.
pub const SinkRecord = struct {
    time_unix_nano: u64,
    level: Level,
    message: []const u8,
    span_context: ids.SpanContext,
    attributes: []const log_record.KeyValue,
};

/// Extra log sink interface (for `o11ytest` and custom consumers).
pub const LogSink = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const SinkError = error{SinkRejected};

    pub const VTable = struct {
        enabled: *const fn (ptr: *anyopaque, ctx: Context, level: Level) bool,
        emit: *const fn (ptr: *anyopaque, ctx: Context, record: SinkRecord) SinkError!void,
    };

    pub fn enabled(s: LogSink, ctx: Context, level: Level) bool {
        return s.vtable.enabled(s.ptr, ctx, level);
    }

    pub fn emit(s: LogSink, ctx: Context, record: SinkRecord) SinkError!void {
        return s.vtable.emit(s.ptr, ctx, record);
    }
};

/// Internal fan-out log pipeline owned by `Telemetry`.
pub const LogPipeline = struct {
    gpa: Allocator,
    io: Io,
    level: Level,
    console_enabled: bool,
    console_format: ConsoleFormat,
    console_writer: ConsoleWriter,
    console_mutex: Io.Mutex = .init,
    attr_replacer: ?AttrReplacer,
    otlp_logger: ?*const pipeline_logger.Logger,
    extra_sinks: []const LogSink,
    policy: *const policy_runtime.Policy,

    pub fn init(
        gpa: Allocator,
        io: Io,
        level: Level,
        console_enabled: bool,
        console_format: ConsoleFormat,
        console_writer: ConsoleWriter,
        attr_replacer: ?AttrReplacer,
        otlp_logger: ?*const pipeline_logger.Logger,
        extra_sinks: []const LogSink,
        policy: *const policy_runtime.Policy,
    ) Allocator.Error!LogPipeline {
        return .{
            .gpa = gpa,
            .io = io,
            .level = level,
            .console_enabled = console_enabled,
            .console_format = console_format,
            .console_writer = console_writer,
            .attr_replacer = attr_replacer,
            .otlp_logger = otlp_logger,
            .extra_sinks = try gpa.dupe(LogSink, extra_sinks),
            .policy = policy,
        };
    }

    pub fn deinit(self: *LogPipeline) void {
        self.gpa.free(self.extra_sinks);
    }

    /// Reports whether `level` is enabled for `ctx`. Forced contexts are
    /// always enabled.
    pub fn enabled(self: *const LogPipeline, ctx: Context, level: Level) bool {
        if (ctx.force_emit) return true;
        return @backingInt(level) >= @backingInt(self.level);
    }

    /// Emits a log record to all configured legs, returning `error.CanaryRejected`
    /// if the console writer or any extra sink rejects the record.
    pub fn emitFallible(self: *LogPipeline, level: Level, ctx: Context, msg: []const u8, raw_attrs: []const log_record.KeyValue) error{CanaryRejected}!void {
        if (!self.enabled(ctx, level)) return;

        var stack_buf: [4096]u8 = undefined;
        var first: std.heap.BufferFirstAllocator = .init(&stack_buf, self.gpa);
        var arena_state: std.heap.ArenaAllocator = .init(first.allocator());
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const now = span_mod.nowUnixNano(self.io);
        const processed = self.processAttrs(arena, &.{}, raw_attrs);

        var rejected = false;

        // 1. Console leg: classify independently, correlate, format, write.
        if (self.console_enabled) {
            const classified = self.policy.classifyLogAttrs(processed, arena);
            self.writeConsole(now, level, msg, ctx.span_context, classified, arena) catch {
                rejected = true;
            };
        }

        // 2. OTLP log leg: native trace correlation; LoggerProvider runs
        // policy.applyLog once on the OTLP leg.
        if (self.otlp_logger) |otlp| {
            otlp.emit(ctx, .{
                .timestamp = now,
                .observed_timestamp = now,
                .severity = level.toSeverity(),
                .severity_text = level.asStr(),
                .body = .{ .string = msg },
                .attributes = processed,
                .trace_id = ctx.span_context.trace_id,
                .span_id = ctx.span_context.span_id,
                .trace_flags = ctx.span_context.flags,
            });
        }

        // 3. Extra log sinks: classify independently per sink and correlate.
        for (self.extra_sinks) |sink| {
            if (!ctx.force_emit and !sink.enabled(ctx, level)) continue;
            const classified = self.policy.classifyLogAttrs(processed, arena);
            const correlated = prependCorrelation(arena, ctx.span_context, classified);
            sink.emit(ctx, .{
                .time_unix_nano = now,
                .level = level,
                .message = msg,
                .span_context = ctx.span_context,
                .attributes = correlated,
            }) catch {
                rejected = true;
            };
        }

        if (rejected) return error.CanaryRejected;
    }

    /// Hot-path emit: returns `void`, never fails the host.
    pub fn emit(self: *LogPipeline, level: Level, ctx: Context, msg: []const u8, raw_attrs: []const log_record.KeyValue) void {
        self.emitFallible(level, ctx, msg, raw_attrs) catch {};
    }

    /// Applies fan-out preprocessing: drops top-level `trace_id`/`span_id`
    /// and empty keys, recurses into maps, and invokes `attr_replacer` once
    /// per leaf attribute.
    fn processAttrs(self: *const LogPipeline, arena: Allocator, path: []const []const u8, attrs: []const log_record.KeyValue) []log_record.KeyValue {
        var out = std.ArrayList(log_record.KeyValue).initCapacity(arena, attrs.len) catch return &.{};
        for (attrs) |a| {
            if (path.len == 0 and (std.mem.eql(u8, a.key, "trace_id") or std.mem.eql(u8, a.key, "span_id"))) {
                continue;
            }
            if (a.value == .map) {
                const members = a.value.map;
                if (a.key.len == 0) {
                    // Inline empty-keyed group.
                    const inlined = self.processAttrs(arena, path, members);
                    out.appendSlice(arena, inlined) catch {};
                    continue;
                }
                const next_path = arena.alloc([]const u8, path.len + 1) catch continue;
                @memcpy(next_path[0..path.len], path);
                next_path[path.len] = a.key;
                const processed_members = self.processAttrs(arena, next_path, members);
                if (processed_members.len == 0) continue; // elide empty group
                out.append(arena, .{ .key = a.key, .value = .{ .map = processed_members } }) catch {};
                continue;
            }
            if (a.key.len == 0) continue;
            var cur = a;
            if (self.attr_replacer) |rep| {
                const replaced = rep.replace(rep.ptr, path, cur, arena) orelse continue;
                if (replaced.key.len == 0) continue;
                cur = replaced;
            }
            out.append(arena, cur) catch {};
        }
        return out.items;
    }

    fn writeConsole(
        self: *LogPipeline,
        time_unix_nano: u64,
        level: Level,
        msg: []const u8,
        sc: ids.SpanContext,
        attrs: []const log_record.KeyValue,
        arena: Allocator,
    ) ConsoleWriter.WriteError!void {
        var buf: Io.Writer.Allocating = .init(arena);
        switch (self.console_format) {
            .json => formatJsonLine(&buf.writer, time_unix_nano, level, msg, sc, attrs) catch return error.WriteFailed,
            .text => formatTextLine(&buf.writer, time_unix_nano, level, msg, sc, attrs) catch return error.WriteFailed,
        }
        self.console_mutex.lockUncancelable(self.io);
        defer self.console_mutex.unlock(self.io);
        try self.console_writer.writeAll(self.io, buf.written());
    }
};

fn prependCorrelation(arena: Allocator, sc: ids.SpanContext, attrs: []const log_record.KeyValue) []const log_record.KeyValue {
    if (!sc.isValid()) return attrs;
    const tid_hex = sc.trace_id.hex();
    const sid_hex = sc.span_id.hex();
    const tid = arena.dupe(u8, &tid_hex) catch return attrs;
    const sid = arena.dupe(u8, &sid_hex) catch return attrs;
    const out = arena.alloc(log_record.KeyValue, attrs.len + 2) catch return attrs;
    out[0] = log_record.kv("trace_id", tid);
    out[1] = log_record.kv("span_id", sid);
    @memcpy(out[2..], attrs);
    return out;
}

/// Public structured logger handle obtained from `telemetry.logger()`.
/// Small value type; all methods return `void` and never fail the host.
pub const Logger = struct {
    pipeline: ?*LogPipeline = null,

    pub const noop: Logger = .{};

    pub fn debug(self: Logger, ctx: Context, msg: []const u8, attrs: anytype) void {
        self.log(.debug, ctx, msg, attrs);
    }

    pub fn info(self: Logger, ctx: Context, msg: []const u8, attrs: anytype) void {
        self.log(.info, ctx, msg, attrs);
    }

    pub fn warn(self: Logger, ctx: Context, msg: []const u8, attrs: anytype) void {
        self.log(.warn, ctx, msg, attrs);
    }

    pub fn err(self: Logger, ctx: Context, msg: []const u8, attrs: anytype) void {
        self.log(.err, ctx, msg, attrs);
    }

    pub fn log(self: Logger, level: Level, ctx: Context, msg: []const u8, attrs: anytype) void {
        const pl = self.pipeline orelse return;
        if (!pl.enabled(ctx, level)) return;
        var stack_buf: [2048]u8 = undefined;
        var first: std.heap.BufferFirstAllocator = .init(&stack_buf, pl.gpa);
        var arena_state: std.heap.ArenaAllocator = .init(first.allocator());
        defer arena_state.deinit();
        const kvs = convertAttrs(arena_state.allocator(), attrs) catch return;
        pl.emit(level, ctx, msg, kvs);
    }
};

/// Converts an anonymous struct literal or slice of `log_record.KeyValue` or
/// `attribute.KeyValue` into a `[]const log_record.KeyValue` allocated in `arena`.
pub fn convertAttrs(arena: Allocator, attrs: anytype) Allocator.Error![]const log_record.KeyValue {
    const T = @TypeOf(attrs);
    if (T == []const log_record.KeyValue or T == []log_record.KeyValue) return attrs;
    if (T == []const attribute.KeyValue or T == []attribute.KeyValue) {
        const out = try arena.alloc(log_record.KeyValue, attrs.len);
        for (out, attrs) |*dst, kv| dst.* = .{ .key = kv.key, .value = try attrValToLogVal(arena, kv.value) };
        return out;
    }
    const info = @typeInfo(T);
    if (info == .pointer and info.pointer.size == .one) {
        const child = @typeInfo(info.pointer.child);
        if (child == .array) {
            if (child.array.child == log_record.KeyValue) return attrs[0..];
            if (child.array.child == attribute.KeyValue) {
                const slice: []const attribute.KeyValue = attrs[0..];
                return convertAttrs(arena, slice);
            }
        }
    }
    if (info == .@"struct") {
        const field_names = info.@"struct".field_names;
        if (field_names.len == 0) return &.{};
        const out = try arena.alloc(log_record.KeyValue, field_names.len);
        inline for (field_names, 0..) |fname, i| {
            out[i] = .{
                .key = fname,
                .value = try redact.toLogValue(arena, @field(attrs, fname)),
            };
        }
        return out;
    }
    @compileError("o11y logger attributes must be a struct literal or slice of KeyValue, got " ++ @typeName(T));
}

fn attrValToLogVal(arena: Allocator, v: attribute.Value) Allocator.Error!log_record.Value {
    return switch (v) {
        .string => |s| .{ .string = s },
        .bool => |b| .{ .bool = b },
        .int => |i| .{ .int = i },
        .double => |d| .{ .double = d },
        .string_array => |items| blk: {
            const out = try arena.alloc(log_record.Value, items.len);
            for (out, items) |*dst, s| dst.* = .{ .string = s };
            break :blk .{ .array = out };
        },
        .bool_array => |items| blk: {
            const out = try arena.alloc(log_record.Value, items.len);
            for (out, items) |*dst, b| dst.* = .{ .bool = b };
            break :blk .{ .array = out };
        },
        .int_array => |items| blk: {
            const out = try arena.alloc(log_record.Value, items.len);
            for (out, items) |*dst, i| dst.* = .{ .int = i };
            break :blk .{ .array = out };
        },
        .double_array => |items| blk: {
            const out = try arena.alloc(log_record.Value, items.len);
            for (out, items) |*dst, d| dst.* = .{ .double = d };
            break :blk .{ .array = out };
        },
    };
}

/// Formats one console JSON line matching Go's `slog.JSONHandler`:
/// `{"time":"...","level":"...","msg":"..."[,"trace_id":"...","span_id":"..."],...}\n`.
pub fn formatJsonLine(
    w: *Io.Writer,
    time_unix_nano: u64,
    level: Level,
    msg: []const u8,
    sc: ids.SpanContext,
    attrs: []const log_record.KeyValue,
) Io.Writer.Error!void {
    try w.writeAll("{\"time\":\"");
    try writeRfc3339Nano(w, time_unix_nano);
    try w.writeAll("\",\"level\":\"");
    try w.writeAll(level.asStr());
    try w.writeAll("\",\"msg\":");
    try writeJsonStr(w, msg);
    if (sc.isValid()) {
        const tid = sc.trace_id.hex();
        const sid = sc.span_id.hex();
        try w.writeAll(",\"trace_id\":\"");
        try w.writeAll(&tid);
        try w.writeAll("\",\"span_id\":\"");
        try w.writeAll(&sid);
        try w.writeByte('"');
    }
    for (attrs) |kv| {
        try w.writeByte(',');
        try writeJsonStr(w, kv.key);
        try w.writeByte(':');
        try writeJsonLogValue(w, kv.value, 0);
    }
    try w.writeAll("}\n");
}

fn formatTextLine(
    w: *Io.Writer,
    time_unix_nano: u64,
    level: Level,
    msg: []const u8,
    sc: ids.SpanContext,
    attrs: []const log_record.KeyValue,
) Io.Writer.Error!void {
    try w.writeAll("time=");
    try writeRfc3339Nano(w, time_unix_nano);
    try w.writeAll(" level=");
    try w.writeAll(level.asStr());
    try w.writeAll(" msg=");
    try writeTextVal(w, msg);
    if (sc.isValid()) {
        const tid = sc.trace_id.hex();
        const sid = sc.span_id.hex();
        try w.writeAll(" trace_id=");
        try w.writeAll(&tid);
        try w.writeAll(" span_id=");
        try w.writeAll(&sid);
    }
    for (attrs) |kv| {
        try writeTextAttr(w, "", kv, 0);
    }
    try w.writeByte('\n');
}

fn writeTextAttr(w: *Io.Writer, prefix: []const u8, kv: log_record.KeyValue, depth: usize) Io.Writer.Error!void {
    if (depth > policy_runtime.max_composite_depth) return;
    if (kv.value == .map) {
        for (kv.value.map) |child| {
            try w.writeByte(' ');
            if (prefix.len > 0) {
                try w.writeAll(prefix);
                try w.writeByte('.');
            }
            try w.writeAll(kv.key);
            try w.writeByte('.');
            try w.writeAll(child.key);
            try w.writeByte('=');
            try writeTextLogVal(w, child.value);
        }
        return;
    }
    try w.writeByte(' ');
    if (prefix.len > 0) {
        try w.writeAll(prefix);
        try w.writeByte('.');
    }
    try w.writeAll(kv.key);
    try w.writeByte('=');
    try writeTextLogVal(w, kv.value);
}

fn writeTextLogVal(w: *Io.Writer, v: log_record.Value) Io.Writer.Error!void {
    switch (v) {
        .empty => try w.writeAll("null"),
        .string => |s| try writeTextVal(w, s),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .int => |i| try w.print("{d}", .{i}),
        .double => |d| {
            var buf: [pii.float_buffer_len]u8 = undefined;
            try w.writeAll(pii.formatFloat(&buf, d));
        },
        .bytes => |b| try std.base64.standard.Encoder.encodeWriter(w, b),
        .array, .map => try writeJsonLogValue(w, v, 0),
    }
}

fn writeTextVal(w: *Io.Writer, s: []const u8) Io.Writer.Error!void {
    const needs_quote = s.len == 0 or for (s) |c| {
        if (c <= ' ' or c == '"' or c == '=' or c == '\\') break true;
    } else false;
    if (!needs_quote) {
        try w.writeAll(s);
    } else {
        try writeJsonStr(w, s);
    }
}

/// Writes Unix nanoseconds as UTC RFC3339Nano (`YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`).
pub fn writeRfc3339Nano(w: *Io.Writer, time_unix_nano: u64) Io.Writer.Error!void {
    const secs: u64 = time_unix_nano / std.time.ns_per_s;
    const nanos: u64 = time_unix_nano % std.time.ns_per_s;
    const es: std.time.epoch.EpochSeconds = .{ .secs = secs };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    try w.print("{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}", .{
        yd.year,
        md.month.numeric(),
        md.day_index + 1,
        ds.getHoursIntoDay(),
        ds.getMinutesIntoHour(),
        ds.getSecondsIntoMinute(),
    });
    if (nanos > 0) {
        var frac_buf: [9]u8 = undefined;
        _ = std.fmt.bufPrint(&frac_buf, "{d:0>9}", .{nanos}) catch {};
        var end: usize = 9;
        while (end > 0 and frac_buf[end - 1] == '0') end -= 1;
        try w.writeByte('.');
        try w.writeAll(frac_buf[0..end]);
    }
    try w.writeByte('Z');
}

fn writeJsonLogValue(w: *Io.Writer, v: log_record.Value, depth: usize) Io.Writer.Error!void {
    if (depth > 32) {
        try w.writeAll("null");
        return;
    }
    switch (v) {
        .empty => try w.writeAll("null"),
        .string => |s| try writeJsonStr(w, s),
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .int => |i| try w.print("{d}", .{i}),
        .double => |d| {
            if (std.math.isNan(d) or std.math.isInf(d)) {
                var buf: [pii.float_buffer_len]u8 = undefined;
                try writeJsonStr(w, pii.formatFloat(&buf, d));
            } else {
                var buf: [pii.float_buffer_len]u8 = undefined;
                try w.writeAll(pii.formatFloat(&buf, d));
            }
        },
        .bytes => |b| {
            try w.writeByte('"');
            try std.base64.standard.Encoder.encodeWriter(w, b);
            try w.writeByte('"');
        },
        .array => |items| {
            try w.writeByte('[');
            for (items, 0..) |item, i| {
                if (i > 0) try w.writeByte(',');
                try writeJsonLogValue(w, item, depth + 1);
            }
            try w.writeByte(']');
        },
        .map => |pairs| {
            try w.writeByte('{');
            for (pairs, 0..) |p, i| {
                if (i > 0) try w.writeByte(',');
                try writeJsonStr(w, p.key);
                try w.writeByte(':');
                try writeJsonLogValue(w, p.value, depth + 1);
            }
            try w.writeByte('}');
        },
    }
}

fn writeJsonStr(w: *Io.Writer, s: []const u8) Io.Writer.Error!void {
    const hex = "0123456789abcdef";
    try w.writeByte('"');
    for (s) |b| {
        switch (b) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            0x08 => try w.writeAll("\\b"),
            0x0c => try w.writeAll("\\f"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0x00...0x07, 0x0b, 0x0e...0x1f => try w.writeAll(&.{ '\\', 'u', '0', '0', hex[b >> 4], hex[b & 0x0f] }),
            else => try w.writeByte(b),
        }
    }
    try w.writeByte('"');
}

// ---------------------------------------------------------------------------
// std.log bridge and opt-in bindThread(ctx)
// ---------------------------------------------------------------------------

var active_std_log_pipeline: std.atomic.Value(?*LogPipeline) = .init(null);

threadlocal var bound_context: ?Context = null;
threadlocal var in_std_log: bool = false;

/// Installs `pipeline` as the target of `stdLogFn`. Called by `o11y.setup`.
pub fn installStdLogTarget(pipeline: *LogPipeline) void {
    active_std_log_pipeline.store(pipeline, .release);
}

/// Clears the global `std.log` target if it still points to `pipeline`.
/// Called on shutdown/abandon of a `setup` telemetry instance.
pub fn clearStdLogTarget(pipeline: *LogPipeline) void {
    _ = active_std_log_pipeline.cmpxchgStrong(pipeline, null, .acq_rel, .monotonic);
}

/// Scope guard returned by `bindThread(ctx)`. Call `defer scope.end();` before
/// returning or awaiting under an evented `Io`.
pub const ThreadScope = struct {
    prev: ?Context,
    ended: bool = false,

    pub fn end(self: *ThreadScope) void {
        if (self.ended) return;
        self.ended = true;
        bound_context = self.prev;
    }
};

/// Opt-in thread-local trace context binding for `std.log` correlation.
/// Do NOT hold across an await point under an evented `std.Io`.
pub fn bindThread(ctx: Context) ThreadScope {
    const prev = bound_context;
    bound_context = ctx;
    return .{ .prev = prev };
}

/// `std.Options` preset that routes `std.log` into the active `o11y.setup`
/// pipeline: `pub const std_options = o11y.std_options;`.
pub const std_options: std.Options = .{
    .logFn = stdLogFn,
};

/// `std.log` handler installed via `o11y.std_options`. Guarded against
/// re-entrancy per thread, correlates ONLY inside an active `bindThread(ctx)`
/// scope, and stamps `o11y.log.source = "logger"`.
pub fn stdLogFn(
    comptime level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    if (in_std_log) return;
    in_std_log = true;
    defer in_std_log = false;

    const pl = active_std_log_pipeline.load(.acquire) orelse {
        std.log.defaultLog(level, scope, format, args);
        return;
    };

    var msg_buf: [4096]u8 = undefined;
    var w: Io.Writer = .fixed(&msg_buf);
    w.print(format, args) catch {};
    const msg = w.buffered();

    const ctx = bound_context orelse Context.background;
    if (scope == .default) {
        const attrs = [_]log_record.KeyValue{
            log_record.kv(spec.LogSource.key, spec.LogSource.logger.asStr()),
        };
        pl.emit(Level.fromStdLog(level), ctx, msg, &attrs);
    } else {
        const attrs = [_]log_record.KeyValue{
            log_record.kv(spec.LogSource.key, spec.LogSource.logger.asStr()),
            log_record.kv("scope", @tagName(scope)),
        };
        pl.emit(Level.fromStdLog(level), ctx, msg, &attrs);
    }
}

const testing = std.testing;

const TestBufferWriter = struct {
    gpa: Allocator,
    buf: std.ArrayList(u8) = .empty,
    fail: bool = false,

    fn deinit(self: *TestBufferWriter) void {
        self.buf.deinit(self.gpa);
    }

    fn writer(self: *TestBufferWriter) ConsoleWriter {
        return .{ .custom = .{ .ptr = self, .writeFn = writeFn } };
    }

    fn writeFn(ptr: *anyopaque, bytes: []const u8) ConsoleWriter.WriteError!void {
        const self: *TestBufferWriter = @ptrCast(@alignCast(ptr));
        if (self.fail) return error.WriteFailed;
        self.buf.appendSlice(self.gpa, bytes) catch return error.WriteFailed;
    }
};

test "console JSON formats time, level, msg, correlation, and redacted attributes" {
    var policy = try policy_runtime.Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();

    var cap: TestBufferWriter = .{ .gpa = testing.allocator };
    defer cap.deinit();

    var pl = try LogPipeline.init(testing.allocator, testing.io, .info, true, .json, cap.writer(), null, null, &.{}, &policy);
    defer pl.deinit();

    const log: Logger = .{ .pipeline = &pl };
    const sc: ids.SpanContext = .{
        .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
    };
    const ctx = Context.background.withSpanContext(sc);

    // Debug gated out unless forced.
    log.debug(ctx, "hidden", .{ .k = 1 });
    try testing.expectEqual(@as(usize, 0), cap.buf.items.len);
    log.debug(ctx.withForceEmit(), "forced", .{ .k = 1 });
    try testing.expect(std.mem.indexOf(u8, cap.buf.items, "\"level\":\"DEBUG\",\"msg\":\"forced\"") != null);

    cap.buf.clearRetainingCapacity();
    log.info(ctx, "order placed", .{
        .order_id = "ord-42",
        .trace_id = "spoofed", // must be dropped so real correlation wins
        .@"host.ip" = "10.0.0.1", // PII -> dropped
        .secret = redact.secret("top-secret"),
    });
    const line = cap.buf.items;
    try testing.expect(std.mem.indexOf(u8, line, "\"level\":\"INFO\",\"msg\":\"order placed\"") != null);
    try testing.expect(std.mem.indexOf(u8, line, "\"trace_id\":\"4bf92f3577b34da6a3ce929d0e0e4736\",\"span_id\":\"00f067aa0ba902b7\"") != null);
    try testing.expect(std.mem.indexOf(u8, line, "\"order_id\":\"ord-42\"") != null);
    try testing.expect(std.mem.indexOf(u8, line, "\"secret\":\"REDACTED\"") != null);
    try testing.expect(std.mem.indexOf(u8, line, "spoofed") == null);
    try testing.expect(std.mem.indexOf(u8, line, "10.0.0.1") == null);
}

test "user replacer runs before sensitivity policy so renamed-to-PII key is still dropped" {
    var policy = try policy_runtime.Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();

    var cap: TestBufferWriter = .{ .gpa = testing.allocator };
    defer cap.deinit();

    const replacer: AttrReplacer = .{
        .replace = struct {
            fn f(_: ?*anyopaque, _: []const []const u8, attr: log_record.KeyValue, _: Allocator) ?log_record.KeyValue {
                if (std.mem.eql(u8, attr.key, "client_addr")) {
                    return .{ .key = "host.ip", .value = attr.value };
                }
                return attr;
            }
        }.f,
    };

    var pl = try LogPipeline.init(testing.allocator, testing.io, .info, true, .json, cap.writer(), replacer, null, &.{}, &policy);
    defer pl.deinit();

    const log: Logger = .{ .pipeline = &pl };
    log.info(.background, "req", .{ .client_addr = "192.168.1.1", .ok = true });
    try testing.expect(std.mem.indexOf(u8, cap.buf.items, "192.168.1.1") == null);
    try testing.expect(std.mem.indexOf(u8, cap.buf.items, "\"ok\":true") != null);
}

test "stdLogFn correlates only inside bindThread and prevents re-entrancy" {
    var policy = try policy_runtime.Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();

    const ReentrantWriter = struct {
        gpa: Allocator,
        buf: std.ArrayList(u8) = .empty,
        trigger_reentry: bool = false,

        fn writeFn(ptr: *anyopaque, bytes: []const u8) ConsoleWriter.WriteError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            if (self.trigger_reentry) {
                self.trigger_reentry = false;
                stdLogFn(.err, .default, "recursive log", .{});
            }
            self.buf.appendSlice(self.gpa, bytes) catch return error.WriteFailed;
        }
    };

    var rw: ReentrantWriter = .{ .gpa = testing.allocator, .trigger_reentry = true };
    defer rw.buf.deinit(testing.allocator);

    var pl = try LogPipeline.init(
        testing.allocator,
        testing.io,
        .debug,
        true,
        .json,
        .{ .custom = .{ .ptr = &rw, .writeFn = ReentrantWriter.writeFn } },
        null,
        null,
        &.{},
        &policy,
    );
    defer pl.deinit();

    installStdLogTarget(&pl);
    defer clearStdLogTarget(&pl);

    // Without bindThread: no trace_id, o11y.log.source = "logger", and re-entrant log suppressed.
    stdLogFn(.info, .my_scope, "hello {d}", .{7});
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "\"msg\":\"hello 7\"") != null);
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "\"o11y.log.source\":\"logger\"") != null);
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "\"scope\":\"my_scope\"") != null);
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "trace_id") == null);
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "recursive log") == null);

    // Inside bindThread: trace_id and span_id appear.
    rw.buf.clearRetainingCapacity();
    const sc: ids.SpanContext = .{
        .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
    };
    {
        var scope = bindThread(Context.background.withSpanContext(sc));
        defer scope.end();
        stdLogFn(.warn, .default, "correlated", .{});
    }
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "\"trace_id\":\"4bf92f3577b34da6a3ce929d0e0e4736\"") != null);

    // After scope.end(): no trace_id again.
    rw.buf.clearRetainingCapacity();
    stdLogFn(.info, .default, "after", .{});
    try testing.expect(std.mem.indexOf(u8, rw.buf.items, "trace_id") == null);
}
