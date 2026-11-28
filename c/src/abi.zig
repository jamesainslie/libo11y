//! Core C11 ABI exports implementing `c/include/o11y/o11y.h` over `o11y` (Zig).

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const c = @import("c_types.zig");
const rt = @import("runtime.zig");

/// Do not allocate a 256 KiB per-thread TLS signal stack or call `sigaltstack`
/// on library worker threads. A C/C++ library must leave host and sanitizer
/// alternate signal stacks untouched.
pub const std_options: std.Options = .{
    .signal_stack_size = null,
};

const gpa = rt.gpa;

// =========================================================================
// Internal Handle Wrappers (shared with test_abi.zig)
// =========================================================================

pub const SdkHandle = struct {
    telemetry: *o11y.Telemetry,
    owns_telemetry: bool,
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

// =========================================================================
// Conversion Helpers (shared with test_abi.zig)
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

const max_composite_depth: usize = 16;
const composite_walk_budget: usize = 2048;

const WalkState = struct {
    remaining: usize,
    ancestors: [@max(max_composite_depth, o11y.pii.max_depth) + 2]usize = undefined,
    ancestor_len: usize = 0,

    fn enter(self: *WalkState, addr: usize) bool {
        for (self.ancestors[0..self.ancestor_len]) |seen| {
            if (seen == addr) return false;
        }
        if (self.ancestor_len >= self.ancestors.len) return false;
        self.ancestors[self.ancestor_len] = addr;
        self.ancestor_len += 1;
        return true;
    }

    fn leave(self: *WalkState) void {
        self.ancestor_len -= 1;
    }
};

fn convertLogValueBounded(arena: Allocator, v: c.LogValue, depth: usize, walk: *WalkState) Allocator.Error!o11y.LogValue {
    if (walk.remaining == 0) return .empty;
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
            if (depth >= max_composite_depth) break :blk .empty;
            const av = v.value.array_val;
            if (av.len == 0 or av.items == null) break :blk .{ .array = &.{} };
            if (!walk.enter(@intFromPtr(av.items.?))) break :blk .empty;
            defer walk.leave();
            const cap = @min(av.len, walk.remaining);
            const out = try arena.alloc(o11y.LogValue, cap);
            for (av.items.?[0..cap], out) |item, *dst| {
                dst.* = try convertLogValueBounded(arena, item, depth + 1, walk);
            }
            break :blk .{ .array = out };
        },
        .map => blk: {
            if (depth >= max_composite_depth) break :blk .empty;
            const mv = v.value.map_val;
            if (mv.len == 0 or mv.items == null) break :blk .{ .map = &.{} };
            if (!walk.enter(@intFromPtr(mv.items.?))) break :blk .empty;
            defer walk.leave();
            const cap = @min(mv.len, walk.remaining);
            const out = try arena.alloc(o11y.LogAttribute, cap);
            for (mv.items.?[0..cap], out) |src, *dst| {
                dst.* = .{
                    .key = try arena.dupe(u8, rt.cStrOrEmpty(src.key)),
                    .value = try convertLogValueBounded(arena, src.value, depth + 1, walk),
                };
            }
            break :blk .{ .map = out };
        },
        _ => .empty,
    };
}

pub fn convertLogAttrs(arena: Allocator, raw: ?[*]const c.LogAttr, len: usize) Allocator.Error![]o11y.LogAttribute {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    var walk: WalkState = .{ .remaining = composite_walk_budget * 16 };
    const out = try arena.alloc(o11y.LogAttribute, len);
    for (ptr[0..len], out) |src, *dst| {
        dst.* = .{
            .key = try arena.dupe(u8, rt.cStrOrEmpty(src.key)),
            .value = try convertLogValueBounded(arena, src.value, 0, &walk),
        };
    }
    return out;
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

        var out_key_buf: [256]u8 = @splat(0);
        var out_val_buf: [1024]u8 = @splat(0);
        var out_val: c.LogValue = .{ .kind = .empty, .value = .{ .int_val = 0 } };
        var replace_val: bool = false;

        const keep = self.func(
            self.userdata,
            c_groups_ptr,
            groups.len,
            key_z.ptr,
            &c_val,
            &out_key_buf,
            out_key_buf.len,
            &out_val_buf,
            out_val_buf.len,
            &out_val,
            &replace_val,
        );
        if (!keep) return null;

        var res = attr;
        if (out_key_buf[0] != 0) {
            const new_k = std.mem.sliceTo(&out_key_buf, 0);
            res.key = arena.dupe(u8, new_k) catch return null;
        }
        if (replace_val) {
            if (out_val.kind != .empty) {
                var walk: WalkState = .{ .remaining = composite_walk_budget * 16 };
                res.value = convertLogValueBounded(arena, out_val, 0, &walk) catch return null;
            } else {
                const new_v = std.mem.sliceTo(&out_val_buf, 0);
                res.value = .{ .string = arena.dupe(u8, new_v) catch return null };
            }
        }
        return res;
    }
};

