//! Wire tests for the OTLP/HTTP metrics exporter: real metrics go through
//! the meter provider, periodic reader and exporter to the in-process
//! receiver, which records each request, and the tests decode the payloads
//! with the vendored bindings and OTLP/JSON.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const proto = @import("opentelemetry-proto");
const collector_metrics = proto.collector_metrics_v1;
const metrics_v1 = proto.metrics_v1;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const kv = attribute.kv;
const deadline = @import("../deadline.zig");
const ids = @import("../ids.zig");
const metric_mod = @import("../metric/metric.zig");
const MeterProvider = metric_mod.meter.MeterProvider;
const PeriodicReader = metric_mod.reader.PeriodicReader;
const processor = @import("../processor.zig");
const json = @import("json.zig");
const metric_exporter = @import("metric_exporter.zig");
const MetricExporter = metric_exporter.MetricExporter;
const receiver = @import("test/receiver.zig");

const io = testing.io;
const gpa = testing.allocator;

const resource_attrs = [_]attribute.KeyValue{
    kv("service.name", "checkout"),
    kv("deployment.environment.name", "test"),
};
const schema_url = "https://schemas.o11y.ing/1.1.0";

const sampled_sc: ids.SpanContext = .{
    .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
    .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
    .flags = .sampled_flag,
};

const hist_bounds = [_]f64{ 0.01, 0.1, 1.0 };

const metric_views = [_]metric_mod.view.View{
    .{
        .instrument_name = "http.server.request.duration",
        .attribute_keys = &.{"http.route"},
        .aggregation = .{ .explicit_bucket_histogram = .{ .boundaries = &hist_bounds } },
    },
};

/// A provider wired to a periodic reader and an OTLP/HTTP metrics exporter.
const Pipeline = struct {
    exporter: *MetricExporter,
    reader: *PeriodicReader,
    provider: *MeterProvider,

    fn init(options: metric_exporter.Options) !Pipeline {
        const exporter = try MetricExporter.create(gpa, io, options);
        errdefer exporter.destroy();
        return initWithExporter(exporter);
    }

    fn initWithExporter(exporter: *MetricExporter) !Pipeline {
        errdefer exporter.destroy();
        const reader = try PeriodicReader.create(gpa, io, exporter.exporter(), .{
            .interval = .fromSeconds(60),
            .timeout = .fromSeconds(10),
        });
        errdefer reader.destroy();
        const provider = try MeterProvider.create(gpa, io, .{
            .resource = .{ .attributes = &resource_attrs, .schema_url = schema_url },
            .readers = &.{reader.reader()},
            .views = &metric_views,
        });
        return .{ .exporter = exporter, .reader = reader, .provider = provider };
    }

    fn deinit(p: *Pipeline) void {
        p.provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        p.provider.destroy();
        p.reader.destroy();
        p.exporter.destroy();
    }

    /// Records a counter, up-down counter, gauge, histogram with exemplar
    /// and filtered attributes, and an observable counter.
    fn emit(p: *Pipeline) void {
        const m = p.provider.meter(.{ .name = "github.com/jamesainslie/libo11y/zig", .version = "0.0.0" });
        const ctx = Context.background.withSpanContext(sampled_sc);
        m.counter(i64, "http.server.requests", .{ .unit = "{request}", .description = "Requests." })
            .add(ctx, 3, &.{kv("http.route", "/orders")});
        m.upDownCounter(i64, "http.server.active_requests", .{})
            .add(.background, -1, &.{});
        m.gauge(f64, "process.cpu.utilization", .{ .unit = "1" })
            .record(.background, 0.42, &.{});
        const hist = m.histogram(f64, "http.server.request.duration", .{ .unit = "s" });
        hist.record(ctx, 0.05, &.{ kv("http.route", "/orders"), kv("user.id", "u-42") });
        hist.record(.background, 0.5, &.{kv("http.route", "/orders")});
        const Obs = struct {
            fn run(_: ?*anyopaque, o: metric_mod.meter.Observation(i64)) void {
                o.observe(99, &.{kv("pool", "db")});
            }
        };
        _ = m.observableCounter(i64, "db.pool.opens", .{ .callbacks = &.{.{ .func = Obs.run }} });
    }
};

