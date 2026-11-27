//! Test harness C11 ABI exports implementing `c/include/o11y/test.h` over
//! `o11ytest` (Zig): hermetic Recorder, span/log/metric/exemplar queries,
//! conformance/correlation/triangle checks, and loopback OTLP HTTP/gRPC
//! receivers.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const o11ytest = @import("o11ytest");
const c = @import("c_types.zig");
const rt = @import("runtime.zig");
const abi = @import("abi.zig");

const gpa = rt.gpa;

// =========================================================================
// Internal Handle Wrappers
// =========================================================================

const RecorderHandle = struct {
    rec: *o11ytest.Recorder,
    sdk_view: abi.SdkHandle,
    opt_arena: std.heap.ArenaAllocator,
    /// Scratch arena for returning NUL-terminated C strings valid until reset/destroy.
    str_arena: std.heap.ArenaAllocator,
};

const SpanView = struct {
    data: *const o11y.SpanData,
    owner: *RecorderHandle,
};

const LogView = struct {
    rec: *const o11ytest.LogRecord,
    owner: *RecorderHandle,
};

const ReportHandle = struct {
    report: o11ytest.ConformanceReport,
    problems_z: [][*:0]const u8,
};

const HttpReceiverHandle = struct {
    rx: *o11ytest.HttpReceiver,
    url_z: [*:0]u8,
};

const GrpcReceiverHandle = struct {
    rx: *o11ytest.GrpcReceiver,
    endpoint_z: [*:0]u8,
};

fn dupeRecorderZ(rec: *RecorderHandle, s: []const u8) [*:0]const u8 {
    const z = rt.dupeZ(rec.str_arena.allocator(), s) catch return "";
    return z.ptr;
}

// =========================================================================
// Hermetic Recorder Lifecycle
// =========================================================================

export fn o11y_test_options_default() c.TestOptions {
    return .{};
}

export fn o11y_test_start(
    opts_ptr: ?*const c.TestOptions,
    out_rec: ?*?*RecorderHandle,
    diag_out: ?*c.Diagnostic,
) c.Err {
    const out = out_rec orelse {
        abi.writeDiagnosticText(diag_out, "o11ytest: out_rec pointer must not be null");
        return .invalid_argument;
    };
    out.* = null;

    const opts = if (opts_ptr) |p| p.* else c.TestOptions{};
    var opt_arena: std.heap.ArenaAllocator = .init(gpa);
    errdefer opt_arena.deinit();
    const arena = opt_arena.allocator();

    const attr_replacer: ?o11y.AttrReplacer = if (opts.attr_replacer_fn) |f| blk: {
        const tr = arena.create(abi.AttrReplacerTrampoline) catch return .out_of_memory;
        tr.* = .{ .func = f, .userdata = opts.attr_replacer_userdata };
        break :blk .{ .ptr = tr, .replace = abi.AttrReplacerTrampoline.replace };
    } else null;

    const baggage_fn = abi.installBaggageAllow(opts.baggage_egress_allow);

    const extra_envs = abi.buildExtraEnvs(arena, opts.extra_environments, opts.extra_environments_len) catch return .out_of_memory;
    const res_attrs = abi.convertAttrs(arena, opts.resource_attributes, opts.resource_attributes_len) catch return .out_of_memory;
    const extra_sinks = abi.buildExtraSinks(arena, opts.extra_log_sinks, opts.extra_log_sinks_len) catch return .out_of_memory;
    const app_regs = abi.buildAppRegistries(arena, opts.app_registries, opts.app_registries_len) catch return .out_of_memory;
    const hist_buckets = abi.buildHistogramBuckets(arena, opts.histogram_buckets, opts.histogram_buckets_len) catch return .out_of_memory;
    const build_info = abi.buildBuildInfo(arena, opts.build_info) catch return .out_of_memory;
    const pii_key: []const u8 = if (opts.pii_hash_key_len > 0 and opts.pii_hash_key != null)
        (arena.dupe(u8, opts.pii_hash_key.?[0..opts.pii_hash_key_len]) catch return .out_of_memory)
    else
        "";

    var zig_diag: o11y.Diagnostic = .{};
    const rec = o11ytest.start(gpa, rt.globalIo(), .{
        .service_name = rt.cStrOpt(opts.service_name),
        .service_version = rt.cStrOpt(opts.service_version),
        .service_namespace = rt.cStrOpt(opts.service_namespace),
        .environment = rt.cStrOpt(opts.environment),
        .extra_environments = extra_envs,
        .strict_identity = opts.strict_identity,
        .resource_attributes = res_attrs,
        .build_info = build_info,
        .build_info_enabled = opts.build_info.enabled,
        .log_level = abi.toZigLevel(opts.log_level),
        .console_enabled = opts.console_enabled,
        .console_format = switch (opts.console_format) {
            .json => .json,
            .text => .text,
            _ => .json,
        },
        .log_export = opts.log_export,
        .attr_replacer = attr_replacer,
        .extra_log_sinks = extra_sinks,
        .pii_mode = abi.toZigPiiMode(opts.pii_mode),
        .pii_hash_key = pii_key,
        .app_registries = app_regs,
        .sampler = abi.toZigSampler(opts.sampler_kind, opts.sampler_ratio) orelse .always_on,
        .baggage_egress_allow = baggage_fn,
        .histogram_buckets = hist_buckets,
        .exemplar_filter = abi.toZigExemplarFilter(opts.exemplar_filter) orelse .trace_based,
        .runtime_metrics = opts.runtime_metrics,
        .diagnostic = &zig_diag,
        .sdk_language = "c",
        .sdk_version = rt.c_version,
        .emit_process_runtime = false,
    }) catch |err| {
        abi.writeDiagnostic(diag_out, &zig_diag);
        return abi.mapSetupError(err);
    };
    errdefer rec.deinit();

    const eff_z = rt.dupeZ(arena, rec.telemetry().effectiveConfig()) catch return .out_of_memory;
    const h = gpa.create(RecorderHandle) catch return .out_of_memory;
    h.* = .{
        .rec = rec,
        .sdk_view = .{
            .telemetry = rec.telemetry(),
            .owns_telemetry = false,
            .arena = .init(gpa),
            .effective_config_z = eff_z.ptr,
        },
        .opt_arena = opt_arena,
        .str_arena = .init(gpa),
    };
    out.* = h;
    return .ok;
}

