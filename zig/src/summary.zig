//! Startup canary (`o11y.telemetry.configured`) and `effectiveConfig()`
//! builder, matching Go's `summary.go` attribute order, names, and endpoint
//! sanitization.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const endpoint = @import("endpoint.zig");
const log_pipeline = @import("log_pipeline.zig");
const resource_mod = @import("resource.zig");
const spec = @import("spec.zig");
const attribute = @import("pipeline/attribute.zig");
const log_record = @import("pipeline/log_record.zig");
const propagation = @import("pipeline/propagation.zig");
const sampler_mod = @import("pipeline/sampler.zig");

/// Owned startup summary attributes and one-line `effectiveConfig()` string.
pub const Summary = struct {
    arena: std.heap.ArenaAllocator,
    attrs: []const log_record.KeyValue,
    effective_config: []const u8,

    pub fn deinit(s: *Summary) void {
        s.arena.deinit();
    }
};

/// Inputs describing the fully resolved SDK configuration.
pub const SummaryInputs = struct {
    resource_attrs: []const attribute.KeyValue,
    env: resource_mod.Env,
    disabled: bool,
    traces_injected: bool,
    metrics_injected: bool,
    logs_enabled: bool,
    logs_injected: bool,
    console_enabled: bool,
    console_format: log_pipeline.ConsoleFormat,
    log_level: log_pipeline.Level,
    explicit_sampler: ?sampler_mod.Sampler,
    propagator: propagation.Propagator,
    runtime_metrics_enabled: bool,
    version_fallback: bool,
};

