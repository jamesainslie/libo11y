//! Core `Telemetry` SDK: `setup`, `init`, `Options`, `SetupError`,
//! `ShutdownReport`, app registry loading, provider assembly, startup canary,
//! events, and concurrent shutdown.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const build_options = @import("build_options");
const appregistry = @import("appregistry/appregistry.zig");
const build_info_mod = @import("build_info.zig");
const Context = @import("context.zig").Context;
const error_handler_mod = @import("error_handler.zig");
const goquote = @import("goquote.zig");
const log_pipeline_mod = @import("log_pipeline.zig");
const policy_runtime = @import("policy_runtime.zig");
const process_metrics_mod = @import("process_metrics.zig");
const record_mod = @import("record.zig");
const resource_mod = @import("resource.zig");
const signals_mod = @import("signals.zig");
const spec = @import("spec.zig");
const summary_mod = @import("summary.zig");
const attribute = @import("pipeline/attribute.zig");
const batch = @import("pipeline/batch.zig");
const deadline_mod = @import("pipeline/deadline.zig");
const Deadline = deadline_mod.Deadline;
const log_processor = @import("pipeline/log_processor.zig");
const log_record = @import("pipeline/log_record.zig");
const pipeline_logger = @import("pipeline/logger.zig");
const metric = @import("pipeline/metric/metric.zig");
const metric_meter = metric.meter;
const metric_reader = metric.reader;
const metric_view = metric.view;
const metric_exemplar = metric.exemplar;
const metric_instrument = metric.instrument;
const otlp_env = @import("pipeline/otlp/env.zig");
const otlp_log = @import("pipeline/otlp/log_exporter.zig");
const otlp_metric = @import("pipeline/otlp/metric_exporter.zig");
const otlp_trace = @import("pipeline/otlp/trace_exporter.zig");
const processor = @import("pipeline/processor.zig");
const propagation = @import("pipeline/propagation.zig");
const pipeline_resource = @import("pipeline/resource.zig");
const sampler_mod = @import("pipeline/sampler.zig");
const span_mod = @import("pipeline/span.zig");
const tracer_mod = @import("pipeline/tracer.zig");

/// Closed error set returned by `o11y.setup` and `o11y.init`.
pub const SetupError = error{
    AlreadySetup,
    NoServiceName,
    NoEnvironment,
    InvalidEnvironment,
    PIIHashKey,
    InvalidAppRegistry,
    CanaryRejected,
    UnsupportedProtocol,
    Exporter,
    OutOfMemory,
};

/// One application registry file (or embedded YAML content) to load and
/// validate at setup/init time.
pub const AppRegistrySource = union(enum) {
    /// Reads `path` relative to `dir`.
    file: struct {
        dir: Io.Dir,
        path: []const u8,
    },
    /// Validates YAML bytes already in memory (for example from `@embedFile`).
    bytes: struct {
        path: []const u8,
        content: []const u8,
    },
};

/// Convenience entry for overriding explicit histogram bucket boundaries by
/// instrument name (wildcards allowed, matching Go's `WithHistogramBuckets`).
pub const HistogramBuckets = struct {
    instrument_name: []const u8,
    boundaries: []const f64,
};

/// Per-signal errors reported by `Telemetry.shutdown` and `Telemetry.forceFlush`.
pub const ShutdownReport = struct {
    logs: ?processor.ExportError = null,
    metrics: ?processor.ExportError = null,
    traces: ?processor.ExportError = null,

    pub fn ok(r: ShutdownReport) bool {
        return r.logs == null and r.metrics == null and r.traces == null;
    }
};

/// Configuration for `o11y.setup` and `o11y.init`.
///
/// Code options win over environment variables (`env`), and environment
/// variables win over defaults. `env` defaults to `.hermetic` so tests and
/// applications never accidentally depend on ambient process environment.
pub const Options = struct {
    /// Explicit environment source. Pass `.{ .map = &environ_map }` from `main`
    /// to read `OTEL_*` variables, or `.hermetic` to ignore all env vars.
    env: resource_mod.Env = .hermetic,

    service_name: ?[]const u8 = null,
    service_version: ?[]const u8 = null,
    service_namespace: ?[]const u8 = null,
    environment: ?[]const u8 = null,
    extra_environments: []const []const u8 = &.{},
    strict_identity: bool = true,
    resource_attributes: []const attribute.KeyValue = &.{},

    build_info: ?build_info_mod.BuildInfo = null,
    build_info_enabled: bool = true,

    log_level: log_pipeline_mod.Level = .info,
    console_enabled: bool = true,
    console_format: log_pipeline_mod.ConsoleFormat = .json,
    console_writer: log_pipeline_mod.ConsoleWriter = .stdout,
    log_export: bool = true,
    attr_replacer: ?log_pipeline_mod.AttrReplacer = null,
    extra_log_sinks: []const log_pipeline_mod.LogSink = &.{},

    pii_mode: policy_runtime.PIIMode = .drop,
    pii_hash_key: []const u8 = "",
    app_registries: []const AppRegistrySource = &.{},

    sampler: ?sampler_mod.Sampler = null,
    propagators: []const propagation.Propagator = &.{},
    baggage_egress_allow: ?*const fn (key: []const u8) bool = null,

    views: []const metric_view.View = &.{},
    histogram_buckets: []const HistogramBuckets = &.{},
    exemplar_filter: ?metric_exemplar.Filter = null,

    runtime_metrics: bool = true,
    startup_summary: bool = true,
    install_std_log: bool = true,
    error_handler: ?processor.ErrorHandler = null,

    // Injected pipeline components (for o11ytest and custom exporters).
    span_exporter: ?processor.SpanExporter = null,
    span_processor: ?processor.SpanProcessor = null,
    metric_reader: ?metric_reader.Reader = null,
    log_exporter: ?log_processor.LogExporter = null,

    /// Optional out-parameter receiving Go's diagnostic message text on error.
    diagnostic: ?*resource_mod.Diagnostic = null,
};

var setup_active: std.atomic.Value(bool) = .init(false);

/// Builds an SDK, runs the startup canary (`o11y.telemetry.configured`), and
/// installs the process-global `std.log` route and double-setup guard.
///
/// Fails with `error.AlreadySetup` if called while another `setup` instance is
/// active. Calling `shutdown` on the returned `*Telemetry` releases the guard.
pub fn setup(gpa: Allocator, io: Io, options: Options) SetupError!*Telemetry {
    if (setup_active.swap(true, .acq_rel)) {
        if (options.diagnostic) |d| d.set("o11y: already set up");
        return error.AlreadySetup;
    }

    var succeeded = false;
    var maybe_sdk: ?*Telemetry = null;
    defer {
        if (!succeeded) {
            if (maybe_sdk) |sdk| {
                sdk.abandon();
                sdk.destroyOwned();
            }
            setup_active.store(false, .release);
        }
    }

    const sdk = try buildSdk(gpa, io, options);
    maybe_sdk = sdk;

    if (options.startup_summary) {
        sdk.emitStartupCanary() catch {
            if (options.diagnostic) |d| d.set("o11y: startup canary rejected by log pipeline");
            return error.CanaryRejected;
        };
    }

    sdk.global = true;
    if (options.install_std_log) {
        log_pipeline_mod.installStdLogTarget(&sdk.log_pipeline);
    }

    succeeded = true;
    return sdk;
}

/// Builds a hermetic/independent SDK without touching process globals or
/// running the startup canary. Safe for parallel tests and multiple instances.
pub fn init(gpa: Allocator, io: Io, options: Options) SetupError!*Telemetry {
    return buildSdk(gpa, io, options);
}

