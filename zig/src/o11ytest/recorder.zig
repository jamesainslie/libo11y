//! Hermetic test harness (`o11ytest.start`) for asserting spans, metrics,
//! exemplars, structured logs, console JSON output, OTLP log records,
//! correlation, and libo11y specification conformance in unit tests.
//!
//! Builds an independent `o11y.Telemetry` via `o11y.init` with `.env = .hermetic`:
//! no process globals are touched, no exporter dials out, and no ambient `OTEL_*`
//! variable affects behavior, so harnesses are deterministic and safe for parallel
//! tests.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const spec = o11y.spec;

/// Errors returned by `o11ytest` assertion helpers.
pub const AssertError = error{
    SpanNotFound,
    UnexpectedSpan,
    LogNotFound,
    EventNotFound,
    MetricNotFound,
    ExemplarNotFound,
    UnexpectedViolations,
    ExpectedViolations,
    ConformanceFailed,
    CorrelationFailed,
    TriangleFailed,
    OutOfMemory,
};

/// Errors returned by metric collection helpers on `Recorder`.
pub const CollectError = o11y.MetricCollectError;

/// Options for `o11ytest.start`.
///
/// Defaults match Go's `o11ytest.Start`:
/// - `service_name = "test-service"`, `environment = "test"`
/// - `log_level = .debug`
/// - `sampler = .always_on`
/// - `exemplar_filter = .trace_based`
/// - `runtime_metrics = false`
/// - `.env = .hermetic` (always enforced)
/// - Spans captured synchronously via an in-memory span processor, metrics
///   collected on demand via `ManualMetricReader`, logs captured synchronously
///   via a structured capture sink plus an in-memory OTLP log exporter and an
///   in-memory console JSON buffer (never writing to stdout).
pub const Options = struct {
    service_name: ?[]const u8 = "test-service",
    service_version: ?[]const u8 = null,
    service_namespace: ?[]const u8 = null,
    environment: ?[]const u8 = spec.Environment.@"test".asStr(),
    extra_environments: []const []const u8 = &.{},
    strict_identity: bool = true,
    resource_attributes: []const o11y.Attribute = &.{},

    build_info: ?o11y.BuildInfo = null,
    build_info_enabled: bool = true,

    log_level: o11y.Level = .debug,
    console_enabled: bool = true,
    console_format: o11y.ConsoleFormat = .json,
    console_writer: ?o11y.ConsoleWriter = null,
    log_export: bool = true,
    attr_replacer: ?o11y.AttrReplacer = null,
    extra_log_sinks: []const o11y.LogSink = &.{},

    pii_mode: o11y.PIIMode = .drop,
    pii_hash_key: []const u8 = "",
    app_registries: []const o11y.AppRegistrySource = &.{},

    sampler: o11y.Sampler = .always_on,
    propagators: []const o11y.Propagator = &.{},
    baggage_egress_allow: ?*const fn (key: []const u8) bool = null,

    views: []const o11y.View = &.{},
    histogram_buckets: []const o11y.HistogramBuckets = &.{},
    exemplar_filter: o11y.ExemplarFilter = .trace_based,

    runtime_metrics: bool = false,
    error_handler: ?o11y.ErrorHandler = null,

    /// Optional extra span exporter (batched alongside the recorder's
    /// synchronous span capture, matching Go's `WithTraceExporter` override).
    span_exporter: ?o11y.SpanExporter = null,
    /// Optional override for the OTLP log exporter. When null and `log_export`
    /// is true, logs are captured into the recorder's in-memory OTLP log buffer.
    log_exporter: ?o11y.LogExporter = null,

    diagnostic: ?*o11y.Diagnostic = null,
};

/// One captured structured log record together with the span context active
/// when it was emitted.
pub const LogRecord = struct {
    time_unix_nano: u64,
    level: o11y.Level,
    message: []const u8,
    span_context: o11y.SpanContext,
    attributes: []const o11y.LogAttribute,

    /// Returns the last top-level attribute value for `key`, or null.
    pub fn attr(self: *const LogRecord, key: []const u8) ?o11y.LogValue {
        var i = self.attributes.len;
        while (i > 0) {
            i -= 1;
            if (std.mem.eql(u8, self.attributes[i].key, key)) return self.attributes[i].value;
        }
        return null;
    }

    /// Returns the string value of top-level attribute `key`, or null.
    pub fn attrString(self: *const LogRecord, key: []const u8) ?[]const u8 {
        const val = self.attr(key) orelse return null;
        return switch (val) {
            .string => |s| s,
            else => null,
        };
    }

    /// Returns the `event.name` attribute when this log record is an event.
    pub fn eventName(self: *const LogRecord) ?[]const u8 {
        return self.attrString(spec.event_name_key);
    }
};

/// One collected metric exemplar in harness form.
pub const Exemplar = struct {
    trace_id: o11y.TraceId = .invalid,
    span_id: o11y.SpanId = .invalid,
    value: f64,
    time_unix_nano: u64 = 0,
    filtered_attributes: []const o11y.Attribute = &.{},
};

/// Result of `checkConforms`, `checkCorrelated`, or `checkTriangle`.
pub const ConformanceReport = struct {
    arena: std.heap.ArenaAllocator,
    problems: []const []const u8,

    pub fn ok(self: *const ConformanceReport) bool {
        return self.problems.len == 0;
    }

    pub fn deinit(self: *ConformanceReport) void {
        self.arena.deinit();
        self.* = undefined;
    }

    /// Reports whether any problem message contains `needle`.
    pub fn contains(self: *const ConformanceReport, needle: []const u8) bool {
        for (self.problems) |p| {
            if (std.mem.indexOf(u8, p, needle) != null) return true;
        }
        return false;
    }
};

