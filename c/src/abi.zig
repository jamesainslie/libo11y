//! Core C11 ABI exports implementing `c/include/o11y/o11y.h` over `o11y` (Zig).

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const c = @import("c_types.zig");
const rt = @import("runtime.zig");
const abi = @import("abi_common.zig");

/// Do not allocate a 256 KiB per-thread TLS signal stack or call `sigaltstack`
/// on library worker threads. A C/C++ library must leave host and sanitizer
/// alternate signal stacks untouched.
pub const std_options: std.Options = .{
    .signal_stack_size = null,
};

const gpa = rt.gpa;

const IoKind = abi.IoKind;
const SdkHandle = abi.SdkHandle;
const CtxHandle = abi.CtxHandle;
const SpanHandle = abi.SpanHandle;
const RecordHandle = abi.RecordHandle;
const DetachedCarrierHandle = abi.DetachedCarrierHandle;
const LinkedSpanHandle = abi.LinkedSpanHandle;
const AttrReplacementHandle = abi.AttrReplacementHandle;

const mapSetupError = abi.mapSetupError;
const mapBuildError = abi.mapBuildError;
const mapExportError = abi.mapExportError;
const writeDiagnostic = abi.writeDiagnostic;
const writeDiagnosticText = abi.writeDiagnosticText;
const toZigLevel = abi.toZigLevel;
const fromZigLevel = abi.fromZigLevel;
const toZigSpanKind = abi.toZigSpanKind;
const fromZigSpanKind = abi.fromZigSpanKind;
const toZigStatusCode = abi.toZigStatusCode;
const fromZigStatusCode = abi.fromZigStatusCode;
const toZigSpanContext = abi.toZigSpanContext;
const fromZigSpanContext = abi.fromZigSpanContext;
const checkedLevel = abi.checkedLevel;
const toZigConsoleFormat = abi.toZigConsoleFormat;
const checkedPiiMode = abi.checkedPiiMode;
const checkedSampler = abi.checkedSampler;
const checkedExemplarFilter = abi.checkedExemplarFilter;
const convertAttrs = abi.convertAttrs;
const WalkState = abi.WalkState;
const composite_walk_budget = abi.composite_walk_budget;
const convertLogValueBounded = abi.convertLogValueBounded;
const convertLogValueStrict = abi.convertLogValueStrict;
const convertLogAttrs = abi.convertLogAttrs;
const ConsoleWriterTrampoline = abi.ConsoleWriterTrampoline;
const AttrReplacerTrampoline = abi.AttrReplacerTrampoline;
const ErrorHandlerTrampoline = abi.ErrorHandlerTrampoline;
const OptionError = abi.OptionError;
const invalidOption = abi.invalidOption;
const buildPropagators = abi.buildPropagators;
const buildAppRegistries = abi.buildAppRegistries;
const buildHistogramBuckets = abi.buildHistogramBuckets;
const buildExtraEnvs = abi.buildExtraEnvs;
const buildExtraSinks = abi.buildExtraSinks;
const buildBuildInfo = abi.buildBuildInfo;
const ownContext = abi.ownContext;
const newCtxHandle = abi.newCtxHandle;
const unwrapCtx = abi.unwrapCtx;

export fn o11y_attr_replacement_set_key(dst: ?*AttrReplacementHandle, key: ?[*:0]const u8) c.Err {
    const h = dst orelse return .invalid_argument;
    const raw = key orelse {
        h.key_failed = true;
        return .invalid_argument;
    };
    const duped = h.arena.dupe(u8, std.mem.span(raw)) catch {
        h.key_failed = true;
        return .out_of_memory;
    };
    h.key = duped;
    h.has_key = true;
    return .ok;
}

export fn o11y_attr_replacement_set_value(dst: ?*AttrReplacementHandle, value: ?*const c.LogValue) c.Err {
    const h = dst orelse return .invalid_argument;
    const vp = value orelse {
        h.val_failed = true;
        return .invalid_argument;
    };
    var walk: WalkState = .{ .remaining = composite_walk_budget };
    const converted = convertLogValueStrict(h.arena, vp.*, 0, &walk) catch |err| {
        h.val_failed = true;
        return switch (err) {
            error.OutOfMemory => .out_of_memory,
            error.InvalidArgument => .invalid_argument,
        };
    };
    h.value = converted;
    h.has_value = true;
    return .ok;
}

// =========================================================================
// Internal companion-archive bridges (reserved for libo11ytest.a)
// =========================================================================

export fn o11y__abi_fingerprint() u64 {
    return abi.abiFingerprint();
}

export fn o11y__runtime_acquire_net_signals() void {
    rt.acquireNetSignals();
}

export fn o11y__runtime_release_net_signals() void {
    rt.releaseNetSignals();
}

export fn o11y__detach_observables(provider: ?*const anyopaque) ?*anyopaque {
    return detachObservableCallbacks(provider);
}