/// Builds the startup summary attributes in Go's exact order and formats the
/// space-separated `key=value` `effectiveConfig()` line.
pub fn build(gpa: Allocator, in: SummaryInputs) Allocator.Error!Summary {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena_state.deinit();
    const arena = arena_state.allocator();

    var service_name: []const u8 = "";
    var service_version: []const u8 = "";
    for (in.resource_attrs) |kv| {
        if (std.mem.eql(u8, kv.key, "service.name") and kv.value == .string) {
            service_name = kv.value.string;
        } else if (std.mem.eql(u8, kv.key, "service.version") and kv.value == .string) {
            service_version = kv.value.string;
        }
    }

    var traces: []const u8 = if (in.traces_injected)
        "injected"
    else if (in.env.isHermetic())
        "none"
    else
        exporterName(in.env, "OTEL_TRACES_EXPORTER");

    var metrics: []const u8 = if (in.metrics_injected)
        "injected"
    else if (in.env.isHermetic())
        "none"
    else
        exporterName(in.env, "OTEL_METRICS_EXPORTER");

    var logs: []const u8 = if (!in.logs_enabled)
        "none"
    else if (in.logs_injected)
        "injected"
    else
        exporterName(in.env, "OTEL_LOGS_EXPORTER");

    if (in.disabled) {
        traces = "none";
        metrics = "none";
        logs = "none";
    }

    const console: []const u8 = if (!in.console_enabled)
        "off"
    else switch (in.console_format) {
        .json => "json",
        .text => "text",
    };

    const sampler_text: []const u8 = if (in.explicit_sampler) |s| blk: {
        var w: Io.Writer.Allocating = .init(arena);
        s.writeDescription(&w.writer) catch return error.OutOfMemory;
        break :blk w.written();
    } else blk: {
        const raw = std.mem.trim(u8, in.env.getOr("OTEL_TRACES_SAMPLER", "parentbased_always_on"), " \t\r\n");
        const lower = try std.ascii.allocLowerString(arena, raw);
        break :blk if (knownSampler(lower)) lower else "parentbased_always_on";
    };

    var prop_buf: Io.Writer.Allocating = .init(arena);
    for (in.propagator.fields(), 0..) |f, i| {
        if (i > 0) prop_buf.writer.writeByte(',') catch return error.OutOfMemory;
        prop_buf.writer.writeAll(f) catch return error.OutOfMemory;
    }
    // As in Go: a propagator that names no fields is reported as custom,
    // because an empty value would be easy to misread.
    const propagators_str = if (prop_buf.written().len > 0) prop_buf.written() else "custom";

    var attrs: std.ArrayList(log_record.KeyValue) = .empty;
    try attrs.append(arena, log_record.kv("service.name", try arena.dupe(u8, service_name)));
    if (service_version.len > 0) {
        try attrs.append(arena, log_record.kv("service.version", try arena.dupe(u8, service_version)));
    }
    try appendConfig(arena, &attrs, "traces", traces);
    try appendConfig(arena, &attrs, "metrics", metrics);
    try appendConfig(arena, &attrs, "logs", logs);
    try appendConfig(arena, &attrs, "console", console);
    try appendConfig(arena, &attrs, "level", in.log_level.asStr());
    try appendConfig(arena, &attrs, "sampler", sampler_text);
    try appendConfig(arena, &attrs, "propagators", propagators_str);
    try appendConfig(arena, &attrs, "runtime_metrics", if (in.runtime_metrics_enabled) "true" else "false");
    if (in.version_fallback) {
        try appendConfig(arena, &attrs, "service_version_fallback", "true");
    }

    const endpoint_vars = [_]struct { key: []const u8, env: []const u8 }{
        .{ .key = "endpoint", .env = "OTEL_EXPORTER_OTLP_ENDPOINT" },
        .{ .key = "traces_endpoint", .env = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" },
        .{ .key = "metrics_endpoint", .env = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT" },
        .{ .key = "logs_endpoint", .env = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT" },
    };
    for (endpoint_vars) |ep| {
        if (in.env.get(ep.env)) |raw| {
            if (raw.len > 0) {
                const sanitized = try endpoint.sanitize(arena, raw);
                try appendConfig(arena, &attrs, ep.key, sanitized);
            }
        }
    }

    var line: Io.Writer.Allocating = .init(arena);
    for (attrs.items, 0..) |kv, i| {
        if (i > 0) line.writer.writeByte(' ') catch return error.OutOfMemory;
        line.writer.print("{s}={s}", .{ kv.key, kv.value.string }) catch return error.OutOfMemory;
    }

    return .{
        .arena = arena_state,
        .attrs = attrs.items,
        .effective_config = line.written(),
    };
}

fn appendConfig(arena: Allocator, list: *std.ArrayList(log_record.KeyValue), key: []const u8, value: []const u8) Allocator.Error!void {
    const full_key = try std.fmt.allocPrint(arena, "{s}.{s}", .{ spec.attr.config, key });
    try list.append(arena, log_record.kv(full_key, try arena.dupe(u8, value)));
}

/// The exporter an `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` or
/// `OTEL_LOGS_EXPORTER` variable selects. The value is a comma-separated
/// list, and libo11y exports each signal to one place, so the first entry
/// that is not blank counts, as in TypeScript and Rust. An unset or blank
/// value means `otlp`.
pub fn exporterName(env: resource_mod.Env, key: []const u8) []const u8 {
    var entries = std.mem.splitScalar(u8, env.getOr(key, ""), ',');
    while (entries.next()) |entry| {
        const name = std.mem.trim(u8, entry, " \t\r\n");
        if (name.len > 0) return name;
    }
    return "otlp";
}

pub fn knownSampler(name: []const u8) bool {
    const known = [_][]const u8{
        "always_on",
        "always_off",
        "traceidratio",
        "parentbased_always_on",
        "parentbased_always_off",
        "parentbased_traceidratio",
    };
    for (known) |k| {
        if (std.mem.eql(u8, name, k)) return true;
    }
    return false;
}

const testing = std.testing;

test "build produces Go's exact config attribute order and sanitizes endpoints" {
    const res_attrs = [_]attribute.KeyValue{
        attribute.kv("service.name", "checkout"),
        attribute.kv("service.version", "1.2.3"),
    };
    const env: resource_mod.Env = .{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "https://user:secret@collector.example:4318/v1?api_key=abc#frag" },
        .{ "OTEL_TRACES_SAMPLER", "unknown_sampler" },
    } };
    var sum = try build(testing.allocator, .{
        .resource_attrs = &res_attrs,
        .env = env,
        .disabled = false,
        .traces_injected = false,
        .metrics_injected = true,
        .logs_enabled = true,
        .logs_injected = false,
        .console_enabled = true,
        .console_format = .json,
        .log_level = .info,
        .explicit_sampler = null,
        .propagator = propagation.default(),
        .runtime_metrics_enabled = true,
        .version_fallback = false,
    });
    defer sum.deinit();

    try testing.expectEqualStrings(
        "service.name=checkout service.version=1.2.3 o11y.config.traces=otlp o11y.config.metrics=injected o11y.config.logs=otlp o11y.config.console=json o11y.config.level=INFO o11y.config.sampler=parentbased_always_on o11y.config.propagators=traceparent,tracestate,baggage o11y.config.runtime_metrics=true o11y.config.endpoint=https://collector.example:4318/v1",
        sum.effective_config,
    );
}
