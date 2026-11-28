//! Internal handle wrappers and C-to-Zig conversion helpers shared between
//! `abi.zig` (`libo11y`), `test_abi.zig` (`libo11ytest`), and `abi_unit_test.zig`.
//! Contains no `export fn` declarations so linking `libo11ytest.a` alongside
//! `libo11y.a` or `libo11y.so`/`.dylib` never introduces duplicate symbols.

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const c = @import("c_types.zig");
const rt = @import("runtime.zig");

const gpa = rt.gpa;

extern "c" fn o11y_ctx_destroy(ctx: ?*CtxHandle) void;

/// Compile-time ABI layout and build-mode fingerprint shared between `libo11y`
/// and `libo11ytest.a` so `o11y_test_start` detects mismatched builds.
pub fn abiFingerprint() u64 {
    return comptime blk: {
        var h = std.hash.Wyhash.init(0x6f3131795f616269);
        const tags = [_][]const u8{
            rt.c_version,
            @tagName(builtin.mode),
            @tagName(builtin.cpu.arch),
            @tagName(builtin.os.tag),
        };
        for (tags) |t| {
            h.update(t);
            h.update(&.{0});
        }
        const metrics = [_]usize{
            @sizeOf(SdkHandle),
            @alignOf(SdkHandle),
            @offsetOf(SdkHandle, "telemetry"),
            @offsetOf(SdkHandle, "owns_telemetry"),
            @offsetOf(SdkHandle, "io_kind"),
            @offsetOf(SdkHandle, "arena"),
            @offsetOf(SdkHandle, "effective_config_z"),
            @sizeOf(CtxHandle),
            @alignOf(CtxHandle),
            @offsetOf(CtxHandle, "arena"),
            @offsetOf(CtxHandle, "ctx"),
            @sizeOf(AttrReplacementHandle),
            @alignOf(AttrReplacementHandle),
            @offsetOf(AttrReplacementHandle, "key"),
            @offsetOf(AttrReplacementHandle, "value"),
            @sizeOf(o11y.Telemetry),
            @alignOf(o11y.Telemetry),
            @offsetOf(o11y.Telemetry, "policy"),
            @offsetOf(o11y.Telemetry, "meter_provider"),
            @offsetOf(o11y.Telemetry, "tracer_provider"),
            @offsetOf(o11y.Telemetry, "logger_provider"),
            @offsetOf(o11y.Telemetry, "log_pipeline"),
            @sizeOf(o11y.SpanData),
            @alignOf(o11y.SpanData),
            @sizeOf(o11y.Context),
            @alignOf(o11y.Context),
            @sizeOf(o11y.LogAttribute),
            @alignOf(o11y.LogAttribute),
            @sizeOf(o11y.LogValue),
            @alignOf(o11y.LogValue),
        };
        for (metrics) |m| {
            var buf: [8]u8 = undefined;
            std.mem.writeInt(u64, &buf, @as(u64, m), .little);
            h.update(&buf);
        }
        break :blk h.final();
    };
}

// =========================================================================
// Internal Handle Wrappers
// =========================================================================

pub const IoKind = enum { none, hermetic, networked };

pub const SdkHandle = struct {
    telemetry: *o11y.Telemetry,
    owns_telemetry: bool,
    io_kind: IoKind = .none,
    arena: std.heap.ArenaAllocator,
    effective_config_z: [*:0]const u8,
};

/// A context handle owns everything its `ctx` refers to except the wide-event
/// record: the trace state text and the baggage live in `arena`, every string
/// in them is NUL-terminated, and `ctx.span` is always null, so a context
/// stays valid after the span it was derived from ends.
pub const CtxHandle = struct {
    arena: std.heap.ArenaAllocator,
    ctx: o11y.Context,
};

pub const SpanHandle = struct {
    span: o11y.Span,
    owns_self: bool,
    /// The span's trace state, copied once when the handle is created and
    /// freed when the span ends.
    trace_state_z: ?[*:0]u8 = null,
};

pub const RecordHandle = struct {
    rec: o11y.Record,
};

pub const DetachedCarrierHandle = struct {
    carrier: o11y.detached.Carrier,
    /// The carrier's trace state, copied once when the handle is created.
    trace_state_z: ?[*:0]u8 = null,
};

pub const LinkedSpanHandle = struct {
    linked: o11y.detached.LinkedSpan,
    ctx_handle: CtxHandle,
    span_handle: SpanHandle,
};

pub const AttrReplacementHandle = struct {
    arena: Allocator,
    key: []const u8 = "",
    has_key: bool = false,
    key_failed: bool = false,
    value: o11y.LogValue = .empty,
    has_value: bool = false,
    val_failed: bool = false,
};

// =========================================================================
// Conversion Helpers
// =========================================================================

pub fn mapSetupError(err: o11y.SetupError) c.Err {
    return switch (err) {
        error.AlreadySetup => .already_setup,
        error.NoServiceName => .no_service_name,
        error.NoEnvironment => .no_environment,
        error.InvalidEnvironment => .invalid_environment,
        error.PIIHashKey => .pii_hash_key,
        error.InvalidAppRegistry => .invalid_app_registry,
        error.CanaryRejected => .canary_rejected,
        error.UnsupportedProtocol => .unsupported_protocol,
        error.Exporter => .exporter,
        error.OutOfMemory => .out_of_memory,
    };
}

