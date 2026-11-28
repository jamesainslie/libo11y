//! End-to-end OTLP wire tests exercising real `o11y.init` and `o11y.setup` SDK
//! instances against `o11ytest.HttpReceiver` (protobuf and OTLP/JSON, plain and
//! TLS/mTLS) and `o11ytest.GrpcReceiver` (h2c and TLS/mTLS), via both explicit
//! code exporters and `OTEL_EXPORTER_OTLP_*` environment configuration.
//!
//! Mirrors and extends `go/otlp_integration_test.go`.

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const spec = o11y.spec;
const o11ytest = @import("o11ytest.zig");
const proto = o11ytest.proto;
const inspect = o11ytest.inspect;

const wire_pii = "10.9.8.7";
const wire_secret = "s3cr3t-wire-sentinel";
const wire_hash_key = "0123456789abcdef0123456789abcdef";

const WireExpectMode = enum {
    drop,
    hash,
};

const WireIds = struct {
    trace_id: o11y.TraceId,
    span_id: o11y.SpanId,
};

/// Emits a full cross-signal workload (span with event + link, histogram with
/// exemplar and filtered attributes, flat + nested logs, registered event)
/// carrying both PII and secret sentinels, then returns the span's trace and
/// span IDs.
fn emitWireWorkload(sdk: *o11y.Telemetry) WireIds {
    const link_sc: o11y.SpanContext = .{
        .trace_id = o11y.TraceId.parseHex("11111111111111111111111111111111").?,
        .span_id = o11y.SpanId.parseHex("2222222222222222").?,
        .flags = .sampled_flag,
    };

    var sp = sdk.tracer("wire-tracer").start(.background, "wire-op", .{
        .attributes = &.{
            o11y.kv("http.request.method", "POST"),
            o11y.kv("host.ip", wire_pii),
            o11y.kv("http.request.header.authorization", wire_secret),
        },
        .links = &.{.{
            .span_context = link_sc,
            .attributes = &.{
                o11y.kv("link.tag", "ok"),
                o11y.kv("http.request.header.cookie", wire_secret),
                o11y.kv("host.ip", wire_pii),
            },
        }},
    });
    sp.addEvent("step", .{
        .attributes = &.{
            o11y.kv("step.num", 1),
            o11y.kv("http.request.header.authorization", wire_secret),
            o11y.kv("host.ip", wire_pii),
        },
    });

    const ctx = o11y.Context.background.withSpan(&sp);

    const hist = sdk.meter("wire-meter").histogram(f64, "work.duration", .{ .unit = "s" });
    hist.record(ctx, 0.5, &.{
        o11y.kv("http.request.method", "POST"),
        o11y.kv("order.id", "ord-wire-1"),
        o11y.kv("host.ip", wire_pii),
        o11y.kv("http.request.header.authorization", wire_secret),
    });

    const nested_secret = [_]o11y.LogAttribute{
        o11y.logKv("authorization", wire_secret),
        o11y.logKv("safe", "kept"),
    };
    const log_attrs = [_]o11y.LogAttribute{
        o11y.logKv("host.ip", wire_pii),
        o11y.logKv("http.request.header.authorization", wire_secret),
        .{ .key = "http.request.header", .value = .{ .map = &nested_secret } },
        o11y.logKv("order.id", "ord-wire-1"),
    };
    sdk.logger().info(ctx, "inside-wire", @as([]const o11y.LogAttribute, &log_attrs));

    sdk.event(ctx, spec.event.request_summary, .{
        .@"http.request.method" = "POST",
        .@"http.response.status_code" = 200,
        .@"o11y.outcome" = spec.Outcome.success.asStr(),
        .@"o11y.duration" = 0.5,
    });

    const out: WireIds = .{
        .trace_id = sp.spanContext().trace_id,
        .span_id = sp.spanContext().span_id,
    };
    sp.end();
    return out;
}