fn endpoint(r: *receiver.Receiver) ![]u8 {
    return r.url(gpa, "/v1/metrics");
}

fn findMetric(sm: metrics_v1.ScopeMetrics, name: []const u8) ?metrics_v1.Metric {
    for (sm.metrics.items) |m| if (std.mem.eql(u8, m.name, name)) return m;
    return null;
}

/// Checks the decoded request carries the resource, scope, counter,
/// up-down counter, gauge, histogram buckets and exemplar trace id.
fn expectEmitted(request: collector_metrics.ExportMetricsServiceRequest, want_delta: bool) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_metrics.items.len);
    const rm = request.resource_metrics.items[0];
    try testing.expectEqualStrings(schema_url, rm.schema_url);
    const res = rm.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", res[0].value.?.value.?.string_value);
    try testing.expectEqualStrings("test", res[1].value.?.value.?.string_value);

    try testing.expectEqual(@as(usize, 1), rm.scope_metrics.items.len);
    const sm = rm.scope_metrics.items[0];
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig", sm.scope.?.name);
    try testing.expectEqualStrings("0.0.0", sm.scope.?.version);
    try testing.expectEqual(@as(usize, 5), sm.metrics.items.len);

    const expected_temp: metrics_v1.AggregationTemporality = if (want_delta)
        .AGGREGATION_TEMPORALITY_DELTA
    else
        .AGGREGATION_TEMPORALITY_CUMULATIVE;

    // Counter.
    const reqs = findMetric(sm, "http.server.requests").?;
    try testing.expectEqualStrings("{request}", reqs.unit);
    try testing.expectEqualStrings("Requests.", reqs.description);
    try testing.expect(reqs.data.?.sum.is_monotonic);
    try testing.expectEqual(expected_temp, reqs.data.?.sum.aggregation_temporality);
    const rp = reqs.data.?.sum.data_points.items[0];
    try testing.expectEqual(@as(i64, 3), rp.value.?.as_int);
    try testing.expectEqual(@as(usize, 1), rp.exemplars.items.len);
    try testing.expectEqualSlices(u8, &sampled_sc.trace_id.bytes, rp.exemplars.items[0].trace_id);
    try testing.expectEqualSlices(u8, &sampled_sc.span_id.bytes, rp.exemplars.items[0].span_id);

    // Up-down counter stays cumulative even under delta preference.
    const active = findMetric(sm, "http.server.active_requests").?;
    try testing.expect(!active.data.?.sum.is_monotonic);
    try testing.expectEqual(metrics_v1.AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE, active.data.?.sum.aggregation_temporality);
    try testing.expectEqual(@as(i64, -1), active.data.?.sum.data_points.items[0].value.?.as_int);

    // Gauge.
    const cpu = findMetric(sm, "process.cpu.utilization").?;
    try testing.expectEqual(@as(f64, 0.42), cpu.data.?.gauge.data_points.items[0].value.?.as_double);

    // Histogram with custom bounds, bucket counts, min/max/sum/count and exemplar.
    const dur = findMetric(sm, "http.server.request.duration").?;
    try testing.expectEqualStrings("s", dur.unit);
    try testing.expectEqual(expected_temp, dur.data.?.histogram.aggregation_temporality);
    const hp = dur.data.?.histogram.data_points.items[0];
    try testing.expectEqual(@as(u64, 2), hp.count);
    try testing.expectApproxEqAbs(@as(f64, 0.55), hp.sum.?, 1e-12);
    try testing.expectEqual(@as(f64, 0.05), hp.min.?);
    try testing.expectEqual(@as(f64, 0.5), hp.max.?);
    try testing.expectEqualSlices(f64, &hist_bounds, hp.explicit_bounds.items);
    // 0.05 falls in (0.01, 0.1] (bucket 1), 0.5 falls in (0.1, 1.0] (bucket 2).
    try testing.expectEqualSlices(u64, &.{ 0, 1, 1, 0 }, hp.bucket_counts.items);
    try testing.expectEqual(@as(usize, 1), hp.attributes.items.len);
    try testing.expectEqualStrings("http.route", hp.attributes.items[0].key);
    try testing.expectEqual(@as(usize, 1), hp.exemplars.items.len);
    const ex = hp.exemplars.items[0];
    try testing.expectEqualSlices(u8, &sampled_sc.trace_id.bytes, ex.trace_id);
    try testing.expectEqualSlices(u8, &sampled_sc.span_id.bytes, ex.span_id);
    try testing.expectEqual(@as(f64, 0.05), ex.value.?.as_double);
    try testing.expect(ex.time_unix_nano > 0);
    try testing.expectEqual(@as(usize, 1), ex.filtered_attributes.items.len);
    try testing.expectEqualStrings("user.id", ex.filtered_attributes.items[0].key);
    try testing.expectEqualStrings("u-42", ex.filtered_attributes.items[0].value.?.value.?.string_value);

    // Observable counter.
    const obs = findMetric(sm, "db.pool.opens").?;
    try testing.expect(obs.data.?.sum.is_monotonic);
    try testing.expectEqual(expected_temp, obs.data.?.sum.aggregation_temporality);
    try testing.expectEqual(@as(i64, 99), obs.data.?.sum.data_points.items[0].value.?.as_int);
}