/// An initialized libo11y telemetry pipeline owning tracer, meter, and logger
/// providers, the shared resource, propagator, sensitivity policy, and process
/// metrics.
pub const Telemetry = struct {
    gpa: Allocator,
    io: Io,
    disabled: bool = false,
    global: bool = false,

    default_error_handler: error_handler_mod.DefaultErrorHandler,
    error_handler: processor.ErrorHandler = .ignore,

    policy: policy_runtime.Policy,
    owned_resource: resource_mod.OwnedResource,

    composite_propagator: ?propagation.Composite = null,
    egress: propagation.BaggageEgress = .{ .inner = propagation.default() },

    // Owned exporters/processors/readers created internally by setup/init.
    owned_otlp_trace_exporter: ?*otlp_trace.TraceExporter = null,
    owned_batch_span_processor: ?*batch.BatchSpanProcessor = null,
    owned_otlp_metric_exporter: ?*otlp_metric.MetricExporter = null,
    owned_periodic_reader: ?*metric_reader.PeriodicReader = null,
    owned_otlp_log_exporter: ?*otlp_log.LogExporter = null,
    owned_batch_log_processor: ?*log_processor.BatchLogProcessor = null,

    owned_views: []metric_view.View = &.{},
    meter_provider: ?*metric_meter.MeterProvider = null,
    process_metrics: ?*process_metrics_mod.ProcessMetrics = null,
    tracer_provider: ?*tracer_mod.TracerProvider = null,
    logger_provider: ?*pipeline_logger.LoggerProvider = null,
    log_pipeline: log_pipeline_mod.LogPipeline,
    summary: summary_mod.Summary,

    shutdown_started: std.atomic.Value(bool) = .init(false),
    shutdown_done: Io.Event = .unset,
    shutdown_report: ShutdownReport = .{},

    /// Shuts down the pipeline if not already shut down, then frees all owned
    /// memory.
    pub fn deinit(self: *Telemetry) void {
        if (!self.shutdown_started.load(.acquire)) {
            _ = self.shutdown(null);
        } else {
            self.shutdown_done.waitUncancelable(self.io);
        }
        self.destroyOwned();
    }

    /// Shuts down logs, metrics, and traces concurrently under one shared
    /// timeout (default 5 seconds). Idempotent: concurrent and later callers
    /// wait and receive the same `ShutdownReport`.
    pub fn shutdown(self: *Telemetry, timeout: ?Io.Duration) ShutdownReport {
        const dl = deadline_mod.after(self.io, timeout orelse signals_mod.default_shutdown_timeout);
        return self.shutdownBy(dl);
    }

    /// Shuts down logs, metrics, and traces concurrently under `deadline`.
    pub fn shutdownBy(self: *Telemetry, deadline: Deadline) ShutdownReport {
        if (self.shutdown_started.swap(true, .acq_rel)) {
            self.shutdown_done.waitUncancelable(self.io);
            return self.shutdown_report;
        }
        defer self.shutdown_done.set(self.io);

        var report: ShutdownReport = .{};
        const TaskArg = struct { t: *Telemetry, dl: Deadline };
        const arg: TaskArg = .{ .t = self, .dl = deadline };

        const log_task = self.io.concurrent(struct {
            fn run(a: TaskArg) ?processor.ExportError {
                const lp = a.t.logger_provider orelse return null;
                lp.shutdown(a.dl) catch |err| return err;
                return null;
            }
        }.run, .{arg});

        const metric_task = self.io.concurrent(struct {
            fn run(a: TaskArg) ?processor.ExportError {
                const mp = a.t.meter_provider orelse return null;
                mp.shutdown(a.dl) catch |err| return err;
                return null;
            }
        }.run, .{arg});

        const trace_task = self.io.concurrent(struct {
            fn run(a: TaskArg) ?processor.ExportError {
                const tp = a.t.tracer_provider orelse return null;
                tp.shutdown(a.dl) catch |err| return err;
                return null;
            }
        }.run, .{arg});

        report.logs = if (log_task) |f| blk: {
            var fut = f;
            break :blk fut.await(self.io);
        } else |_| blk: {
            const lp = self.logger_provider orelse break :blk null;
            lp.shutdown(deadline) catch |err| break :blk err;
            break :blk null;
        };

        report.metrics = if (metric_task) |f| blk: {
            var fut = f;
            break :blk fut.await(self.io);
        } else |_| blk: {
            const mp = self.meter_provider orelse break :blk null;
            mp.shutdown(deadline) catch |err| break :blk err;
            break :blk null;
        };

        report.traces = if (trace_task) |f| blk: {
            var fut = f;
            break :blk fut.await(self.io);
        } else |_| blk: {
            const tp = self.tracer_provider orelse break :blk null;
            tp.shutdown(deadline) catch |err| break :blk err;
            break :blk null;
        };

        // Emit o11y.telemetry.dropped to surviving sinks (console + extra) for
        // any signal that failed to shut down cleanly.
        if (report.logs) |err| self.emitDropped(.logs, err);
        if (report.metrics) |err| self.emitDropped(.metrics, err);
        if (report.traces) |err| self.emitDropped(.traces, err);

        self.shutdown_report = report;

        if (self.global) {
            log_pipeline_mod.clearStdLogTarget(&self.log_pipeline);
            setup_active.store(false, .release);
        }

        return report;
    }

    /// Flushes logs, metrics, and traces sequentially under one shared timeout
    /// (default 5 seconds).
    pub fn forceFlush(self: *Telemetry, timeout: ?Io.Duration) ShutdownReport {
        const dl = deadline_mod.after(self.io, timeout orelse signals_mod.default_shutdown_timeout);
        var report: ShutdownReport = .{};
        if (self.logger_provider) |lp| {
            lp.forceFlush(dl) catch |err| {
                report.logs = err;
            };
        }
        if (self.meter_provider) |mp| {
            mp.forceFlush(dl) catch |err| {
                report.metrics = err;
            };
        }
        if (self.tracer_provider) |tp| {
            tp.forceFlush(dl) catch |err| {
                report.traces = err;
            };
        }
        return report;
    }

    /// Returns a tracer for `name` (or the no-op tracer when disabled).
    pub fn tracer(self: *Telemetry, name: []const u8) *const tracer_mod.Tracer {
        return self.tracerWithScope(.{ .name = name });
    }

    /// Returns a tracer for `scope` (or the no-op tracer when disabled).
    pub fn tracerWithScope(self: *Telemetry, scope: pipeline_resource.InstrumentationScope) *const tracer_mod.Tracer {
        if (self.disabled) return &tracer_mod.Tracer.noop;
        const tp = self.tracer_provider orelse return &tracer_mod.Tracer.noop;
        return tp.tracer(scope);
    }

    /// Returns a meter for `name`.
    pub fn meter(self: *Telemetry, name: []const u8) *const metric_meter.Meter {
        return self.meterWithScope(.{ .name = name });
    }

    /// Returns a meter for `scope`.
    pub fn meterWithScope(self: *Telemetry, scope: pipeline_resource.InstrumentationScope) *const metric_meter.Meter {
        const mp = self.meter_provider orelse return &metric_meter.Meter.noop;
        return mp.meter(scope);
    }

    /// Returns the structured logger backed by this SDK's fan-out pipeline.
    pub fn logger(self: *Telemetry) log_pipeline_mod.Logger {
        return .{ .pipeline = &self.log_pipeline };
    }

    /// Returns the underlying OTLP `LoggerProvider`, or null when log export
    /// is disabled.
    pub fn loggerProvider(self: *Telemetry) ?*pipeline_logger.LoggerProvider {
        return self.logger_provider;
    }

    /// Returns the underlying `TracerProvider`.
    pub fn tracerProvider(self: *Telemetry) ?*tracer_mod.TracerProvider {
        return self.tracer_provider;
    }

    /// Returns the underlying `MeterProvider`.
    pub fn meterProvider(self: *Telemetry) ?*metric_meter.MeterProvider {
        return self.meter_provider;
    }

    /// Returns the SDK's egress-filtered propagator.
    pub fn propagator(self: *const Telemetry) propagation.Propagator {
        return self.egress.propagator();
    }

    /// Returns the SDK's classified telemetry resource.
    pub fn resource(self: *const Telemetry) pipeline_resource.Resource {
        return self.owned_resource.resource;
    }

    /// Returns the single-line effective configuration string.
    pub fn effectiveConfig(self: *const Telemetry) []const u8 {
        return self.summary.effective_config;
    }

    /// Emits a named event exempt from level gating (`forceEmit`). Strips
    /// caller-supplied `event.name`, deduplicates last-wins, validates against
    /// `spec.eventInfo(name)` (incrementing `o11y.schema.violations` on
    /// contract violations), and emits through the log pipeline. Never fails
    /// the host.
    pub fn event(self: *Telemetry, ctx: Context, name: []const u8, attrs: anytype) void {
        self.emitEventFallible(ctx, name, attrs) catch {};
    }

    fn emitEventFallible(self: *Telemetry, ctx: Context, name: []const u8, attrs: anytype) error{CanaryRejected}!void {
        var stack_buf: [2048]u8 = undefined;
        var first: std.heap.BufferFirstAllocator = .init(&stack_buf, self.gpa);
        var arena_state: std.heap.ArenaAllocator = .init(first.allocator());
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const raw = log_pipeline_mod.convertAttrs(arena, attrs) catch return;
        const deduped = dedupeEventAttrs(arena, raw) catch return;

        // Validate against registered event contract (if registered in spec).
        if (spec.eventInfo(name)) |info| {
            self.validateEventContract(info, deduped);
        }

        const full = arena.alloc(log_record.KeyValue, deduped.len + 1) catch return;
        full[0] = log_record.kv(spec.event_name_key, name);
        @memcpy(full[1..], deduped);

        try self.log_pipeline.emitFallible(.info, ctx.withForceEmit(), name, full);
    }

    fn validateEventContract(self: *const Telemetry, info: *const spec.EventInfo, attrs: []const log_record.KeyValue) void {
        const rec = &(self.policy.recorder orelse return);
        for (info.required) |req| {
            const found = for (attrs) |kv| {
                if (std.mem.eql(u8, kv.key, req)) break true;
            } else false;
            if (!found) {
                rec.record(.logs, "event_contract");
            }
        }
        for (info.required_templates) |tmpl| {
            const found = for (attrs) |kv| {
                if (kv.key.len > tmpl.len + 1 and std.mem.startsWith(u8, kv.key, tmpl) and kv.key[tmpl.len] == '.') {
                    break true;
                }
            } else false;
            if (!found) {
                rec.record(.logs, "event_contract");
            }
        }
    }

    fn emitStartupCanary(self: *Telemetry) error{CanaryRejected}!void {
        try self.emitEventFallible(.background, spec.event.telemetry_configured, self.summary.attrs);
    }

    fn emitDropped(self: *Telemetry, signal: spec.Signal, err: processor.ExportError) void {
        const attrs = [_]log_record.KeyValue{
            log_record.kv(spec.Signal.key, signal.asStr()),
            log_record.kv("error.type", @errorName(err)),
        };
        self.event(.background, spec.event.telemetry_dropped, @as([]const log_record.KeyValue, &attrs));
    }

    /// Stops internal workers promptly when setup/init fails partway through.
    fn abandon(self: *Telemetry) void {
        if (self.shutdown_started.swap(true, .acq_rel)) return;
        defer self.shutdown_done.set(self.io);
        const past = deadline_mod.after(self.io, .zero);
        if (self.logger_provider) |lp| lp.shutdown(past) catch {};
        if (self.tracer_provider) |tp| tp.shutdown(past) catch {};
        if (self.meter_provider) |mp| mp.shutdown(past) catch {};
    }

    /// Frees every heap object owned by `Telemetry`. Must only be called after
    /// `shutdown` or `abandon`.
    fn destroyOwned(self: *Telemetry) void {
        const gpa = self.gpa;
        if (self.process_metrics) |pm| pm.destroy(gpa);
        if (self.logger_provider) |lp| lp.destroy();
        if (self.owned_batch_log_processor) |bp| bp.destroy();
        if (self.owned_otlp_log_exporter) |ex| ex.destroy();

        if (self.tracer_provider) |tp| tp.destroy();
        if (self.owned_batch_span_processor) |bp| bp.destroy();
        if (self.owned_otlp_trace_exporter) |ex| ex.destroy();

        if (self.meter_provider) |mp| mp.destroy();
        if (self.owned_periodic_reader) |pr| pr.destroy();
        if (self.owned_otlp_metric_exporter) |ex| ex.destroy();
        if (self.owned_views.len > 0) gpa.free(self.owned_views);

        self.log_pipeline.deinit();
        self.summary.deinit();
        if (self.composite_propagator) |c| c.deinit(gpa);
        self.owned_resource.deinit();
        self.policy.deinit();
        gpa.destroy(self);
    }
};