/// Checks a recorded event's attribute keys against its registered contract in
/// `o11y.spec.events` (port of `go/internal/conformance/conformance.go`).
/// Unregistered event names have no contract and return an empty slice.
pub fn checkEvent(arena: Allocator, event_name: []const u8, keys: []const []const u8) Allocator.Error![]const []const u8 {
    const info = spec.eventInfo(event_name) orelse return &.{};
    var problems: std.ArrayList([]const u8) = .empty;

    for (info.required) |req| {
        const present = for (keys) |k| {
            if (std.mem.eql(u8, k, req)) break true;
        } else false;
        if (!present) {
            try problems.append(arena, try std.fmt.allocPrint(
                arena,
                "event {s}: missing required attribute {s}",
                .{ event_name, req },
            ));
        }
    }

    for (info.required_templates) |tmpl| {
        const satisfied = for (keys) |k| {
            if (k.len > tmpl.len + 1 and std.mem.startsWith(u8, k, tmpl) and k[tmpl.len] == '.') {
                break true;
            }
        } else false;
        if (!satisfied) {
            try problems.append(arena, try std.fmt.allocPrint(
                arena,
                "event {s}: missing required template attribute {s}.<key>",
                .{ event_name, tmpl },
            ));
        }
    }

    return problems.items;
}

/// Builds a hermetic `o11y.Telemetry` and returns its owned `*Recorder`.
/// Call `defer rec.deinit();` to shut down and release all resources.
pub fn start(gpa: Allocator, io: Io, options: Options) o11y.SetupError!*Recorder {
    const r = try gpa.create(Recorder);
    errdefer gpa.destroy(r);

    r.* = .{
        .gpa = gpa,
        .io = io,
        .t = undefined,
        .span_recorder = SpanRecorder.init(gpa, io),
        .metric_reader = o11y.ManualMetricReader.init(io, .{}),
        .log_capture = LogCapture.init(gpa, io),
        .otlp_log_capture = OtlpLogCapture.init(gpa, io),
        .console_capture = ConsoleCapture.init(gpa, io),
        .query_arena = .init(gpa),
    };
    errdefer r.deinitCaptures();

    // Combine our synchronous capture sink with any caller-supplied extra sinks.
    const sinks = try gpa.alloc(o11y.LogSink, options.extra_log_sinks.len + 1);
    defer gpa.free(sinks);
    sinks[0] = r.log_capture.sink();
    @memcpy(sinks[1..], options.extra_log_sinks);

    const log_exporter: ?o11y.LogExporter = if (!options.log_export)
        null
    else
        options.log_exporter orelse r.otlp_log_capture.exporter();

    const console_writer: o11y.ConsoleWriter = options.console_writer orelse r.console_capture.writer();

    r.t = try o11y.init(gpa, io, .{
        .env = .hermetic,
        .service_name = options.service_name,
        .service_version = options.service_version,
        .service_namespace = options.service_namespace,
        .environment = options.environment,
        .extra_environments = options.extra_environments,
        .strict_identity = options.strict_identity,
        .resource_attributes = options.resource_attributes,
        .build_info = options.build_info,
        .build_info_enabled = options.build_info_enabled,
        .log_level = options.log_level,
        .console_enabled = options.console_enabled,
        .console_format = options.console_format,
        .console_writer = console_writer,
        .log_export = options.log_export,
        .attr_replacer = options.attr_replacer,
        .extra_log_sinks = sinks,
        .pii_mode = options.pii_mode,
        .pii_hash_key = options.pii_hash_key,
        .app_registries = options.app_registries,
        .sampler = options.sampler,
        .propagators = options.propagators,
        .baggage_egress_allow = options.baggage_egress_allow,
        .views = options.views,
        .histogram_buckets = options.histogram_buckets,
        .exemplar_filter = options.exemplar_filter,
        .runtime_metrics = options.runtime_metrics,
        .startup_summary = false,
        .install_std_log = false,
        .error_handler = options.error_handler,
        .span_processor = r.span_recorder.processor(),
        .span_exporter = options.span_exporter,
        .metric_reader = r.metric_reader.reader(),
        .log_exporter = log_exporter,
        .diagnostic = options.diagnostic,
    });

    return r;
}

