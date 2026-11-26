//! Wire tests for `GrpcMetricExporter` through `MeterProvider` and
//! `PeriodicReader` against the loopback HTTP/2 gRPC receiver.

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
const grpc = @import("grpc.zig");
const grpc_metric_exporter = @import("grpc_metric_exporter.zig");
const GrpcMetricExporter = grpc_metric_exporter.GrpcMetricExporter;
const grpc_receiver = @import("test/grpc_receiver.zig");
const GrpcReceiver = grpc_receiver.GrpcReceiver;

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

const Pipeline = struct {
    exporter: *GrpcMetricExporter,
    reader: *PeriodicReader,
    provider: *MeterProvider,

    fn init(options: grpc_metric_exporter.Options) !Pipeline {
        const exporter = try GrpcMetricExporter.create(gpa, io, options);
        errdefer exporter.destroy();
        return initWithExporter(exporter);
    }

    fn initWithExporter(exporter: *GrpcMetricExporter) !Pipeline {
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

fn findMetric(sm: metrics_v1.ScopeMetrics, name: []const u8) ?metrics_v1.Metric {
    for (sm.metrics.items) |m| if (std.mem.eql(u8, m.name, name)) return m;
    return null;
}

fn expectEmitted(request: collector_metrics.ExportMetricsServiceRequest, want_delta: bool) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_metrics.items.len);
    const rm = request.resource_metrics.items[0];
    try testing.expectEqualStrings(schema_url, rm.schema_url);
    const res = rm.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", res[0].value.?.value.?.string_value);

    const sm = rm.scope_metrics.items[0];
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig", sm.scope.?.name);
    try testing.expectEqual(@as(usize, 5), sm.metrics.items.len);

    const expected_temp: metrics_v1.AggregationTemporality = if (want_delta)
        .AGGREGATION_TEMPORALITY_DELTA
    else
        .AGGREGATION_TEMPORALITY_CUMULATIVE;

    const reqs = findMetric(sm, "http.server.requests").?;
    try testing.expectEqual(expected_temp, reqs.data.?.sum.aggregation_temporality);
    try testing.expectEqual(@as(i64, 3), reqs.data.?.sum.data_points.items[0].value.?.as_int);

    const active = findMetric(sm, "http.server.active_requests").?;
    try testing.expectEqual(metrics_v1.AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE, active.data.?.sum.aggregation_temporality);
    try testing.expectEqual(@as(i64, -1), active.data.?.sum.data_points.items[0].value.?.as_int);

    const cpu = findMetric(sm, "process.cpu.utilization").?;
    try testing.expectEqual(@as(f64, 0.42), cpu.data.?.gauge.data_points.items[0].value.?.as_double);

    const dur = findMetric(sm, "http.server.request.duration").?;
    try testing.expectEqual(expected_temp, dur.data.?.histogram.aggregation_temporality);
    const hp = dur.data.?.histogram.data_points.items[0];
    try testing.expectEqual(@as(u64, 2), hp.count);
    try testing.expectEqualSlices(u64, &.{ 0, 1, 1, 0 }, hp.bucket_counts.items);
    try testing.expectEqual(@as(usize, 1), hp.exemplars.items.len);
    const ex = hp.exemplars.items[0];
    try testing.expectEqualSlices(u8, &sampled_sc.trace_id.bytes, ex.trace_id);
    try testing.expectEqualSlices(u8, &sampled_sc.span_id.bytes, ex.span_id);
    try testing.expectEqualStrings("user.id", ex.filtered_attributes.items[0].key);
    try testing.expectEqualStrings("u-42", ex.filtered_attributes.items[0].value.?.value.?.string_value);

    const obs = findMetric(sm, "db.pool.opens").?;
    try testing.expectEqual(@as(i64, 99), obs.data.?.sum.data_points.items[0].value.?.as_int);
}