fn buildSdk(gpa: Allocator, io: Io, options: Options) SetupError!*Telemetry {
    // 1. Validate PII hash key length upfront.
    if (options.pii_mode == .hash and options.pii_hash_key.len < @import("pii.zig").min_key_len) {
        if (options.diagnostic) |d| d.set("o11y: PIIHash requires pii_hash_key with at least 32 bytes");
        return error.PIIHashKey;
    }

    // 2. Load and validate application registries.
    var app_classes = try loadAppRegistries(gpa, io, options.app_registries, options.diagnostic);
    errdefer {
        var it = app_classes.keyIterator();
        while (it.next()) |k| gpa.free(k.*);
        app_classes.deinit(gpa);
    }

    // 3. Build sensitivity policy.
    var owned_by_self = false;
    var policy = try policy_runtime.Policy.init(gpa, options.pii_mode, options.pii_hash_key, app_classes, null);
    app_classes = .empty; // ownership moved to policy
    errdefer if (!owned_by_self) policy.deinit();

    // 4. Compose and classify resource.
    var resource_violations: policy_runtime.ViolationCounts = .{};
    defer resource_violations.deinit(gpa);
    var owned_resource = resource_mod.build(gpa, io, .{
        .env = options.env,
        .sdk_version = build_options.version,
        .service_name = options.service_name,
        .service_version = options.service_version,
        .service_namespace = options.service_namespace,
        .environment = options.environment,
        .extra_environments = options.extra_environments,
        .strict_identity = options.strict_identity,
        .resource_attributes = options.resource_attributes,
        .build_info = options.build_info,
        .build_info_enabled = options.build_info_enabled,
        .diagnostic = options.diagnostic,
    }, &policy, &resource_violations) catch |err| return switch (err) {
        error.NoServiceName => error.NoServiceName,
        error.NoEnvironment => error.NoEnvironment,
        error.InvalidEnvironment => error.InvalidEnvironment,
        error.OutOfMemory => error.OutOfMemory,
    };
    errdefer if (!owned_by_self) owned_resource.deinit();

    // 5. Allocate Telemetry on the heap so all internal back-pointers remain
    // stable for the entire lifetime of the SDK.
    const self = try gpa.create(Telemetry);
    self.* = .{
        .gpa = gpa,
        .io = io,
        .default_error_handler = error_handler_mod.DefaultErrorHandler.init(io, .stderr),
        .policy = policy,
        .owned_resource = owned_resource,
        .log_pipeline = undefined,
        .summary = undefined,
    };
    owned_by_self = true;
    return finishBuild(self, options, &resource_violations) catch |err| {
        self.abandon();
        cleanupPartial(self);
        return err;
    };
}