/// Hermetic telemetry recorder owning an in-memory `o11y.Telemetry` instance
/// and all captured spans, metrics, structured logs, OTLP logs, and console
/// JSON output.
pub const Recorder = struct {
    gpa: Allocator,
    io: Io,
    /// The underlying hermetic `o11y.Telemetry` SDK.
    t: *o11y.Telemetry,

    span_recorder: SpanRecorder,
    metric_reader: o11y.ManualMetricReader,
    log_capture: LogCapture,
    otlp_log_capture: OtlpLogCapture,
    console_capture: ConsoleCapture,

    // Storage for query results returned by `metrics()`, `metricNames()`,
    // `exemplars()`, etc., cleared on `reset()` and freed on `deinit()`.
    query_mutex: Io.Mutex = .init,
    collected_metrics: std.ArrayList(o11y.ResourceMetrics) = .empty,
    query_arena: std.heap.ArenaAllocator,

    /// Shuts down telemetry (if not already shut down) and frees all owned memory.
    pub fn deinit(self: *Recorder) void {
        self.t.deinit();
        self.deinitCaptures();
        self.gpa.destroy(self);
    }

    fn deinitCaptures(self: *Recorder) void {
        for (self.collected_metrics.items) |*rm| rm.deinit();
        self.collected_metrics.deinit(self.gpa);
        self.query_arena.deinit();
        self.span_recorder.deinit();
        self.log_capture.deinit();
        self.otlp_log_capture.deinit();
        self.console_capture.deinit();
    }

    /// Returns the underlying `*o11y.Telemetry`.
    pub fn telemetry(self: *Recorder) *o11y.Telemetry {
        return self.t;
    }

    /// Returns the SDK's structured logger.
    pub fn logger(self: *Recorder) o11y.Logger {
        return self.t.logger();
    }

    /// Returns a tracer scoped to `name`.
    pub fn tracer(self: *Recorder, name: []const u8) *const o11y.Tracer {
        return self.t.tracer(name);
    }

    /// Returns a meter scoped to `name`.
    pub fn meter(self: *Recorder, name: []const u8) *const o11y.Meter {
        return self.t.meter(name);
    }

    /// Clears recorded spans, structured logs, OTLP logs, console buffer, and
    /// cached query snapshots. Metrics remain cumulative in the meter provider.
    pub fn reset(self: *Recorder) void {
        if (!self.t.shutdown_started.load(.acquire)) {
            _ = self.t.forceFlush(null);
        }
        self.span_recorder.reset();
        self.log_capture.reset();
        self.otlp_log_capture.reset();
        self.console_capture.reset();
        self.query_mutex.lockUncancelable(self.io);
        defer self.query_mutex.unlock(self.io);
        for (self.collected_metrics.items) |*rm| rm.deinit();
        self.collected_metrics.clearRetainingCapacity();
        _ = self.query_arena.reset(.retain_capacity);
    }

    // -----------------------------------------------------------------------
    // Spans
    // -----------------------------------------------------------------------

    /// Returns all ended sampled spans in end order.
    pub fn spans(self: *Recorder) []const *const o11y.SpanData {
        self.span_recorder.mutex.lockUncancelable(self.io);
        defer self.span_recorder.mutex.unlock(self.io);
        return self.span_recorder.spans.items;
    }

    /// Returns the first recorded span named `name`, or null.
    pub fn span(self: *Recorder, name: []const u8) ?*const o11y.SpanData {
        self.span_recorder.mutex.lockUncancelable(self.io);
        defer self.span_recorder.mutex.unlock(self.io);
        for (self.span_recorder.spans.items) |sp| {
            if (std.mem.eql(u8, sp.name, name)) return sp;
        }
        return null;
    }

    /// Returns the first recorded span named `name`, or `error.SpanNotFound`.
    pub fn requireSpan(self: *Recorder, name: []const u8) AssertError!*const o11y.SpanData {
        return self.span(name) orelse error.SpanNotFound;
    }

    /// Asserts that a span named `name` was recorded and returns it.
    pub fn expectSpan(self: *Recorder, name: []const u8) AssertError!*const o11y.SpanData {
        return self.requireSpan(name);
    }

    /// Asserts that no span named `name` was recorded.
    pub fn expectNoSpan(self: *Recorder, name: []const u8) AssertError!void {
        if (self.span(name) != null) return error.UnexpectedSpan;
    }

    // -----------------------------------------------------------------------
    // Logs (structured, console JSON, and OTLP)
    // -----------------------------------------------------------------------

    /// Returns all structured log records captured so far, in emission order.
    pub fn logs(self: *Recorder) []const LogRecord {
        self.log_capture.mutex.lockUncancelable(self.io);
        defer self.log_capture.mutex.unlock(self.io);
        return self.log_capture.records.items;
    }

    /// Returns the first captured log record with message `msg`, or null.
    pub fn log(self: *Recorder, msg: []const u8) ?*const LogRecord {
        self.log_capture.mutex.lockUncancelable(self.io);
        defer self.log_capture.mutex.unlock(self.io);
        for (self.log_capture.records.items) |*rec| {
            if (std.mem.eql(u8, rec.message, msg)) return rec;
        }
        return null;
    }

    /// Returns the first captured log record with message `msg`, or `error.LogNotFound`.
    pub fn requireLog(self: *Recorder, msg: []const u8) AssertError!*const LogRecord {
        return self.log(msg) orelse error.LogNotFound;
    }

    /// Asserts that a log record with message `msg` was captured and returns it.
    pub fn expectLog(self: *Recorder, msg: []const u8) AssertError!*const LogRecord {
        return self.requireLog(msg);
    }

    /// Asserts that an event with `event.name == name` was captured and returns it.
    pub fn expectEvent(self: *Recorder, name: []const u8) AssertError!*const LogRecord {
        self.log_capture.mutex.lockUncancelable(self.io);
        defer self.log_capture.mutex.unlock(self.io);
        for (self.log_capture.records.items) |*rec| {
            if (rec.eventName()) |en| {
                if (std.mem.eql(u8, en, name)) return rec;
            }
        }
        return error.EventNotFound;
    }

    /// Returns the raw console output bytes captured so far.
    pub fn consoleOutput(self: *Recorder) []const u8 {
        self.console_capture.mutex.lockUncancelable(self.io);
        defer self.console_capture.mutex.unlock(self.io);
        return self.console_capture.buf.items;
    }

    /// Returns each non-empty line written to the console buffer. Caller owns
    /// the returned slice (the line slices point into the recorder's buffer).
    pub fn consoleLogs(self: *Recorder, gpa: Allocator) Allocator.Error![][]const u8 {
        self.console_capture.mutex.lockUncancelable(self.io);
        defer self.console_capture.mutex.unlock(self.io);
        var lines: std.ArrayList([]const u8) = .empty;
        errdefer lines.deinit(gpa);
        var it = std.mem.splitScalar(u8, self.console_capture.buf.items, '\n');
        while (it.next()) |line| {
            if (line.len > 0) try lines.append(gpa, line);
        }
        return lines.toOwnedSlice(gpa);
    }

    /// Flushes the OTLP log pipeline (when active) and returns every exported
    /// OTLP `LogData` record captured so far.
    pub fn otlpLogs(self: *Recorder) []const *const o11y.LogData {
        if (!self.t.shutdown_started.load(.acquire)) {
            _ = self.t.forceFlush(null);
        }
        self.otlp_log_capture.mutex.lockUncancelable(self.io);
        defer self.otlp_log_capture.mutex.unlock(self.io);
        return self.otlp_log_capture.records.items;
    }

    /// Plants a synthetic `LogRecord` directly into the capture buffer without
    /// going through the redaction pipeline (for testing clear-text regression
    /// detection in `checkConforms`).
    pub fn plantLogForTest(self: *Recorder, record: LogRecord) Allocator.Error!void {
        try self.log_capture.appendCopy(record);
    }

    // -----------------------------------------------------------------------
    // Metrics and exemplars
    // -----------------------------------------------------------------------

    /// Collects a fresh caller-owned `o11y.ResourceMetrics` snapshot from the
    /// manual reader. Caller must call `deinit()` on the returned value.
    pub fn collectMetrics(self: *Recorder, gpa: Allocator) CollectError!o11y.ResourceMetrics {
        return self.metric_reader.collect(gpa);
    }

    /// Collects metrics from the manual reader and caches the snapshot in the
    /// recorder until `reset()` or `deinit()`.
    pub fn metrics(self: *Recorder) CollectError!*const o11y.ResourceMetrics {
        var rm = try self.metric_reader.collect(self.gpa);
        errdefer rm.deinit();
        self.query_mutex.lockUncancelable(self.io);
        defer self.query_mutex.unlock(self.io);
        try self.collected_metrics.append(self.gpa, rm);
        return &self.collected_metrics.items[self.collected_metrics.items.len - 1];
    }

    /// Collects metrics and returns the names of all recorded instruments.
    /// The returned slice is owned by the recorder until `reset()` or `deinit()`.
    pub fn metricNames(self: *Recorder) CollectError![]const []const u8 {
        const rm = try self.metrics();
        self.query_mutex.lockUncancelable(self.io);
        defer self.query_mutex.unlock(self.io);
        const a = self.query_arena.allocator();
        var names: std.ArrayList([]const u8) = .empty;
        for (rm.scope_metrics) |sm| {
            for (sm.metrics) |m| {
                try names.append(a, m.name);
            }
        }
        return names.items;
    }

    /// Collects metrics and returns the first instrument named `name`, or null.
    pub fn metric(self: *Recorder, name: []const u8) CollectError!?*const o11y.Metric {
        const rm = try self.metrics();
        return rm.find(name);
    }

    /// Collects metrics and returns the instrument named `name`, or `error.MetricNotFound`.
    pub fn requireMetric(self: *Recorder, name: []const u8) (CollectError || AssertError)!*const o11y.Metric {
        return (try self.metric(name)) orelse error.MetricNotFound;
    }

    /// Asserts that a metric named `name` has recorded data and returns it.
    pub fn expectMetric(self: *Recorder, name: []const u8) (CollectError || AssertError)!*const o11y.Metric {
        return self.requireMetric(name);
    }

    /// Collects metrics and returns every exemplar recorded on `instrument_name`
    /// across all data points. Owned by the recorder until `reset()` or `deinit()`.
    pub fn exemplars(self: *Recorder, instrument_name: []const u8) CollectError![]const Exemplar {
        const rm = try self.metrics();
        self.query_mutex.lockUncancelable(self.io);
        defer self.query_mutex.unlock(self.io);
        const a = self.query_arena.allocator();
        var out: std.ArrayList(Exemplar) = .empty;
        for (rm.scope_metrics) |sm| {
            for (sm.metrics) |m| {
                if (!std.mem.eql(u8, m.name, instrument_name)) continue;
                try collectMetricExemplars(a, &out, m.data);
            }
        }
        return out.items;
    }

    /// Asserts that `instrument_name` has at least one exemplar (and when
    /// `expected_trace_id` is non-null, one carrying that trace ID) and returns it.
    pub fn expectExemplar(
        self: *Recorder,
        instrument_name: []const u8,
        expected_trace_id: ?o11y.TraceId,
    ) (CollectError || AssertError)!Exemplar {
        const list = try self.exemplars(instrument_name);
        if (list.len == 0) return error.ExemplarNotFound;
        if (expected_trace_id) |want| {
            for (list) |ex| {
                if (std.mem.eql(u8, &ex.trace_id.bytes, &want.bytes)) return ex;
            }
            return error.ExemplarNotFound;
        }
        return list[0];
    }

    // -----------------------------------------------------------------------
    // Violations & conformance
    // -----------------------------------------------------------------------

    /// Sums `o11y.schema.violations` data points matching optional `signal`
    /// and optional `rule`.
    pub fn violations(self: *Recorder, signal: ?spec.Signal, rule: ?[]const u8) CollectError!i64 {
        var rm = try self.metric_reader.collect(self.gpa);
        defer rm.deinit();
        return sumViolations(&rm, signal, rule);
    }

    /// Asserts that zero `o11y.schema.violations` were recorded across all signals.
    pub fn expectNoViolations(self: *Recorder) (CollectError || AssertError)!void {
        if ((try self.violations(null, null)) > 0) return error.UnexpectedViolations;
    }

    /// Asserts that at least `min_count` violations were recorded for optional
    /// `signal` and `rule`.
    pub fn expectViolations(self: *Recorder, signal: ?spec.Signal, rule: ?[]const u8, min_count: i64) (CollectError || AssertError)!void {
        const count = try self.violations(signal, rule);
        if (count < min_count) return error.ExpectedViolations;
    }

    /// Evaluates full libo11y specification conformance and returns a structured
    /// `ConformanceReport` listing every violation found (mirroring Go's
    /// `Recorder.AssertConforms`):
    /// - every `spec.required_tier0` attribute present on `t.resource()`;
    /// - `forceFlush` succeeds;
    /// - zero `o11y.schema.violations` with `o11y.rule=secret_attribute` on any
    ///   signal (distinct message for `resource` vs code signals);
    /// - no spec-table `.secret` attribute visible in the clear on captured logs
    ///   (walking dotted keys through nested maps/arrays) or recorded spans
    ///   (attributes, events, links);
    /// - every recorded event satisfies its registered contract in `spec.events`.
    pub fn checkConforms(self: *Recorder, gpa: Allocator) Allocator.Error!ConformanceReport {
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        errdefer arena_state.deinit();
        const a = arena_state.allocator();
        var problems: std.ArrayList([]const u8) = .empty;

        // 1. Required tier-0 resource attributes.
        const res_attrs = self.t.resource().attributes;
        for (spec.required_tier0) |req_key| {
            const present = for (res_attrs) |kv| {
                if (std.mem.eql(u8, kv.key, req_key)) break true;
            } else false;
            if (!present) {
                try problems.append(a, try std.fmt.allocPrint(
                    a,
                    "o11ytest: resource missing required tier-0 attribute \"{s}\"",
                    .{req_key},
                ));
            }
        }

        // 2. Flush before reading violation counters (so batch exporters count).
        const flush_report = self.t.forceFlush(null);
        if (!flush_report.ok()) {
            if (flush_report.logs) |err| {
                try problems.append(a, try std.fmt.allocPrint(a, "o11ytest: flushing before conformance checks (logs): {s}", .{@errorName(err)}));
            }
            if (flush_report.metrics) |err| {
                try problems.append(a, try std.fmt.allocPrint(a, "o11ytest: flushing before conformance checks (metrics): {s}", .{@errorName(err)}));
            }
            if (flush_report.traces) |err| {
                try problems.append(a, try std.fmt.allocPrint(a, "o11ytest: flushing before conformance checks (traces): {s}", .{@errorName(err)}));
            }
        }

        // 3. Check o11y.schema.violations for secret_attribute per signal.
        if (self.metric_reader.collect(gpa)) |collected| {
            var rm = collected;
            defer rm.deinit();
            const signal_order = [_]spec.Signal{ .logs, .metrics, .resource, .traces };
            for (signal_order) |sig| {
                const n = sumViolations(&rm, sig, "secret_attribute");
                if (n <= 0) continue;
                if (sig == .resource) {
                    try problems.append(a, try std.fmt.allocPrint(
                        a,
                        "o11ytest: options passed to start put a secret-classified attribute on the resource ({d} redaction(s) counted); it was redacted, but secrets must never be emitted",
                        .{n},
                    ));
                } else {
                    try problems.append(a, try std.fmt.allocPrint(
                        a,
                        "o11ytest: the code under test emitted secret-classified attributes on {s} ({d} redaction(s) counted); they were redacted, but secrets must never be emitted",
                        .{ sig.asStr(), n },
                    ));
                }
            }
        } else |err| {
            if (err == error.OutOfMemory) return error.OutOfMemory;
            try problems.append(a, try std.fmt.allocPrint(a, "o11ytest: collecting metrics: {s}", .{@errorName(err)}));
        }

        // 4. Scan captured logs for clear-text secrets and event contracts.
        for (self.logs()) |*rec| {
            var keys: std.ArrayList([]const u8) = .empty;
            try walkLogAttrs(a, "", rec.attributes, &keys, &problems, rec.message, 0);
            if (rec.eventName()) |ev_name| {
                const ev_problems = try checkEvent(a, ev_name, keys.items);
                for (ev_problems) |p| {
                    try problems.append(a, try std.fmt.allocPrint(a, "o11ytest: {s}", .{p}));
                }
            }
        }

        // 5. Scan recorded spans (attributes, events, links) for clear-text secrets.
        for (self.spans()) |sp| {
            for (sp.attributes.items) |kv| {
                if (spec.sensitivityOf(kv.key) == .secret) {
                    try problems.append(a, try std.fmt.allocPrint(
                        a,
                        "o11ytest: span \"{s}\" carries secret-classified attribute \"{s}\" in the clear",
                        .{ sp.name, kv.key },
                    ));
                }
            }
            for (sp.events.items) |ev| {
                for (ev.attributes) |kv| {
                    if (spec.sensitivityOf(kv.key) == .secret) {
                        try problems.append(a, try std.fmt.allocPrint(
                            a,
                            "o11ytest: span \"{s}\" event \"{s}\" carries secret-classified attribute \"{s}\" in the clear",
                            .{ sp.name, ev.name, kv.key },
                        ));
                    }
                }
            }
            for (sp.links.items) |link| {
                for (link.attributes) |kv| {
                    if (spec.sensitivityOf(kv.key) == .secret) {
                        try problems.append(a, try std.fmt.allocPrint(
                            a,
                            "o11ytest: span \"{s}\" link carries secret-classified attribute \"{s}\" in the clear",
                            .{ sp.name, kv.key },
                        ));
                    }
                }
            }
        }

        return .{
            .arena = arena_state,
            .problems = problems.items,
        };
    }

    /// Fails with `error.ConformanceFailed` if `checkConforms` reports any problem.
    pub fn expectConforms(self: *Recorder) AssertError!void {
        var report = try self.checkConforms(self.gpa);
        defer report.deinit();
        if (!report.ok()) return error.ConformanceFailed;
    }

    /// Checks that every captured log emitted inside a valid span context
    /// carries matching `trace_id` and `span_id` attributes.
    pub fn checkCorrelated(self: *Recorder, gpa: Allocator) Allocator.Error!ConformanceReport {
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        errdefer arena_state.deinit();
        const a = arena_state.allocator();
        var problems: std.ArrayList([]const u8) = .empty;

        for (self.logs()) |*rec| {
            if (!rec.span_context.isValid()) continue;
            const want_trace = rec.span_context.trace_id.hex();
            const want_span = rec.span_context.span_id.hex();

            const got_trace = rec.attrString("trace_id") orelse {
                try problems.append(a, try std.fmt.allocPrint(
                    a,
                    "o11ytest: correlated record \"{s}\" has no trace_id attribute",
                    .{rec.message},
                ));
                continue;
            };
            if (!std.mem.eql(u8, got_trace, &want_trace)) {
                try problems.append(a, try std.fmt.allocPrint(
                    a,
                    "o11ytest: record \"{s}\" trace_id \"{s}\" does not match its span \"{s}\"",
                    .{ rec.message, got_trace, &want_trace },
                ));
            }
            const got_span = rec.attrString("span_id") orelse {
                try problems.append(a, try std.fmt.allocPrint(
                    a,
                    "o11ytest: correlated record \"{s}\" has no span_id attribute",
                    .{rec.message},
                ));
                continue;
            };
            if (!std.mem.eql(u8, got_span, &want_span)) {
                try problems.append(a, try std.fmt.allocPrint(
                    a,
                    "o11ytest: record \"{s}\" span_id \"{s}\" does not match its span \"{s}\"",
                    .{ rec.message, got_span, &want_span },
                ));
            }
        }

        return .{
            .arena = arena_state,
            .problems = problems.items,
        };
    }

    /// Fails with `error.CorrelationFailed` unless every log inside a span
    /// carries matching `trace_id` and `span_id`.
    pub fn expectCorrelated(self: *Recorder) AssertError!void {
        var report = try self.checkCorrelated(self.gpa);
        defer report.deinit();
        if (!report.ok()) return error.CorrelationFailed;
    }

    /// Checks that the full correlation triangle closes for `metric_name`:
    /// a recorded span, a captured log carrying its trace and span IDs, and an
    /// exemplar on `metric_name` carrying the same trace ID.
    pub fn checkTriangle(self: *Recorder, gpa: Allocator, metric_name: []const u8) (CollectError || Allocator.Error)!ConformanceReport {
        var arena_state: std.heap.ArenaAllocator = .init(gpa);
        errdefer arena_state.deinit();
        const a = arena_state.allocator();
        var problems: std.ArrayList([]const u8) = .empty;

        const recorded_spans = self.spans();
        if (recorded_spans.len == 0) {
            try problems.append(a, "o11ytest: triangle has no recorded spans");
            return .{ .arena = arena_state, .problems = problems.items };
        }
        const recorded_logs = self.logs();
        const recorded_exemplars = try self.exemplars(metric_name);

        var closed = false;
        for (recorded_spans) |sp| {
            const tid = sp.span_context.trace_id;
            const sid = sp.span_context.span_id;
            if (!tid.isValid()) continue;
            const tid_hex = tid.hex();
            const sid_hex = sid.hex();

            const has_log = for (recorded_logs) |*lr| {
                const lt = lr.attrString("trace_id") orelse continue;
                const ls = lr.attrString("span_id") orelse continue;
                if (std.mem.eql(u8, lt, &tid_hex) and std.mem.eql(u8, ls, &sid_hex)) break true;
            } else false;

            const has_ex = for (recorded_exemplars) |ex| {
                if (std.mem.eql(u8, &ex.trace_id.bytes, &tid.bytes)) break true;
            } else false;

            if (has_log and has_ex) {
                closed = true;
                break;
            }
        }

        if (!closed) {
            try problems.append(a, try std.fmt.allocPrint(
                a,
                "o11ytest: correlation triangle did not close for metric \"{s}\" (spans={d}, logs={d}, exemplars={d})",
                .{ metric_name, recorded_spans.len, recorded_logs.len, recorded_exemplars.len },
            ));
        }

        return .{
            .arena = arena_state,
            .problems = problems.items,
        };
    }

    /// Fails with `error.TriangleFailed` unless the correlation triangle closes.
    pub fn expectTriangle(self: *Recorder, metric_name: []const u8) (CollectError || AssertError)!void {
        var report = try self.checkTriangle(self.gpa, metric_name);
        defer report.deinit();
        if (!report.ok()) return error.TriangleFailed;
    }
};