fn verifyResourceIdentity(
    attrs: []const proto.common_v1.KeyValue,
    schema_url: []const u8,
    want_service: []const u8,
    want_env: []const u8,
    mode: WireExpectMode,
) !void {
    try testing.expectEqualStrings(spec.schema_url, schema_url);
    try testing.expectEqualStrings(want_service, inspect.attrString(attrs, "service.name").?);
    try testing.expectEqualStrings(want_env, inspect.attrString(attrs, spec.Environment.key).?);
    const inst = inspect.attrString(attrs, "service.instance.id").?;
    try testing.expect(inst.len == 36); // UUID string

    // Secret never reaches the resource.
    try testing.expect(!inspect.hasAttr(attrs, "http.request.header.authorization"));
    try testing.expect(!inspect.hasAttr(attrs, "http.request.header.cookie"));

    // PII on resource: dropped in drop mode, hashed in hash mode, never clear text.
    switch (mode) {
        .drop => try testing.expect(!inspect.hasAttr(attrs, "host.ip")),
        .hash => {
            const h = inspect.attrString(attrs, "host.ip").?;
            try testing.expect(std.mem.startsWith(u8, h, "hmac-sha256:"));
            try testing.expect(std.mem.indexOf(u8, h, wire_pii) == null);
        },
    }
    const leaked = try inspect.attrsContainKeyOrSentinel(
        testing.allocator,
        attrs,
        &.{ "http.request.header.authorization", "http.request.header.cookie" },
        &.{ wire_pii, wire_secret },
    );
    try testing.expect(!leaked);
}