export fn o11y__free_observables(list: ?*anyopaque) void {
    const head: ?*ObsTrampoline = if (list) |p| @ptrCast(@alignCast(p)) else null;
    freeObservableCallbacks(head);
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

    const io_kind: IoKind = if (opts.env_mode == .hermetic) .hermetic else .networked;
    const io = if (io_kind == .hermetic) rt.acquireHermeticIo() else rt.acquireIo();
    errdefer switch (io_kind) {
        .hermetic => rt.releaseHermeticIo(),
        .networked => rt.releaseIo(),
        .none => {},
    };
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
        .io_kind = io_kind,
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
    const io_kind = h.io_kind;
    h.arena.deinit();
    gpa.destroy(h);
    switch (io_kind) {
        .hermetic => rt.releaseHermeticIo(),
        .networked => rt.releaseIo(),
        .none => {},
    }
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
            if (rt.isRuntimeReservedSignal(sig)) return .invalid_argument;
            var old_act: std.c.Sigaction = undefined;
            if (std.c.sigaction(sig, null, &old_act) != 0) return .invalid_argument;
            dst.* = sig;
        }
        sigs = sig_buf[0..opts.signals_len];
    }

    const report = o11y.shutdownOnSignals(h.telemetry.io, h.telemetry, .{
        .timeout = if (opts.timeout_ms == 0) .fromSeconds(5) else .fromMilliseconds(@intCast(@min(opts.timeout_ms, std.math.maxInt(i64)))),
        .before_shutdown = before,
        .signals = sigs,
    });
    return fillReport(report, out_report);
}

// =========================================================================
// Context
// =========================================================================

/// The handle's trace state as a C string, or null when it is empty.
/// `ownContext` wrote the NUL after it.
fn ctxTraceStateZ(h: *const CtxHandle) ?[*:0]const u8 {
    const header = h.ctx.span_context.trace_state.header;
    if (header.len == 0) return null;
    return @ptrCast(header.ptr);
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
        gpa.destroy(tr);
        return if (provider.is_shutdown.load(.acquire)) .shutdown else .out_of_memory;
    }
    obs_lock.lock();
    tr.next = obs_head;
    obs_head = tr;
    obs_lock.unlock();
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
    const h = gpa.create(RecordHandle) catch return null;
    h.* = .{ .rec = o11y.Record.init(gpa, rt.syncIo()) };
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
    if (text_len > 0 and text == null) return .invalid_argument;
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
    if (raw_len > 0 and raw == null) return .invalid_argument;
    const slice: []const u8 = if (raw) |p| p[0..raw_len] else "";
    const sanitized = o11y.endpoint.sanitize(gpa, slice) catch return .out_of_memory;
    defer gpa.free(sanitized);
    dst.* = rt.allocCString(sanitized) orelse return .out_of_memory;
    return .ok;
}

fn piiKeyLessThan(keys: []const []const u8, a: usize, b: usize) bool {
    return switch (std.mem.order(u8, keys[a], keys[b])) {
        .lt => true,
        .gt => false,
        .eq => a < b,
    };
}

fn logValueToPiiValue(arena: Allocator, v: c.LogValue, depth: usize, walk: *WalkState) (Allocator.Error || error{InvalidArgument})!o11y.pii.Value {
    if (depth > o11y.pii.max_depth or walk.remaining == 0) return .{ .string = o11y.pii.truncated };
    walk.remaining -= 1;
    return switch (v.kind) {
        .empty => .{ .string = "" },
        .string => blk: {
            const sv = v.value.str_val;
            if (sv.has_len and sv.len > 0 and sv.data == null) return error.InvalidArgument;
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
            if (bv.len > 0 and bv.data == null) return error.InvalidArgument;
            break :blk .{ .bytes = if (bv.len > 0) bv.data.?[0..bv.len] else &.{} };
        },
        .array => blk: {
            const av = v.value.array_val;
            if (av.len > 0 and av.items == null) return error.InvalidArgument;
            if (av.len == 0) break :blk .{ .array = &.{} };
            if (!walk.enter(@intFromPtr(av.items.?))) break :blk .{ .string = o11y.pii.truncated };
            defer walk.leave();
            const out = try arena.alloc(o11y.pii.Value, av.len);
            for (av.items.?[0..av.len], out) |item, *dst| {
                dst.* = if (depth + 1 > o11y.pii.max_depth or walk.remaining == 0)
                    .{ .string = o11y.pii.truncated }
                else
                    try logValueToPiiValue(arena, item, depth + 1, walk);
            }
            break :blk .{ .array = out };
        },
        .map => blk: {
            const mv = v.value.map_val;
            if (mv.len > 0 and mv.items == null) return error.InvalidArgument;
            if (mv.len == 0) break :blk .{ .map = &.{} };
            if (!walk.enter(@intFromPtr(mv.items.?))) break :blk .{ .string = o11y.pii.truncated };
            defer walk.leave();
            const items = mv.items.?[0..mv.len];
            const keys = try arena.alloc([]const u8, mv.len);
            const order = try arena.alloc(usize, mv.len);
            for (items, keys, order, 0..) |item, *k, *o, i| {
                k.* = rt.cStrOrEmpty(item.key);
                o.* = i;
            }
            std.mem.sort(usize, order, keys, piiKeyLessThan);

            const out = try arena.alloc(o11y.pii.Member, mv.len);
            for (order, out) |idx, *dst| {
                dst.* = .{
                    .key = keys[idx],
                    .value = if (depth + 1 > o11y.pii.max_depth or walk.remaining == 0)
                        .{ .string = o11y.pii.truncated }
                    else
                        try logValueToPiiValue(arena, items[idx].value, depth + 1, walk),
                };
            }
            break :blk .{ .map = out };
        },
        _ => return error.InvalidArgument,
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
    var walk: WalkState = .{ .remaining = o11y.pii.walk_budget };
    const pv = logValueToPiiValue(arena_state.allocator(), vp.*, 0, &walk) catch |err| return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.InvalidArgument => .invalid_argument,
    };
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