fn walkLogAttrs(
    arena: Allocator,
    prefix: []const u8,
    attrs: []const o11y.LogAttribute,
    keys: *std.ArrayList([]const u8),
    problems: *std.ArrayList([]const u8),
    msg: []const u8,
    depth: usize,
) Allocator.Error!void {
    if (depth > 32) return;
    for (attrs) |kv| {
        const eff: []const u8 = if (kv.key.len == 0)
            prefix
        else if (prefix.len == 0)
            kv.key
        else
            try std.fmt.allocPrint(arena, "{s}.{s}", .{ prefix, kv.key });

        switch (kv.value) {
            .map => |members| {
                try walkLogAttrs(arena, eff, members, keys, problems, msg, depth + 1);
            },
            .array => |items| {
                try keys.append(arena, eff);
                if (spec.sensitivityOf(eff) == .secret) {
                    try problems.append(arena, try std.fmt.allocPrint(
                        arena,
                        "o11ytest: log record \"{s}\" carries secret-classified attribute \"{s}\" in the clear",
                        .{ msg, eff },
                    ));
                }
                for (items) |item| {
                    if (item == .map) {
                        try walkLogAttrs(arena, eff, item.map, keys, problems, msg, depth + 1);
                    }
                }
            },
            else => {
                try keys.append(arena, eff);
                if (spec.sensitivityOf(eff) == .secret) {
                    try problems.append(arena, try std.fmt.allocPrint(
                        arena,
                        "o11ytest: log record \"{s}\" carries secret-classified attribute \"{s}\" in the clear",
                        .{ msg, eff },
                    ));
                }
            },
        }
    }
}