fn finishBuild(
    self: *Telemetry,
    options: Options,
    resource_violations: *const policy_runtime.ViolationCounts,
) SetupError!*Telemetry {
    const gpa = self.gpa;
    const io = self.io;

    // Install error handler.
    self.error_handler = options.error_handler orelse self.default_error_handler.handler();

    // Check OTEL_SDK_DISABLED.
    const disabled_info = parseSdkDisabled(options.env);
    self.disabled = disabled_info.disabled;
    if (disabled_info.invalid_value) |bad| {
        var msg_buf: [256]u8 = undefined;
        var w: Io.Writer = .fixed(&msg_buf);
        w.print("o11y: OTEL_SDK_DISABLED={s} is neither true nor false; the SDK stays enabled", .{bad}) catch {};
        if (options.error_handler == null) {
            self.default_error_handler.reportWarning(w.buffered());
        } else {
            self.error_handler.handle("o11y", error.ExportFailed, w.buffered());
        }
    }

    // Propagator + inject-only baggage egress filter.
    const base_prop: propagation.Propagator = switch (options.propagators.len) {
        0 => propagation.default(),
        1 => options.propagators[0],
        else => blk: {
            self.composite_propagator = try propagation.Composite.init(gpa, options.propagators);
            break :blk self.composite_propagator.?.propagator();
        },
    };
    self.egress = .{
        .inner = base_prop,
        .allow = options.baggage_egress_allow orelse propagation.BaggageEgress.allowAll,
    };

    // Views (explicit views + histogram_buckets convenience entries).
    const total_views = options.views.len + options.histogram_buckets.len;
    if (total_views > 0) {
        self.owned_views = try gpa.alloc(metric_view.View, total_views);
        @memcpy(self.owned_views[0..options.views.len], options.views);
        for (options.histogram_buckets, 0..) |hb, i| {
            self.owned_views[options.views.len + i] = .{
                .instrument_name = hb.instrument_name,
                .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = hb.boundaries } },
            };
        }
    }

    // MeterProvider.
    var readers_buf: [1]metric_reader.Reader = undefined;
    var reader_count: usize = 0;
    if (!self.disabled) {
        if (options.metric_reader) |r| {
            readers_buf[0] = r;
            reader_count = 1;
        } else if (!options.env.isHermetic()) {
            const exp_name = std.mem.trim(u8, options.env.getOr("OTEL_METRICS_EXPORTER", "otlp"), " \t\r\n");
            if (std.ascii.eqlIgnoreCase(exp_name, "none")) {
                // Disabled via env.
            } else if (std.ascii.eqlIgnoreCase(exp_name, "otlp")) {
                var env_opts = otlp_env.fromEnv(gpa, options.env, .metrics) catch |err| return mapEnvErr(err, options.diagnostic);
                defer env_opts.deinit();
                const proto: otlp_metric.Protocol = switch (env_opts.protocol) {
                    .http_protobuf => .http_protobuf,
                    .http_json => .http_json,
                    .grpc => return failDiag(options.diagnostic, error.UnsupportedProtocol, "o11y: OTLP/gRPC protocol is not yet supported"),
                };
                self.owned_otlp_metric_exporter = otlp_metric.MetricExporter.create(gpa, io, .{
                    .protocol = proto,
                    .endpoint = env_opts.endpoint,
                    .headers = env_opts.headers,
                    .compression = env_opts.compression,
                    .timeout = env_opts.timeout,
                    .tls = env_opts.tls,
                    .temporality = metric_instrument.temporalityPreferenceFromEnv(options.env) orelse .cumulative,
                    .on_error = self.error_handler,
                }) catch |err| return mapExporterErr(err, options.diagnostic, "o11y: building metric exporter");
                const periodic = metric_instrument.periodicFromEnv(options.env);
                self.owned_periodic_reader = metric_reader.PeriodicReader.create(gpa, io, self.owned_otlp_metric_exporter.?.exporter(), .{
                    .interval = periodic.interval,
                    .timeout = periodic.timeout,
                    .on_error = self.error_handler,
                }) catch |err| return mapCreateErr(err, options.diagnostic, "o11y: starting periodic metric reader");
                readers_buf[0] = self.owned_periodic_reader.?.reader();
                reader_count = 1;
            } else {
                return failDiag(options.diagnostic, error.Exporter, "o11y: unsupported OTEL_METRICS_EXPORTER");
            }
        }
    }

    const exemplar_filter: metric_exemplar.Filter = options.exemplar_filter orelse
        (if (!options.env.isHermetic()) metric_exemplar.filterFromEnv(options.env) else null) orelse
        .trace_based;

    self.meter_provider = try metric_meter.MeterProvider.create(gpa, io, .{
        .resource = self.owned_resource.resource,
        .readers = readers_buf[0..reader_count],
        .views = self.owned_views,
        .exemplar_filter = exemplar_filter,
        .policy = self.policy.attributePolicy(),
    });

    // Attach violation recorder and flush resource violations recorded before
    // the meter provider existed.
    self.policy.attachRecorder(self.meter_provider.?);
    if (self.policy.recorder) |*rec| {
        resource_violations.recordAll(rec, .resource);
    }

    // Default semantic-convention process metrics.
    const runtime_metrics_enabled = options.runtime_metrics and !self.disabled;
    if (runtime_metrics_enabled) {
        self.process_metrics = try process_metrics_mod.ProcessMetrics.create(gpa, io, self.meter_provider.?);
    }

    // TracerProvider.
    const resolved_sampler: sampler_mod.Sampler = options.sampler orelse blk: {
        if (options.env.isHermetic()) break :blk .default;
        const env_s = sampler_mod.fromEnv(
            options.env.get("OTEL_TRACES_SAMPLER"),
            options.env.get("OTEL_TRACES_SAMPLER_ARG"),
        );
        break :blk env_s.sampler orelse .default;
    };

    var span_procs_buf: [2]processor.SpanProcessor = undefined;
    var span_proc_count: usize = 0;
    if (!self.disabled) {
        if (options.span_processor) |sp| {
            span_procs_buf[span_proc_count] = sp;
            span_proc_count += 1;
        }
        const bsp_cfg = bspConfigFromEnv(options.env);
        if (options.span_exporter) |ex| {
            self.owned_batch_span_processor = batch.BatchSpanProcessor.create(gpa, io, ex, .{
                .config = bsp_cfg,
                .on_error = self.error_handler,
            }) catch |err| return mapCreateErr(err, options.diagnostic, "o11y: starting batch span processor");
            span_procs_buf[span_proc_count] = self.owned_batch_span_processor.?.processor();
            span_proc_count += 1;
        } else if (options.span_processor == null and !options.env.isHermetic()) {
            const exp_name = std.mem.trim(u8, options.env.getOr("OTEL_TRACES_EXPORTER", "otlp"), " \t\r\n");
            if (std.ascii.eqlIgnoreCase(exp_name, "none")) {
                // Disabled via env.
            } else if (std.ascii.eqlIgnoreCase(exp_name, "otlp")) {
                var env_opts = otlp_env.fromEnv(gpa, options.env, .traces) catch |err| return mapEnvErr(err, options.diagnostic);
                defer env_opts.deinit();
                const proto: otlp_trace.Protocol = switch (env_opts.protocol) {
                    .http_protobuf => .http_protobuf,
                    .http_json => .http_json,
                    .grpc => return failDiag(options.diagnostic, error.UnsupportedProtocol, "o11y: OTLP/gRPC protocol is not yet supported"),
                };
                self.owned_otlp_trace_exporter = otlp_trace.TraceExporter.create(gpa, io, .{
                    .protocol = proto,
                    .endpoint = env_opts.endpoint,
                    .headers = env_opts.headers,
                    .compression = env_opts.compression,
                    .timeout = env_opts.timeout,
                    .tls = env_opts.tls,
                    .on_error = self.error_handler,
                }) catch |err| return mapExporterErr(err, options.diagnostic, "o11y: building span exporter");
                self.owned_batch_span_processor = batch.BatchSpanProcessor.create(gpa, io, self.owned_otlp_trace_exporter.?.exporter(), .{
                    .config = bsp_cfg,
                    .on_error = self.error_handler,
                }) catch |err| return mapCreateErr(err, options.diagnostic, "o11y: starting batch span processor");
                span_procs_buf[span_proc_count] = self.owned_batch_span_processor.?.processor();
                span_proc_count += 1;
            } else {
                return failDiag(options.diagnostic, error.Exporter, "o11y: unsupported OTEL_TRACES_EXPORTER");
            }
        }
    }

    self.tracer_provider = try tracer_mod.TracerProvider.create(gpa, io, .{
        .resource = self.owned_resource.resource,
        .sampler = resolved_sampler,
        .processors = span_procs_buf[0..span_proc_count],
        .policy = self.policy.attributePolicy(),
    });

    // LoggerProvider (OTLP log export leg).
    const env_logs_exporter = if (options.env.isHermetic()) "" else std.mem.trim(u8, options.env.getOr("OTEL_LOGS_EXPORTER", "otlp"), " \t\r\n");
    const log_export_enabled = !self.disabled and options.log_export and
        (options.log_exporter != null or (!options.env.isHermetic() and !std.ascii.eqlIgnoreCase(env_logs_exporter, "none")));

    var otlp_logger_ptr: ?*const pipeline_logger.Logger = null;
    if (log_export_enabled) {
        const log_exp: log_processor.LogExporter = if (options.log_exporter) |ex|
            ex
        else if (std.ascii.eqlIgnoreCase(env_logs_exporter, "otlp")) blk: {
            var env_opts = otlp_env.fromEnv(gpa, options.env, .logs) catch |err| return mapEnvErr(err, options.diagnostic);
            defer env_opts.deinit();
            const proto: otlp_log.Protocol = switch (env_opts.protocol) {
                .http_protobuf => .http_protobuf,
                .http_json => .http_json,
                .grpc => return failDiag(options.diagnostic, error.UnsupportedProtocol, "o11y: OTLP/gRPC protocol is not yet supported"),
            };
            self.owned_otlp_log_exporter = otlp_log.LogExporter.create(gpa, io, .{
                .protocol = proto,
                .endpoint = env_opts.endpoint,
                .headers = env_opts.headers,
                .compression = env_opts.compression,
                .timeout = env_opts.timeout,
                .tls = env_opts.tls,
                .on_error = self.error_handler,
            }) catch |err| return mapExporterErr(err, options.diagnostic, "o11y: building log exporter");
            break :blk self.owned_otlp_log_exporter.?.exporter();
        } else {
            return failDiag(options.diagnostic, error.Exporter, "o11y: unsupported OTEL_LOGS_EXPORTER");
        };

        const blrp_cfg = if (options.env.isHermetic())
            log_processor.default_batch_config
        else
            log_processor.batchConfig(.{}, options.env);

        self.owned_batch_log_processor = log_processor.BatchLogProcessor.create(gpa, io, log_exp, .{
            .config = blrp_cfg,
            .on_error = self.error_handler,
        }) catch |err| return mapCreateErr(err, options.diagnostic, "o11y: starting batch log processor");

        const log_limits = if (options.env.isHermetic())
            log_record.Limits{}
        else
            log_processor.limitsFromEnv(options.env);

        self.logger_provider = try pipeline_logger.LoggerProvider.create(gpa, io, .{
            .resource = self.owned_resource.resource,
            .limits = log_limits,
            .processors = &.{self.owned_batch_log_processor.?.processor()},
            .policy = self.policy.attributePolicy(),
        });
        otlp_logger_ptr = self.logger_provider.?.logger(.{ .name = policy_runtime.scope_name });
    }

    // Fan-out structured log pipeline.
    self.log_pipeline = try log_pipeline_mod.LogPipeline.init(
        gpa,
        io,
        options.log_level,
        options.console_enabled,
        options.console_format,
        options.console_writer,
        options.attr_replacer,
        otlp_logger_ptr,
        options.extra_log_sinks,
        &self.policy,
    );

    // Summary & effectiveConfig().
    self.summary = try summary_mod.build(gpa, .{
        .resource_attrs = self.owned_resource.resource.attributes,
        .env = options.env,
        .disabled = self.disabled,
        .traces_injected = options.span_processor != null or options.span_exporter != null,
        .metrics_injected = options.metric_reader != null,
        .logs_enabled = log_export_enabled,
        .logs_injected = options.log_exporter != null,
        .console_enabled = options.console_enabled,
        .console_format = options.console_format,
        .log_level = options.log_level,
        .explicit_sampler = options.sampler,
        .propagator = self.propagator(),
        .runtime_metrics_enabled = runtime_metrics_enabled,
        .version_fallback = self.owned_resource.version_fallback,
    });

    return self;
}