export fn o11y_test_destroy(rec: ?*RecorderHandle) void {
    const h = rec orelse return;
    h.rec.deinit();
    h.sdk_view.arena.deinit();
    h.str_arena.deinit();
    h.opt_arena.deinit();
    gpa.destroy(h);
}

export fn o11y_test_sdk(rec: ?*RecorderHandle) ?*abi.SdkHandle {
    const h = rec orelse return null;
    return &h.sdk_view;
}

export fn o11y_test_reset(rec: ?*RecorderHandle) void {
    const h = rec orelse return;
    h.rec.reset();
    _ = h.str_arena.reset(.retain_capacity);
}

// =========================================================================
// Span Inspection
// =========================================================================

fn wrapSpan(owner: *RecorderHandle, data: *const o11y.SpanData) ?*const SpanView {
    const v = owner.str_arena.allocator().create(SpanView) catch return null;
    v.* = .{ .data = data, .owner = owner };
    return v;
}

export fn o11y_test_span_count(rec: ?*RecorderHandle) usize {
    const h = rec orelse return 0;
    return h.rec.spans().len;
}

export fn o11y_test_span_at(rec: ?*RecorderHandle, index: usize) ?*const SpanView {
    const h = rec orelse return null;
    const list = h.rec.spans();
    if (index >= list.len) return null;
    return wrapSpan(h, list[index]);
}

export fn o11y_test_find_span(rec: ?*RecorderHandle, name: ?[*:0]const u8) ?*const SpanView {
    const h = rec orelse return null;
    const sp = h.rec.span(rt.cStrOrEmpty(name)) orelse return null;
    return wrapSpan(h, sp);
}

export fn o11y_test_span_name(span: ?*const SpanView) [*:0]const u8 {
    const v = span orelse return "";
    return dupeRecorderZ(v.owner, v.data.name);
}

export fn o11y_test_span_kind(span: ?*const SpanView) c.SpanKind {
    const v = span orelse return .internal;
    return abi.fromZigSpanKind(v.data.kind);
}