fn collectMetricExemplars(arena: Allocator, out: *std.ArrayList(Exemplar), data: o11y.MetricData) Allocator.Error!void {
    switch (data) {
        .sum => |s| {
            for (s.data_points) |dp| try appendExemplars(arena, out, dp.exemplars);
        },
        .gauge => |g| {
            for (g.data_points) |dp| try appendExemplars(arena, out, dp.exemplars);
        },
        .histogram => |h| {
            for (h.data_points) |dp| try appendExemplars(arena, out, dp.exemplars);
        },
    }
}

fn appendExemplars(arena: Allocator, out: *std.ArrayList(Exemplar), src: []const o11y.MetricExemplar) Allocator.Error!void {
    for (src) |e| {
        try out.append(arena, .{
            .trace_id = e.trace_id,
            .span_id = e.span_id,
            .value = e.value.toDouble(),
            .time_unix_nano = e.time_unix_nano,
            .filtered_attributes = e.filtered_attributes,
        });
    }
}

fn sumViolations(rm: *const o11y.ResourceMetrics, signal: ?spec.Signal, rule: ?[]const u8) i64 {
    var total: i64 = 0;
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            if (!std.mem.eql(u8, m.name, spec.metric.schema_violations)) continue;
            if (m.data != .sum) continue;
            for (m.data.sum.data_points) |dp| {
                if (dp.value != .int or dp.value.int <= 0) continue;
                if (signal) |want_sig| {
                    const got = findAttrString(dp.attributes, spec.Signal.key) orelse continue;
                    if (!std.mem.eql(u8, got, want_sig.asStr())) continue;
                }
                if (rule) |want_rule| {
                    const got = findAttrString(dp.attributes, spec.attr.rule) orelse continue;
                    if (!std.mem.eql(u8, got, want_rule)) continue;
                }
                total += dp.value.int;
            }
        }
    }
    return total;
}