fn cleanupPartial(self: *Telemetry) void {
    const gpa = self.gpa;
    if (self.process_metrics) |pm| pm.destroy(gpa);
    if (self.logger_provider) |lp| lp.destroy();
    if (self.owned_batch_log_processor) |bp| bp.destroy();
    if (self.owned_otlp_log_exporter) |ex| ex.destroy();
    if (self.tracer_provider) |tp| tp.destroy();
    if (self.owned_batch_span_processor) |bp| bp.destroy();
    if (self.owned_otlp_trace_exporter) |ex| ex.destroy();
    if (self.meter_provider) |mp| mp.destroy();
    if (self.owned_periodic_reader) |pr| pr.destroy();
    if (self.owned_otlp_metric_exporter) |ex| ex.destroy();
    if (self.owned_views.len > 0) gpa.free(self.owned_views);
    if (self.composite_propagator) |c| c.deinit(gpa);
    self.owned_resource.deinit();
    self.policy.deinit();
    gpa.destroy(self);
}

fn loadAppRegistries(
    gpa: Allocator,
    io: Io,
    sources: []const AppRegistrySource,
    diagnostic: ?*resource_mod.Diagnostic,
) SetupError!std.StringHashMapUnmanaged(spec.Sensitivity) {
    var classes: std.StringHashMapUnmanaged(spec.Sensitivity) = .empty;
    errdefer {
        var it = classes.keyIterator();
        while (it.next()) |k| gpa.free(k.*);
        classes.deinit(gpa);
    }
    if (sources.len == 0) return classes;

    var declared_by: std.StringHashMapUnmanaged([]const u8) = .empty;
    defer {
        var it = declared_by.iterator();
        while (it.next()) |e| {
            gpa.free(e.key_ptr.*);
            gpa.free(e.value_ptr.*);
        }
        declared_by.deinit(gpa);
    }

    for (sources) |src| {
        const path: []const u8 = switch (src) {
            .file => |f| f.path,
            .bytes => |b| b.path,
        };
        var owned_bytes: ?[]u8 = null;
        defer if (owned_bytes) |b| gpa.free(b);

        const raw: []const u8 = switch (src) {
            .bytes => |b| b.content,
            .file => |f| blk: {
                const content = f.dir.readFileAlloc(io, f.path, gpa, .limited(4 * 1024 * 1024)) catch |err| {
                    if (diagnostic) |d| d.print("o11y: reading application registry: {s}: {s}", .{ f.path, @errorName(err) });
                    return error.InvalidAppRegistry;
                };
                owned_bytes = content;
                break :blk content;
            },
        };

        var result = try appregistry.check(gpa, raw, .{});
        defer result.deinit();

        switch (result.outcome) {
            .parse_error => |pe| {
                if (diagnostic) |d| d.print("o11y: {s}: {s}", .{ path, pe.message });
                return error.InvalidAppRegistry;
            },
            .invalid => |vs| {
                if (diagnostic) |d| {
                    var w: Io.Writer = .fixed(&d.buf);
                    w.print("o11y: invalid application registry: {s}: ", .{path}) catch {};
                    for (vs, 0..) |v, i| {
                        if (i > 0) w.writeAll("; ") catch {};
                        v.format(&w) catch {};
                    }
                    d.len = w.buffered().len;
                }
                return error.InvalidAppRegistry;
            },
            .valid => |reg| {
                if (declared_by.get(reg.namespace)) |first_path| {
                    if (diagnostic) |d| {
                        var w: Io.Writer = .fixed(&d.buf);
                        w.print("o11y: invalid application registry: {s} and {s} both declare namespace ", .{ first_path, path }) catch {};
                        goquote.writeQuoted(&w, reg.namespace) catch {};
                        d.len = w.buffered().len;
                    }
                    return error.InvalidAppRegistry;
                }
                const ns_copy = try gpa.dupe(u8, reg.namespace);
                errdefer gpa.free(ns_copy);
                const path_copy = try gpa.dupe(u8, path);
                errdefer gpa.free(path_copy);
                try declared_by.put(gpa, ns_copy, path_copy);

                for (reg.attributes) |a| {
                    if (spec.Sensitivity.parse(a.sensitivity)) |sens| {
                        const gop = try classes.getOrPut(gpa, a.name);
                        if (!gop.found_existing) {
                            gop.key_ptr.* = try gpa.dupe(u8, a.name);
                        }
                        gop.value_ptr.* = sens;
                    }
                }
            },
        }
    }
    return classes;
}