test "protobuf export reaches /v1/metrics with histogram buckets and exemplar trace id" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{
        .endpoint = url,
        .headers = &.{.{ .name = "x-tenant", .value = "acme" }},
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/metrics", req.path);
    try testing.expectEqualStrings("application/x-protobuf", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var wire: Io.Reader = .fixed(req.body);
    var decoded = try collector_metrics.ExportMetricsServiceRequest.decode(&wire, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "gzip JSON export follows the OTLP/JSON mapping for histograms and exemplars" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{
        .endpoint = url,
        .protocol = .http_json,
        .compression = .gzip,
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/metrics", req.path);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);

    // Check raw OTLP/JSON wire conventions: hex trace/span ids, integer
    // aggregationTemporality, decimal string 64-bit counts.
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, req.body, .{});
    defer parsed.deinit();
    const metrics_arr = parsed.value.object.get("resourceMetrics").?.array.items[0].object
        .get("scopeMetrics").?.array.items[0].object
        .get("metrics").?.array.items;
    var found_hist = false;
    for (metrics_arr) |item| {
        const obj = item.object;
        if (!std.mem.eql(u8, obj.get("name").?.string, "http.server.request.duration")) continue;
        found_hist = true;
        const hist = obj.get("histogram").?.object;
        try testing.expectEqual(@as(i64, 2), hist.get("aggregationTemporality").?.integer);
        const dp = hist.get("dataPoints").?.array.items[0].object;
        try testing.expectEqualStrings("2", dp.get("count").?.string);
        const ex = dp.get("exemplars").?.array.items[0].object;
        const trace_id = ex.get("traceId").?.string;
        try testing.expectEqualStrings("4bf92f3577b34da6a3ce929d0e0e4736", trace_id);
        try testing.expectEqualStrings("00f067aa0ba902b7", ex.get("spanId").?.string);
        try testing.expect(ex.get("timeUnixNano").? == .string);
    }
    try testing.expect(found_hist);

    // The OTLP/JSON decoder reproduces the exact same message.
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try expectEmitted(try json.decode(collector_metrics.ExportMetricsServiceRequest, arena.allocator(), req.body), false);
}

test "createFromEnv configures endpoint, protocol, headers, compression and temporality" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const base_url = try r.url(gpa, "");
    defer gpa.free(base_url);

    const env: metric_mod.instrument.TestEnv = .{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/json" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "x-key=val%201" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION", "gzip" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta" },
    } };
    const exporter = try MetricExporter.createFromEnv(gpa, io, env, .ignore);
    var p = try Pipeline.initWithExporter(exporter);
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("/v1/metrics", req.path);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);
    try testing.expectEqualStrings("val 1", req.header("x-key").?);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try expectEmitted(try json.decode(collector_metrics.ExportMetricsServiceRequest, arena.allocator(), req.body), true);

    // gRPC is rejected by the HTTP exporter factory.
    const grpc_env: metric_mod.instrument.TestEnv = .{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc" },
    } };
    try testing.expectError(error.UnsupportedProtocol, MetricExporter.createFromEnv(gpa, io, grpc_env, .ignore));
}