export fn o11y_test_span_status_code(span: ?*const SpanView) c.StatusCode {
    const v = span orelse return .unset;
    return abi.fromZigStatusCode(v.data.status.code);
}

export fn o11y_test_span_status_description(span: ?*const SpanView) [*:0]const u8 {
    const v = span orelse return "";
    return dupeRecorderZ(v.owner, v.data.status.description);
}

export fn o11y_test_span_context(span: ?*const SpanView) c.SpanContext {
    const v = span orelse return .{};
    const ts_z: ?[*:0]const u8 = if (v.data.span_context.trace_state.header.len > 0)
        dupeRecorderZ(v.owner, v.data.span_context.trace_state.header)
    else
        null;
    return abi.fromZigSpanContext(v.data.span_context, ts_z);
}

export fn o11y_test_span_parent_context(span: ?*const SpanView) c.SpanContext {
    const v = span orelse return .{};
    return abi.fromZigSpanContext(v.data.parent, null);
}

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

export fn o11y_test_span_has_attr(span: ?*const SpanView, key: ?[*:0]const u8) bool {
    const v = span orelse return false;
    return findAttr(v.data.attributes.items, rt.cStrOrEmpty(key)) != null;
}

export fn o11y_test_span_attr_str(span: ?*const SpanView, key: ?[*:0]const u8) ?[*:0]const u8 {
    const v = span orelse return null;
    const val = findAttr(v.data.attributes.items, rt.cStrOrEmpty(key)) orelse return null;
    return switch (val) {
        .string => |s| dupeRecorderZ(v.owner, s),
        else => null,
    };
}