fn verifyWirePayloads(
    traces: []const proto.trace_v1.ResourceSpans,
    metrics: []const proto.metrics_v1.ResourceMetrics,
    logs: []const proto.logs_v1.ResourceLogs,
    want_service: []const u8,
    want_env: []const u8,
    want_trace_id: o11y.TraceId,
    want_span_id: o11y.SpanId,
    mode: WireExpectMode,
) !void {
    try testing.expect(traces.len > 0);
    try testing.expect(metrics.len > 0);
    try testing.expect(logs.len > 0);

    const forbidden_always = [_][]const u8{
        "http.request.header.authorization",
        "http.request.header.cookie",
    };
    const forbidden_drop = [_][]const u8{
        "http.request.header.authorization",
        "http.request.header.cookie",
        "host.ip",
    };
    const sentinels = [_][]const u8{ wire_pii, wire_secret };
    const forbidden_non_metric: []const []const u8 = if (mode == .drop) &forbidden_drop else &forbidden_always;

    // 1. Verify traces.
    var span_ip_hash: ?[]const u8 = null;
    for (traces) |*rs| {
        try verifyResourceIdentity(rs.resource.?.attributes.items, rs.schema_url, want_service, want_env, mode);
        for (rs.scope_spans.items) |*ss| {
            for (ss.spans.items) |*sp| {
                try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, sp.attributes.items, forbidden_non_metric, &sentinels));
                for (sp.events.items) |*ev| {
                    try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, ev.attributes.items, forbidden_non_metric, &sentinels));
                }
                for (sp.links.items) |*lk| {
                    try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, lk.attributes.items, forbidden_non_metric, &sentinels));
                }
            }
        }
    }
    const op = inspect.findSpan(traces, "wire-op").?;
    try testing.expectEqualSlices(u8, &want_trace_id.bytes, op.trace_id);
    try testing.expectEqualSlices(u8, &want_span_id.bytes, op.span_id);
    try testing.expectEqualStrings("POST", inspect.attrString(op.attributes.items, "http.request.method").?);
    if (mode == .hash) {
        span_ip_hash = inspect.attrString(op.attributes.items, "host.ip").?;
        try testing.expect(std.mem.startsWith(u8, span_ip_hash.?, "hmac-sha256:"));
    }
    try testing.expect(op.events.items.len == 1 and std.mem.eql(u8, op.events.items[0].name, "step"));
    try testing.expect(op.links.items.len == 1);

    // 2. Verify metrics: PII ALWAYS dropped on metrics + exemplars even in hash mode!
    var saw_hist_point = false;
    var saw_hist_exemplar = false;
    var saw_filtered_order_id = false;
    var saw_violations_metric = false;
    for (metrics) |*rm| {
        try verifyResourceIdentity(rm.resource.?.attributes.items, rm.schema_url, want_service, want_env, mode);
        for (rm.scope_metrics.items) |*sm| {
            for (sm.metrics.items) |*m| {
                if (std.mem.eql(u8, m.name, spec.metric.schema_violations)) {
                    saw_violations_metric = true;
                    const sum = m.data.?.sum;
                    var total: i64 = 0;
                    for (sum.data_points.items) |*dp| {
                        total += dp.value.?.as_int;
                    }
                    try testing.expect(total > 0);
                }
                if (std.mem.eql(u8, m.name, "work.duration")) {
                    const hist = m.data.?.histogram;
                    for (hist.data_points.items) |*dp| {
                        saw_hist_point = true;
                        try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, dp.attributes.items, &forbidden_drop, &sentinels));
                        try testing.expectEqualStrings("POST", inspect.attrString(dp.attributes.items, "http.request.method").?);
                        for (dp.exemplars.items) |*ex| {
                            try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, ex.filtered_attributes.items, &forbidden_drop, &sentinels));
                            if (std.mem.eql(u8, ex.trace_id, &want_trace_id.bytes) and std.mem.eql(u8, ex.span_id, &want_span_id.bytes)) {
                                saw_hist_exemplar = true;
                                if (inspect.attrString(ex.filtered_attributes.items, "order.id")) |oid| {
                                    if (std.mem.eql(u8, oid, "ord-wire-1")) saw_filtered_order_id = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    try testing.expect(saw_hist_point);
    try testing.expect(saw_hist_exemplar);
    try testing.expect(saw_filtered_order_id);
    try testing.expect(saw_violations_metric);

    // 3. Verify logs: correlation on regular log and event, no leaks, hash agreement.
    for (logs) |*rl| {
        try verifyResourceIdentity(rl.resource.?.attributes.items, rl.schema_url, want_service, want_env, mode);
        for (rl.scope_logs.items) |*sl| {
            for (sl.log_records.items) |*lr| {
                try testing.expect(!try inspect.attrsContainKeyOrSentinel(testing.allocator, lr.attributes.items, forbidden_non_metric, &sentinels));
                const body_text = try inspect.anyValueToText(testing.allocator, lr.body);
                defer testing.allocator.free(body_text);
                try testing.expect(std.mem.indexOf(u8, body_text, wire_pii) == null);
                try testing.expect(std.mem.indexOf(u8, body_text, wire_secret) == null);
            }
        }
    }
    const lr = inspect.findLogByBody(logs, "inside-wire").?;
    try testing.expectEqualSlices(u8, &want_trace_id.bytes, lr.trace_id);
    try testing.expectEqualSlices(u8, &want_span_id.bytes, lr.span_id);
    if (mode == .hash) {
        const log_ip_hash = inspect.attrString(lr.attributes.items, "host.ip").?;
        try testing.expectEqualStrings(span_ip_hash.?, log_ip_hash);
    }

    const ev = inspect.findLogByEvent(logs, spec.event.request_summary).?;
    try testing.expectEqualSlices(u8, &want_trace_id.bytes, ev.trace_id);
    try testing.expectEqualSlices(u8, &want_span_id.bytes, ev.span_id);
}

fn runExplicitHttpWireTest(protocol: o11y.otlp.HttpProtocol, compression: o11y.otlp.Compression, mode: WireExpectMode, use_mtls: bool) !void {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var tls_opt: ?o11ytest.HttpTlsOptions = null;
    var client_tls: o11y.otlp.TlsOptions = .{};
    var ca_path: ?[]u8 = null;
    defer if (ca_path) |p| testing.allocator.free(p);
    var cert_path: ?[]u8 = null;
    defer if (cert_path) |p| testing.allocator.free(p);
    var key_path: ?[]u8 = null;
    defer if (key_path) |p| testing.allocator.free(p);

    if (use_mtls) {
        try o11ytest.certs.writeAll(io, tmp.dir);
        ca_path = try o11ytest.certs.path(testing.allocator, &tmp, "ca.pem");
        cert_path = try o11ytest.certs.path(testing.allocator, &tmp, "client.pem");
        key_path = try o11ytest.certs.path(testing.allocator, &tmp, "client-key.pem");
        tls_opt = .{
            .cert_pem = o11ytest.certs.server,
            .key_pem = o11ytest.certs.server_key,
            .client_ca_pem = o11ytest.certs.ca,
        };
        client_tls = .{
            .ca_file = ca_path,
            .client_cert_file = cert_path,
            .client_key_file = key_path,
        };
    }

    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{ .tls = tls_opt });
    defer recv.deinit();

    const traces_url = try recv.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(traces_url);
    const metrics_url = try recv.url(testing.allocator, "/v1/metrics");
    defer testing.allocator.free(metrics_url);
    const logs_url = try recv.url(testing.allocator, "/v1/logs");
    defer testing.allocator.free(logs_url);

    const trace_exp = try o11y.otlp.TraceExporter.create(testing.allocator, io, .{
        .protocol = protocol,
        .endpoint = traces_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer trace_exp.destroy();

    const metric_exp = try o11y.otlp.MetricExporter.create(testing.allocator, io, .{
        .protocol = protocol,
        .endpoint = metrics_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer metric_exp.destroy();

    const periodic = try o11y.PeriodicMetricReader.create(testing.allocator, io, metric_exp.exporter(), .{
        .interval = .fromSeconds(3600),
    });
    defer periodic.destroy();

    const log_exp = try o11y.otlp.LogExporter.create(testing.allocator, io, .{
        .protocol = protocol,
        .endpoint = logs_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer log_exp.destroy();

    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "work.duration",
        .attribute_keys = &keep_keys,
    }};

    const sdk = try o11y.init(testing.allocator, io, .{
        .env = .hermetic,
        .service_name = "http-wire-svc",
        .environment = "test",
        .pii_mode = if (mode == .hash) .hash else .drop,
        .pii_hash_key = if (mode == .hash) wire_hash_key else "",
        .resource_attributes = &.{
            o11y.kv("host.ip", wire_pii),
            o11y.kv("http.request.header.authorization", wire_secret),
        },
        .views = &views,
        .console_enabled = false,
        .runtime_metrics = false,
        .span_exporter = trace_exp.exporter(),
        .metric_reader = periodic.reader(),
        .log_exporter = log_exp.exporter(),
    });
    defer sdk.deinit();

    const ids = emitWireWorkload(sdk);
    try testing.expect(sdk.shutdown(.fromSeconds(10)).ok());
    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    try verifyWirePayloads(
        recv.traces(),
        recv.metrics(),
        recv.logs(),
        "http-wire-svc",
        "test",
        ids.trace_id,
        ids.span_id,
        mode,
    );
}

test "wire: OTLP/HTTP protobuf explicit exporters (drop mode, plain)" {
    try runExplicitHttpWireTest(.http_protobuf, .none, .drop, false);
}

test "wire: OTLP/HTTP protobuf explicit exporters (hash mode, gzip, mTLS)" {
    try runExplicitHttpWireTest(.http_protobuf, .gzip, .hash, true);
}

test "wire: OTLP/HTTP JSON explicit exporters (drop mode, plain)" {
    try runExplicitHttpWireTest(.http_json, .none, .drop, false);
}

test "wire: OTLP/HTTP JSON explicit exporters (hash mode, gzip, mTLS)" {
    try runExplicitHttpWireTest(.http_json, .gzip, .hash, true);
}

fn runExplicitGrpcWireTest(compression: o11y.otlp.Compression, mode: WireExpectMode, use_mtls: bool) !void {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();

    var tls_opt: ?o11ytest.GrpcTlsOptions = null;
    var client_tls: o11y.otlp.TlsOptions = .{};
    var ca_path: ?[]u8 = null;
    defer if (ca_path) |p| testing.allocator.free(p);
    var cert_path: ?[]u8 = null;
    defer if (cert_path) |p| testing.allocator.free(p);
    var key_path: ?[]u8 = null;
    defer if (key_path) |p| testing.allocator.free(p);

    if (use_mtls) {
        try o11ytest.certs.writeAll(io, tmp.dir);
        ca_path = try o11ytest.certs.path(testing.allocator, &tmp, "ca.pem");
        cert_path = try o11ytest.certs.path(testing.allocator, &tmp, "client.pem");
        key_path = try o11ytest.certs.path(testing.allocator, &tmp, "client-key.pem");
        tls_opt = .{
            .cert_pem = o11ytest.certs.server,
            .key_pem = o11ytest.certs.server_key,
            .client_ca_pem = o11ytest.certs.ca,
        };
        client_tls = .{
            .ca_file = ca_path,
            .client_cert_file = cert_path,
            .client_key_file = key_path,
        };
    }

    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{ .tls = tls_opt });
    defer recv.deinit();

    const grpc_url = try recv.url(testing.allocator);
    defer testing.allocator.free(grpc_url);

    const trace_exp = try o11y.otlp.GrpcTraceExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer trace_exp.destroy();

    const metric_exp = try o11y.otlp.GrpcMetricExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer metric_exp.destroy();

    const periodic = try o11y.PeriodicMetricReader.create(testing.allocator, io, metric_exp.exporter(), .{
        .interval = .fromSeconds(3600),
    });
    defer periodic.destroy();

    const log_exp = try o11y.otlp.GrpcLogExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .compression = compression,
        .tls = client_tls,
    });
    defer log_exp.destroy();

    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "work.duration",
        .attribute_keys = &keep_keys,
    }};

    const sdk = try o11y.init(testing.allocator, io, .{
        .env = .hermetic,
        .service_name = "grpc-wire-svc",
        .environment = "production",
        .pii_mode = if (mode == .hash) .hash else .drop,
        .pii_hash_key = if (mode == .hash) wire_hash_key else "",
        .resource_attributes = &.{
            o11y.kv("host.ip", wire_pii),
            o11y.kv("http.request.header.authorization", wire_secret),
        },
        .views = &views,
        .console_enabled = false,
        .runtime_metrics = false,
        .span_exporter = trace_exp.exporter(),
        .metric_reader = periodic.reader(),
        .log_exporter = log_exp.exporter(),
    });
    defer sdk.deinit();

    const ids = emitWireWorkload(sdk);
    try testing.expect(sdk.shutdown(.fromSeconds(10)).ok());
    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    if (use_mtls) {
        try testing.expectEqualStrings("h2", recv.request(0).alpn_protocol.?);
    }

    try verifyWirePayloads(
        recv.traces(),
        recv.metrics(),
        recv.logs(),
        "grpc-wire-svc",
        "production",
        ids.trace_id,
        ids.span_id,
        mode,
    );
}

test "wire: OTLP/gRPC explicit exporters (h2c, drop mode)" {
    try runExplicitGrpcWireTest(.none, .drop, false);
}

test "wire: OTLP/gRPC explicit exporters (TLS ALPN h2 + mTLS, gzip, hash mode)" {
    try runExplicitGrpcWireTest(.gzip, .hash, true);
}

test "wire: OTLP/HTTP protobuf via Env (OTEL_EXPORTER_OTLP_*) with o11y.setup startup canary" {
    const io = testing.io;
    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{});
    defer recv.deinit();

    const base_url = try recv.baseUrl(testing.allocator);
    defer testing.allocator.free(base_url);

    const env_pairs = [_][2][]const u8{
        .{ "OTEL_SERVICE_NAME", "env-http-proto-svc" },
        .{ "OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=staging,host.ip=" ++ wire_pii ++ ",http.request.header.authorization=" ++ wire_secret },
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        .{ "OTEL_TRACES_EXPORTER", "otlp" },
        .{ "OTEL_METRICS_EXPORTER", "otlp" },
        .{ "OTEL_LOGS_EXPORTER", "otlp" },
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "3600000" },
        .{ "OTEL_BSP_SCHEDULE_DELAY", "60000" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "60000" },
    };

    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "work.duration",
        .attribute_keys = &keep_keys,
    }};

    const sdk = try o11y.setup(testing.allocator, io, .{
        .env = .{ .pairs = &env_pairs },
        .views = &views,
        .console_enabled = false,
        .runtime_metrics = false,
        .install_std_log = false,
    });
    defer sdk.deinit();

    const ids = emitWireWorkload(sdk);
    try testing.expect(sdk.shutdown(.fromSeconds(10)).ok());
    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    try verifyWirePayloads(
        recv.traces(),
        recv.metrics(),
        recv.logs(),
        "env-http-proto-svc",
        "staging",
        ids.trace_id,
        ids.span_id,
        .drop,
    );

    // Startup canary o11y.telemetry.configured also crossed the OTLP wire!
    const canary = inspect.findLogByEvent(recv.logs(), spec.event.telemetry_configured);
    try testing.expect(canary != null);
}