test "a 503 is retried within the metric export" {
    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .status = 503, .retry_after = "0" }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{
        .endpoint = url,
        .retry = .{ .initial_interval = .fromMilliseconds(5), .max_interval = .fromMilliseconds(20) },
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try testing.expectEqual(@as(usize, 2), r.requestCount());
    var wire: Io.Reader = .fixed(r.request(1).body);
    var decoded = try collector_metrics.ExportMetricsServiceRequest.decode(&wire, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "a partial success fails the metric export and reports the collector's message" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp metric exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };
    const response: collector_metrics.ExportMetricsServiceResponse = .{
        .partial_success = .{ .rejected_data_points = 4, .error_message = "invalid temporality" },
    };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var capture: Capture = .{};
    var p = try Pipeline.init(.{ .endpoint = url, .on_error = .{ .ptr = &capture, .report = Capture.report } });
    defer p.deinit();

    p.emit();
    try testing.expectError(error.ExportFailed, p.provider.forceFlush(deadline.after(io, .fromSeconds(5))));
    try testing.expectEqualStrings("OTLP partial success: invalid temporality (4 data points rejected)", capture.detail[0..capture.len]);
}

test "shutdown with a deadline returns against a hanging metric receiver" {
    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{ .endpoint = url });
    defer p.deinit();
    p.emit();

    const started = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(300))));
    const took = -deadline.remaining(io, started).toMilliseconds();
    try testing.expect(took >= 250);
    try testing.expect(took < 3000);
    try testing.expectEqual(@as(usize, 1), r.requestCount());
}

test "mutual TLS metric export to a receiver that requires a client certificate" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try receiver.certs.writeAll(io, tmp.dir);
    const ca = try receiver.certs.path(gpa, &tmp, "ca.pem");
    defer gpa.free(ca);
    const cert = try receiver.certs.path(gpa, &tmp, "client.pem");
    defer gpa.free(cert);
    const key = try receiver.certs.path(gpa, &tmp, "client-key.pem");
    defer gpa.free(key);

    const r = try receiver.Receiver.start(gpa, io, .{ .tls = .{ .client_ca_pem = receiver.certs.ca } });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    try testing.expect(std.mem.startsWith(u8, url, "https://"));
    var p = try Pipeline.init(.{
        .endpoint = url,
        .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key },
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    var wire: Io.Reader = .fixed(r.request(0).body);
    var decoded = try collector_metrics.ExportMetricsServiceRequest.decode(&wire, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "metric exports after shutdown fail with Shutdown and empty collections send nothing" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    const exporter = try MetricExporter.create(gpa, io, .{ .endpoint = url });
    defer exporter.destroy();
    const e = exporter.exporter();

    var empty: metric_mod.data.ResourceMetrics = .{
        .arena = .init(gpa),
        .resource = .empty,
        .scope_metrics = &.{},
    };
    defer empty.deinit();
    try e.exportMetrics(&empty, deadline.after(io, .fromSeconds(1)));
    try testing.expectEqual(@as(usize, 0), r.requestCount());

    try e.shutdown(deadline.after(io, .fromSeconds(1)));
    try testing.expectError(error.Shutdown, e.exportMetrics(&empty, deadline.after(io, .fromSeconds(1))));
    try testing.expectError(error.Shutdown, e.forceFlush(deadline.after(io, .fromSeconds(1))));
}