fn findAttrString(attrs: []const o11y.Attribute, key: []const u8) ?[]const u8 {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) {
            return switch (attrs[i].value) {
                .string => |s| s,
                else => null,
            };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Internal capture components
// ---------------------------------------------------------------------------

const SpanRecorder = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    spans: std.ArrayList(*const o11y.SpanData) = .empty,
    is_shutdown: bool = false,

    fn init(gpa: Allocator, io: Io) SpanRecorder {
        return .{ .gpa = gpa, .io = io };
    }

    fn deinit(self: *SpanRecorder) void {
        self.reset();
        self.spans.deinit(self.gpa);
    }

    fn reset(self: *SpanRecorder) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        for (self.spans.items) |sp| sp.release();
        self.spans.clearRetainingCapacity();
    }

    fn processor(self: *SpanRecorder) o11y.SpanProcessor {
        return .{
            .ptr = self,
            .vtable = &.{
                .onStart = onStart,
                .onEnd = onEnd,
                .forceFlush = forceFlush,
                .shutdown = shutdown,
            },
        };
    }

    fn onStart(_: *anyopaque, _: o11y.Context, _: *o11y.SpanData) void {}

    fn onEnd(ptr: *anyopaque, sp: *const o11y.SpanData) void {
        const self: *SpanRecorder = @ptrCast(@alignCast(ptr));
        if (!sp.span_context.isSampled()) return;
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.is_shutdown) return;
        sp.retain();
        self.spans.append(self.gpa, sp) catch {
            sp.release();
        };
    }

    fn forceFlush(_: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {}

    fn shutdown(ptr: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {
        const self: *SpanRecorder = @ptrCast(@alignCast(ptr));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.is_shutdown = true;
    }
};

const LogCapture = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    arena: std.heap.ArenaAllocator,
    records: std.ArrayList(LogRecord) = .empty,

    fn init(gpa: Allocator, io: Io) LogCapture {
        return .{ .gpa = gpa, .io = io, .arena = .init(gpa) };
    }

    fn deinit(self: *LogCapture) void {
        self.records.deinit(self.gpa);
        self.arena.deinit();
    }

    fn reset(self: *LogCapture) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.records.clearRetainingCapacity();
        _ = self.arena.reset(.retain_capacity);
    }

    fn sink(self: *LogCapture) o11y.LogSink {
        return .{
            .ptr = self,
            .vtable = &.{
                .enabled = enabled,
                .emit = emit,
            },
        };
    }

    fn enabled(_: *anyopaque, _: o11y.Context, _: o11y.Level) bool {
        return true;
    }

    fn emit(ptr: *anyopaque, _: o11y.Context, rec: o11y.SinkRecord) o11y.LogSink.SinkError!void {
        const self: *LogCapture = @ptrCast(@alignCast(ptr));
        self.appendCopy(.{
            .time_unix_nano = rec.time_unix_nano,
            .level = rec.level,
            .message = rec.message,
            .span_context = rec.span_context,
            .attributes = rec.attributes,
        }) catch return error.SinkRejected;
    }

    fn appendCopy(self: *LogCapture, rec: LogRecord) Allocator.Error!void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        const a = self.arena.allocator();
        const msg_copy = try a.dupe(u8, rec.message);
        const attrs_copy = try dupeLogAttrs(a, rec.attributes, 0);
        var sc = rec.span_context;
        if (sc.trace_state.header.len > 0) {
            sc.trace_state = .{ .header = try a.dupe(u8, sc.trace_state.header) };
        }
        try self.records.append(self.gpa, .{
            .time_unix_nano = rec.time_unix_nano,
            .level = rec.level,
            .message = msg_copy,
            .span_context = sc,
            .attributes = attrs_copy,
        });
    }
};