test "gRPC metric exporter sends protobuf over h2c with histogram buckets and exemplars" {
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .headers = &.{.{ .name = "X-Tenant", .value = "acme" }},
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings(grpc_metric_exporter.method, req.path);
    try testing.expectEqualStrings("application/grpc", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var decoded = try req.decodeMetrics(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "gRPC metric exporter supports gzip compression and UNAVAILABLE retry" {
    const r = try GrpcReceiver.start(gpa, io, .{
        .replies = &.{.{
            .grpc_status = @backingInt(grpc.StatusCode.unavailable),
            .grpc_message = "retry%20metrics",
        }},
    });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .compression = .gzip,
        .retry = .{ .initial_interval = .fromMilliseconds(10), .max_interval = .fromMilliseconds(20) },
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try testing.expectEqual(@as(usize, 2), r.requestCount());
    try testing.expectEqualStrings("gzip", r.request(1).grpc_encoding.?);

    var decoded = try r.request(1).decodeMetrics(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "GrpcMetricExporter.createFromEnv configures endpoint, headers, gzip and delta temporality" {
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    const env_map: metric_mod.instrument.TestEnv = .{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", url },
        .{ "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "x-key=val%201" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION", "gzip" },
        .{ "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta" },
    } };
    const exporter = try GrpcMetricExporter.createFromEnv(gpa, io, env_map, .ignore);
    var p = try Pipeline.initWithExporter(exporter);
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings(grpc_metric_exporter.method, req.path);
    try testing.expectEqualStrings("gzip", req.grpc_encoding.?);
    try testing.expectEqualStrings("val 1", req.header("x-key").?);

    var decoded = try req.decodeMetrics(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, true);

    // Non-gRPC protocol is rejected.
    const http_env: metric_mod.instrument.TestEnv = .{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/protobuf" },
    } };
    try testing.expectError(error.UnsupportedProtocol, GrpcMetricExporter.createFromEnv(gpa, io, http_env, .ignore));
}

test "gRPC metric partial success fails export and reports collector detail" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp grpc metric exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };

    const response: collector_metrics.ExportMetricsServiceResponse = .{
        .partial_success = .{ .rejected_data_points = 4, .error_message = "bad bucket bounds" },
    };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var capture: Capture = .{};
    var p = try Pipeline.init(.{
        .endpoint = url,
        .on_error = .{ .ptr = &capture, .report = Capture.report },
    });
    defer p.deinit();

    p.emit();
    try testing.expectError(error.ExportFailed, p.provider.forceFlush(deadline.after(io, .fromSeconds(5))));
    try testing.expectEqualStrings("OTLP partial success: bad bucket bounds (4 data points rejected)", capture.detail[0..capture.len]);
}

test "gRPC metric exporter works over mutual TLS with ALPN h2" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try grpc_receiver.certs.writeAll(io, tmp.dir);
    const ca = try grpc_receiver.certs.path(gpa, &tmp, "ca.pem");
    defer gpa.free(ca);
    const cert = try grpc_receiver.certs.path(gpa, &tmp, "client.pem");
    defer gpa.free(cert);
    const key = try grpc_receiver.certs.path(gpa, &tmp, "client-key.pem");
    defer gpa.free(key);

    const r = try GrpcReceiver.start(gpa, io, .{
        .tls = .{ .client_ca_pem = grpc_receiver.certs.ca },
    });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key },
    });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("h2", r.request(0).alpn_protocol.?);

    var decoded = try r.request(0).decodeMetrics(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, false);
}

test "gRPC metric exporter handles empty collection, hanging shutdown deadline and post-shutdown" {
    const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    const empty_exp = try GrpcMetricExporter.create(gpa, io, .{ .endpoint = url });
    defer empty_exp.destroy();
    const e = empty_exp.exporter();
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

    var p = try Pipeline.init(.{ .endpoint = url });
    defer p.deinit();
    p.emit();
    try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(250))));
    try testing.expectEqual(@as(usize, 1), r.requestCount());
}