pub fn mapBuildError(err: anytype) c.Err {
    return switch (err) {
        error.InvalidArgument => .invalid_argument,
        error.UnsupportedPropagator => .unsupported_propagator,
        else => |e| mapSetupError(e),
    };
}

pub fn mapExportError(err: ?o11y.ExportError) c.Err {
    const e = err orelse return .ok;
    return switch (e) {
        error.Timeout => .timeout,
        error.Shutdown => .shutdown,
        error.Canceled => .shutdown,
        else => .exporter,
    };
}

pub fn writeDiagnostic(diag_out: ?*c.Diagnostic, d: *const o11y.Diagnostic) void {
    const dst = diag_out orelse return;
    const msg = d.message();
    const n = @min(msg.len, dst.message.len - 1);
    if (n > 0) @memcpy(dst.message[0..n], msg[0..n]);
    dst.message[n] = 0;
    dst.len = n;
}

pub fn writeDiagnosticText(diag_out: ?*c.Diagnostic, msg: []const u8) void {
    const dst = diag_out orelse return;
    const n = @min(msg.len, dst.message.len - 1);
    if (n > 0) @memcpy(dst.message[0..n], msg[0..n]);
    dst.message[n] = 0;
    dst.len = n;
}

pub fn toZigLevel(l: c.Level) o11y.Level {
    return switch (l) {
        .debug => .debug,
        .info => .info,
        .warn => .warn,
        .err => .err,
        _ => .info,
    };
}

pub fn fromZigLevel(l: o11y.Level) c.Level {
    return switch (l) {
        .debug => .debug,
        .info => .info,
        .warn => .warn,
        .err => .err,
    };
}

pub fn toZigSpanKind(k: c.SpanKind) o11y.SpanKind {
    return switch (k) {
        .internal => .internal,
        .server => .server,
        .client => .client,
        .producer => .producer,
        .consumer => .consumer,
        _ => .internal,
    };
}

pub fn fromZigSpanKind(k: o11y.SpanKind) c.SpanKind {
    return switch (k) {
        .internal => .internal,
        .server => .server,
        .client => .client,
        .producer => .producer,
        .consumer => .consumer,
    };
}

pub fn toZigStatusCode(code: c.StatusCode) o11y.StatusCode {
    return switch (code) {
        .unset => .unset,
        .err => .@"error",
        .ok => .ok,
        _ => .unset,
    };
}

pub fn fromZigStatusCode(code: o11y.StatusCode) c.StatusCode {
    return switch (code) {
        .unset => .unset,
        .@"error" => .err,
        .ok => .ok,
    };
}

pub fn toZigSpanContext(sc: c.SpanContext) o11y.SpanContext {
    return .{
        .trace_id = .{ .bytes = sc.trace_id.bytes },
        .span_id = .{ .bytes = sc.span_id.bytes },
        .flags = .fromByte(sc.trace_flags),
        .trace_state = .{ .header = rt.cStrOrEmpty(sc.trace_state) },
        .remote = sc.remote,
    };
}

pub fn fromZigSpanContext(sc: o11y.SpanContext, ts_z: ?[*:0]const u8) c.SpanContext {
    return .{
        .trace_id = .{ .bytes = sc.trace_id.bytes },
        .span_id = .{ .bytes = sc.span_id.bytes },
        .trace_flags = sc.flags.toByte(),
        .remote = sc.remote,
        .trace_state = ts_z,
    };
}

// Option enums are checked: a value the header does not define fails setup
// with `O11Y_ERR_INVALID_ARGUMENT` instead of silently becoming a default.

pub fn checkedLevel(l: c.Level, diag_out: ?*c.Diagnostic) error{InvalidArgument}!o11y.Level {
    return switch (l) {
        .debug => .debug,
        .info => .info,
        .warn => .warn,
        .err => .err,
        _ => invalidOption(diag_out, "unknown log_level"),
    };
}

pub fn toZigConsoleFormat(f: c.ConsoleFormat, diag_out: ?*c.Diagnostic) error{InvalidArgument}!o11y.ConsoleFormat {
    return switch (f) {
        .json => .json,
        .text => .text,
        _ => invalidOption(diag_out, "unknown console_format"),
    };
}

pub fn checkedPiiMode(m: c.PiiMode, diag_out: ?*c.Diagnostic) error{InvalidArgument}!o11y.PIIMode {
    return switch (m) {
        .drop => .drop,
        .hash => .hash,
        .allow => .allow,
        _ => invalidOption(diag_out, "unknown pii_mode"),
    };
}

pub fn checkedSampler(kind: c.SamplerKind, ratio: f64, diag_out: ?*c.Diagnostic) error{InvalidArgument}!?o11y.Sampler {
    return switch (kind) {
        .default => null,
        .always_on => .always_on,
        .always_off => .always_off,
        .trace_id_ratio => o11y.Sampler.traceIdRatio(ratio),
        .parent_based_always_on => .{ .parent_based = .{ .root = .always_on } },
        .parent_based_always_off => .{ .parent_based = .{ .root = .always_off } },
        .parent_based_trace_id_ratio => .{ .parent_based = .{ .root = .{ .trace_id_ratio = .init(ratio) } } },
        _ => invalidOption(diag_out, "unknown sampler_kind"),
    };
}