fn dupeLogAttrs(arena: Allocator, attrs: []const o11y.LogAttribute, depth: usize) Allocator.Error![]const o11y.LogAttribute {
    if (attrs.len == 0 or depth > 64) return &.{};
    const out = try arena.alloc(o11y.LogAttribute, attrs.len);
    for (out, attrs) |*dst, src| {
        dst.* = .{
            .key = try arena.dupe(u8, src.key),
            .value = try dupeLogValue(arena, src.value, depth + 1),
        };
    }
    return out;
}

fn dupeLogValue(arena: Allocator, val: o11y.LogValue, depth: usize) Allocator.Error!o11y.LogValue {
    if (depth > 64) return .empty;
    return switch (val) {
        .empty => .empty,
        .bool => |b| .{ .bool = b },
        .int => |i| .{ .int = i },
        .double => |d| .{ .double = d },
        .string => |s| .{ .string = try arena.dupe(u8, s) },
        .bytes => |b| .{ .bytes = try arena.dupe(u8, b) },
        .array => |items| blk: {
            if (items.len == 0) break :blk .{ .array = &.{} };
            const out = try arena.alloc(o11y.LogValue, items.len);
            for (out, items) |*dst, item| dst.* = try dupeLogValue(arena, item, depth + 1);
            break :blk .{ .array = out };
        },
        .map => |pairs| .{ .map = try dupeLogAttrs(arena, pairs, depth + 1) },
    };
}