export fn o11y_test_span_attr_int(span: ?*const SpanView, key: ?[*:0]const u8, out: ?*i64) bool {
    const v = span orelse return false;
    const dst = out orelse return false;
    const val = findAttr(v.data.attributes.items, rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .int => |n| {
            dst.* = n;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_span_attr_double(span: ?*const SpanView, key: ?[*:0]const u8, out: ?*f64) bool {
    const v = span orelse return false;
    const dst = out orelse return false;
    const val = findAttr(v.data.attributes.items, rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .double => |d| {
            dst.* = d;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_span_attr_bool(span: ?*const SpanView, key: ?[*:0]const u8, out: ?*bool) bool {
    const v = span orelse return false;
    const dst = out orelse return false;
    const val = findAttr(v.data.attributes.items, rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .bool => |b| {
            dst.* = b;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_span_event_count(span: ?*const SpanView) usize {
    const v = span orelse return 0;
    return v.data.events.items.len;
}

export fn o11y_test_span_event_name(span: ?*const SpanView, index: usize) ?[*:0]const u8 {
    const v = span orelse return null;
    if (index >= v.data.events.items.len) return null;
    return dupeRecorderZ(v.owner, v.data.events.items[index].name);
}

export fn o11y_test_span_event_has_attr(span: ?*const SpanView, event_index: usize, key: ?[*:0]const u8) bool {
    const v = span orelse return false;
    if (event_index >= v.data.events.items.len) return false;
    return findAttr(v.data.events.items[event_index].attributes, rt.cStrOrEmpty(key)) != null;
}

export fn o11y_test_span_event_attr_str(span: ?*const SpanView, event_index: usize, key: ?[*:0]const u8) ?[*:0]const u8 {
    const v = span orelse return null;
    if (event_index >= v.data.events.items.len) return null;
    const val = findAttr(v.data.events.items[event_index].attributes, rt.cStrOrEmpty(key)) orelse return null;
    return switch (val) {
        .string => |s| dupeRecorderZ(v.owner, s),
        else => null,
    };
}

export fn o11y_test_span_link_count(span: ?*const SpanView) usize {
    const v = span orelse return 0;
    return v.data.links.items.len;
}

export fn o11y_test_span_link_context(span: ?*const SpanView, index: usize) c.SpanContext {
    const v = span orelse return .{};
    if (index >= v.data.links.items.len) return .{};
    const sc = v.data.links.items[index].span_context;
    const ts_z: ?[*:0]const u8 = if (sc.trace_state.header.len > 0) dupeRecorderZ(v.owner, sc.trace_state.header) else null;
    return abi.fromZigSpanContext(sc, ts_z);
}

export fn o11y_test_span_link_has_attr(span: ?*const SpanView, link_index: usize, key: ?[*:0]const u8) bool {
    const v = span orelse return false;
    if (link_index >= v.data.links.items.len) return false;
    return findAttr(v.data.links.items[link_index].attributes, rt.cStrOrEmpty(key)) != null;
}

export fn o11y_test_span_resource_schema_url(span: ?*const SpanView) [*:0]const u8 {
    const v = span orelse return "";
    return dupeRecorderZ(v.owner, v.data.resource().schema_url);
}

export fn o11y_test_span_resource_attr_str(span: ?*const SpanView, key: ?[*:0]const u8) ?[*:0]const u8 {
    const v = span orelse return null;
    const val = findAttr(v.data.resource().attributes, rt.cStrOrEmpty(key)) orelse return null;
    return switch (val) {
        .string => |s| dupeRecorderZ(v.owner, s),
        else => null,
    };
}

// =========================================================================
// Log Inspection
// =========================================================================

fn wrapLog(owner: *RecorderHandle, lr: *const o11ytest.LogRecord) ?*const LogView {
    const v = owner.str_arena.allocator().create(LogView) catch return null;
    v.* = .{ .rec = lr, .owner = owner };
    return v;
}

export fn o11y_test_log_count(rec: ?*RecorderHandle) usize {
    const h = rec orelse return 0;
    return h.rec.logs().len;
}

export fn o11y_test_log_at(rec: ?*RecorderHandle, index: usize) ?*const LogView {
    const h = rec orelse return null;
    const list = h.rec.logs();
    if (index >= list.len) return null;
    return wrapLog(h, &list[index]);
}

export fn o11y_test_find_log(rec: ?*RecorderHandle, message: ?[*:0]const u8) ?*const LogView {
    const h = rec orelse return null;
    const lr = h.rec.log(rt.cStrOrEmpty(message)) orelse return null;
    return wrapLog(h, lr);
}

export fn o11y_test_find_event(rec: ?*RecorderHandle, event_name: ?[*:0]const u8) ?*const LogView {
    const h = rec orelse return null;
    const lr = h.rec.expectEvent(rt.cStrOrEmpty(event_name)) catch return null;
    return wrapLog(h, lr);
}

export fn o11y_test_log_message(log: ?*const LogView) [*:0]const u8 {
    const v = log orelse return "";
    return dupeRecorderZ(v.owner, v.rec.message);
}

export fn o11y_test_log_level(log: ?*const LogView) c.Level {
    const v = log orelse return .info;
    return abi.fromZigLevel(v.rec.level);
}

export fn o11y_test_log_span_context(log: ?*const LogView) c.SpanContext {
    const v = log orelse return .{};
    return abi.fromZigSpanContext(v.rec.span_context, null);
}

export fn o11y_test_log_has_attr(log: ?*const LogView, key: ?[*:0]const u8) bool {
    const v = log orelse return false;
    return v.rec.attr(rt.cStrOrEmpty(key)) != null;
}

export fn o11y_test_log_attr_str(log: ?*const LogView, key: ?[*:0]const u8) ?[*:0]const u8 {
    const v = log orelse return null;
    const s = v.rec.attrString(rt.cStrOrEmpty(key)) orelse return null;
    return dupeRecorderZ(v.owner, s);
}

export fn o11y_test_log_attr_int(log: ?*const LogView, key: ?[*:0]const u8, out: ?*i64) bool {
    const v = log orelse return false;
    const dst = out orelse return false;
    const val = v.rec.attr(rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .int => |n| {
            dst.* = n;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_log_attr_double(log: ?*const LogView, key: ?[*:0]const u8, out: ?*f64) bool {
    const v = log orelse return false;
    const dst = out orelse return false;
    const val = v.rec.attr(rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .double => |d| {
            dst.* = d;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_log_attr_bool(log: ?*const LogView, key: ?[*:0]const u8, out: ?*bool) bool {
    const v = log orelse return false;
    const dst = out orelse return false;
    const val = v.rec.attr(rt.cStrOrEmpty(key)) orelse return false;
    switch (val) {
        .bool => |b| {
            dst.* = b;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_console_output(rec: ?*RecorderHandle, out_len: ?*usize) [*:0]const u8 {
    const h = rec orelse {
        if (out_len) |l| l.* = 0;
        return "";
    };
    const raw = h.rec.consoleOutput();
    if (out_len) |l| l.* = raw.len;
    return dupeRecorderZ(h, raw);
}

export fn o11y_test_otlp_log_count(rec: ?*RecorderHandle) usize {
    const h = rec orelse return 0;
    return h.rec.otlpLogs().len;
}

// =========================================================================
// Metrics & Exemplars Inspection
// =========================================================================

export fn o11y_test_has_metric(rec: ?*RecorderHandle, name: ?[*:0]const u8) bool {
    const h = rec orelse return false;
    const m = h.rec.metric(rt.cStrOrEmpty(name)) catch return false;
    return m != null;
}

export fn o11y_test_metric_sum_i64(rec: ?*RecorderHandle, name: ?[*:0]const u8, out: ?*i64) bool {
    const h = rec orelse return false;
    const dst = out orelse return false;
    const m = (h.rec.metric(rt.cStrOrEmpty(name)) catch return false) orelse return false;
    var total: i64 = 0;
    switch (m.data) {
        .sum => |s| for (s.data_points) |dp| switch (dp.value) {
            .int => |n| total +|= n,
            .double => |d| total +|= @intFromFloat(d),
        },
        .gauge => |g| for (g.data_points) |dp| switch (dp.value) {
            .int => |n| total +|= n,
            .double => |d| total +|= @intFromFloat(d),
        },
        .histogram => return false,
    }
    dst.* = total;
    return true;
}

export fn o11y_test_metric_sum_f64(rec: ?*RecorderHandle, name: ?[*:0]const u8, out: ?*f64) bool {
    const h = rec orelse return false;
    const dst = out orelse return false;
    const m = (h.rec.metric(rt.cStrOrEmpty(name)) catch return false) orelse return false;
    var total: f64 = 0;
    switch (m.data) {
        .sum => |s| for (s.data_points) |dp| {
            total += dp.value.toDouble();
        },
        .gauge => |g| for (g.data_points) |dp| {
            total += dp.value.toDouble();
        },
        .histogram => return false,
    }
    dst.* = total;
    return true;
}

export fn o11y_test_metric_histogram_count(rec: ?*RecorderHandle, name: ?[*:0]const u8, out: ?*u64) bool {
    const h = rec orelse return false;
    const dst = out orelse return false;
    const m = (h.rec.metric(rt.cStrOrEmpty(name)) catch return false) orelse return false;
    switch (m.data) {
        .histogram => |hist| {
            var total: u64 = 0;
            for (hist.data_points) |dp| total += dp.count;
            dst.* = total;
            return true;
        },
        else => return false,
    }
}

export fn o11y_test_metric_has_attr(rec: ?*RecorderHandle, name: ?[*:0]const u8, attr_key: ?[*:0]const u8) bool {
    const h = rec orelse return false;
    const m = (h.rec.metric(rt.cStrOrEmpty(name)) catch return false) orelse return false;
    const key = rt.cStrOrEmpty(attr_key);
    switch (m.data) {
        .sum => |s| for (s.data_points) |dp| {
            if (findAttr(dp.attributes, key) != null) return true;
        },
        .gauge => |g| for (g.data_points) |dp| {
            if (findAttr(dp.attributes, key) != null) return true;
        },
        .histogram => |hist| for (hist.data_points) |dp| {
            if (findAttr(dp.attributes, key) != null) return true;
        },
    }
    return false;
}

export fn o11y_test_exemplar_count(rec: ?*RecorderHandle, metric_name: ?[*:0]const u8) usize {
    const h = rec orelse return 0;
    const list = h.rec.exemplars(rt.cStrOrEmpty(metric_name)) catch return 0;
    return list.len;
}

export fn o11y_test_exemplar_at(
    rec: ?*RecorderHandle,
    metric_name: ?[*:0]const u8,
    index: usize,
    out: ?*c.TestExemplar,
) bool {
    const h = rec orelse return false;
    const dst = out orelse return false;
    const list = h.rec.exemplars(rt.cStrOrEmpty(metric_name)) catch return false;
    if (index >= list.len) return false;
    const ex = list[index];
    dst.* = .{
        .trace_id = .{ .bytes = ex.trace_id.bytes },
        .span_id = .{ .bytes = ex.span_id.bytes },
        .value = ex.value,
        .time_unix_nano = ex.time_unix_nano,
    };
    return true;
}

// =========================================================================
// Violations & Conformance Reports
// =========================================================================

export fn o11y_test_violations(rec: ?*RecorderHandle, signal: ?[*:0]const u8, rule: ?[*:0]const u8) i64 {
    const h = rec orelse return 0;
    const sig: ?o11y.spec.Signal = if (rt.cStrOpt(signal)) |s| o11y.spec.Signal.parse(s) else null;
    return h.rec.violations(sig, rt.cStrOpt(rule)) catch 0;
}

fn wrapReport(report: o11ytest.ConformanceReport) ?*ReportHandle {
    var mut = report;
    const a = mut.arena.allocator();
    const zs = a.alloc([*:0]const u8, mut.problems.len) catch {
        mut.deinit();
        return null;
    };
    for (mut.problems, zs) |p, *dst| {
        dst.* = (rt.dupeZ(a, p) catch {
            mut.deinit();
            return null;
        }).ptr;
    }
    const h = gpa.create(ReportHandle) catch {
        mut.deinit();
        return null;
    };
    h.* = .{ .report = mut, .problems_z = zs };
    return h;
}

export fn o11y_test_check_conforms(rec: ?*RecorderHandle) ?*ReportHandle {
    const h = rec orelse return null;
    const report = h.rec.checkConforms(gpa) catch return null;
    return wrapReport(report);
}

export fn o11y_test_check_correlated(rec: ?*RecorderHandle) ?*ReportHandle {
    const h = rec orelse return null;
    const report = h.rec.checkCorrelated(gpa) catch return null;
    return wrapReport(report);
}

export fn o11y_test_check_triangle(rec: ?*RecorderHandle, metric_name: ?[*:0]const u8) ?*ReportHandle {
    const h = rec orelse return null;
    const report = h.rec.checkTriangle(gpa, rt.cStrOrEmpty(metric_name)) catch return null;
    return wrapReport(report);
}

export fn o11y_test_report_ok(report: ?*const ReportHandle) bool {
    const h = report orelse return false;
    return h.report.ok();
}

export fn o11y_test_report_count(report: ?*const ReportHandle) usize {
    const h = report orelse return 0;
    return h.problems_z.len;
}

export fn o11y_test_report_problem(report: ?*const ReportHandle, index: usize) ?[*:0]const u8 {
    const h = report orelse return null;
    if (index >= h.problems_z.len) return null;
    return h.problems_z[index];
}

export fn o11y_test_report_destroy(report: ?*ReportHandle) void {
    const h = report orelse return;
    h.report.deinit();
    gpa.destroy(h);
}

// =========================================================================
// In-Process OTLP/HTTP Receiver
// =========================================================================

export fn o11y_test_http_receiver_start(
    opts_ptr: ?*const c.TestHttpReceiverOptions,
    out_rx: ?*?*HttpReceiverHandle,
) c.Err {
    const out = out_rx orelse return .invalid_argument;
    out.* = null;
    const opts = if (opts_ptr) |p| p.* else c.TestHttpReceiverOptions{};

    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const replies: []o11ytest.HttpReply = if (opts.replies_len > 0 and opts.replies != null) blk: {
        const arr = arena.alloc(o11ytest.HttpReply, opts.replies_len) catch return .out_of_memory;
        for (opts.replies.?[0..opts.replies_len], arr) |src, *dst| {
            dst.* = .{
                .status = if (src.status == 0) 200 else src.status,
                .retry_after = rt.cStrOpt(src.retry_after),
                .body = if (src.body_len > 0 and src.body != null) src.body.?[0..src.body_len] else "",
                .content_type = rt.cStrOpt(src.content_type) orelse "application/x-protobuf",
                .delay = .fromMilliseconds(@intCast(@min(src.delay_ms, std.math.maxInt(i64)))),
                .hang = src.hang,
                .close_after = src.close_after,
            };
        }
        break :blk arr;
    } else &.{};

    const tls_opts: ?o11ytest.HttpTlsOptions = if (opts.tls.enabled) .{
        .cert_pem = rt.cStrOpt(opts.tls.cert_pem) orelse o11ytest.certs.server,
        .key_pem = rt.cStrOpt(opts.tls.key_pem) orelse o11ytest.certs.server_key,
        .client_ca_pem = rt.cStrOpt(opts.tls.client_ca_pem),
    } else null;

    const rx = o11ytest.HttpReceiver.start(gpa, rt.globalIo(), .{
        .replies = replies,
        .tls = tls_opts,
    }) catch return .io;
    errdefer rx.deinit();

    const base_url = rx.baseUrl(gpa) catch return .out_of_memory;
    defer gpa.free(base_url);
    const url_z = rt.dupeZ(gpa, base_url) catch return .out_of_memory;
    errdefer gpa.free(url_z[0 .. url_z.len + 1]);

    const h = gpa.create(HttpReceiverHandle) catch return .out_of_memory;
    h.* = .{ .rx = rx, .url_z = url_z.ptr };
    out.* = h;
    return .ok;
}

export fn o11y_test_http_receiver_destroy(rx: ?*HttpReceiverHandle) void {
    const h = rx orelse return;
    h.rx.deinit();
    rt.freeZ(gpa, h.url_z);
    gpa.destroy(h);
}

export fn o11y_test_http_receiver_url(rx: ?*const HttpReceiverHandle) [*:0]const u8 {
    const h = rx orelse return "";
    return h.url_z;
}

export fn o11y_test_http_receiver_request_count(rx: ?*HttpReceiverHandle) usize {
    const h = rx orelse return 0;
    return h.rx.requestCount();
}

fn countProtoSpans(res_spans: []const o11ytest.proto.trace_v1.ResourceSpans) usize {
    var total: usize = 0;
    for (res_spans) |rs| {
        for (rs.scope_spans.items) |ss| total += ss.spans.items.len;
    }
    return total;
}

fn countProtoMetrics(res_metrics: []const o11ytest.proto.metrics_v1.ResourceMetrics) usize {
    var total: usize = 0;
    for (res_metrics) |rm| {
        for (rm.scope_metrics.items) |sm| total += sm.metrics.items.len;
    }
    return total;
}

fn countProtoLogs(res_logs: []const o11ytest.proto.logs_v1.ResourceLogs) usize {
    var total: usize = 0;
    for (res_logs) |rl| {
        for (rl.scope_logs.items) |sl| total += sl.log_records.items.len;
    }
    return total;
}

export fn o11y_test_http_receiver_span_count(rx: ?*HttpReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoSpans(h.rx.traces());
}

export fn o11y_test_http_receiver_metric_count(rx: ?*HttpReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoMetrics(h.rx.metrics());
}

export fn o11y_test_http_receiver_log_count(rx: ?*HttpReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoLogs(h.rx.logs());
}

export fn o11y_test_http_receiver_decode_errors(rx: ?*HttpReceiverHandle) usize {
    const h = rx orelse return 0;
    return h.rx.decodeErrors();
}

export fn o11y_test_http_receiver_wait_requests(rx: ?*HttpReceiverHandle, min_count: usize, timeout_ms: u64) bool {
    const h = rx orelse return false;
    const dur: Io.Duration = .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    h.rx.waitForRequests(min_count, dur) catch return false;
    return true;
}

// =========================================================================
// In-Process OTLP/gRPC Receiver
// =========================================================================

export fn o11y_test_grpc_receiver_start(
    opts_ptr: ?*const c.TestGrpcReceiverOptions,
    out_rx: ?*?*GrpcReceiverHandle,
) c.Err {
    const out = out_rx orelse return .invalid_argument;
    out.* = null;
    const opts = if (opts_ptr) |p| p.* else c.TestGrpcReceiverOptions{};

    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const replies: []o11ytest.GrpcReply = if (opts.replies_len > 0 and opts.replies != null) blk: {
        const arr = arena.alloc(o11ytest.GrpcReply, opts.replies_len) catch return .out_of_memory;
        for (opts.replies.?[0..opts.replies_len], arr) |src, *dst| {
            dst.* = .{
                .http_status = if (src.http_status == 0) 200 else src.http_status,
                .grpc_status = src.grpc_status,
                .grpc_message = rt.cStrOpt(src.grpc_message),
                .delay = .fromMilliseconds(@intCast(@min(src.delay_ms, std.math.maxInt(i64)))),
                .hang = src.hang,
            };
        }
        break :blk arr;
    } else &.{};

    const tls_opts: ?o11ytest.GrpcTlsOptions = if (opts.tls.enabled) .{
        .cert_pem = rt.cStrOpt(opts.tls.cert_pem) orelse o11ytest.certs.server,
        .key_pem = rt.cStrOpt(opts.tls.key_pem) orelse o11ytest.certs.server_key,
        .client_ca_pem = rt.cStrOpt(opts.tls.client_ca_pem),
    } else null;

    const rx = o11ytest.GrpcReceiver.start(gpa, rt.globalIo(), .{
        .replies = replies,
        .tls = tls_opts,
    }) catch return .io;
    errdefer rx.deinit();

    const ep = rx.url(gpa) catch return .out_of_memory;
    defer gpa.free(ep);
    const ep_z = rt.dupeZ(gpa, ep) catch return .out_of_memory;
    errdefer gpa.free(ep_z[0 .. ep_z.len + 1]);

    const h = gpa.create(GrpcReceiverHandle) catch return .out_of_memory;
    h.* = .{ .rx = rx, .endpoint_z = ep_z.ptr };
    out.* = h;
    return .ok;
}

export fn o11y_test_grpc_receiver_destroy(rx: ?*GrpcReceiverHandle) void {
    const h = rx orelse return;
    h.rx.deinit();
    rt.freeZ(gpa, h.endpoint_z);
    gpa.destroy(h);
}

export fn o11y_test_grpc_receiver_endpoint(rx: ?*const GrpcReceiverHandle) [*:0]const u8 {
    const h = rx orelse return "";
    return h.endpoint_z;
}

export fn o11y_test_grpc_receiver_request_count(rx: ?*GrpcReceiverHandle) usize {
    const h = rx orelse return 0;
    return h.rx.requestCount();
}

export fn o11y_test_grpc_receiver_span_count(rx: ?*GrpcReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoSpans(h.rx.traces());
}

export fn o11y_test_grpc_receiver_metric_count(rx: ?*GrpcReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoMetrics(h.rx.metrics());
}

export fn o11y_test_grpc_receiver_log_count(rx: ?*GrpcReceiverHandle) usize {
    const h = rx orelse return 0;
    return countProtoLogs(h.rx.logs());
}

export fn o11y_test_grpc_receiver_decode_errors(rx: ?*GrpcReceiverHandle) usize {
    const h = rx orelse return 0;
    return h.rx.decodeErrors();
}

export fn o11y_test_grpc_receiver_wait_requests(rx: ?*GrpcReceiverHandle, min_count: usize, timeout_ms: u64) bool {
    const h = rx orelse return false;
    const dur: Io.Duration = .fromMilliseconds(@intCast(@min(timeout_ms, std.math.maxInt(i64))));
    h.rx.waitForRequests(min_count, dur) catch return false;
    return true;
}

// =========================================================================
// Built-in Test TLS Certificates (NUL-terminated PEM strings)
// =========================================================================

const ca_pem_z: [:0]const u8 = o11ytest.certs.ca;
const server_pem_z: [:0]const u8 = o11ytest.certs.server;
const server_key_pem_z: [:0]const u8 = o11ytest.certs.server_key;
const client_pem_z: [:0]const u8 = o11ytest.certs.client;
const client_key_pem_z: [:0]const u8 = o11ytest.certs.client_key;
const other_ca_pem_z: [:0]const u8 = o11ytest.certs.other_ca;

export fn o11y_test_cert_ca_pem() [*:0]const u8 {
    return ca_pem_z.ptr;
}
export fn o11y_test_cert_server_pem() [*:0]const u8 {
    return server_pem_z.ptr;
}
export fn o11y_test_cert_server_key_pem() [*:0]const u8 {
    return server_key_pem_z.ptr;
}
export fn o11y_test_cert_client_pem() [*:0]const u8 {
    return client_pem_z.ptr;
}
export fn o11y_test_cert_client_key_pem() [*:0]const u8 {
    return client_key_pem_z.ptr;
}
export fn o11y_test_cert_other_ca_pem() [*:0]const u8 {
    return other_ca_pem_z.ptr;
}