pub fn checkedExemplarFilter(f: c.ExemplarFilter, diag_out: ?*c.Diagnostic) error{InvalidArgument}!?o11y.ExemplarFilter {
    return switch (f) {
        .default => null,
        .trace_based => .trace_based,
        .always_on => .always_on,
        .always_off => .always_off,
        _ => invalidOption(diag_out, "unknown exemplar_filter"),
    };
}

pub fn convertAttrs(arena: Allocator, raw: ?[*]const c.Attr, len: usize) Allocator.Error![]o11y.Attribute {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    const slice = ptr[0..len];
    var out = try std.ArrayList(o11y.Attribute).initCapacity(arena, len);
    for (slice) |a| {
        const key = rt.cStrOrEmpty(a.key);
        const val: o11y.AttributeValue = switch (a.kind) {
            .string => .{ .string = try arena.dupe(u8, rt.cStrOrEmpty(a.value.str_val)) },
            .bool => .{ .bool = a.value.bool_val },
            .int => .{ .int = a.value.int_val },
            .double => .{ .double = a.value.double_val },
            .string_array => blk: {
                const n = a.value.str_array.len;
                if (n == 0 or a.value.str_array.items == null) break :blk .{ .string_array = &.{} };
                const items = a.value.str_array.items.?[0..n];
                const duped = try arena.alloc([]const u8, n);
                for (items, duped) |src, *dst| {
                    dst.* = try arena.dupe(u8, rt.cStrOrEmpty(src));
                }
                break :blk .{ .string_array = duped };
            },
            .bool_array => blk: {
                const n = a.value.bool_array.len;
                if (n == 0 or a.value.bool_array.items == null) break :blk .{ .bool_array = &.{} };
                break :blk .{ .bool_array = try arena.dupe(bool, a.value.bool_array.items.?[0..n]) };
            },
            .int_array => blk: {
                const n = a.value.int_array.len;
                if (n == 0 or a.value.int_array.items == null) break :blk .{ .int_array = &.{} };
                break :blk .{ .int_array = try arena.dupe(i64, a.value.int_array.items.?[0..n]) };
            },
            .double_array => blk: {
                const n = a.value.double_array.len;
                if (n == 0 or a.value.double_array.items == null) break :blk .{ .double_array = &.{} };
                break :blk .{ .double_array = try arena.dupe(f64, a.value.double_array.items.?[0..n]) };
            },
            _ => continue,
        };
        out.appendAssumeCapacity(.{ .key = try arena.dupe(u8, key), .value = val });
    }
    return out.items;
}

pub const composite_walk_budget: usize = o11y.pii.walk_budget;

pub const WalkState = struct {
    remaining: usize,
    ancestors: [o11y.pii.max_depth + 2]usize = undefined,
    ancestor_len: usize = 0,

    pub fn enter(self: *WalkState, addr: usize) bool {
        for (self.ancestors[0..self.ancestor_len]) |seen| {
            if (seen == addr) return false;
        }
        if (self.ancestor_len >= self.ancestors.len) return false;
        self.ancestors[self.ancestor_len] = addr;
        self.ancestor_len += 1;
        return true;
    }

    pub fn leave(self: *WalkState) void {
        self.ancestor_len -= 1;
    }
};

pub fn convertLogValueBounded(arena: Allocator, v: c.LogValue, depth: usize, walk: *WalkState) Allocator.Error!?o11y.LogValue {
    if (walk.remaining == 0) return null;
    walk.remaining -= 1;
    return switch (v.kind) {
        .empty => .empty,
        .string => blk: {
            const sv = v.value.str_val;
            const slice: []const u8 = if (sv.data) |d|
                (if (sv.has_len) d[0..sv.len] else std.mem.span(@as([*:0]const u8, @ptrCast(d))))
            else
                "";
            break :blk .{ .string = try arena.dupe(u8, slice) };
        },
        .bool => .{ .bool = v.value.bool_val },
        .int => .{ .int = v.value.int_val },
        .double => .{ .double = v.value.double_val },
        .bytes => blk: {
            const bv = v.value.bytes_val;
            if (bv.len == 0 or bv.data == null) break :blk .{ .bytes = &.{} };
            break :blk .{ .bytes = try arena.dupe(u8, bv.data.?[0..bv.len]) };
        },
        .array => blk: {
            // Match zig/src/log_pipeline.zig and zig/src/policy_runtime.zig depth >= max_composite_depth.
            if (depth >= o11y.pii.max_depth) break :blk null;
            const av = v.value.array_val;
            if (av.len == 0 or av.items == null) break :blk .{ .array = &.{} };
            if (!walk.enter(@intFromPtr(av.items.?))) break :blk null;
            defer walk.leave();
            var kept: std.ArrayList(o11y.LogValue) = .empty;
            for (av.items.?[0..av.len]) |item| {
                if (walk.remaining == 0) break;
                if (try convertLogValueBounded(arena, item, depth + 1, walk)) |val| {
                    try kept.append(arena, val);
                }
            }
            if (kept.items.len == 0) break :blk null;
            break :blk .{ .array = kept.items };
        },
        .map => blk: {
            // Match zig/src/log_pipeline.zig and zig/src/policy_runtime.zig depth >= max_composite_depth.
            if (depth >= o11y.pii.max_depth) break :blk null;
            const mv = v.value.map_val;
            if (mv.len == 0 or mv.items == null) break :blk .{ .map = &.{} };
            if (!walk.enter(@intFromPtr(mv.items.?))) break :blk null;
            defer walk.leave();
            var kept: std.ArrayList(o11y.LogAttribute) = .empty;
            for (mv.items.?[0..mv.len]) |src| {
                if (walk.remaining == 0) break;
                if (try convertLogValueBounded(arena, src.value, depth + 1, walk)) |val| {
                    try kept.append(arena, .{
                        .key = try arena.dupe(u8, rt.cStrOrEmpty(src.key)),
                        .value = val,
                    });
                }
            }
            if (kept.items.len == 0) break :blk null;
            break :blk .{ .map = kept.items };
        },
        _ => null,
    };
}