const OtlpLogCapture = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    records: std.ArrayList(*const o11y.LogData) = .empty,
    is_shutdown: bool = false,

    fn init(gpa: Allocator, io: Io) OtlpLogCapture {
        return .{ .gpa = gpa, .io = io };
    }

    fn deinit(self: *OtlpLogCapture) void {
        self.reset();
        self.records.deinit(self.gpa);
    }

    fn reset(self: *OtlpLogCapture) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        for (self.records.items) |rec| rec.release();
        self.records.clearRetainingCapacity();
    }

    fn exporter(self: *OtlpLogCapture) o11y.LogExporter {
        return .{
            .ptr = self,
            .vtable = &.{
                .exportLogs = exportLogs,
                .forceFlush = forceFlush,
                .shutdown = shutdown,
            },
        };
    }

    fn exportLogs(ptr: *anyopaque, records: []const *const o11y.LogData, _: o11y.Deadline) o11y.ExportError!void {
        const self: *OtlpLogCapture = @ptrCast(@alignCast(ptr));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.is_shutdown) return error.Shutdown;
        self.records.ensureUnusedCapacity(self.gpa, records.len) catch return error.ExportFailed;
        for (records) |rec| {
            rec.retain();
            self.records.appendAssumeCapacity(rec);
        }
    }

    fn forceFlush(_: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {}

    fn shutdown(ptr: *anyopaque, _: o11y.Deadline) o11y.ExportError!void {
        const self: *OtlpLogCapture = @ptrCast(@alignCast(ptr));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.is_shutdown = true;
    }
};

const ConsoleCapture = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    buf: std.ArrayList(u8) = .empty,

    fn init(gpa: Allocator, io: Io) ConsoleCapture {
        return .{ .gpa = gpa, .io = io };
    }

    fn deinit(self: *ConsoleCapture) void {
        self.buf.deinit(self.gpa);
    }

    fn reset(self: *ConsoleCapture) void {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.buf.clearRetainingCapacity();
    }

    fn writer(self: *ConsoleCapture) o11y.ConsoleWriter {
        return .{ .custom = .{ .ptr = self, .writeFn = writeFn } };
    }

    fn writeFn(ptr: *anyopaque, bytes: []const u8) o11y.ConsoleWriter.WriteError!void {
        const self: *ConsoleCapture = @ptrCast(@alignCast(ptr));
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        self.buf.appendSlice(self.gpa, bytes) catch return error.WriteFailed;
    }
};
