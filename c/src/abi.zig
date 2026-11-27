//! Core C11 ABI exports implementing `c/include/o11y/o11y.h` over `o11y` (Zig).

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const c = @import("c_types.zig");
const rt = @import("runtime.zig");

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

pub const CtxHandle = struct {
    arena: std.heap.ArenaAllocator,
    ctx: o11y.Context,
    baggage: ?o11y.Baggage = null,
    trace_state_z: ?[*:0]const u8 = null,
};

pub const SpanHandle = struct {
    span: o11y.Span,
    owns_self: bool,
    trace_state_z: ?[*:0]u8 = null,
};

pub const RecordHandle = struct {
    rec: o11y.Record,
};

pub const DetachedCarrierHandle = struct {
    carrier: o11y.detached.Carrier,
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

pub fn toZigPiiMode(m: c.PiiMode) o11y.PIIMode {
    return switch (m) {
        .drop => .drop,
        .hash => .hash,
        .allow => .allow,
        _ => .drop,
    };
}

pub fn toZigSampler(kind: c.SamplerKind, ratio: f64) ?o11y.Sampler {
    return switch (kind) {
        .default => null,
        .always_on => .always_on,
        .always_off => .always_off,
        .trace_id_ratio => o11y.Sampler.traceIdRatio(ratio),
        .parent_based_always_on => .{ .parent_based = .{ .root = .always_on } },
        .parent_based_always_off => .{ .parent_based = .{ .root = .always_off } },
        .parent_based_trace_id_ratio => .{ .parent_based = .{ .root = .{ .trace_id_ratio = .init(ratio) } } },
        _ => null,
    };
}

pub fn toZigExemplarFilter(f: c.ExemplarFilter) ?o11y.ExemplarFilter {
    return switch (f) {
        .default => null,
        .trace_based => .trace_based,
        .always_on => .always_on,
        .always_off => .always_off,
        _ => null,
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

pub fn convertLogValue(arena: Allocator, v: c.LogValue, depth: usize) Allocator.Error!o11y.LogValue {
    if (depth > 32) return .empty;
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
            const av = v.value.array_val;
            if (av.len == 0 or av.items == null) break :blk .{ .array = &.{} };
            const out = try arena.alloc(o11y.LogValue, av.len);
            for (av.items.?[0..av.len], out) |item, *dst| {
                dst.* = try convertLogValue(arena, item, depth + 1);
            }
            break :blk .{ .array = out };
        },
        .map => blk: {
            const mv = v.value.map_val;
            if (mv.len == 0 or mv.items == null) break :blk .{ .map = &.{} };
            const out = try convertLogAttrs(arena, mv.items, mv.len, depth + 1);
            break :blk .{ .map = out };
        },
        _ => .empty,
    };
}

pub fn convertLogAttrs(arena: Allocator, raw: ?[*]const c.LogAttr, len: usize, depth: usize) Allocator.Error![]o11y.LogAttribute {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    const out = try arena.alloc(o11y.LogAttribute, len);
    for (ptr[0..len], out) |src, *dst| {
        dst.* = .{
            .key = try arena.dupe(u8, rt.cStrOrEmpty(src.key)),
            .value = try convertLogValue(arena, src.value, depth),
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
        const self: *AttrReplacerTrampoline = @ptrCast(@alignCast(ptr orelse return attr));
        const key_z = rt.dupeZ(arena, attr.key) catch return attr;
        const c_val = zigLogValueToC(arena, attr.value, 0) catch return attr;

        var c_groups_ptr: ?[*]const ?[*:0]const u8 = null;
        if (groups.len > 0) {
            const grp_arr = arena.alloc(?[*:0]const u8, groups.len) catch return attr;
            for (groups, grp_arr) |g, *dst| {
                dst.* = (rt.dupeZ(arena, g) catch return attr).ptr;
            }
            c_groups_ptr = grp_arr.ptr;
        }

        var out_key_buf: [256]u8 = @splat(0);
        var out_val_buf: [1024]u8 = @splat(0);
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
            &replace_val,
        );
        if (!keep) return null;

        var res = attr;
        if (out_key_buf[0] != 0) {
            const new_k = std.mem.sliceTo(&out_key_buf, 0);
            res.key = arena.dupe(u8, new_k) catch return attr;
        }
        if (replace_val) {
            const new_v = std.mem.sliceTo(&out_val_buf, 0);
            res.value = .{ .string = arena.dupe(u8, new_v) catch return attr };
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
        var buf: [512]u8 = undefined;
        const formatted = std.fmt.bufPrint(&buf, "{s}: {s}: {s}", .{ component, @errorName(err), detail }) catch component;
        const n = @min(formatted.len, buf.len - 1);
        buf[n] = 0;
        self.func(self.userdata, @ptrCast(&buf));
    }
};

// Global baggage egress callback slot (since Zig's baggage_egress_allow is a plain fn pointer).
var baggage_allow_fn: std.atomic.Value(?c.BaggageEgressAllowFn) = .init(null);

fn baggageEgressBridge(key: []const u8) bool {
    const f = baggage_allow_fn.load(.acquire) orelse return true;
    return f(key.ptr, key.len);
}

pub fn installBaggageAllow(f: ?c.BaggageEgressAllowFn) ?*const fn ([]const u8) bool {
    const cb = f orelse return null;
    baggage_allow_fn.store(cb, .release);
    return baggageEgressBridge;
}

pub fn buildAppRegistries(arena: Allocator, raw: ?[*]const c.AppRegistrySource, len: usize) Allocator.Error![]o11y.AppRegistrySource {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    const out = try arena.alloc(o11y.AppRegistrySource, len);
    for (ptr[0..len], out) |src, *dst| {
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

pub fn buildHistogramBuckets(arena: Allocator, raw: ?[*]const c.HistogramBuckets, len: usize) Allocator.Error![]o11y.HistogramBuckets {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    const out = try arena.alloc(o11y.HistogramBuckets, len);
    for (ptr[0..len], out) |src, *dst| {
        const bounds = if (src.boundaries_len > 0 and src.boundaries != null)
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

pub fn buildExtraEnvs(arena: Allocator, raw: ?[*]const ?[*:0]const u8, len: usize) Allocator.Error![][]const u8 {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
    const out = try arena.alloc([]const u8, len);
    for (ptr[0..len], out) |s, *dst| {
        dst.* = try arena.dupe(u8, rt.cStrOrEmpty(s));
    }
    return out;
}

pub fn buildExtraSinks(arena: Allocator, raw: ?[*]const c.LogSink, len: usize) Allocator.Error![]o11y.LogSink {
    if (len == 0) return &.{};
    const ptr = raw orelse return &.{};
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
        .not_found => "O11Y_ERR_NOT_FOUND",
        .conformance_failed => "O11Y_ERR_CONFORMANCE_FAILED",
        .correlation_failed => "O11Y_ERR_CORRELATION_FAILED",
        .triangle_failed => "O11Y_ERR_TRIANGLE_FAILED",
        .violations => "O11Y_ERR_VIOLATIONS",
        .io => "O11Y_ERR_IO",
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

export fn o11y_trace_id_hex(id: c.TraceId, out: *[33]u8) void {
    const t: o11y.TraceId = .{ .bytes = id.bytes };
    const hex = t.hex();
    @memcpy(out[0..32], &hex);
    out[32] = 0;
}

export fn o11y_span_id_hex(id: c.SpanId, out: *[17]u8) void {
    const s: o11y.SpanId = .{ .bytes = id.bytes };
    const hex = s.hex();
    @memcpy(out[0..16], &hex);
    out[16] = 0;
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
    const out = out_sdk orelse {
        writeDiagnosticText(diag_out, "o11y: out_sdk pointer must not be null");
        return .invalid_argument;
    };
    out.* = null;

    const opts = if (opts_ptr) |p| p.* else c.Options{};
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena_state.deinit();
    const arena = arena_state.allocator();

    // Build Env source.
    const env: o11y.Env = switch (opts.env_mode) {
        .hermetic => .hermetic,
        .process => .{ .pairs = rt.readProcessEnvPairs(arena) catch return .out_of_memory },
        .pairs => blk: {
            if (opts.env_pairs_len == 0 or opts.env_pairs == null) break :blk .{ .pairs = &.{} };
            const ps = arena.alloc([2][]const u8, opts.env_pairs_len) catch return .out_of_memory;
            for (opts.env_pairs.?[0..opts.env_pairs_len], ps) |src, *dst| {
                dst.* = .{
                    arena.dupe(u8, rt.cStrOrEmpty(src.key)) catch return .out_of_memory,
                    arena.dupe(u8, rt.cStrOrEmpty(src.value)) catch return .out_of_memory,
                };
            }
            break :blk .{ .pairs = ps };
        },
        .entries => blk: {
            if (opts.env_entries_len == 0 or opts.env_entries == null) break :blk .{ .entries = &.{} };
            const es = arena.alloc([]const u8, opts.env_entries_len) catch return .out_of_memory;
            for (opts.env_entries.?[0..opts.env_entries_len], es) |src, *dst| {
                dst.* = arena.dupe(u8, rt.cStrOrEmpty(src)) catch return .out_of_memory;
            }
            break :blk .{ .entries = es };
        },
        _ => .hermetic,
    };

    const protocol: ?o11y.Protocol = switch (opts.protocol) {
        .default => null,
        .http_protobuf => .http_protobuf,
        .http_json => .http_json,
        .grpc => .grpc,
        _ => null,
    };

    const console_writer: o11y.ConsoleWriter = switch (opts.console_target) {
        .stdout => .stdout,
        .stderr => .stderr,
        .custom => blk: {
            const f = opts.console_write_fn orelse {
                writeDiagnosticText(diag_out, "o11y: custom console target requires console_write_fn");
                return .invalid_argument;
            };
            const tr = arena.create(ConsoleWriterTrampoline) catch return .out_of_memory;
            tr.* = .{ .func = f, .userdata = opts.console_write_userdata };
            break :blk .{ .custom = .{ .ptr = tr, .writeFn = ConsoleWriterTrampoline.write } };
        },
        _ => .stdout,
    };

    const attr_replacer: ?o11y.AttrReplacer = if (opts.attr_replacer_fn) |f| blk: {
        const tr = arena.create(AttrReplacerTrampoline) catch return .out_of_memory;
        tr.* = .{ .func = f, .userdata = opts.attr_replacer_userdata };
        break :blk .{ .ptr = tr, .replace = AttrReplacerTrampoline.replace };
    } else null;

    const err_handler: ?o11y.ErrorHandler = if (opts.error_handler_fn) |f| blk: {
        const tr = arena.create(ErrorHandlerTrampoline) catch return .out_of_memory;
        tr.* = .{ .func = f, .userdata = opts.error_handler_userdata };
        break :blk .{ .ptr = tr, .report = ErrorHandlerTrampoline.handle };
    } else null;

    const baggage_fn = installBaggageAllow(opts.baggage_egress_allow);

    const extra_envs = buildExtraEnvs(arena, opts.extra_environments, opts.extra_environments_len) catch return .out_of_memory;
    const res_attrs = convertAttrs(arena, opts.resource_attributes, opts.resource_attributes_len) catch return .out_of_memory;
    const extra_sinks = buildExtraSinks(arena, opts.extra_log_sinks, opts.extra_log_sinks_len) catch return .out_of_memory;
    const app_regs = buildAppRegistries(arena, opts.app_registries, opts.app_registries_len) catch return .out_of_memory;
    const hist_buckets = buildHistogramBuckets(arena, opts.histogram_buckets, opts.histogram_buckets_len) catch return .out_of_memory;
    const build_info = buildBuildInfo(arena, opts.build_info) catch return .out_of_memory;
    const pii_key: []const u8 = if (opts.pii_hash_key_len > 0 and opts.pii_hash_key != null)
        (arena.dupe(u8, opts.pii_hash_key.?[0..opts.pii_hash_key_len]) catch return .out_of_memory)
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
        .log_level = toZigLevel(opts.log_level),
        .console_enabled = opts.console_enabled,
        .console_format = switch (opts.console_format) {
            .json => .json,
            .text => .text,
            _ => .json,
        },
        .console_writer = console_writer,
        .log_export = opts.log_export,
        .attr_replacer = attr_replacer,
        .extra_log_sinks = extra_sinks,
        .pii_mode = toZigPiiMode(opts.pii_mode),
        .pii_hash_key = pii_key,
        .app_registries = app_regs,
        .sampler = toZigSampler(opts.sampler_kind, opts.sampler_ratio),
        .baggage_egress_allow = baggage_fn,
        .histogram_buckets = hist_buckets,
        .exemplar_filter = toZigExemplarFilter(opts.exemplar_filter),
        .runtime_metrics = opts.runtime_metrics,
        .startup_summary = opts.startup_summary,
        .install_std_log = false,
        .error_handler = err_handler,
        .diagnostic = &zig_diag,
        .sdk_language = "c",
        .sdk_version = rt.c_version,
        .emit_process_runtime = false,
    };

    const io = rt.globalIo();
    const telemetry = (if (is_setup) o11y.setup(gpa, io, zig_opts) else o11y.init(gpa, io, zig_opts)) catch |err| {
        writeDiagnostic(diag_out, &zig_diag);
        return mapSetupError(err);
    };
    errdefer telemetry.deinit();

    const eff_z = rt.dupeZ(arena, telemetry.effectiveConfig()) catch return .out_of_memory;
    const handle = gpa.create(SdkHandle) catch return .out_of_memory;
    handle.* = .{
        .telemetry = telemetry,
        .owns_telemetry = true,
        .arena = arena_state,
        .effective_config_z = eff_z.ptr,
    };
    out.* = handle;
    return .ok;
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
    const h = sdk orelse return .invalid_argument;
    const timeout: ?Io.Duration = if (timeout_ms == 0) null else .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    const report = h.telemetry.shutdown(timeout);
    return fillReport(report, out_report);
}

export fn o11y_force_flush(sdk: ?*SdkHandle, timeout_ms: u64, out_report: ?*c.ShutdownReport) c.Err {
    const h = sdk orelse return .invalid_argument;
    const timeout: ?Io.Duration = if (timeout_ms == 0) null else .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    const report = h.telemetry.forceFlush(timeout);
    return fillReport(report, out_report);
}

export fn o11y_destroy(sdk: ?*SdkHandle) void {
    const h = sdk orelse return;
    if (!h.owns_telemetry) return;
    h.telemetry.deinit();
    h.arena.deinit();
    gpa.destroy(h);
}

export fn o11y_effective_config(sdk: ?*const SdkHandle) [*:0]const u8 {
    const h = sdk orelse return "";
    return h.effective_config_z;
}

const BeforeShutdownTrampoline = struct {
    func: *const fn (?*anyopaque) callconv(.c) void,
    userdata: ?*anyopaque,

    fn call(ptr: ?*anyopaque, _: o11y.Deadline) void {
        const self: *BeforeShutdownTrampoline = @ptrCast(@alignCast(ptr orelse return));
        self.func(self.userdata);
    }
};

export fn o11y_shutdown_on_signals(sdk: ?*SdkHandle, opts_ptr: ?*const c.SignalOptions, out_report: ?*c.ShutdownReport) c.Err {
    const h = sdk orelse return .invalid_argument;
    const opts = if (opts_ptr) |p| p.* else c.SignalOptions{};

    var tramp: BeforeShutdownTrampoline = undefined;
    var before: ?o11y.BeforeShutdown = null;
    if (opts.before_shutdown) |f| {
        tramp = .{ .func = f, .userdata = opts.before_shutdown_userdata };
        before = .{ .ptr = &tramp, .func = BeforeShutdownTrampoline.call };
    }

    var sig_buf: [16]std.posix.SIG = undefined;
    var sigs: []const std.posix.SIG = &.{ .INT, .TERM };
    if (builtin.os.tag != .windows and opts.signals_len > 0 and opts.signals != null) {
        const n = @min(opts.signals_len, sig_buf.len);
        for (0..n) |i| {
            sig_buf[i] = @fromBackingInt(@intCast(opts.signals.?[i]));
        }
        sigs = sig_buf[0..n];
    }

    const report = o11y.shutdownOnSignals(rt.globalIo(), h.telemetry, .{
        .timeout = if (opts.timeout_ms == 0) .fromSeconds(5) else .fromMilliseconds(@intCast(@min(opts.timeout_ms, std.math.maxInt(i64)))),
        .before_shutdown = before,
        .signals = sigs,
    });
    return fillReport(report, out_report);
}

// =========================================================================
// Context
// =========================================================================

fn cloneCtxHandle(parent: ?*const CtxHandle) ?*CtxHandle {
    const h = gpa.create(CtxHandle) catch return null;
    h.* = .{
        .arena = .init(gpa),
        .ctx = .background,
    };
    const arena = h.arena.allocator();
    if (parent) |p| {
        h.ctx = p.ctx;
        if (p.ctx.span_context.trace_state.header.len > 0) {
            const ts_z = rt.dupeZ(arena, p.ctx.span_context.trace_state.header) catch {
                h.arena.deinit();
                gpa.destroy(h);
                return null;
            };
            h.ctx.span_context.trace_state = .{ .header = ts_z };
            h.trace_state_z = ts_z.ptr;
        }
        if (p.ctx.baggage) |bag| {
            const members = arena.alloc(o11y.Baggage.Member, bag.members.len) catch {
                h.arena.deinit();
                gpa.destroy(h);
                return null;
            };
            for (bag.members, members) |m, *dst| {
                dst.* = .{
                    .key = arena.dupe(u8, m.key) catch {
                        h.arena.deinit();
                        gpa.destroy(h);
                        return null;
                    },
                    .value = arena.dupe(u8, m.value) catch {
                        h.arena.deinit();
                        gpa.destroy(h);
                        return null;
                    },
                    .metadata = arena.dupe(u8, m.metadata) catch {
                        h.arena.deinit();
                        gpa.destroy(h);
                        return null;
                    },
                };
            }
            h.baggage = .{ .members = members };
            h.ctx.baggage = &h.baggage.?;
        }
    }
    return h;
}

pub fn unwrapCtx(ctx: ?*const CtxHandle) o11y.Context {
    const h = ctx orelse return .background;
    return h.ctx;
}

export fn o11y_ctx_create() ?*CtxHandle {
    return cloneCtxHandle(null);
}

export fn o11y_ctx_destroy(ctx: ?*CtxHandle) void {
    const h = ctx orelse return;
    h.arena.deinit();
    gpa.destroy(h);
}

export fn o11y_ctx_with_span(parent: ?*const CtxHandle, span: ?*SpanHandle) ?*CtxHandle {
    const h = cloneCtxHandle(parent) orelse return null;
    if (span) |sp| {
        h.ctx = h.ctx.withSpan(&sp.span);
        if (h.ctx.span_context.trace_state.header.len > 0) {
            const ts_z = rt.dupeZ(h.arena.allocator(), h.ctx.span_context.trace_state.header) catch null;
            if (ts_z) |z| {
                h.ctx.span_context.trace_state = .{ .header = z };
                h.trace_state_z = z.ptr;
            }
        } else {
            h.trace_state_z = null;
        }
    }
    return h;
}

export fn o11y_ctx_with_span_context(parent: ?*const CtxHandle, sc: c.SpanContext) ?*CtxHandle {
    const h = cloneCtxHandle(parent) orelse return null;
    var zsc = toZigSpanContext(sc);
    if (zsc.trace_state.header.len > 0) {
        const ts_z = rt.dupeZ(h.arena.allocator(), zsc.trace_state.header) catch {
            h.arena.deinit();
            gpa.destroy(h);
            return null;
        };
        zsc.trace_state = .{ .header = ts_z };
        h.trace_state_z = ts_z.ptr;
    } else {
        h.trace_state_z = null;
    }
    h.ctx = h.ctx.withSpanContext(zsc);
    return h;
}

export fn o11y_ctx_with_force_emit(parent: ?*const CtxHandle) ?*CtxHandle {
    const h = cloneCtxHandle(parent) orelse return null;
    h.ctx = h.ctx.withForceEmit();
    return h;
}

export fn o11y_ctx_with_record(parent: ?*const CtxHandle, record: ?*RecordHandle) ?*CtxHandle {
    const h = cloneCtxHandle(parent) orelse return null;
    h.ctx = h.ctx.withRecord(if (record) |r| &r.rec else null);
    return h;
}

export fn o11y_ctx_with_baggage_item(parent: ?*const CtxHandle, key: ?[*:0]const u8, value: ?[*:0]const u8) ?*CtxHandle {
    const h = cloneCtxHandle(parent) orelse return null;
    const k = rt.cStrOpt(key) orelse return h;
    if (k.len == 0) return h;
    const v = rt.cStrOrEmpty(value);
    const arena = h.arena.allocator();

    const existing = if (h.baggage) |b| b.members else &.{};
    var list: std.ArrayList(o11y.Baggage.Member) = .empty;
    var replaced = false;
    for (existing) |m| {
        if (std.mem.eql(u8, m.key, k)) {
            list.append(arena, .{
                .key = m.key,
                .value = arena.dupe(u8, v) catch return h,
                .metadata = "",
            }) catch return h;
            replaced = true;
        } else {
            list.append(arena, m) catch return h;
        }
    }
    if (!replaced) {
        list.append(arena, .{
            .key = arena.dupe(u8, k) catch return h,
            .value = arena.dupe(u8, v) catch return h,
            .metadata = "",
        }) catch return h;
    }
    h.baggage = .{ .members = list.items };
    h.ctx.baggage = &h.baggage.?;
    return h;
}

export fn o11y_ctx_span_context(ctx: ?*const CtxHandle) c.SpanContext {
    const h = ctx orelse return .{};
    return fromZigSpanContext(h.ctx.span_context, h.trace_state_z);
}

export fn o11y_ctx_baggage_get(ctx: ?*const CtxHandle, key: ?[*:0]const u8) ?[*:0]const u8 {
    const h = ctx orelse return null;
    const k = rt.cStrOpt(key) orelse return null;
    const bag = h.ctx.baggage orelse return null;
    const val = for (bag.members) |m| {
        if (std.mem.eql(u8, m.key, k)) break m.value;
    } else return null;
    const mut: *CtxHandle = @constCast(h);
    const z = rt.dupeZ(mut.arena.allocator(), val) catch return null;
    return z.ptr;
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
    const start_opts = convertSpanStartOptions(arena_state.allocator(), options) catch o11y.StartOptions{};

    const h = gpa.create(SpanHandle) catch return null;
    h.* = .{
        .span = tr.start(unwrapCtx(ctx), rt.cStrOrEmpty(name), start_opts),
        .owns_self = true,
    };
    return h;
}

export fn o11y_span_context(span: ?*const SpanHandle) c.SpanContext {
    const h = span orelse return .{};
    const sc = h.span.spanContext();
    var ts_z: ?[*:0]const u8 = null;
    if (sc.trace_state.header.len > 0) {
        const mut: *SpanHandle = @constCast(h);
        if (mut.trace_state_z) |prev| rt.freeZ(gpa, prev);
        if (rt.dupeZ(gpa, sc.trace_state.header)) |z| {
            mut.trace_state_z = z.ptr;
            ts_z = z.ptr;
        } else |_| {}
    }
    return fromZigSpanContext(sc, ts_z);
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

const ObsI64Trampoline = struct {
    func: c.ObserveI64Fn,
    userdata: ?*anyopaque,

    fn call(ptr: ?*anyopaque, obs: o11y.Observation(i64)) void {
        const self: *ObsI64Trampoline = @ptrCast(@alignCast(ptr orelse return));
        var box = obs;
        self.func(self.userdata, &box);
    }
};

const ObsF64Trampoline = struct {
    func: c.ObserveF64Fn,
    userdata: ?*anyopaque,

    fn call(ptr: ?*anyopaque, obs: o11y.Observation(f64)) void {
        const self: *ObsF64Trampoline = @ptrCast(@alignCast(ptr orelse return));
        var box = obs;
        self.func(self.userdata, &box);
    }
};

export fn o11y_observation_i64_observe(obs_ptr: ?*anyopaque, value: i64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    const obs: *o11y.Observation(i64) = @ptrCast(@alignCast(obs_ptr orelse return));
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    obs.observe(value, converted);
}

export fn o11y_observation_f64_observe(obs_ptr: ?*anyopaque, value: f64, attrs: ?[*]const c.Attr, attrs_len: usize) void {
    const obs: *o11y.Observation(f64) = @ptrCast(@alignCast(obs_ptr orelse return));
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertAttrs(arena_state.allocator(), attrs, attrs_len) catch return;
    obs.observe(value, converted);
}

export fn o11y_meter_observable_counter_i64(
    meter: ?*const o11y.Meter,
    name: ?[*:0]const u8,
    opts_ptr: ?*const c.InstrumentOptions,
    callback: ?c.ObserveI64Fn,
    userdata: ?*anyopaque,
) c.Err {
    const m = meter orelse return .invalid_argument;
    const cb = callback orelse return .invalid_argument;
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const tr = gpa.create(ObsI64Trampoline) catch return .out_of_memory;
    tr.* = .{ .func = cb, .userdata = userdata };
    _ = m.observableCounter(i64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
        .callbacks = &.{.{ .ptr = tr, .func = ObsI64Trampoline.call }},
    });
    return .ok;
}

export fn o11y_meter_observable_gauge_f64(
    meter: ?*const o11y.Meter,
    name: ?[*:0]const u8,
    opts_ptr: ?*const c.InstrumentOptions,
    callback: ?c.ObserveF64Fn,
    userdata: ?*anyopaque,
) c.Err {
    const m = meter orelse return .invalid_argument;
    const cb = callback orelse return .invalid_argument;
    const o = if (opts_ptr) |p| p.* else c.InstrumentOptions{};
    const tr = gpa.create(ObsF64Trampoline) catch return .out_of_memory;
    tr.* = .{ .func = cb, .userdata = userdata };
    _ = m.observableGauge(f64, rt.cStrOrEmpty(name), .{
        .description = rt.cStrOrEmpty(o.description),
        .unit = rt.cStrOrEmpty(o.unit),
        .callbacks = &.{.{ .ptr = tr, .func = ObsF64Trampoline.call }},
    });
    return .ok;
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
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len, 0) catch return;
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
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len, 0) catch return;
    h.telemetry.event(unwrapCtx(ctx), rt.cStrOrEmpty(event_name), @as([]const o11y.LogAttribute, converted));
}

export fn o11y_record_create() ?*RecordHandle {
    const h = gpa.create(RecordHandle) catch return null;
    h.* = .{ .rec = o11y.Record.init(gpa, rt.globalIo()) };
    return h;
}

export fn o11y_record_destroy(rec: ?*RecordHandle) void {
    const h = rec orelse return;
    h.rec.deinit();
    gpa.destroy(h);
}

export fn o11y_record_set_attrs(rec: ?*RecordHandle, attrs: ?[*]const c.LogAttr, attrs_len: usize) void {
    const h = rec orelse return;
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const converted = convertLogAttrs(arena_state.allocator(), attrs, attrs_len, 0) catch return;
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
    h.rec.set("error.type", rt.cStrOpt(error_type) orelse "error");
    h.rec.set(o11y.spec.Outcome.key, o11y.spec.Outcome.failure.asStr());
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
    const extra = convertLogAttrs(arena_state.allocator(), extra_attrs, extra_attrs_len, 0) catch return;
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
        return std.mem.span(v_z);
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
    const h = cloneCtxHandle(parent) orelse return null;
    const sh = sdk orelse return h;
    const cp = carrier_ptr orelse return h;

    var scratch_state: std.heap.ArenaAllocator = .init(gpa);
    defer scratch_state.deinit();
    var adapter: CCarrierAdapter = .{ .carrier = cp.*, .arena = scratch_state.allocator() };
    const zcarrier: o11y.Carrier = .{ .ptr = &adapter, .vtable = &CCarrierAdapter.vtable };

    const extracted = sh.telemetry.propagator().extract(h.ctx, h.arena.allocator(), zcarrier);
    h.ctx = extracted;
    if (extracted.span_context.trace_state.header.len > 0) {
        if (rt.dupeZ(h.arena.allocator(), extracted.span_context.trace_state.header)) |z| {
            h.ctx.span_context.trace_state = .{ .header = z };
            h.trace_state_z = z.ptr;
        } else |_| {}
    } else {
        h.trace_state_z = null;
    }
    if (extracted.baggage) |b| {
        h.baggage = b.*;
        h.ctx.baggage = &h.baggage.?;
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
    const h = gpa.create(DetachedCarrierHandle) catch {
        var mut = carrier;
        mut.deinit(gpa);
        return .out_of_memory;
    };
    h.* = .{ .carrier = carrier };
    out.* = h;
    return .ok;
}

export fn o11y_detached_is_zero(carrier: ?*const DetachedCarrierHandle) bool {
    const h = carrier orelse return true;
    return h.carrier.isZero();
}

export fn o11y_detached_span_context(carrier: ?*const DetachedCarrierHandle) c.SpanContext {
    const h = carrier orelse return .{};
    const sc = h.carrier.spanContext();
    var ts_z: ?[*:0]const u8 = null;
    if (sc.trace_state.header.len > 0) {
        const mut: *DetachedCarrierHandle = @constCast(h);
        if (mut.trace_state_z) |prev| rt.freeZ(gpa, prev);
        if (rt.dupeZ(gpa, sc.trace_state.header)) |z| {
            mut.trace_state_z = z.ptr;
            ts_z = z.ptr;
        } else |_| {}
    }
    return fromZigSpanContext(sc, ts_z);
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
    const h = gpa.create(DetachedCarrierHandle) catch {
        var mut = parsed;
        mut.deinit(gpa);
        return .out_of_memory;
    };
    h.* = .{ .carrier = parsed };
    out.* = h;
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
    const start_opts = convertSpanStartOptions(arena_state.allocator(), options) catch o11y.StartOptions{};
    const zcarrier = if (carrier) |ch| ch.carrier else o11y.detached.Carrier.zero;

    const h = gpa.create(LinkedSpanHandle) catch return null;
    h.* = .{
        .linked = sh.telemetry.startLinked(gpa, unwrapCtx(ctx), zcarrier, rt.cStrOrEmpty(name), start_opts),
        .ctx_handle = .{ .arena = .init(gpa), .ctx = .background },
        .span_handle = .{ .span = .noop, .owns_self = false },
    };
    h.span_handle.span = h.linked.span;
    h.ctx_handle.ctx = h.linked.context();
    if (h.ctx_handle.ctx.span_context.trace_state.header.len > 0) {
        if (rt.dupeZ(h.ctx_handle.arena.allocator(), h.ctx_handle.ctx.span_context.trace_state.header)) |z| {
            h.ctx_handle.ctx.span_context.trace_state = .{ .header = z };
            h.ctx_handle.trace_state_z = z.ptr;
        } else |_| {}
    }
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
    const h = cloneCtxHandle(parent) orelse return null;
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
    const env: o11y.Env = .{ .pairs = pairs[0..n] };
    const extracted = o11y.proc.extractEnv(h.ctx, h.arena.allocator(), env);
    h.ctx = extracted;
    if (extracted.span_context.trace_state.header.len > 0) {
        if (rt.dupeZ(h.arena.allocator(), extracted.span_context.trace_state.header)) |z| {
            h.ctx.span_context.trace_state = .{ .header = z };
            h.trace_state_z = z.ptr;
        } else |_| {}
    } else {
        h.trace_state_z = null;
    }
    return h;
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

fn logValueToPiiValue(arena: Allocator, v: c.LogValue, depth: usize) Allocator.Error!o11y.pii.Value {
    if (depth > 32) return .{ .string = "" };
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
            const out = try arena.alloc(o11y.pii.Value, av.len);
            for (av.items.?[0..av.len], out) |item, *dst| {
                dst.* = try logValueToPiiValue(arena, item, depth + 1);
            }
            break :blk .{ .array = out };
        },
        .map => blk: {
            const mv = v.value.map_val;
            if (mv.len == 0 or mv.items == null) break :blk .{ .map = &.{} };
            const out = try arena.alloc(o11y.pii.Member, mv.len);
            for (mv.items.?[0..mv.len], out) |item, *dst| {
                dst.* = .{
                    .key = rt.cStrOrEmpty(item.key),
                    .value = try logValueToPiiValue(arena, item.value, depth + 1),
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
    const vp = value_ptr orelse return .invalid_argument;
    if (key == null or key_len < o11y.pii.min_key_len) return .pii_hash_key;
    if (out_canonical) |oc| oc.* = null;

    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const pv = logValueToPiiValue(arena_state.allocator(), vp.*, 0) catch return .out_of_memory;
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