pub const LogSinkTrampoline = struct {
    sink: c.LogSink,

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
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        const msg_z = rt.dupeZ(arena, rec.message) catch return;
        const ts_z: ?[*:0]const u8 = if (rec.span_context.trace_state.header.len > 0)
            (rt.dupeZ(arena, rec.span_context.trace_state.header) catch null)
        else
            null;
        const c_attrs = zigLogAttrsToC(arena, rec.attributes, 0) catch return;
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

    fn get(userdata: ?*anyopaque, key: [*:0]const u8) callconv(.c) ?[*:0]const u8 {
        const self: *EngineCarrierBridge = @ptrCast(@alignCast(userdata orelse return null));
        const value = self.carrier.get(std.mem.span(key)) orelse return null;
        const z = rt.dupeZ(self.arena, value) catch return null;
        return z.ptr;
    }

    fn set(userdata: ?*anyopaque, key: [*:0]const u8, value: [*:0]const u8) callconv(.c) void {
        const self: *EngineCarrierBridge = @ptrCast(@alignCast(userdata orelse return));
        self.carrier.set(std.mem.span(key), std.mem.span(value));
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
        for (defs, list) |def, *dst| {
            dst.* = switch (def.kind) {
                .trace_context => o11y.TraceContextPropagator.propagator,
                .baggage => o11y.BaggagePropagator.propagator,
                .custom => blk: {
                    if (def.inject == null and def.extract == null) {
                        return invalidOption(diag_out, "a custom propagator needs an inject or an extract callback");
                    }
                    if (def.fields_len > 0 and def.fields == null) {
                        return invalidOption(diag_out, "custom propagator fields pointer must not be null when fields_len > 0");
                    }
                    const names = try arena.alloc([]const u8, def.fields_len);
                    for (names, 0..) |*name, i| name.* = try arena.dupe(u8, rt.cStrOrEmpty(def.fields.?[i]));
                    const custom = try arena.create(CustomPropagator);
                    custom.* = .{ .def = def, .field_names = names };
                    break :blk custom.propagator();
                },
                _ => return invalidOption(diag_out, "unknown propagator kind"),
            };
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
// Version & error exports
// =========================================================================

export fn o11y_version() [*:0]const u8 {
    return rt.c_version;
}

export fn o11y_err_name(err: c.Err) [*:0]const u8 {
    return switch (err) {
        .ok => "O11Y_OK",
        .already_setup => "O11Y_ERR_ALREADY_SETUP",
        .no_service_name => "O11Y_ERR_NO_SERVICE_NAME",
        .no_environment => "O11Y_ERR_NO_ENVIRONMENT",
        .invalid_environment => "O11Y_ERR_INVALID_ENVIRONMENT",
        .pii_hash_key => "O11Y_ERR_PII_HASH_KEY",
        .invalid_app_registry => "O11Y_ERR_INVALID_APP_REGISTRY",
        .canary_rejected => "O11Y_ERR_CANARY_REJECTED",
        .unsupported_protocol => "O11Y_ERR_UNSUPPORTED_PROTOCOL",
        .exporter => "O11Y_ERR_EXPORTER",
        .out_of_memory => "O11Y_ERR_OUT_OF_MEMORY",
        .invalid_argument => "O11Y_ERR_INVALID_ARGUMENT",
        .invalid_carrier => "O11Y_ERR_INVALID_CARRIER",
        .timeout => "O11Y_ERR_TIMEOUT",
        .shutdown => "O11Y_ERR_SHUTDOWN",
        .io => "O11Y_ERR_IO",
        .unsupported_propagator => "O11Y_ERR_UNSUPPORTED_PROPAGATOR",
        _ => "O11Y_ERR_UNKNOWN",
    };
}

export fn o11y_string_free(s: ?[*:0]u8) void {
    rt.freeCString(s);
}

// =========================================================================
// Trace & Span IDs
// =========================================================================

export fn o11y_trace_id_is_valid(id: c.TraceId) bool {
    const t: o11y.TraceId = .{ .bytes = id.bytes };
    return t.isValid();
}

export fn o11y_span_id_is_valid(id: c.SpanId) bool {
    const s: o11y.SpanId = .{ .bytes = id.bytes };
    return s.isValid();
}

export fn o11y_span_context_is_valid(sc: c.SpanContext) bool {
    return toZigSpanContext(sc).isValid();
}

export fn o11y_span_context_is_sampled(sc: c.SpanContext) bool {
    return toZigSpanContext(sc).isSampled();
}

export fn o11y_trace_id_hex(id: c.TraceId, out: ?*[33]u8) void {
    const dst = out orelse return;
    const t: o11y.TraceId = .{ .bytes = id.bytes };
    const hex = t.hex();
    @memcpy(dst[0..32], &hex);
    dst[32] = 0;
}

export fn o11y_span_id_hex(id: c.SpanId, out: ?*[17]u8) void {
    const dst = out orelse return;
    const s: o11y.SpanId = .{ .bytes = id.bytes };
    const hex = s.hex();
    @memcpy(dst[0..16], &hex);
    dst[16] = 0;
}

export fn o11y_trace_id_parse_hex(hex: ?[*:0]const u8, out: ?*c.TraceId) bool {
    const s = rt.cStrOpt(hex) orelse return false;
    const dst = out orelse return false;
    const parsed = o11y.TraceId.parseHex(s) orelse return false;
    dst.bytes = parsed.bytes;
    return true;
}

export fn o11y_span_id_parse_hex(hex: ?[*:0]const u8, out: ?*c.SpanId) bool {
    const s = rt.cStrOpt(hex) orelse return false;
    const dst = out orelse return false;
    const parsed = o11y.SpanId.parseHex(s) orelse return false;
    dst.bytes = parsed.bytes;
    return true;
}

// =========================================================================
// Capture-time redaction helpers
// =========================================================================

export fn o11y_redact_secret() [*:0]const u8 {
    return o11y.redact.redacted_literal;
}

export fn o11y_redact_mask(value: ?[*]const u8, value_len: usize, out: ?[*]u8, out_cap: usize) usize {
    var count: usize = 0;
    if (value) |ptr| {
        const slice = ptr[0..value_len];
        var i: usize = 0;
        while (i < slice.len) {
            const seq_len = std.unicode.utf8ByteSequenceLength(slice[i]) catch 1;
            if (i + seq_len <= slice.len and std.unicode.utf8ValidateSlice(slice[i .. i + seq_len])) {
                i += seq_len;
            } else {
                i += 1;
            }
            count += 1;
        }
    }
    if (out) |dst| {
        if (out_cap > 0) {
            const write_n = @min(count, out_cap - 1);
            if (write_n > 0) @memset(dst[0..write_n], 'X');
            dst[write_n] = 0;
        }
    }
    return count;
}

// =========================================================================
// Options & Lifecycle
// =========================================================================

export fn o11y_options_default() c.Options {
    return .{};
}

fn createSdk(is_setup: bool, opts_ptr: ?*const c.Options, out_sdk: ?*?*SdkHandle, diag_out: ?*c.Diagnostic) c.Err {
    if (diag_out) |d| {
        d.message[0] = 0;
        d.len = 0;
    }
    const out = out_sdk orelse {
        writeDiagnosticText(diag_out, "o11y: out_sdk pointer must not be null");
        return .invalid_argument;
    };
    out.* = null;

    const opts = if (opts_ptr) |p| blk: {
        if (p.struct_size != @sizeOf(c.Options)) {
            writeDiagnosticText(diag_out, "o11y: invalid options struct_size; initialize with o11y_options_default()");
            return .invalid_argument;
        }
        break :blk p.*;
    } else c.Options{};

    out.* = buildSdk(is_setup, opts, diag_out) catch |err| return mapBuildError(err);
    return .ok;
}

/// Converts the C options and builds the SDK. Every failure path releases
/// what it allocated, including the engine SDK, setup guard, and I/O reference.
fn buildSdk(is_setup: bool, opts: c.Options, diag_out: ?*c.Diagnostic) (o11y.SetupError || OptionError)!*SdkHandle {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena_state.deinit();
    const arena = arena_state.allocator();

    // Scratch arena holds env strings only for setup/init, never past it.
    var env_arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer env_arena_state.deinit();
    const env_arena = env_arena_state.allocator();

    const env: o11y.Env = switch (opts.env_mode) {
        .hermetic => .hermetic,
        .process => .{ .pairs = try rt.readProcessEnvPairs(env_arena) },
        .pairs => blk: {
            if (opts.env_pairs_len == 0) break :blk .{ .pairs = &.{} };
            const raw_pairs = opts.env_pairs orelse return invalidOption(diag_out, "env_pairs pointer must not be null when env_pairs_len > 0");
            const ps = try env_arena.alloc([2][]const u8, opts.env_pairs_len);
            for (raw_pairs[0..opts.env_pairs_len], ps) |src, *dst| {
                dst.* = .{
                    try env_arena.dupe(u8, rt.cStrOrEmpty(src.key)),
                    try env_arena.dupe(u8, rt.cStrOrEmpty(src.value)),
                };
            }
            break :blk .{ .pairs = ps };
        },
        .entries => blk: {
            if (opts.env_entries_len == 0) break :blk .{ .entries = &.{} };
            const raw_entries = opts.env_entries orelse return invalidOption(diag_out, "env_entries pointer must not be null when env_entries_len > 0");
            const es = try env_arena.alloc([]const u8, opts.env_entries_len);
            for (raw_entries[0..opts.env_entries_len], es) |src, *dst| {
                dst.* = try env_arena.dupe(u8, rt.cStrOrEmpty(src));
            }
            break :blk .{ .entries = es };
        },
        _ => return invalidOption(diag_out, "unknown env_mode"),
    };

    const protocol: ?o11y.Protocol = switch (opts.protocol) {
        .default => null,
        .http_protobuf => .http_protobuf,
        .http_json => .http_json,
        .grpc => .grpc,
        _ => return invalidOption(diag_out, "unknown protocol"),
    };

    const console_writer: o11y.ConsoleWriter = switch (opts.console_target) {
        .stdout => .stdout,
        .stderr => .stderr,
        .custom => blk: {
            const f = opts.console_write_fn orelse
                return invalidOption(diag_out, "custom console target requires console_write_fn");
            const tr = try arena.create(ConsoleWriterTrampoline);
            tr.* = .{ .func = f, .userdata = opts.console_write_userdata };
            break :blk .{ .custom = .{ .ptr = tr, .writeFn = ConsoleWriterTrampoline.write } };
        },
        _ => return invalidOption(diag_out, "unknown console_target"),
    };

    const console_format: o11y.ConsoleFormat = try toZigConsoleFormat(opts.console_format, diag_out);
    const log_level = try checkedLevel(opts.log_level, diag_out);
    const pii_mode = try checkedPiiMode(opts.pii_mode, diag_out);
    const sampler = try checkedSampler(opts.sampler_kind, opts.sampler_ratio, diag_out);
    const exemplar_filter = try checkedExemplarFilter(opts.exemplar_filter, diag_out);

    const attr_replacer: ?o11y.AttrReplacer = if (opts.attr_replacer_fn) |f| blk: {
        const tr = try arena.create(AttrReplacerTrampoline);
        tr.* = .{ .func = f, .userdata = opts.attr_replacer_userdata };
        break :blk .{ .ptr = tr, .replace = AttrReplacerTrampoline.replace };
    } else null;

    const err_handler: ?o11y.ErrorHandler = if (opts.error_handler_fn) |f| blk: {
        const tr = try arena.create(ErrorHandlerTrampoline);
        tr.* = .{ .func = f, .userdata = opts.error_handler_userdata };
        break :blk .{ .ptr = tr, .report = ErrorHandlerTrampoline.handle };
    } else null;

    if (opts.resource_attributes_len > 0 and opts.resource_attributes == null) {
        return invalidOption(diag_out, "resource_attributes pointer must not be null when resource_attributes_len > 0");
    }
    if (opts.pii_hash_key_len > 0 and opts.pii_hash_key == null) {
        return invalidOption(diag_out, "pii_hash_key pointer must not be null when pii_hash_key_len > 0");
    }

    const propagators = try buildPropagators(
        arena,
        env,
        opts.propagators,
        opts.propagators_len,
        opts.baggage_egress_allow,
        opts.baggage_egress_allow_userdata,
        diag_out,
    );
    const extra_envs = try buildExtraEnvs(arena, opts.extra_environments, opts.extra_environments_len, diag_out);
    const res_attrs = try convertAttrs(arena, opts.resource_attributes, opts.resource_attributes_len);
    const extra_sinks = try buildExtraSinks(arena, opts.extra_log_sinks, opts.extra_log_sinks_len, diag_out);
    const app_regs = try buildAppRegistries(arena, opts.app_registries, opts.app_registries_len, diag_out);
    const hist_buckets = try buildHistogramBuckets(arena, opts.histogram_buckets, opts.histogram_buckets_len, diag_out);
    const build_info = try buildBuildInfo(arena, opts.build_info);
    const pii_key: []const u8 = if (opts.pii_hash_key_len > 0)
        try arena.dupe(u8, opts.pii_hash_key.?[0..opts.pii_hash_key_len])
    else
        "";

    var zig_diag: o11y.Diagnostic = .{};
    const zig_opts: o11y.Options = .{
        .env = env,
        .protocol = protocol,
        .service_name = rt.cStrOpt(opts.service_name),
        .service_version = rt.cStrOpt(opts.service_version),
        .service_namespace = rt.cStrOpt(opts.service_namespace),
        .environment = rt.cStrOpt(opts.environment),
        .extra_environments = extra_envs,
        .strict_identity = opts.strict_identity,
        .resource_attributes = res_attrs,
        .build_info = build_info,
        .build_info_enabled = opts.build_info.enabled,
        .log_level = log_level,
        .console_enabled = opts.console_enabled,
        .console_format = console_format,
        .console_writer = console_writer,
        .log_export = opts.log_export,
        .attr_replacer = attr_replacer,
        .extra_log_sinks = extra_sinks,
        .pii_mode = pii_mode,
        .pii_hash_key = pii_key,
        .app_registries = app_regs,
        .sampler = sampler,
        .propagators = propagators,
        .histogram_buckets = hist_buckets,
        .exemplar_filter = exemplar_filter,
        .runtime_metrics = opts.runtime_metrics,
        .startup_summary = opts.startup_summary,
        .install_std_log = false,
        .error_handler = err_handler,
        .diagnostic = &zig_diag,
        .sdk_language = "c",
        .sdk_version = rt.c_version,
        .emit_process_runtime = false,
    };

    const io = rt.acquireIo();
    errdefer rt.releaseIo();
    const telemetry = (if (is_setup) o11y.setup(gpa, io, zig_opts) else o11y.init(gpa, io, zig_opts)) catch |err| {
        writeDiagnostic(diag_out, &zig_diag);
        return err;
    };
    errdefer telemetry.deinit();

    const eff_z = try rt.dupeZ(arena, telemetry.effectiveConfig());
    const handle = try gpa.create(SdkHandle);
    handle.* = .{
        .telemetry = telemetry,
        .owns_telemetry = true,
        .arena = arena_state,
        .effective_config_z = eff_z.ptr,
    };
    return handle;
}

export fn o11y_setup(options: ?*const c.Options, out_sdk: ?*?*SdkHandle, diag: ?*c.Diagnostic) c.Err {
    return createSdk(true, options, out_sdk, diag);
}

export fn o11y_init(options: ?*const c.Options, out_sdk: ?*?*SdkHandle, diag: ?*c.Diagnostic) c.Err {
    return createSdk(false, options, out_sdk, diag);
}

fn fillReport(report: o11y.ShutdownReport, out_report: ?*c.ShutdownReport) c.Err {
    const r: c.ShutdownReport = .{
        .logs = mapExportError(report.logs),
        .metrics = mapExportError(report.metrics),
        .traces = mapExportError(report.traces),
    };
    if (out_report) |dst| dst.* = r;
    if (r.logs != .ok) return r.logs;
    if (r.metrics != .ok) return r.metrics;
    if (r.traces != .ok) return r.traces;
    return .ok;
}

export fn o11y_shutdown(sdk: ?*SdkHandle, timeout_ms: u64, out_report: ?*c.ShutdownReport) c.Err {
    if (out_report) |dst| dst.* = .{};
    const h = sdk orelse return .ok;
    const timeout: ?Io.Duration = if (timeout_ms == 0) null else .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    const report = h.telemetry.shutdown(timeout);
    return fillReport(report, out_report);
}

export fn o11y_force_flush(sdk: ?*SdkHandle, timeout_ms: u64, out_report: ?*c.ShutdownReport) c.Err {
    if (out_report) |dst| dst.* = .{};
    const h = sdk orelse return .ok;
    const timeout: ?Io.Duration = if (timeout_ms == 0) null else .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    const report = h.telemetry.forceFlush(timeout);
    return fillReport(report, out_report);
}

export fn o11y_destroy(sdk: ?*SdkHandle) void {
    const h = sdk orelse return;
    if (!h.owns_telemetry) return;
    // Detach the callbacks first, so no later SDK that reuses the provider's
    // address can lose its own. They stay alive through the final flush.
    const callbacks = detachObservableCallbacks(h.telemetry.meterProvider());
    h.telemetry.deinit();
    freeObservableCallbacks(callbacks);
    h.arena.deinit();
    gpa.destroy(h);
    rt.releaseIo();
}

export fn o11y_effective_config(sdk: ?*const SdkHandle) [*:0]const u8 {
    const h = sdk orelse return "";
    return h.effective_config_z;
}

/// The most signal numbers `o11y_shutdown_on_signals` accepts.
const max_signals = 16;
/// The highest signal number it accepts. Linux real-time signals end at 64.
const max_signal_number = 64;

const BeforeShutdownTrampoline = struct {
    func: *const fn (?*anyopaque) callconv(.c) void,
    userdata: ?*anyopaque,

    fn call(ptr: ?*anyopaque, _: o11y.Deadline) void {
        const self: *BeforeShutdownTrampoline = @ptrCast(@alignCast(ptr orelse return));
        self.func(self.userdata);
    }
};

export fn o11y_shutdown_on_signals(sdk: ?*SdkHandle, opts_ptr: ?*const c.SignalOptions, out_report: ?*c.ShutdownReport) c.Err {
    if (out_report) |dst| dst.* = .{};
    const h = sdk orelse return .invalid_argument;
    const opts = if (opts_ptr) |p| p.* else c.SignalOptions{};

    var tramp: BeforeShutdownTrampoline = undefined;
    var before: ?o11y.BeforeShutdown = null;
    if (opts.before_shutdown) |f| {
        tramp = .{ .func = f, .userdata = opts.before_shutdown_userdata };
        before = .{ .ptr = &tramp, .func = BeforeShutdownTrampoline.call };
    }

    var sig_buf: [max_signals]std.posix.SIG = undefined;
    var sigs: []const std.posix.SIG = &.{ .INT, .TERM };
    if (builtin.os.tag != .windows and opts.signals_len > 0) {
        const raw = opts.signals orelse return .invalid_argument;
        if (opts.signals_len > sig_buf.len) return .invalid_argument;
        const kill_num: c_int = @intCast(@backingInt(std.posix.SIG.KILL));
        const stop_num: c_int = @intCast(@backingInt(std.posix.SIG.STOP));
        for (raw[0..opts.signals_len], sig_buf[0..opts.signals_len]) |number, *dst| {
            if (number < 1 or number > max_signal_number) return .invalid_argument;
            if (number == kill_num or number == stop_num) return .invalid_argument;
            const sig: std.posix.SIG = @fromBackingInt(@intCast(number));
            var old_act: std.c.Sigaction = undefined;
            if (std.c.sigaction(sig, null, &old_act) != 0) return .invalid_argument;
            dst.* = sig;
        }
        sigs = sig_buf[0..opts.signals_len];
    }

    const io = rt.acquireIo();
    defer rt.releaseIo();
    const report = o11y.shutdownOnSignals(io, h.telemetry, .{
        .timeout = if (opts.timeout_ms == 0) .fromSeconds(5) else .fromMilliseconds(@intCast(@min(opts.timeout_ms, std.math.maxInt(i64)))),
        .before_shutdown = before,
        .signals = sigs,
    });
    return fillReport(report, out_report);
}

// =========================================================================
// Context
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

/// The handle's trace state as a C string, or null when it is empty.
/// `ownContext` wrote the NUL after it.
fn ctxTraceStateZ(h: *const CtxHandle) ?[*:0]const u8 {
    const header = h.ctx.span_context.trace_state.header;
    if (header.len == 0) return null;
    return @ptrCast(header.ptr);
}

pub fn unwrapCtx(ctx: ?*const CtxHandle) o11y.Context {
    const h = ctx orelse return .background;
    return h.ctx;
}

export fn o11y_ctx_create() ?*CtxHandle {
    return newCtxHandle(.background);
}

export fn o11y_ctx_destroy(ctx: ?*CtxHandle) void {
    const h = ctx orelse return;
    h.arena.deinit();
    gpa.destroy(h);
}

export fn o11y_ctx_with_span(parent: ?*const CtxHandle, span: ?*SpanHandle) ?*CtxHandle {
    const base = unwrapCtx(parent);
    const sp = span orelse return newCtxHandle(base);
    return newCtxHandle(base.withSpan(&sp.span));
}

export fn o11y_ctx_with_span_context(parent: ?*const CtxHandle, sc: c.SpanContext) ?*CtxHandle {
    return newCtxHandle(unwrapCtx(parent).withSpanContext(toZigSpanContext(sc)));
}

export fn o11y_ctx_with_force_emit(parent: ?*const CtxHandle) ?*CtxHandle {
    return newCtxHandle(unwrapCtx(parent).withForceEmit());
}

export fn o11y_ctx_with_record(parent: ?*const CtxHandle, record: ?*RecordHandle) ?*CtxHandle {
    return newCtxHandle(unwrapCtx(parent).withRecord(if (record) |r| &r.rec else null));
}

fn isValidBaggageKey(k: []const u8) bool {
    if (k.len == 0) return false;
    for (k) |ch| {
        const ok = switch (ch) {
            '!', '#'...'\'', '*', '+', '-', '.', '0'...'9', 'A'...'Z', '^'...'z', '|', '~' => true,
            else => false,
        };
        if (!ok) return false;
    }
    return true;
}

export fn o11y_ctx_with_baggage_item(parent: ?*const CtxHandle, key: ?[*:0]const u8, value: ?[*:0]const u8) ?*CtxHandle {
    const base = unwrapCtx(parent);
    const k = rt.cStrOrEmpty(key);
    const v = rt.cStrOrEmpty(value);
    if (!isValidBaggageKey(k) or !std.unicode.utf8ValidateSlice(v)) return newCtxHandle(base);

    const existing: []const o11y.Baggage.Member = if (base.baggage) |b| b.members else &.{};
    var scratch_state: std.heap.ArenaAllocator = .init(gpa);
    defer scratch_state.deinit();
    const scratch = scratch_state.allocator();

    const members = scratch.alloc(o11y.Baggage.Member, existing.len + 1) catch return null;
    var n: usize = 0;
    var replaced = false;
    for (existing) |m| {
        if (std.mem.eql(u8, m.key, k)) {
            members[n] = .{ .key = k, .value = v };
            replaced = true;
        } else {
            members[n] = m;
        }
        n += 1;
    }
    if (!replaced) {
        members[n] = .{ .key = k, .value = v };
        n += 1;
    }
    const bag = o11y.Baggage.fromMembers(scratch, members[0..n]) catch return newCtxHandle(base);
    return newCtxHandle(base.withBaggage(&bag));
}

export fn o11y_ctx_span_context(ctx: ?*const CtxHandle) c.SpanContext {
    const h = ctx orelse return .{};
    return fromZigSpanContext(h.ctx.span_context, ctxTraceStateZ(h));
}

export fn o11y_ctx_baggage_get(ctx: ?*const CtxHandle, key: ?[*:0]const u8) ?[*:0]const u8 {
    const h = ctx orelse return null;
    const k = rt.cStrOpt(key) orelse return null;
    const bag = h.ctx.baggage orelse return null;
    for (bag.members) |m| {
        // `ownContext` wrote a NUL after every value.
        if (std.mem.eql(u8, m.key, k)) return @ptrCast(m.value.ptr);
    }
    return null;
}

export fn o11y_ctx_record(ctx: ?*const CtxHandle) ?*RecordHandle {
    const h = ctx orelse return null;
    const rec_ptr = h.ctx.record orelse return null;
    return @fieldParentPtr("rec", rec_ptr);
}

// =========================================================================
// Tracing
// =========================================================================

export fn o11y_tracer(sdk: ?*SdkHandle, name: ?[*:0]const u8) ?*const o11y.Tracer {
    const h = sdk orelse return &o11y.Tracer.noop;
    return h.telemetry.tracer(rt.cStrOrEmpty(name));
}

export fn o11y_tracer_with_scope(
    sdk: ?*SdkHandle,
    name: ?[*:0]const u8,
    version: ?[*:0]const u8,
    schema_url: ?[*:0]const u8,
) ?*const o11y.Tracer {
    const h = sdk orelse return &o11y.Tracer.noop;
    return h.telemetry.tracerWithScope(.{
        .name = rt.cStrOrEmpty(name),
        .version = rt.cStrOrEmpty(version),
        .schema_url = rt.cStrOrEmpty(schema_url),
    });
}

fn convertSpanStartOptions(arena: Allocator, opts_ptr: ?*const c.SpanStartOptions) Allocator.Error!o11y.StartOptions {
    const opts = if (opts_ptr) |p| p.* else c.SpanStartOptions{};
    const attrs = try convertAttrs(arena, opts.attributes, opts.attributes_len);
    const links: []o11y.Link = if (opts.links_len > 0 and opts.links != null) blk: {
        const out = try arena.alloc(o11y.Link, opts.links_len);
        for (opts.links.?[0..opts.links_len], out) |src, *dst| {
            dst.* = .{
                .span_context = toZigSpanContext(src.span_context),
                .attributes = try convertAttrs(arena, src.attributes, src.attributes_len),
            };
        }
        break :blk out;
    } else &.{};
    return .{
        .kind = toZigSpanKind(opts.kind),
        .attributes = attrs,
        .links = links,
        .start_time = if (opts.start_time_unix_nano == 0) null else opts.start_time_unix_nano,
        .new_root = opts.new_root,
    };
}

export fn o11y_tracer_start(
    tracer: ?*const o11y.Tracer,
    ctx: ?*const CtxHandle,
    name: ?[*:0]const u8,
    options: ?*const c.SpanStartOptions,
) ?*SpanHandle {
    const tr = tracer orelse &o11y.Tracer.noop;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const start_opts = convertSpanStartOptions(arena_state.allocator(), options) catch return null;

    const h = gpa.create(SpanHandle) catch return null;
    h.* = .{
        .span = tr.start(unwrapCtx(ctx), rt.cStrOrEmpty(name), start_opts),
        .owns_self = true,
    };
    h.trace_state_z = spanTraceStateZ(&h.span);
    return h;
}

/// Copies the span's trace state into a C string, or returns null when it is
/// empty or memory runs out. A span's trace state never changes after start.
fn spanTraceStateZ(span: *const o11y.Span) ?[*:0]u8 {
    const header = span.spanContext().trace_state.header;
    if (header.len == 0) return null;
    const z = rt.dupeZ(gpa, header) catch return null;
    return z.ptr;
}

export fn o11y_span_context(span: ?*const SpanHandle) c.SpanContext {
    const h = span orelse return .{};
    return fromZigSpanContext(h.span.spanContext(), h.trace_state_z);
}

export fn o11y_span_is_recording(span: ?*const SpanHandle) bool {
    const h = span orelse return false;
    return h.span.isRecording();
}

export fn o11y_span_set_name(span: ?*SpanHandle, name: ?[*:0]const u8) void {
    const h = span orelse return;
    h.span.setName(rt.cStrOrEmpty(name));
}

export fn o11y_span_set_attrs(span: ?*SpanHandle, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    const h = span orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    h.span.setAttributes(converted);
}

export fn o11y_span_set_attr(span: ?*SpanHandle, attr: c.Attr) void {
    o11y_span_set_attrs(span, @ptrCast(&attr), 1);
}

export fn o11y_span_set_status(span: ?*SpanHandle, code: c.StatusCode, description: ?[*:0]const u8) void {
    const h = span orelse return;
    h.span.setStatus(toZigStatusCode(code), rt.cStrOrEmpty(description));
}

export fn o11y_span_add_event(
    span: ?*SpanHandle,
    name: ?[*:0]const u8,
    attrs: ?[*]const c.Attr,
    attrs_len: usize,
    timestamp_unix_nano: u64,
) void {
    const h = span orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    h.span.addEvent(rt.cStrOrEmpty(name), .{
        .attributes = converted,
        .timestamp = if (timestamp_unix_nano == 0) null else timestamp_unix_nano,
    });
}

export fn o11y_span_record_error(
    span: ?*SpanHandle,
    error_type: ?[*:0]const u8,
    message: ?[*:0]const u8,
    attrs: ?[*]const c.Attr,
    attrs_len: usize,
) void {
    const h = span orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const extra = convertAttrs(arena, attrs, attrs_len) catch return;
    const etype = rt.cStrOpt(error_type) orelse "error";
    const msg = rt.cStrOpt(message) orelse etype;

    var combined = std.ArrayList(o11y.Attribute).initCapacity(arena, extra.len + 2) catch return;
    combined.appendAssumeCapacity(o11y.kv("exception.type", etype));
    combined.appendAssumeCapacity(o11y.kv("exception.message", msg));
    combined.appendSliceAssumeCapacity(extra);
    h.span.addEvent("exception", .{ .attributes = combined.items });
}

export fn o11y_span_add_link(span: ?*SpanHandle, link_ptr: ?*const c.SpanLink) void {
    const h = span orelse return;
    const link = link_ptr orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const attrs = convertAttrs(arena_state.allocator(), link.attributes, link.attributes_len) catch return;
    h.span.addLink(.{
        .span_context = toZigSpanContext(link.span_context),
        .attributes = attrs,
    });
}

export fn o11y_span_end_at(span: ?*SpanHandle, end_time_unix_nano: u64) void {
    const h = span orelse return;
    h.span.endAt(if (end_time_unix_nano == 0) null else end_time_unix_nano);
    if (h.trace_state_z) |z| {
        rt.freeZ(gpa, z);
        h.trace_state_z = null;
    }
    if (h.owns_self) gpa.destroy(h);
}

export fn o11y_span_end(span: ?*SpanHandle) void {
    o11y_span_end_at(span, 0);
}

// =========================================================================
// Metrics & Exemplars
// =========================================================================

export fn o11y_meter(sdk: ?*SdkHandle, name: ?[*:0]const u8) ?*const o11y.Meter {
    const h = sdk orelse return &o11y.Meter.noop;
    return h.telemetry.meter(rt.cStrOrEmpty(name));
}

export fn o11y_meter_with_scope(
    sdk: ?*SdkHandle,
    name: ?[*:0]const u8,
    version: ?[*:0]const u8,
    schema_url: ?[*:0]const u8,
) ?*const o11y.Meter {
    const h = sdk orelse return &o11y.Meter.noop;
    return h.telemetry.meterWithScope(.{
        .name = rt.cStrOrEmpty(name),
        .version = rt.cStrOrEmpty(version),
        .schema_url = rt.cStrOrEmpty(schema_url),
    });
}

export fn o11y_meter_counter_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.counter(i64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_counter_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.counter(f64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_updown_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.upDownCounter(i64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_updown_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.upDownCounter(f64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_histogram_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.HistogramOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.HistogramOptions{};
    const bounds: ?[]const f64 = if (o.explicit_bucket_boundaries_len > 0 and o.explicit_bucket_boundaries != null)
        o.explicit_bucket_boundaries.?[0..o.explicit_bucket_boundaries_len]
    else
        null;
    const inst = m.histogram(i64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
        .explicit_bucket_boundaries = bounds,
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_histogram_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.HistogramOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.HistogramOptions{};
    const bounds: ?[]const f64 = if (o.explicit_bucket_boundaries_len > 0 and o.explicit_bucket_boundaries != null)
        o.explicit_bucket_boundaries.?[0..o.explicit_bucket_boundaries_len]
    else
        null;
    const inst = m.histogram(f64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
        .explicit_bucket_boundaries = bounds,
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_gauge_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.gauge(i64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

export fn o11y_meter_gauge_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts_ptr: ?*const c.InstrumentOptions) c.InstHandle {
    const m = meter orelse return .{};
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const inst = m.gauge(f64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
    });
    return .{ .impl = inst.inst };
}

fn measureInst(comptime InstT: type, comptime N: type, h: c.InstHandle, ctx: ?*const CtxHandle, value: N, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    const impl = h.impl orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    const inst: InstT = .{ .inst = @ptrCast(@alignCast(impl)) };
    if (@hasDecl(InstT, "add")) {
        inst.add(unwrapCtx(ctx), value, converted);
    } else {
        inst.record(unwrapCtx(ctx), value, converted);
    }
}

export fn o11y_counter_i64_add(inst: c.InstHandle, ctx: ?*const CtxHandle, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Counter(i64), i64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_counter_f64_add(inst: c.InstHandle, ctx: ?*const CtxHandle, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Counter(f64), f64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_updown_i64_add(inst: c.InstHandle, ctx: ?*const CtxHandle, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.UpDownCounter(i64), i64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_updown_f64_add(inst: c.InstHandle, ctx: ?*const CtxHandle, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.UpDownCounter(f64), f64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_histogram_i64_record(inst: c.InstHandle, ctx: ?*const CtxHandle, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Histogram(i64), i64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_histogram_f64_record(inst: c.InstHandle, ctx: ?*const CtxHandle, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Histogram(f64), f64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_gauge_i64_record(inst: c.InstHandle, ctx: ?*const CtxHandle, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Gauge(i64), i64, inst, ctx, value, attrs, attrs_len);
}

export fn o11y_gauge_f64_record(inst: c.InstHandle, ctx: ?*const CtxHandle, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    measureInst(o11y.Gauge(f64), f64, inst, ctx, value, attrs, attrs_len);
}

/// The callback of one observable instrument. A meter handle is the engine's
/// own `*const Meter`, which does not lead back to the `SdkHandle`, so the
/// trampolines are kept in one process-wide list keyed by the meter provider
/// that calls them, and `o11y_destroy` frees the ones of its provider.
pub const ObsTrampoline = struct {
    next: ?*ObsTrampoline = null,
    provider: *const anyopaque,
    func: c.ObserveI64Fn,
    userdata: ?*anyopaque,
};

var obs_lock: rt.Mutex = .{};
var obs_head: ?*ObsTrampoline = null;

/// Unlinks every trampoline of `provider` and returns them as a list. Call it
/// before the provider is destroyed and free the list after.
pub fn detachObservableCallbacks(provider: ?*const anyopaque) ?*ObsTrampoline {
    const key = provider orelse return null;
    var detached: ?*ObsTrampoline = null;
    obs_lock.lock();
    defer obs_lock.unlock();
    var link: *?*ObsTrampoline = &obs_head;
    while (link.*) |node| {
        if (node.provider == key) {
            link.* = node.next;
            node.next = detached;
            detached = node;
        } else {
            link = &node.next;
        }
    }
    return detached;
}

pub fn freeObservableCallbacks(list: ?*ObsTrampoline) void {
    var next = list;
    while (next) |node| {
        next = node.next;
        gpa.destroy(node);
    }
}

fn ObsCall(comptime N: type) type {
    return struct {
        fn call(ptr: ?*anyopaque, obs: o11y.Observation(N)) void {
            const self: *ObsTrampoline = @ptrCast(@alignCast(ptr orelse return));
            var box = obs;
            self.func(self.userdata, &box);
        }
    };
}

fn observeInto(comptime N: type, obs_ptr: ?*anyopaque, value: N, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    const obs: *o11y.Observation(N) = @ptrCast(@alignCast(obs_ptr orelse return));
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    obs.observe(value, converted);
}

export fn o11y_observation_i64_observe(obs: ?*anyopaque, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    observeInto(i64, obs, value, attrs, attrs_len);
}

export fn o11y_observation_f64_observe(obs: ?*anyopaque, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    observeInto(f64, obs, value, attrs, attrs_len);
}

const ObservableKind = enum { counter, up_down_counter, gauge };

fn registerObservable(
    comptime N: type,
    comptime kind: ObservableKind,
    meter: ?*const o11y.Meter,
    name: ?[*:0]const u8,
    opts_ptr: ?*const c.InstrumentOptions,
    callback: ?c.ObserveI64Fn,
    userdata: ?*anyopaque,
) c.Err {
    const m = meter orelse return .invalid_argument;
    const cb = callback orelse return .invalid_argument;
    // A no-op meter observes nothing, so there is no callback to keep.
    const provider = m.provider orelse return .ok;
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};

    const tr = gpa.create(ObsTrampoline) catch return .out_of_memory;
    tr.* = .{ .provider = provider, .func = cb, .userdata = userdata };
    obs_lock.lock();
    tr.next = obs_head;
    obs_head = tr;
    obs_lock.unlock();

    const inst_name = rt.cStrOrEmpty(name);
    const description = rt.cStrOrEmpty(o.description);
    const unit = rt.cStrOrEmpty(o.unit);
    const registered = switch (kind) {
        .counter => m.observableCounter(N, inst_name, .{
            .description = description,
            .unit = unit,
            .callbacks = &.{.{ .ptr = tr, .func = ObsCall(N).call }},
        }).inst != null,
        .up_down_counter => m.observableUpDownCounter(N, inst_name, .{
            .description = description,
            .unit = unit,
            .callbacks = &.{.{ .ptr = tr, .func = ObsCall(N).call }},
        }).inst != null,
        .gauge => m.observableGauge(N, inst_name, .{
            .description = description,
            .unit = unit,
            .callbacks = &.{.{ .ptr = tr, .func = ObsCall(N).call }},
        }).inst != null,
    };
    if (!registered) {
        obs_lock.lock();
        var link: *?*ObsTrampoline = &obs_head;
        while (link.*) |node| {
            if (node == tr) {
                link.* = node.next;
                break;
            }
            link = &node.next;
        }
        obs_lock.unlock();
        gpa.destroy(tr);
        return if (provider.is_shutdown.load(.acquire)) .shutdown else .out_of_memory;
    }
    return .ok;
}

export fn o11y_meter_observable_counter_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveI64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(i64, .counter, meter, name, opts, callback, userdata);
}

export fn o11y_meter_observable_counter_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveF64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(f64, .counter, meter, name, opts, callback, userdata);
}

export fn o11y_meter_observable_updown_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveI64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(i64, .up_down_counter, meter, name, opts, callback, userdata);
}

export fn o11y_meter_observable_updown_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveF64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(f64, .up_down_counter, meter, name, opts, callback, userdata);
}

export fn o11y_meter_observable_gauge_i64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveI64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(i64, .gauge, meter, name, opts, callback, userdata);
}

export fn o11y_meter_observable_gauge_f64(meter: ?*const o11y.Meter, name: ?[*:0]const u8, opts: ?*const c.InstrumentOptions, callback: ?c.ObserveF64Fn, userdata: ?*anyopaque) c.Err {
    return registerObservable(f64, .gauge, meter, name, opts, callback, userdata);
}

// =========================================================================
// Structured Logging, Events, and Wide Events (Record)
// =========================================================================

export fn o11y_log(
    sdk: ?*SdkHandle,
    level: c.Level,
    ctx: ?*const CtxHandle,
    message: ?[*:0]const u8,
    attrs: ?[*]const c.LogAttr,
    attrs_len: usize,
) void {
    const h = sdk orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    h.telemetry.log_pipeline.emit(toZigLevel(level), unwrapCtx(ctx), rt.cStrOrEmpty(message), converted);
}

export fn o11y_event(
    sdk: ?*SdkHandle,
    ctx: ?*const CtxHandle,
    event_name: ?[*:0]const u8,
    attrs: ?[*]const c.LogAttr,
    attrs_len: usize,
) void {
    const h = sdk orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    h.telemetry.event(unwrapCtx(ctx), rt.cStrOrEmpty(event_name), @as([]const o11y.LogAttribute, converted));
}

export fn o11y_record_create() ?*RecordHandle {
    const io = rt.acquireIo();
    const h = gpa.create(RecordHandle) catch {
        rt.releaseIo();
        return null;
    };
    h.* = .{ .rec = o11y.Record.init(gpa, io) };
    return h;
}

export fn o11y_record_destroy(rec: ?*RecordHandle) void {
    const h = rec orelse return;
    h.rec.deinit();
    gpa.destroy(h);
    rt.releaseIo();
}

export fn o11y_record_set_attrs(rec: ?*RecordHandle, attrs: ?[*]const c.LogAttr, attrs_len: usize) void {
    const h = rec orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    h.rec.setAttrs(@as([]const o11y.LogAttribute, converted));
}

export fn o11y_record_set(rec: ?*RecordHandle, attr: c.LogAttr) void {
    o11y_record_set_attrs(rec, @ptrCast(&attr), 1);
}

export fn o11y_record_add(rec: ?*RecordHandle, key: ?[*:0]const u8, delta: i64) void {
    const h = rec orelse return;
    h.rec.add(rt.cStrOrEmpty(key), delta);
}

export fn o11y_record_max(rec: ?*RecordHandle, key: ?[*:0]const u8, value: f64) void {
    const h = rec orelse return;
    h.rec.max(rt.cStrOrEmpty(key), value);
}

export fn o11y_record_set_error(rec: ?*RecordHandle, error_type: ?[*:0]const u8) void {
    const h = rec orelse return;
    const pairs = [_]o11y.LogAttribute{
        .{ .key = "error.type", .value = .{ .string = rt.cStrOpt(error_type) orelse "error" } },
        .{ .key = o11y.spec.Outcome.key, .value = .{ .string = o11y.spec.Outcome.failure.asStr() } },
    };
    h.rec.setAttrs(@as([]const o11y.LogAttribute, &pairs));
}

export fn o11y_record_emit_event(
    rec: ?*RecordHandle,
    ctx: ?*const CtxHandle,
    sdk: ?*SdkHandle,
    event_name: ?[*:0]const u8,
    extra_attrs: ?[*]const c.LogAttr,
    extra_attrs_len: usize,
) void {
    const sh = sdk orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const extra = convertLogAttrs(arena_state.allocator(), extra_attrs, extra_attrs_len) catch return;
    const zctx = unwrapCtx(ctx);
    const name = rt.cStrOrEmpty(event_name);
    if (rec) |h| {
        h.rec.emitEvent(zctx, sh.telemetry, name, @as([]const o11y.LogAttribute, extra));
    } else {
        sh.telemetry.event(zctx, name, @as([]const o11y.LogAttribute, extra));
    }
}

// =========================================================================
// W3C Context Propagation, Detached Work, and Child Process Propagation
// =========================================================================

const CCarrierAdapter = struct {
    carrier: c.Carrier,
    arena: Allocator,

    const vtable: o11y.Carrier.VTable = .{
        .get = getFn,
        .set = setFn,
    };

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const self: *CCarrierAdapter = @ptrCast(@alignCast(ptr));
        const getter = self.carrier.get orelse return null;
        const k_z = rt.dupeZ(self.arena, key) catch return null;
        const v_z = getter(self.carrier.userdata, k_z.ptr) orelse return null;
        return self.arena.dupe(u8, std.mem.span(v_z)) catch null;
    }

    fn setFn(ptr: *anyopaque, key: []const u8, value: []const u8) void {
        const self: *CCarrierAdapter = @ptrCast(@alignCast(ptr));
        const setter = self.carrier.set orelse return;
        const k_z = rt.dupeZ(self.arena, key) catch return;
        const v_z = rt.dupeZ(self.arena, value) catch return;
        setter(self.carrier.userdata, k_z.ptr, v_z.ptr);
    }
};

export fn o11y_inject(sdk: ?*const SdkHandle, ctx: ?*const CtxHandle, carrier_ptr: ?*const c.Carrier) void {
    const sh = sdk orelse return;
    const cp = carrier_ptr orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    var adapter: CCarrierAdapter = .{ .carrier = cp.*, .arena = arena_state.allocator() };
    const zcarrier: o11y.Carrier = .{ .ptr = &adapter, .vtable = &CCarrierAdapter.vtable };
    sh.telemetry.propagator().inject(unwrapCtx(ctx), gpa, zcarrier);
}

export fn o11y_extract(sdk: ?*const SdkHandle, parent: ?*const CtxHandle, carrier_ptr: ?*const c.Carrier) ?*CtxHandle {
    const base = unwrapCtx(parent);
    const sh = sdk orelse return newCtxHandle(base);
    const cp = carrier_ptr orelse return newCtxHandle(base);

    var scratch_state: std.heap.ArenaAllocator = .init(gpa);
    defer scratch_state.deinit();
    var adapter: CCarrierAdapter = .{ .carrier = cp.*, .arena = scratch_state.allocator() };
    const zcarrier: o11y.Carrier = .{ .ptr = &adapter, .vtable = &CCarrierAdapter.vtable };
    return newCtxHandle(sh.telemetry.propagator().extract(base, scratch_state.allocator(), zcarrier));
}

/// Wraps `carrier` in a handle and copies its trace state. On failure it
/// frees the carrier and returns null.
fn newCarrierHandle(carrier: o11y.detached.Carrier) ?*DetachedCarrierHandle {
    var owned = carrier;
    const h = gpa.create(DetachedCarrierHandle) catch {
        owned.deinit(gpa);
        return null;
    };
    h.* = .{ .carrier = owned };
    const header = h.carrier.spanContext().trace_state.header;
    if (header.len > 0) {
        const z = rt.dupeZ(gpa, header) catch {
            h.carrier.deinit(gpa);
            gpa.destroy(h);
            return null;
        };
        h.trace_state_z = z.ptr;
    }
    return h;
}

export fn o11y_detached_capture(
    sdk: ?*const SdkHandle,
    ctx: ?*const CtxHandle,
    out_carrier: ?*?*DetachedCarrierHandle,
) c.Err {
    const out = out_carrier orelse return .invalid_argument;
    out.* = null;
    const sh = sdk orelse return .invalid_argument;
    const carrier = sh.telemetry.captureDetached(gpa, unwrapCtx(ctx)) catch return .out_of_memory;
    out.* = newCarrierHandle(carrier) orelse return .out_of_memory;
    return .ok;
}

export fn o11y_detached_is_zero(carrier: ?*const DetachedCarrierHandle) bool {
    const h = carrier orelse return true;
    return h.carrier.isZero();
}

export fn o11y_detached_span_context(carrier: ?*const DetachedCarrierHandle) c.SpanContext {
    const h = carrier orelse return .{};
    return fromZigSpanContext(h.carrier.spanContext(), h.trace_state_z);
}

export fn o11y_detached_marshal(carrier: ?*const DetachedCarrierHandle, out_text: ?*?[*:0]u8) c.Err {
    const out = out_text orelse return .invalid_argument;
    out.* = null;
    const h = carrier orelse {
        out.* = rt.allocCString("") orelse return .out_of_memory;
        return .ok;
    };
    const text = h.carrier.marshalText(gpa) catch return .out_of_memory;
    defer gpa.free(text);
    out.* = rt.allocCString(text) orelse return .out_of_memory;
    return .ok;
}

export fn o11y_detached_unmarshal(text: ?[*]const u8, text_len: usize, out_carrier: ?*?*DetachedCarrierHandle) c.Err {
    const out = out_carrier orelse return .invalid_argument;
    out.* = null;
    const slice: []const u8 = if (text) |p| p[0..text_len] else "";
    const parsed = o11y.detached.Carrier.unmarshalText(gpa, slice) catch |err| return switch (err) {
        error.InvalidCarrier => .invalid_carrier,
        error.OutOfMemory => .out_of_memory,
    };
    out.* = newCarrierHandle(parsed) orelse return .out_of_memory;
    return .ok;
}

export fn o11y_detached_destroy(carrier: ?*DetachedCarrierHandle) void {
    const h = carrier orelse return;
    if (h.trace_state_z) |z| rt.freeZ(gpa, z);
    h.carrier.deinit(gpa);
    gpa.destroy(h);
}

export fn o11y_detached_start_linked(
    sdk: ?*SdkHandle,
    ctx: ?*const CtxHandle,
    carrier: ?*const DetachedCarrierHandle,
    name: ?[*:0]const u8,
    options: ?*const c.SpanStartOptions,
) ?*LinkedSpanHandle {
    const sh = sdk orelse return null;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const start_opts = convertSpanStartOptions(arena_state.allocator(), options) catch return null;
    const zcarrier = if (carrier) |ch| ch.carrier else o11y.detached.Carrier.zero;

    const h = gpa.create(LinkedSpanHandle) catch return null;
    h.* = .{
        .linked = sh.telemetry.startLinked(gpa, unwrapCtx(ctx), zcarrier, rt.cStrOrEmpty(name), start_opts),
        .ctx_handle = .{ .arena = .init(gpa), .ctx = .background },
        .span_handle = .{ .span = .noop, .owns_self = false },
    };
    h.span_handle.span = h.linked.span;
    h.span_handle.trace_state_z = spanTraceStateZ(&h.span_handle.span);
    h.ctx_handle.ctx = ownContext(h.ctx_handle.arena.allocator(), h.linked.context()) catch blk: {
        // Out of memory: keep the span identity and lose trace state and baggage.
        var sc = h.linked.span.spanContext();
        sc.trace_state = .empty;
        break :blk o11y.Context.background.withSpanContext(sc);
    };
    return h;
}

export fn o11y_linked_span_ctx(linked: ?*const LinkedSpanHandle) ?*const CtxHandle {
    const h = linked orelse return null;
    return &h.ctx_handle;
}

export fn o11y_linked_span_handle(linked: ?*LinkedSpanHandle) ?*SpanHandle {
    const h = linked orelse return null;
    return &h.span_handle;
}

export fn o11y_linked_span_end(linked: ?*LinkedSpanHandle) void {
    const h = linked orelse return;
    // Sync span state back before ending so edits via span_handle are finalized once.
    h.linked.span = h.span_handle.span;
    h.span_handle.span = .noop;
    if (h.span_handle.trace_state_z) |z| {
        rt.freeZ(gpa, z);
        h.span_handle.trace_state_z = null;
    }
    h.linked.end();
    h.ctx_handle.arena.deinit();
    gpa.destroy(h);
}

export fn o11y_proc_env_entries(
    ctx: ?*const CtxHandle,
    out_traceparent_entry: ?*?[*:0]u8,
    out_tracestate_entry: ?*?[*:0]u8,
) bool {
    if (out_traceparent_entry) |p| p.* = null;
    if (out_tracestate_entry) |p| p.* = null;
    var entries = (o11y.proc.envEntries(gpa, unwrapCtx(ctx)) catch return false) orelse return false;
    defer entries.deinit(gpa);
    if (out_traceparent_entry) |p| {
        p.* = rt.allocCString(entries.traceparent) orelse return false;
    }
    if (out_tracestate_entry) |p| {
        p.* = rt.allocCString(entries.tracestate) orelse {
            if (out_traceparent_entry) |tp| {
                rt.freeCString(tp.*);
                tp.* = null;
            }
            return false;
        };
    }
    return true;
}

export fn o11y_proc_extract_env(
    parent: ?*const CtxHandle,
    traceparent: ?[*:0]const u8,
    tracestate: ?[*:0]const u8,
) ?*CtxHandle {
    var pairs: [2][2][]const u8 = undefined;
    var n: usize = 0;
    if (rt.cStrOpt(traceparent)) |tp| {
        pairs[n] = .{ o11y.proc.env_traceparent, tp };
        n += 1;
    }
    if (rt.cStrOpt(tracestate)) |ts| {
        pairs[n] = .{ o11y.proc.env_tracestate, ts };
        n += 1;
    }
    var scratch_state: std.heap.ArenaAllocator = .init(gpa);
    defer scratch_state.deinit();
    const env: o11y.Env = .{ .pairs = pairs[0..n] };
    return newCtxHandle(o11y.proc.extractEnv(unwrapCtx(parent), scratch_state.allocator(), env));
}

// =========================================================================
// Specification, Sensitivity, and Conformance Utilities
// =========================================================================

export fn o11y_spec_sensitivity_of(key: ?[*:0]const u8) c.Sensitivity {
    const k = rt.cStrOpt(key) orelse return .unclassified;
    const s = o11y.spec.sensitivityOf(k) orelse return .unclassified;
    return switch (s) {
        .public => .public,
        .internal => .internal,
        .pii => .pii,
        .secret => .secret,
    };
}

export fn o11y_spec_cardinality_of(key: ?[*:0]const u8) c.Cardinality {
    const k = rt.cStrOpt(key) orelse return .unclassified;
    const card = o11y.spec.cardinalityOf(k) orelse return .unclassified;
    return switch (card) {
        .@"enum" => .@"enum",
        .bounded => .bounded,
        .unbounded => .unbounded,
    };
}

export fn o11y_derive_instance_id(
    pod_uid: ?[*:0]const u8,
    pod_name: ?[*:0]const u8,
    namespace_name: ?[*:0]const u8,
    out: ?*[37]u8,
) bool {
    const dst = out orelse return false;
    var buf: [o11y.identity.uuid_text_len]u8 = undefined;
    const derived = o11y.identity.instanceId(
        &buf,
        rt.cStrOrEmpty(pod_uid),
        rt.cStrOrEmpty(pod_name),
        rt.cStrOrEmpty(namespace_name),
    ) orelse return false;
    @memcpy(dst[0..derived.len], derived);
    dst[derived.len] = 0;
    return true;
}

export fn o11y_sanitize_endpoint(raw: ?[*]const u8, raw_len: usize, out: ?*?[*:0]u8) c.Err {
    const dst = out orelse return .invalid_argument;
    dst.* = null;
    const slice: []const u8 = if (raw) |p| p[0..raw_len] else "";
    const sanitized = o11y.endpoint.sanitize(gpa, slice) catch return .out_of_memory;
    defer gpa.free(sanitized);
    dst.* = rt.allocCString(sanitized) orelse return .out_of_memory;
    return .ok;
}

fn logValueToPiiValue(arena: Allocator, v: c.LogValue, depth: usize, walk: *WalkState) Allocator.Error!o11y.pii.Value {
    if (depth > o11y.pii.max_depth or walk.remaining == 0) return .{ .string = o11y.pii.truncated };
    walk.remaining -= 1;
    return switch (v.kind) {
        .empty => .{ .string = "" },
        .string => blk: {
            const sv = v.value.str_val;
            const slice: []const u8 = if (sv.data) |d|
                (if (sv.has_len) d[0..sv.len] else std.mem.span(@as([*:0]const u8, @ptrCast(d))))
            else
                "";
            break :blk .{ .string = slice };
        },
        .bool => .{ .bool = v.value.bool_val },
        .int => .{ .int = v.value.int_val },
        .double => .{ .float = v.value.double_val },
        .bytes => blk: {
            const bv = v.value.bytes_val;
            break :blk .{ .bytes = if (bv.len > 0 and bv.data != null) bv.data.?[0..bv.len] else &.{} };
        },
        .array => blk: {
            const av = v.value.array_val;
            if (av.len == 0 or av.items == null) break :blk .{ .array = &.{} };
            if (!walk.enter(@intFromPtr(av.items.?))) break :blk .{ .string = o11y.pii.truncated };
            defer walk.leave();
            const cap = @min(av.len, walk.remaining + 1);
            const out = try arena.alloc(o11y.pii.Value, cap);
            for (av.items.?[0..cap], out) |item, *dst| {
                dst.* = try logValueToPiiValue(arena, item, depth + 1, walk);
            }
            break :blk .{ .array = out };
        },
        .map => blk: {
            const mv = v.value.map_val;
            if (mv.len == 0 or mv.items == null) break :blk .{ .map = &.{} };
            if (!walk.enter(@intFromPtr(mv.items.?))) break :blk .{ .string = o11y.pii.truncated };
            defer walk.leave();
            const cap = @min(mv.len, walk.remaining + 1);
            const out = try arena.alloc(o11y.pii.Member, cap);
            for (mv.items.?[0..cap], out) |item, *dst| {
                dst.* = .{
                    .key = rt.cStrOrEmpty(item.key),
                    .value = try logValueToPiiValue(arena, item.value, depth + 1, walk),
                };
            }
            break :blk .{ .map = out };
        },
        _ => .{ .string = "" },
    };
}

export fn o11y_pii_hash_value(
    value_ptr: ?*const c.LogValue,
    key: ?[*]const u8,
    key_len: usize,
    out_canonical: ?*?[*:0]u8,
    out_token: ?*[45]u8,
) c.Err {
    if (out_canonical) |oc| oc.* = null;
    if (out_token) |ot| ot[0] = 0;
    const vp = value_ptr orelse return .invalid_argument;
    if (key == null or key_len < o11y.pii.min_key_len) return .pii_hash_key;

    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    var walk: WalkState = .{ .remaining = o11y.pii.walk_budget * 16 };
    const pv = logValueToPiiValue(arena_state.allocator(), vp.*, 0, &walk) catch return .out_of_memory;
    const canon = o11y.pii.canonical(gpa, pv) catch return .out_of_memory;
    defer gpa.free(canon);

    if (out_canonical) |oc| {
        oc.* = rt.allocCString(canon) orelse return .out_of_memory;
    }
    if (out_token) |ot| {
        var tok_buf: [o11y.pii.token_len]u8 = undefined;
        const tok = o11y.pii.token(&tok_buf, key.?[0..key_len], canon);
        @memcpy(ot[0..tok.len], tok);
        ot[tok.len] = 0;
    }
    return .ok;
}

export fn o11y_app_registry_check_bytes(
    content: ?[*]const u8,
    content_len: usize,
    out_want: ?*?[*:0]u8,
    out_status: ?*c_int,
) c.Err {
    if (out_want) |ow| ow.* = null;
    if (out_status) |st| st.* = 0;
    if (content_len > 0 and content == null) return .invalid_argument;
    const raw: []const u8 = if (content) |p| p[0..content_len] else "";
    var result = o11y.appregistry.check(gpa, raw, .{}) catch return .out_of_memory;
    defer result.deinit();

    if (out_status) |st| {
        st.* = switch (result.outcome) {
            .valid => 0,
            .invalid => 1,
            .parse_error => 2,
        };
    }

    if (out_want) |ow| {
        var buf: Io.Writer.Allocating = .init(gpa);
        defer buf.deinit();
        result.writeWant(&buf.writer) catch return .out_of_memory;
        ow.* = rt.allocCString(buf.written()) orelse return .out_of_memory;
    }
    return .ok;
}