test "wire: a collector that rejects the final batches shows in the shutdown report" {
    const io = testing.io;
    // 400 is not retryable, so every export fails at once.
    const rejections: [8]o11ytest.HttpReply = @splat(.{ .status = 400, .body = "rejected" });
    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{ .replies = &rejections });
    defer recv.deinit();

    const base_url = try recv.baseUrl(testing.allocator);
    defer testing.allocator.free(base_url);

    const env_pairs = [_][2][]const u8{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "3600000" },
        .{ "OTEL_BSP_SCHEDULE_DELAY", "60000" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "60000" },
    };

    const Console = struct {
        buf: std.ArrayList(u8) = .empty,
        fn write(ptr: *anyopaque, bytes: []const u8) o11y.ConsoleWriter.WriteError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.buf.appendSlice(testing.allocator, bytes) catch return error.WriteFailed;
        }
    };
    var console: Console = .{};
    defer console.buf.deinit(testing.allocator);

    const sdk = try o11y.init(testing.allocator, io, .{
        .env = .{ .pairs = &env_pairs },
        .service_name = "rejected-svc",
        .environment = "test",
        .console_writer = .{ .custom = .{ .ptr = &console, .writeFn = Console.write } },
        .runtime_metrics = false,
        // The rejections are the point of the test, so keep them off stderr.
        .error_handler = .ignore,
    });
    defer sdk.deinit();

    _ = emitWireWorkload(sdk);
    const report = sdk.shutdown(.fromSeconds(10));
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), report.traces);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), report.logs);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), report.metrics);

    // The loss is also said on the sinks that still work.
    const out = console.buf.items;
    try testing.expect(std.mem.indexOf(u8, out, "\"event.name\":\"o11y.telemetry.dropped\"") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"o11y.signal\":\"traces\"") != null);
    try testing.expect(std.mem.indexOf(u8, out, "\"o11y.signal\":\"logs\"") != null);
}