pub fn convertLogAttrs(arena: Allocator, raw: ?[*]const c.LogAttr, len: usize) Allocator.Error![]o11y.LogAttribute {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    var out = try std.ArrayList(o11y.LogAttribute).initCapacity(arena, len);
    for (ptr[0..len]) |src| {
        var walk: WalkState = .{ .remaining = composite_walk_budget };
        if (try convertLogValueBounded(arena, src.value, 0, &walk)) |val| {
            out.appendAssumeCapacity(.{
                .key = try arena.dupe(u8, rt.cStrOrEmpty(src.key)),
                .value = val,
            });
        }
    }
    return out.items;
}

pub fn zigLogValueToC(arena: Allocator, v: o11y.LogValue, depth: usize) Allocator.Error!c.LogValue {
    if (depth > 32) return .{ .kind = .empty, .value = .{ .int_val = 0 } };
    return switch (v) {
        .empty => .{ .kind = .empty, .value = .{ .int_val = 0 } },
        .string => |s| blk: {
            const z = try rt.dupeZ(arena, s);
            break :blk .{ .kind = .string, .value = .{ .str_val = .{ .data = z.ptr, .len = s.len, .has_len = true } } };
        },
        .bool => |b| .{ .kind = .bool, .value = .{ .bool_val = b } },
        .int => |n| .{ .kind = .int, .value = .{ .int_val = n } },
        .double => |d| .{ .kind = .double, .value = .{ .double_val = d } },
        .bytes => |b| blk: {
            const cp = try arena.dupe(u8, b);
            break :blk .{ .kind = .bytes, .value = .{ .bytes_val = .{ .data = cp.ptr, .len = cp.len } } };
        },
        .array => |items| blk: {
            const out = try arena.alloc(c.LogValue, items.len);
            for (items, out) |item, *dst| {
                dst.* = try zigLogValueToC(arena, item, depth + 1);
            }
            break :blk .{ .kind = .array, .value = .{ .array_val = .{ .items = if (out.len > 0) out.ptr else null, .len = out.len } } };
        },
        .map => |pairs| blk: {
            const out = try zigLogAttrsToC(arena, pairs, depth + 1);
            break :blk .{ .kind = .map, .value = .{ .map_val = .{ .items = if (out.len > 0) out.ptr else null, .len = out.len } } };
        },
    };
}

pub fn zigLogAttrsToC(arena: Allocator, attrs: []const o11y.LogAttribute, depth: usize) Allocator.Error![]c.LogAttr {
    if (attrs.len == 0) return &.{};
    const out = try arena.alloc(c.LogAttr, attrs.len);
    for (attrs, out) |src, *dst| {
        dst.* = .{
            .key = (try rt.dupeZ(arena, src.key)).ptr,
            .value = try zigLogValueToC(arena, src.value, depth),
        };
    }
    return out;
}

// =========================================================================
// Trampolines for C callbacks stored in SdkHandle / Recorder arena
// =========================================================================

pub const ConsoleWriterTrampoline = struct {
    func: c.ConsoleWriteFn,
    userdata: ?*anyopaque,

    pub fn write(ptr: *anyopaque, bytes: []const u8) o11y.ConsoleWriter.WriteError!void {
        const self: *ConsoleWriterTrampoline = @ptrCast(@alignCast(ptr));
        const rc = self.func(self.userdata, bytes.ptr, bytes.len);
        if (rc != .ok) return error.WriteFailed;
    }
};

pub const AttrReplacerTrampoline = struct {
    func: c.AttrReplacerFn,
    userdata: ?*anyopaque,

    pub fn replace(ptr: ?*anyopaque, groups: []const []const u8, attr: o11y.LogAttribute, arena: Allocator) ?o11y.LogAttribute {
        const self: *AttrReplacerTrampoline = @ptrCast(@alignCast(ptr orelse return null));
        const key_z = rt.dupeZ(arena, attr.key) catch return null;
        const c_val = zigLogValueToC(arena, attr.value, 0) catch return null;

        var c_groups_ptr: ?[*]const ?[*:0]const u8 = null;
        if (groups.len > 0) {
            const grp_arr = arena.alloc(?[*:0]const u8, groups.len) catch return null;
            for (groups, grp_arr) |g, *dst| {
                dst.* = (rt.dupeZ(arena, g) catch return null).ptr;
            }
            c_groups_ptr = grp_arr.ptr;
        }

        var repl: AttrReplacementHandle = .{ .arena = arena };
        const keep = self.func(
            self.userdata,
            c_groups_ptr,
            groups.len,
            key_z.ptr,
            &c_val,
            &repl,
        );
        if (!keep or repl.key_failed or repl.val_failed) return null;

        var res = attr;
        if (repl.has_key) res.key = repl.key;
        if (repl.has_value) res.value = repl.value;
        return res;
    }
};