fn dedupeEventAttrs(arena: Allocator, attrs: []const log_record.KeyValue) Allocator.Error![]log_record.KeyValue {
    var out: std.ArrayList(log_record.KeyValue) = try .initCapacity(arena, attrs.len);
    for (attrs, 0..) |a, i| {
        if (std.mem.eql(u8, a.key, spec.event_name_key)) continue;
        if (a.key.len == 0) {
            out.appendAssumeCapacity(a);
            continue;
        }
        const has_later = for (attrs[i + 1 ..]) |b| {
            if (std.mem.eql(u8, b.key, a.key)) break true;
        } else false;
        if (!has_later) out.appendAssumeCapacity(a);
    }
    return out.items;
}

const DisabledInfo = struct {
    disabled: bool = false,
    invalid_value: ?[]const u8 = null,
};

fn parseSdkDisabled(env: resource_mod.Env) DisabledInfo {
    const raw = env.get("OTEL_SDK_DISABLED") orelse return .{};
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return .{};
    if (std.ascii.eqlIgnoreCase(trimmed, "true")) return .{ .disabled = true };
    if (std.ascii.eqlIgnoreCase(trimmed, "false")) return .{ .disabled = false };
    return .{ .disabled = false, .invalid_value = trimmed };
}

fn bspConfigFromEnv(env: resource_mod.Env) batch.Config {
    var cfg: batch.Config = .{};
    if (env.isHermetic()) return cfg;
    if (env.get("OTEL_BSP_MAX_QUEUE_SIZE")) |s| {
        if (log_processor.parseAtoi(s)) |n| if (n >= 1) {
            cfg.max_queue_size = std.math.cast(usize, n) orelse std.math.maxInt(usize);
        };
    }
    if (env.get("OTEL_BSP_SCHEDULE_DELAY")) |s| {
        if (log_processor.parseAtoi(s)) |ms| if (ms >= 1) {
            cfg.schedule_delay = .fromMilliseconds(ms);
        };
    }
    if (env.get("OTEL_BSP_EXPORT_TIMEOUT")) |s| {
        if (log_processor.parseAtoi(s)) |ms| if (ms >= 1) {
            cfg.export_timeout = .fromMilliseconds(ms);
        };
    }
    if (env.get("OTEL_BSP_MAX_EXPORT_BATCH_SIZE")) |s| {
        if (log_processor.parseAtoi(s)) |n| if (n >= 1) {
            cfg.max_export_batch_size = std.math.cast(usize, n) orelse std.math.maxInt(usize);
        };
    }
    cfg.max_export_batch_size = @min(cfg.max_export_batch_size, cfg.max_queue_size);
    return cfg;
}

fn failDiag(diag: ?*resource_mod.Diagnostic, err: SetupError, msg: []const u8) SetupError {
    if (diag) |d| d.set(msg);
    return err;
}

fn mapEnvErr(err: otlp_env.EnvError, diag: ?*resource_mod.Diagnostic) SetupError {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.UnsupportedProtocol => failDiag(diag, error.UnsupportedProtocol, "o11y: unsupported OTLP protocol"),
    };
}

fn mapExporterErr(err: anytype, diag: ?*resource_mod.Diagnostic, prefix: []const u8) SetupError {
    if (err == error.OutOfMemory) return error.OutOfMemory;
    if (diag) |d| d.print("{s}: {s}", .{ prefix, @errorName(err) });
    return error.Exporter;
}

fn mapCreateErr(err: batch.CreateError, diag: ?*resource_mod.Diagnostic, prefix: []const u8) SetupError {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.ConcurrencyUnavailable => blk: {
            if (diag) |d| d.print("{s}: ConcurrencyUnavailable", .{prefix});
            break :blk error.Exporter;
        },
    };
}

const testing = std.testing;
const memory_exporter = @import("pipeline/memory_exporter.zig");

const TestConsole = struct {
    gpa: Allocator,
    buf: std.ArrayList(u8) = .empty,
    reject: bool = false,

    fn deinit(c: *TestConsole) void {
        c.buf.deinit(c.gpa);
    }

    fn writer(c: *TestConsole) log_pipeline_mod.ConsoleWriter {
        return .{ .custom = .{ .ptr = c, .writeFn = writeFn } };
    }

    fn writeFn(ptr: *anyopaque, bytes: []const u8) log_pipeline_mod.ConsoleWriter.WriteError!void {
        const c: *TestConsole = @ptrCast(@alignCast(ptr));
        if (c.reject) return error.WriteFailed;
        c.buf.appendSlice(c.gpa, bytes) catch return error.WriteFailed;
    }
};