test "wire: OTLP/HTTP JSON + gzip + mTLS via Env (OTEL_EXPORTER_OTLP_*)" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try o11ytest.certs.writeAll(io, tmp.dir);
    const ca_path = try o11ytest.certs.path(testing.allocator, &tmp, "ca.pem");
    defer testing.allocator.free(ca_path);
    const cert_path = try o11ytest.certs.path(testing.allocator, &tmp, "client.pem");
    defer testing.allocator.free(cert_path);
    const key_path = try o11ytest.certs.path(testing.allocator, &tmp, "client-key.pem");
    defer testing.allocator.free(key_path);

    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{
        .tls = .{
            .cert_pem = o11ytest.certs.server,
            .key_pem = o11ytest.certs.server_key,
            .client_ca_pem = o11ytest.certs.ca,
        },
    });
    defer recv.deinit();

    const base_url = try recv.baseUrl(testing.allocator);
    defer testing.allocator.free(base_url);

    const env_pairs = [_][2][]const u8{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http/json" },
        .{ "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
        .{ "OTEL_EXPORTER_OTLP_CERTIFICATE", ca_path },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert_path },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_KEY", key_path },
        .{ "OTEL_EXPORTER_OTLP_HEADERS", "x-wire-token=abc123" },
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "3600000" },
        .{ "OTEL_BSP_SCHEDULE_DELAY", "60000" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "60000" },
    };

    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "work.duration",
        .attribute_keys = &keep_keys,
    }};

    const sdk = try o11y.init(testing.allocator, io, .{
        .env = .{ .pairs = &env_pairs },
        .service_name = "env-json-mtls",
        .environment = "production",
        .pii_mode = .hash,
        .pii_hash_key = wire_hash_key,
        .resource_attributes = &.{
            o11y.kv("host.ip", wire_pii),
            o11y.kv("http.request.header.authorization", wire_secret),
        },
        .views = &views,
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    const ids = emitWireWorkload(sdk);
    try testing.expect(sdk.shutdown(.fromSeconds(10)).ok());
    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    // Verify custom header and gzip encoding arrived on the wire.
    for (0..recv.requestCount()) |i| {
        const req = recv.request(i);
        try testing.expectEqualStrings("application/json", req.content_type.?);
        try testing.expectEqualStrings("gzip", req.content_encoding.?);
        try testing.expectEqualStrings("abc123", req.header("x-wire-token").?);
    }

    try verifyWirePayloads(
        recv.traces(),
        recv.metrics(),
        recv.logs(),
        "env-json-mtls",
        "production",
        ids.trace_id,
        ids.span_id,
        .hash,
    );
}

test "wire: OTLP/gRPC + mTLS + gzip via Env (OTEL_EXPORTER_OTLP_*)" {
    const io = testing.io;
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try o11ytest.certs.writeAll(io, tmp.dir);
    const ca_path = try o11ytest.certs.path(testing.allocator, &tmp, "ca.pem");
    defer testing.allocator.free(ca_path);
    const cert_path = try o11ytest.certs.path(testing.allocator, &tmp, "client.pem");
    defer testing.allocator.free(cert_path);
    const key_path = try o11ytest.certs.path(testing.allocator, &tmp, "client-key.pem");
    defer testing.allocator.free(key_path);

    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{
        .tls = .{
            .cert_pem = o11ytest.certs.server,
            .key_pem = o11ytest.certs.server_key,
            .client_ca_pem = o11ytest.certs.ca,
        },
    });
    defer recv.deinit();

    const grpc_url = try recv.url(testing.allocator);
    defer testing.allocator.free(grpc_url);

    const env_pairs = [_][2][]const u8{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", grpc_url },
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
        .{ "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
        .{ "OTEL_EXPORTER_OTLP_CERTIFICATE", ca_path },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert_path },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_KEY", key_path },
        .{ "OTEL_EXPORTER_OTLP_HEADERS", "x-grpc-key=val99" },
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "3600000" },
        .{ "OTEL_BSP_SCHEDULE_DELAY", "60000" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "60000" },
    };

    const keep_keys = [_][]const u8{"http.request.method"};
    const views = [_]o11y.View{.{
        .instrument_name = "work.duration",
        .attribute_keys = &keep_keys,
    }};

    const sdk = try o11y.init(testing.allocator, io, .{
        .env = .{ .pairs = &env_pairs },
        .service_name = "env-grpc-mtls",
        .environment = "development",
        .pii_mode = .drop,
        .resource_attributes = &.{
            o11y.kv("host.ip", wire_pii),
            o11y.kv("http.request.header.authorization", wire_secret),
        },
        .views = &views,
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    const ids = emitWireWorkload(sdk);
    try testing.expect(sdk.shutdown(.fromSeconds(10)).ok());
    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    for (0..recv.requestCount()) |i| {
        const req = recv.request(i);
        try testing.expectEqualStrings("h2", req.alpn_protocol.?);
        try testing.expectEqualStrings("gzip", req.grpc_encoding.?);
        try testing.expectEqualStrings("val99", req.header("x-grpc-key").?);
    }

    try verifyWirePayloads(
        recv.traces(),
        recv.metrics(),
        recv.logs(),
        "env-grpc-mtls",
        "development",
        ids.trace_id,
        ids.span_id,
        .drop,
    );
}