pub const LogSinkTrampoline = struct {
    sink: c.LogSink,
    allocator: Allocator = gpa,

    pub const vtable: o11y.LogSink.VTable = .{
        .enabled = enabledFn,
        .emit = emitFn,
    };

    fn enabledFn(ptr: *anyopaque, ctx: o11y.Context, level: o11y.Level) bool {
        const self: *LogSinkTrampoline = @ptrCast(@alignCast(ptr));
        const f = self.sink.enabled orelse return true;
        return f(self.sink.userdata, fromZigLevel(level), ctx.force_emit);
    }

    fn emitFn(ptr: *anyopaque, _: o11y.Context, rec: o11y.SinkRecord) o11y.LogSink.SinkError!void {
        const self: *LogSinkTrampoline = @ptrCast(@alignCast(ptr));
        const f = self.sink.emit orelse return;
        var arena_state: std.heap.ArenaAllocator = .init(self.allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const msg_z = rt.dupeZ(arena, rec.message) catch return error.SinkRejected;
        const ts_z: ?[*:0]const u8 = if (rec.span_context.trace_state.header.len > 0)
            (rt.dupeZ(arena, rec.span_context.trace_state.header) catch return error.SinkRejected)
        else
            null;
        const c_attrs = zigLogAttrsToC(arena, rec.attributes, 0) catch return error.SinkRejected;
        const rc = f(
            self.sink.userdata,
            rec.time_unix_nano,
            fromZigLevel(rec.level),
            msg_z.ptr,
            fromZigSpanContext(rec.span_context, ts_z),
            if (c_attrs.len > 0) c_attrs.ptr else null,
            c_attrs.len,
        );
        if (rc != .ok) return error.SinkRejected;
    }
};

pub const ErrorHandlerTrampoline = struct {
    func: c.ErrorHandlerFn,
    userdata: ?*anyopaque,

    pub fn handle(ptr: ?*anyopaque, component: []const u8, err: o11y.ExportError, detail: []const u8) void {
        const self: *ErrorHandlerTrampoline = @ptrCast(@alignCast(ptr orelse return));
        // A message longer than the buffer is truncated, never dropped.
        var buf: [512]u8 = undefined;
        var w: Io.Writer = .fixed(buf[0 .. buf.len - 1]);
        w.print("{s}: {s}: {s}", .{ component, @errorName(err), detail }) catch {};
        buf[w.end] = 0;
        self.func(self.userdata, @ptrCast(&buf));
    }
};

// =========================================================================
// Propagators and the baggage egress filter
// =========================================================================

/// The error a C option can cause before the engine sees it.
pub const OptionError = error{ OutOfMemory, InvalidArgument, UnsupportedPropagator };

/// Writes "o11y: <msg>" to the diagnostic and returns `error.InvalidArgument`.
pub fn invalidOption(diag_out: ?*c.Diagnostic, comptime msg: []const u8) error{InvalidArgument} {
    writeDiagnosticText(diag_out, "o11y: " ++ msg);
    return error.InvalidArgument;
}

const NoopPropagator = struct {
    const stateless: u8 = 0;
    const none_fields = [_][]const u8{"none"};
    const propagator: o11y.Propagator = .{ .ptr = &stateless, .vtable = &vtable };
    const vtable: o11y.Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };

    fn inject(_: *const anyopaque, _: o11y.Context, _: Allocator, _: o11y.Carrier) void {}

    fn extract(_: *const anyopaque, ctx: o11y.Context, _: Allocator, _: o11y.Carrier) o11y.Context {
        return ctx;
    }

    fn fields(_: *const anyopaque) []const []const u8 {
        return &none_fields;
    }
};

/// A C carrier whose callbacks read and write an engine carrier. A custom
/// propagator receives one of these.
const EngineCarrierBridge = struct {
    carrier: o11y.Carrier,
    arena: Allocator,

    fn cCarrier(self: *EngineCarrierBridge) c.Carrier {
        return .{ .userdata = self, .get = get, .set = set };
    }

    fn get(userdata: ?*anyopaque, key: ?[*:0]const u8) callconv(.c) ?[*:0]const u8 {
        const self: *EngineCarrierBridge = @ptrCast(@alignCast(userdata orelse return null));
        const k = rt.cStrOpt(key) orelse return null;
        const value = self.carrier.get(k) orelse return null;
        const z = rt.dupeZ(self.arena, value) catch return null;
        return z.ptr;
    }

    fn set(userdata: ?*anyopaque, key: ?[*:0]const u8, value: ?[*:0]const u8) callconv(.c) void {
        const self: *EngineCarrierBridge = @ptrCast(@alignCast(userdata orelse return));
        const k = rt.cStrOpt(key) orelse return;
        const v = rt.cStrOpt(value) orelse return;
        self.carrier.set(k, v);
    }
};