test "setup enforces double-setup guard, emits canary, rejects failing canary, and releases guard on shutdown" {
    var console: TestConsole = .{ .gpa = testing.allocator };
    defer console.deinit();

    // Failing canary fails setup with error.CanaryRejected and releases the guard.
    console.reject = true;
    var diag: resource_mod.Diagnostic = .{};
    try testing.expectError(error.CanaryRejected, setup(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .console_writer = console.writer(),
        .runtime_metrics = false,
        .diagnostic = &diag,
    }));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "canary") != null);

    // Now setup succeeds and emits o11y.telemetry.configured.
    console.reject = false;
    const t1 = try setup(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .console_writer = console.writer(),
        .runtime_metrics = false,
    });
    defer t1.deinit();

    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"event.name\":\"o11y.telemetry.configured\"") != null);
    try testing.expect(std.mem.indexOf(u8, t1.effectiveConfig(), "service.name=svc") != null);

    // Second setup fails with error.AlreadySetup while t1 is active.
    try testing.expectError(error.AlreadySetup, setup(testing.allocator, testing.io, .{
        .service_name = "svc2",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
    }));

    // Independent init() succeeds even while setup() is active.
    const t_iso = try init(testing.allocator, testing.io, .{
        .service_name = "iso",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
    });
    t_iso.deinit();

    // Shutting down t1 releases the guard so a new setup() succeeds.
    const report = t1.shutdown(null);
    try testing.expect(report.ok());

    const t2 = try setup(testing.allocator, testing.io, .{
        .service_name = "svc2",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t2.deinit();
}

test "PII hash key validation, app registry enforcement, and grpc unsupported protocol" {
    var diag: resource_mod.Diagnostic = .{};
    try testing.expectError(error.PIIHashKey, init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .pii_mode = .hash,
        .pii_hash_key = "too-short",
        .console_enabled = false,
        .runtime_metrics = false,
        .diagnostic = &diag,
    }));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "32 bytes") != null);

    // Invalid app registry fails with InvalidAppRegistry + diagnostic.
    try testing.expectError(error.InvalidAppRegistry, init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .app_registries = &.{.{ .bytes = .{
            .path = "bad.yaml",
            .content = "schema: wrong\nnamespace: shop\nattributes: {}\n",
        } }},
        .console_enabled = false,
        .runtime_metrics = false,
        .diagnostic = &diag,
    }));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "libo11y_app_schema_unknown") != null);

    // Valid app registry classifies custom PII & secret attributes on traces and logs.
    var span_exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer span_exp.deinit();
    var log_exp = log_processor.InMemoryLogExporter.init(testing.allocator, testing.io);
    defer log_exp.deinit();
    var console: TestConsole = .{ .gpa = testing.allocator };
    defer console.deinit();

    const key = "0123456789abcdef0123456789abcdef";
    const t = try init(testing.allocator, testing.io, .{
        .service_name = "shop-api",
        .environment = "production",
        .pii_mode = .hash,
        .pii_hash_key = key,
        .app_registries = &.{.{ .bytes = .{
            .path = "shop.yaml",
            .content =
            \\schema: libo11y.app-registry/v1
            \\namespace: shop
            \\attributes:
            \\  shop.customer.email: {type: string, sensitivity: pii, cardinality: unbounded}
            \\  shop.api.secret: {type: string, sensitivity: secret, cardinality: unbounded}
            \\
            ,
        } }},
        .span_exporter = span_exp.exporter(),
        .log_exporter = log_exp.exporter(),
        .console_writer = console.writer(),
        .runtime_metrics = false,
    });
    defer t.deinit();

    const tr = t.tracer("shop");
    var sp = tr.start(.background, "checkout", .{
        .attributes = &.{
            attribute.kv("shop.customer.email", "alice@example.com"),
            attribute.kv("shop.api.secret", "s3cr3t"),
        },
    });
    const ctx = Context.background.withSpan(&sp);
    t.logger().info(ctx, "paid", .{
        .@"shop.customer.email" = "alice@example.com",
        .@"shop.api.secret" = "s3cr3t",
    });
    sp.end();
    try testing.expect(t.shutdown(null).ok());

    const spans = try span_exp.snapshot(testing.allocator);
    defer testing.allocator.free(spans);
    try testing.expectEqual(@as(usize, 1), spans.len);
    const span_email = attribute.find(spans[0].attributes.items, "shop.customer.email").?.string;
    try testing.expect(std.mem.startsWith(u8, span_email, "hmac-sha256:"));
    try testing.expectEqual(null, attribute.find(spans[0].attributes.items, "shop.api.secret"));

    // Span token and console log token and OTLP log token agree identically!
    try testing.expect(std.mem.indexOf(u8, console.buf.items, span_email) != null);
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "s3cr3t") == null);

    const logs = try log_exp.snapshot(testing.allocator);
    defer testing.allocator.free(logs);
    try testing.expectEqual(@as(usize, 1), logs.len);
    try testing.expectEqualStrings(span_email, log_record.find(logs[0].attributes, "shop.customer.email").?.string);
    try testing.expectEqual(null, log_record.find(logs[0].attributes, "shop.api.secret"));

    // gRPC protocol cleanly fails with error.UnsupportedProtocol.
    try testing.expectError(error.UnsupportedProtocol, init(testing.allocator, testing.io, .{
        .env = .{ .pairs = &.{.{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" }} },
        .service_name = "svc",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
    }));
}

test "event contract validation increments o11y.schema.violations and Record emits wide event" {
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    var console: TestConsole = .{ .gpa = testing.allocator };
    defer console.deinit();

    const t = try init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .metric_reader = reader.reader(),
        .console_writer = console.writer(),
        .log_level = .err, // verify event bypasses level gate!
        .runtime_metrics = false,
    });
    defer t.deinit();

    // Emit o11y.request.summary missing all 4 required attributes -> 4 event_contract violations.
    t.event(.background, spec.event.request_summary, .{ .extra = "val" });
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"event.name\":\"o11y.request.summary\"") != null);

    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();
    var contract_violations: i64 = 0;
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            if (std.mem.eql(u8, m.name, spec.metric.schema_violations)) {
                for (m.data.sum.data_points) |pt| {
                    const rule = attribute.find(pt.attributes, spec.attr.rule).?.string;
                    if (std.mem.eql(u8, rule, "event_contract")) contract_violations += pt.value.int;
                }
            }
        }
    }
    try testing.expectEqual(@as(i64, 4), contract_violations);

    // Record wide event accumulates and emits cleanly.
    console.buf.clearRetainingCapacity();
    var rec = record_mod.Record.init(testing.allocator, testing.io);
    defer rec.deinit();
    const rctx = Context.background.withRecord(&rec);
    rec.set("http.request.method", "GET");
    rec.add("db.queries", 3);
    rec.emitEvent(rctx, t, spec.event.request_summary, .{
        .@"http.response.status_code" = 200,
        .@"o11y.outcome" = "success",
        .@"o11y.duration" = 0.042,
    });
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"http.request.method\":\"GET\"") != null);
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"db.queries\":3") != null);
}

test "concurrent shutdown races emits safely and shares the same ShutdownReport" {
    var span_exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer span_exp.deinit();
    var log_exp = log_processor.InMemoryLogExporter.init(testing.allocator, testing.io);
    defer log_exp.deinit();

    const t = try init(testing.allocator, testing.io, .{
        .service_name = "race",
        .environment = "test",
        .span_exporter = span_exp.exporter(),
        .log_exporter = log_exp.exporter(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t.deinit();

    const tr = t.tracer("race");
    var emitter = try testing.io.concurrent(struct {
        fn run(sdk: *Telemetry, trc: *const tracer_mod.Tracer) void {
            for (0..50) |i| {
                var sp = trc.start(.background, "op", .{});
                sdk.logger().info(Context.background.withSpan(&sp), "tick", .{ .i = i });
                sp.end();
            }
        }
    }.run, .{ t, tr });

    var s1 = try testing.io.concurrent(struct {
        fn run(sdk: *Telemetry) ShutdownReport {
            return sdk.shutdown(null);
        }
    }.run, .{t});
    var s2 = try testing.io.concurrent(struct {
        fn run(sdk: *Telemetry) ShutdownReport {
            return sdk.shutdown(null);
        }
    }.run, .{t});

    emitter.await(testing.io);
    const r1 = s1.await(testing.io);
    const r2 = s2.await(testing.io);
    try testing.expect(r1.ok());
    try testing.expectEqual(r1, r2);
}

test "process metrics disabled when runtime_metrics is false" {
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    const t = try init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .metric_reader = reader.reader(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t.deinit();

    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            try testing.expect(!std.mem.startsWith(u8, m.name, "process."));
        }
    }
}

test "propagator wraps custom propagator in baggage egress filter without globals" {
    const t = try init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .baggage_egress_allow = struct {
            fn allow(k: []const u8) bool {
                return std.mem.eql(u8, k, "tenant");
            }
        }.allow,
    });
    defer t.deinit();

    const MapCarrier = struct {
        gpa: Allocator,
        bag: ?[]u8 = null,
        fn deinit(m: *@This()) void {
            if (m.bag) |b| m.gpa.free(b);
        }
        fn carrier(m: *@This()) propagation.Carrier {
            return .{ .ptr = m, .vtable = &.{ .get = get, .set = set } };
        }
        fn get(ptr: *anyopaque, key: []const u8) ?[]const u8 {
            const m: *@This() = @ptrCast(@alignCast(ptr));
            if (std.mem.eql(u8, key, "baggage")) return m.bag;
            return null;
        }
        fn set(ptr: *anyopaque, key: []const u8, val: []const u8) void {
            const m: *@This() = @ptrCast(@alignCast(ptr));
            if (std.mem.eql(u8, key, "baggage")) {
                if (m.bag) |old| m.gpa.free(old);
                m.bag = m.gpa.dupe(u8, val) catch null;
            }
        }
    };

    const Baggage = @import("pipeline/baggage.zig").Baggage;
    const bag: Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "secret_bag", .value = "dropme" },
    } };
    var mc: MapCarrier = .{ .gpa = testing.allocator };
    defer mc.deinit();

    t.propagator().inject(Context.background.withBaggage(&bag), testing.allocator, mc.carrier());
    try testing.expectEqualStrings("tenant=acme", mc.bag.?);
}