/// An `o11y_propagator_t` of kind `O11Y_PROPAGATOR_CUSTOM` as an engine
/// propagator. It lives in the SDK's arena.
const CustomPropagator = struct {
    def: c.Propagator,
    field_names: []const []const u8,

    const vtable: o11y.Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };

    fn propagator(self: *const CustomPropagator) o11y.Propagator {
        return .{ .ptr = self, .vtable = &vtable };
    }

    fn cast(ptr: *const anyopaque) *const CustomPropagator {
        return @ptrCast(@alignCast(ptr));
    }

    fn inject(ptr: *const anyopaque, ctx: o11y.Context, _: Allocator, carrier: o11y.Carrier) void {
        const self = cast(ptr);
        const f = self.def.inject orelse return;
        var view: CtxHandle = .{ .arena = .init(gpa), .ctx = .background };
        defer view.arena.deinit();
        view.ctx = ownContext(view.arena.allocator(), ctx) catch return;
        var bridge: EngineCarrierBridge = .{ .carrier = carrier, .arena = view.arena.allocator() };
        const c_carrier = bridge.cCarrier();
        f(self.def.userdata, &view, &c_carrier);
    }

    fn extract(ptr: *const anyopaque, ctx: o11y.Context, arena: Allocator, carrier: o11y.Carrier) o11y.Context {
        const self = cast(ptr);
        const f = self.def.extract orelse return ctx;
        var view: CtxHandle = .{ .arena = .init(gpa), .ctx = .background };
        defer view.arena.deinit();
        view.ctx = ownContext(view.arena.allocator(), ctx) catch return ctx;
        var bridge: EngineCarrierBridge = .{ .carrier = carrier, .arena = view.arena.allocator() };
        const c_carrier = bridge.cCarrier();
        const returned = f(self.def.userdata, &view, &c_carrier) orelse return ctx;
        const out: *CtxHandle = @ptrCast(@alignCast(returned));
        // The callback returns a context it derived. Its input is not its to return.
        if (out == &view) return ctx;
        defer o11y_ctx_destroy(out);
        var result = ownContext(arena, out.ctx) catch return ctx;
        // Only what a propagator carries comes from the callback's context.
        result.span = ctx.span;
        result.force_emit = ctx.force_emit;
        result.record = ctx.record;
        return result;
    }

    fn fields(ptr: *const anyopaque) []const []const u8 {
        return cast(ptr).field_names;
    }
};

/// The propagators of one SDK behind a baggage egress filter that calls a C
/// predicate with its userdata. The engine's own filter takes a bare function
/// pointer, which cannot carry per-SDK state, so the C layer filters here and
/// leaves the engine's filter at its default, which allows every key.
const EgressFilter = struct {
    inners: []const o11y.Propagator,
    field_names: []const []const u8,
    allow: c.BaggageEgressAllowFn,
    userdata: ?*anyopaque,

    const vtable: o11y.Propagator.VTable = .{ .inject = inject, .extract = extract, .fields = fields };

    fn propagator(self: *const EgressFilter) o11y.Propagator {
        return .{ .ptr = self, .vtable = &vtable };
    }

    fn cast(ptr: *const anyopaque) *const EgressFilter {
        return @ptrCast(@alignCast(ptr));
    }

    fn injectAll(self: *const EgressFilter, ctx: o11y.Context, scratch: Allocator, carrier: o11y.Carrier) void {
        for (self.inners) |p| p.inject(ctx, scratch, carrier);
    }

    /// Injects with only the baggage members the predicate allows. When the
    /// filtered list cannot be built, it injects no baggage at all instead of
    /// unfiltered baggage.
    fn inject(ptr: *const anyopaque, ctx: o11y.Context, scratch: Allocator, carrier: o11y.Carrier) void {
        const self = cast(ptr);
        const bag = ctx.baggage orelse return self.injectAll(ctx, scratch, carrier);
        if (bag.members.len == 0) return self.injectAll(ctx, scratch, carrier);
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const kept = arena.alloc(o11y.Baggage.Member, bag.members.len) catch
            return self.injectAll(ctx.withBaggage(null), scratch, carrier);
        var n: usize = 0;
        for (bag.members) |m| {
            const key_z = rt.dupeZ(arena, m.key) catch
                return self.injectAll(ctx.withBaggage(null), scratch, carrier);
            if (!self.allow(self.userdata, key_z.ptr)) continue;
            kept[n] = m;
            n += 1;
        }
        const filtered: o11y.Baggage = .{ .members = kept[0..n] };
        self.injectAll(ctx.withBaggage(&filtered), scratch, carrier);
    }

    fn extract(ptr: *const anyopaque, ctx: o11y.Context, arena: Allocator, carrier: o11y.Carrier) o11y.Context {
        var out = ctx;
        for (cast(ptr).inners) |p| out = p.extract(out, arena, carrier);
        return out;
    }

    fn fields(ptr: *const anyopaque) []const []const u8 {
        return cast(ptr).field_names;
    }
};

/// Builds the value of the engine's `propagators` option from the C options
/// and `env` (`OTEL_PROPAGATORS`, ignored when `propagators_len > 0` or hermetic).
/// With no predicate it is the configured list, which the engine composes and
/// which is empty for the W3C default. With a predicate it is one
/// `EgressFilter` around the configured list or around the W3C default.
/// Everything is allocated in `arena`, which must live as long as the SDK.
pub fn buildPropagators(
    arena: Allocator,
    env: o11y.Env,
    raw: ?[*]const c.Propagator,
    len: usize,
    allow: ?c.BaggageEgressAllowFn,
    allow_userdata: ?*anyopaque,
    diag_out: ?*c.Diagnostic,
) OptionError![]const o11y.Propagator {
    if (len > 0 and raw == null) {
        return invalidOption(diag_out, "propagators pointer must not be null when propagators_len > 0");
    }
    var list: []o11y.Propagator = &.{};
    if (len > 0) {
        const defs = raw.?[0..len];
        list = try arena.alloc(o11y.Propagator, defs.len);
        var has_any_field = false;
        var first_custom: ?*CustomPropagator = null;
        for (defs, list) |def, *dst| {
            dst.* = switch (def.kind) {
                .trace_context => blk: {
                    has_any_field = true;
                    break :blk o11y.TraceContextPropagator.propagator;
                },
                .baggage => blk: {
                    has_any_field = true;
                    break :blk o11y.BaggagePropagator.propagator;
                },
                .custom => blk: {
                    if (def.inject == null and def.extract == null) {
                        return invalidOption(diag_out, "a custom propagator needs an inject or an extract callback");
                    }
                    if (def.fields_len > 0 and def.fields == null) {
                        return invalidOption(diag_out, "custom propagator fields pointer must not be null when fields_len > 0");
                    }
                    const names = try arena.alloc([]const u8, def.fields_len);
                    for (names, 0..) |*name, i| {
                        name.* = try arena.dupe(u8, rt.cStrOrEmpty(def.fields.?[i]));
                        if (name.*.len > 0) has_any_field = true;
                    }
                    const custom = try arena.create(CustomPropagator);
                    custom.* = .{ .def = def, .field_names = names };
                    if (first_custom == null) first_custom = custom;
                    break :blk custom.propagator();
                },
                _ => return invalidOption(diag_out, "unknown propagator kind"),
            };
        }
        if (!has_any_field) {
            if (first_custom) |custom| {
                const fallback = try arena.alloc([]const u8, 1);
                fallback[0] = "custom";
                custom.field_names = fallback;
            }
        }
    } else if (!env.isHermetic()) {
        if (env.get("OTEL_PROPAGATORS")) |raw_env| {
            var parsed: std.ArrayList(o11y.Propagator) = .empty;
            var has_tc = false;
            var has_baggage = false;
            var has_none = false;
            var it = std.mem.splitScalar(u8, raw_env, ',');
            while (it.next()) |token_raw| {
                const name = std.mem.trim(u8, token_raw, " \t\r\n\x0b\x0c");
                if (name.len == 0) continue;
                if (std.mem.eql(u8, name, "tracecontext")) {
                    if (!has_tc) {
                        has_tc = true;
                        try parsed.append(arena, o11y.TraceContextPropagator.propagator);
                    }
                } else if (std.mem.eql(u8, name, "baggage")) {
                    if (!has_baggage) {
                        has_baggage = true;
                        try parsed.append(arena, o11y.BaggagePropagator.propagator);
                    }
                } else if (std.mem.eql(u8, name, "none")) {
                    has_none = true;
                } else {
                    var msg_buf: [256]u8 = undefined;
                    const msg = std.fmt.bufPrint(&msg_buf, "o11y: building propagator: unsupported OTEL_PROPAGATORS entry \"{s}\"", .{name}) catch "o11y: building propagator: unsupported OTEL_PROPAGATORS entry";
                    writeDiagnosticText(diag_out, msg);
                    return error.UnsupportedPropagator;
                }
            }
            if (has_none) {
                list = try arena.dupe(o11y.Propagator, &.{NoopPropagator.propagator});
            } else if (parsed.items.len > 0) {
                list = parsed.items;
            }
        }
    }

    const allow_fn = allow orelse return list;
    const inners: []const o11y.Propagator = if (list.len > 0) list else try arena.dupe(o11y.Propagator, &.{
        o11y.TraceContextPropagator.propagator,
        o11y.BaggagePropagator.propagator,
    });
    var names: std.ArrayList([]const u8) = .empty;
    for (inners) |p| {
        for (p.fields()) |name| {
            const seen = for (names.items) |have| {
                if (std.mem.eql(u8, have, name)) break true;
            } else false;
            if (!seen) try names.append(arena, name);
        }
    }
    const filter = try arena.create(EgressFilter);
    filter.* = .{ .inners = inners, .field_names = names.items, .allow = allow_fn, .userdata = allow_userdata };
    const wrapped = try arena.alloc(o11y.Propagator, 1);
    wrapped[0] = filter.propagator();
    return wrapped;
}

pub fn buildAppRegistries(arena: Allocator, raw: ?[*]const c.AppRegistrySource, len: usize, diag_out: ?*c.Diagnostic) OptionError![]o11y.AppRegistrySource {
    if (len == 0) return &.{};
    const ptr = raw orelse return invalidOption(diag_out, "app_registries pointer must not be null when app_registries_len > 0");
    const out = try arena.alloc(o11y.AppRegistrySource, len);
    for (ptr[0..len], out) |src, *dst| {
        if (src.content_len > 0 and src.content == null) {
            return invalidOption(diag_out, "app registry content pointer must not be null when content_len > 0");
        }
        const path = try arena.dupe(u8, rt.cStrOrEmpty(src.file_path));
        if (src.content) |content_ptr| {
            const content = try arena.dupe(u8, content_ptr[0..src.content_len]);
            dst.* = .{ .bytes = .{ .path = path, .content = content } };
        } else {
            dst.* = .{ .file = .{ .dir = Io.Dir.cwd(), .path = path } };
        }
    }
    return out;
}