test "hermetic mode ignores env vars and code options win over env vars" {
    const env_pairs: resource_mod.Env = .{ .pairs = &.{
        .{ "OTEL_SERVICE_NAME", "env-svc" },
        .{ "OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=staging,service.version=9.9.9" },
        .{ "OTEL_TRACES_SAMPLER", "always_off" },
        .{ "OTEL_TRACES_EXPORTER", "none" },
        .{ "OTEL_METRICS_EXPORTER", "none" },
        .{ "OTEL_LOGS_EXPORTER", "none" },
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "https://u:p@collector.example:4318" },
    } };

    // Env resolves service, environment, version, sampler, and sanitized endpoint.
    const t_env = try init(testing.allocator, testing.io, .{
        .env = env_pairs,
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t_env.deinit();
    try testing.expectEqualStrings("env-svc", attribute.find(t_env.resource().attributes, "service.name").?.string);
    try testing.expectEqualStrings("staging", attribute.find(t_env.resource().attributes, spec.Environment.key).?.string);
    try testing.expectEqualStrings("9.9.9", attribute.find(t_env.resource().attributes, "service.version").?.string);
    try testing.expect(std.mem.indexOf(u8, t_env.effectiveConfig(), "o11y.config.sampler=always_off") != null);
    try testing.expect(std.mem.indexOf(u8, t_env.effectiveConfig(), "o11y.config.endpoint=https://collector.example:4318") != null);
    // Code options beat env vars.
    const t_code = try init(testing.allocator, testing.io, .{
        .env = env_pairs,
        .service_name = "code-svc",
        .environment = "production",
        .service_version = "2.0.0",
        .sampler = .always_on,
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t_code.deinit();
    try testing.expectEqualStrings("code-svc", attribute.find(t_code.resource().attributes, "service.name").?.string);
    try testing.expectEqualStrings("production", attribute.find(t_code.resource().attributes, spec.Environment.key).?.string);
    try testing.expectEqualStrings("2.0.0", attribute.find(t_code.resource().attributes, "service.version").?.string);
    try testing.expect(std.mem.indexOf(u8, t_code.effectiveConfig(), "o11y.config.sampler=AlwaysOnSampler") != null);

    // Hermetic mode reports no endpoints and exporters as none.
    const t_herm = try init(testing.allocator, testing.io, .{
        .env = .hermetic,
        .service_name = "herm-svc",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer t_herm.deinit();
    try testing.expect(std.mem.indexOf(u8, t_herm.effectiveConfig(), "o11y.config.traces=none") != null);
    try testing.expect(std.mem.indexOf(u8, t_herm.effectiveConfig(), "o11y.config.endpoint=") == null);
}

test "duplicate app registry namespace and file load errors report InvalidAppRegistry with diagnostic" {
    const reg_a =
        \\schema: libo11y.app-registry/v1
        \\namespace: billing
        \\attributes:
        \\  billing.invoice.id: {type: string, sensitivity: internal, cardinality: unbounded}
        \\
    ;
    const reg_b =
        \\schema: libo11y.app-registry/v1
        \\namespace: billing
        \\attributes:
        \\  billing.card.last4: {type: string, sensitivity: pii, cardinality: unbounded}
        \\
    ;
    var diag: resource_mod.Diagnostic = .{};
    try testing.expectError(error.InvalidAppRegistry, init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .app_registries = &.{
            .{ .bytes = .{ .path = "a.yaml", .content = reg_a } },
            .{ .bytes = .{ .path = "b.yaml", .content = reg_b } },
        },
        .console_enabled = false,
        .runtime_metrics = false,
        .diagnostic = &diag,
    }));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "both declare namespace \"billing\"") != null);

    // Missing file fails cleanly with InvalidAppRegistry + diagnostic.
    try testing.expectError(error.InvalidAppRegistry, init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .app_registries = &.{
            .{ .file = .{ .dir = Io.Dir.cwd(), .path = "nonexistent-registry-file.yaml" } },
        },
        .console_enabled = false,
        .runtime_metrics = false,
        .diagnostic = &diag,
    }));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "reading application registry") != null);
}

test "OTEL_SDK_DISABLED disables exports and runtime metrics while keeping console logs" {
    var span_exp = memory_exporter.InMemoryExporter.init(testing.allocator, testing.io);
    defer span_exp.deinit();
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    var console: TestConsole = .{ .gpa = testing.allocator };
    defer console.deinit();

    const t = try init(testing.allocator, testing.io, .{
        .env = .{ .pairs = &.{.{ "OTEL_SDK_DISABLED", "TRUE" }} },
        .service_name = "disabled-svc",
        .environment = "test",
        .span_exporter = span_exp.exporter(),
        .metric_reader = reader.reader(),
        .console_writer = console.writer(),
        .runtime_metrics = true,
    });
    defer t.deinit();

    var sp = t.tracer("app").start(.background, "op", .{});
    try testing.expect(!sp.isRecording());
    sp.end();
    t.logger().info(.background, "still logged", .{});
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "still logged") != null);
    try testing.expect(std.mem.indexOf(u8, t.effectiveConfig(), "o11y.config.traces=none") != null);
    try testing.expect(std.mem.indexOf(u8, t.effectiveConfig(), "o11y.config.runtime_metrics=false") != null);
    try testing.expectEqual(@as(usize, 0), span_exp.count());
}

test "log PII violation counts once per sink (console + OTLP) and shutdown emits telemetry.dropped on failing exporter" {
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    var log_exp = log_processor.InMemoryLogExporter.init(testing.allocator, testing.io);
    defer log_exp.deinit();
    var console: TestConsole = .{ .gpa = testing.allocator };
    defer console.deinit();

    const FailingSpanExporter = struct {
        fn exporter(self: *@This()) processor.SpanExporter {
            return .{ .ptr = self, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdownFn } };
        }
        fn exportSpans(_: *anyopaque, _: []const *const span_mod.SpanData, _: Deadline) processor.ExportError!void {
            return error.ExportFailed;
        }
        fn shutdownFn(_: *anyopaque, _: Deadline) processor.ExportError!void {
            return error.ExportFailed;
        }
    };
    var bad_spans: FailingSpanExporter = .{};

    const t = try init(testing.allocator, testing.io, .{
        .service_name = "svc",
        .environment = "test",
        .metric_reader = reader.reader(),
        .log_exporter = log_exp.exporter(),
        .span_exporter = bad_spans.exporter(),
        .console_writer = console.writer(),
        .runtime_metrics = false,
    });
    defer t.deinit();

    t.logger().info(.background, "hello", .{ .@"host.ip" = "10.0.0.1" });
    try testing.expect(t.forceFlush(null).ok());

    // Console + OTLP = 2 violations on logs for the single PII attribute.
    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();
    var log_pii_count: i64 = 0;
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            if (std.mem.eql(u8, m.name, spec.metric.schema_violations)) {
                for (m.data.sum.data_points) |pt| {
                    const sig = attribute.find(pt.attributes, spec.Signal.key).?.string;
                    const rule = attribute.find(pt.attributes, spec.attr.rule).?.string;
                    if (std.mem.eql(u8, sig, "logs") and std.mem.eql(u8, rule, "pii_attribute")) {
                        log_pii_count += pt.value.int;
                    }
                }
            }
        }
    }
    try testing.expectEqual(@as(i64, 2), log_pii_count);

    // Shutdown reports traces failure and emits o11y.telemetry.dropped to console.
    const report = t.shutdown(null);
    try testing.expect(!report.ok());
    try testing.expectEqual(@as(?processor.ExportError, error.ExportFailed), report.traces);
    try testing.expectEqual(@as(?processor.ExportError, null), report.logs);
    try testing.expectEqual(@as(?processor.ExportError, null), report.metrics);
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"event.name\":\"o11y.telemetry.dropped\"") != null);
    try testing.expect(std.mem.indexOf(u8, console.buf.items, "\"o11y.signal\":\"traces\"") != null);
}