pub fn buildHistogramBuckets(arena: Allocator, raw: ?[*]const c.HistogramBuckets, len: usize, diag_out: ?*c.Diagnostic) OptionError![]o11y.HistogramBuckets {
    if (len == 0) return &.{};
    const ptr = raw orelse return invalidOption(diag_out, "histogram_buckets pointer must not be null when histogram_buckets_len > 0");
    const out = try arena.alloc(o11y.HistogramBuckets, len);
    for (ptr[0..len], out) |src, *dst| {
        if (src.boundaries_len > 0 and src.boundaries == null) {
            return invalidOption(diag_out, "histogram boundaries pointer must not be null when boundaries_len > 0");
        }
        const bounds = if (src.boundaries_len > 0)
            try arena.dupe(f64, src.boundaries.?[0..src.boundaries_len])
        else
            &.{};
        dst.* = .{
            .instrument_name = try arena.dupe(u8, rt.cStrOrEmpty(src.instrument_name)),
            .boundaries = bounds,
        };
    }
    return out;
}

pub fn buildExtraEnvs(arena: Allocator, raw: ?[*]const ?[*:0]const u8, len: usize, diag_out: ?*c.Diagnostic) OptionError![][]const u8 {
    if (len == 0) return &.{};
    const ptr = raw orelse return invalidOption(diag_out, "extra_environments pointer must not be null when extra_environments_len > 0");
    const out = try arena.alloc([]const u8, len);
    for (ptr[0..len], out) |s, *dst| {
        dst.* = try arena.dupe(u8, rt.cStrOrEmpty(s));
    }
    return out;
}

pub fn buildExtraSinks(arena: Allocator, raw: ?[*]const c.LogSink, len: usize, diag_out: ?*c.Diagnostic) OptionError![]o11y.LogSink {
    if (len == 0) return &.{};
    const ptr = raw orelse return invalidOption(diag_out, "extra_log_sinks pointer must not be null when extra_log_sinks_len > 0");
    const out = try arena.alloc(o11y.LogSink, len);
    for (ptr[0..len], out) |src, *dst| {
        const tr = try arena.create(LogSinkTrampoline);
        tr.* = .{ .sink = src };
        dst.* = .{ .ptr = tr, .vtable = &LogSinkTrampoline.vtable };
    }
    return out;
}

pub fn buildBuildInfo(arena: Allocator, bi: c.BuildInfo) Allocator.Error!?o11y.BuildInfo {
    if (!bi.enabled) return null;
    return .{
        .version = try arena.dupe(u8, rt.cStrOrEmpty(bi.version)),
        .revision = try arena.dupe(u8, rt.cStrOrEmpty(bi.revision)),
        .time = try arena.dupe(u8, rt.cStrOrEmpty(bi.time)),
        .modified = if (bi.modified_set) bi.modified else null,
    };
}

// =========================================================================
// Context Helpers
// =========================================================================

/// Returns `ctx` with everything it borrows copied into `arena`: the trace
/// state text and the baggage, with a NUL after the trace state and after
/// every baggage value so C reads them in place. The live span pointer is
/// dropped. A C context may outlive the span it was derived from, and the
/// engine reads only `span_context`.
pub fn ownContext(arena: Allocator, ctx: o11y.Context) Allocator.Error!o11y.Context {
    var out = ctx;
    out.span = null;
    const header = ctx.span_context.trace_state.header;
    out.span_context.trace_state = .{ .header = if (header.len > 0) try rt.dupeZ(arena, header) else "" };
    if (ctx.baggage) |bag| {
        const members = try arena.alloc(o11y.Baggage.Member, bag.members.len);
        for (bag.members, members) |m, *dst| {
            const props = try arena.alloc(o11y.Baggage.Property, m.properties.len);
            for (m.properties, props) |prop, *pd| {
                pd.* = .{
                    .key = try arena.dupe(u8, prop.key),
                    .value = if (prop.value) |v| try arena.dupe(u8, v) else null,
                };
            }
            dst.* = .{
                .key = try arena.dupe(u8, m.key),
                .value = try rt.dupeZ(arena, m.value),
                .properties = props,
                .metadata = try arena.dupe(u8, m.metadata),
            };
        }
        const owned = try arena.create(o11y.Baggage);
        owned.* = .{ .members = members };
        out.baggage = owned;
    }
    return out;
}

/// Allocates a context handle that owns a copy of `ctx`. Null when out of
/// memory.
pub fn newCtxHandle(ctx: o11y.Context) ?*CtxHandle {
    const h = gpa.create(CtxHandle) catch return null;
    h.* = .{ .arena = .init(gpa), .ctx = .background };
    h.ctx = ownContext(h.arena.allocator(), ctx) catch {
        h.arena.deinit();
        gpa.destroy(h);
        return null;
    };
    return h;
}

pub fn unwrapCtx(ctx: ?*const CtxHandle) o11y.Context {
    const h = ctx orelse return .background;
    return h.ctx;
}
