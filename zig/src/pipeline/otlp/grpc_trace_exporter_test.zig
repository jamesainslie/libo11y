//! End-to-end wire tests for `GrpcTraceExporter` through `TracerProvider` and
//! `BatchSpanProcessor` against the loopback HTTP/2 gRPC receiver.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const proto = @import("opentelemetry-proto");
const collector_trace = proto.collector_trace_v1;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const kv = attribute.kv;
const batch = @import("../batch.zig");
const deadline = @import("../deadline.zig");
const processor = @import("../processor.zig");
const tracer_mod = @import("../tracer.zig");
const env = @import("env.zig");
const grpc = @import("grpc.zig");
const grpc_receiver = @import("test/grpc_receiver.zig");
const GrpcReceiver = grpc_receiver.GrpcReceiver;
const grpc_trace_exporter = @import("grpc_trace_exporter.zig");
const GrpcTraceExporter = grpc_trace_exporter.GrpcTraceExporter;

const io = testing.io;
const gpa = testing.allocator;

const resource_attrs = [_]attribute.KeyValue{
    kv("service.name", "checkout"),
    kv("deployment.environment.name", "test"),
};
const schema_url = "https://schemas.o11y.ing/1.1.0";

const Pipeline = struct {
    exporter: *GrpcTraceExporter,
    bsp: *batch.BatchSpanProcessor,
    provider: *tracer_mod.TracerProvider,

    fn init(options: grpc_trace_exporter.Options, config: batch.Config) !Pipeline {
        const exporter = try GrpcTraceExporter.create(gpa, io, options);
        errdefer exporter.destroy();
        const bsp = try batch.BatchSpanProcessor.create(gpa, io, exporter.exporter(), .{ .config = config });
        errdefer bsp.destroy();
        const provider = try tracer_mod.TracerProvider.create(gpa, io, .{
            .resource = .{ .attributes = &resource_attrs, .schema_url = schema_url },
            .processors = &.{bsp.processor()},
        });
        return .{ .exporter = exporter, .bsp = bsp, .provider = provider };
    }

    fn deinit(p: *Pipeline) void {
        p.provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        p.provider.destroy();
        p.bsp.destroy();
        p.exporter.destroy();
    }

    fn emit(p: *Pipeline) void {
        const t = p.provider.tracer(.{ .name = "github.com/jamesainslie/libo11y/zig", .version = "0.0.0" });
        var server = t.start(.background, "GET /orders/{id}", .{ .kind = .server, .attributes = &.{kv("http.response.status_code", 200)} });
        var child = t.start(Context.background.withSpan(&server), "SELECT orders", .{ .kind = .client });
        child.addEvent("db.query", .{ .attributes = &.{kv("rows", 3)} });
        child.end();
        server.setStatus(.ok, "");
        server.end();
    }
};

fn expectEmitted(request: collector_trace.ExportTraceServiceRequest) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_spans.items.len);
    const rs = request.resource_spans.items[0];
    try testing.expectEqualStrings(schema_url, rs.schema_url);
    const res = rs.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", res[0].value.?.value.?.string_value);
    const ss = rs.scope_spans.items[0];
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig", ss.scope.?.name);
    try testing.expectEqual(@as(usize, 2), ss.spans.items.len);
    const child = ss.spans.items[0];
    const server = ss.spans.items[1];
    try testing.expectEqualStrings("SELECT orders", child.name);
    try testing.expectEqualStrings("GET /orders/{id}", server.name);
    try testing.expectEqualSlices(u8, server.trace_id, child.trace_id);
    try testing.expectEqualSlices(u8, server.span_id, child.parent_span_id);
    try testing.expectEqual(@as(i64, 3), child.events.items[0].attributes.items[0].value.?.value.?.int_value);
}

test "BatchSpanProcessor exports spans over OTLP/gRPC h2c and reuses connection" {
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .headers = &.{.{ .name = "X-Tenant", .value = "acme" }},
    }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(2, .fromSeconds(5));

    try testing.expectEqual(@as(usize, 1), r.connectionCount());
    const req = r.request(0);
    try testing.expectEqualStrings(grpc_trace_exporter.method, req.path);
    try testing.expectEqualStrings("application/grpc", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var reader: Io.Reader = .fixed(req.body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "BatchSpanProcessor exports gzip-compressed spans over OTLP/gRPC" {
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .compression = .gzip,
    }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("gzip", r.request(0).grpc_encoding.?);

    var reader: Io.Reader = .fixed(r.request(0).body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "gRPC exporter retries UNAVAILABLE and succeeds on second attempt" {
    const r = try GrpcReceiver.start(gpa, io, .{
        .replies = &.{.{
            .grpc_status = @backingInt(grpc.StatusCode.unavailable),
            .grpc_message = "collector%20restarting",
        }},
    });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{
        .endpoint = url,
        .retry = .{ .initial_interval = .fromMilliseconds(10), .max_interval = .fromMilliseconds(20) },
    }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try testing.expectEqual(@as(usize, 2), r.requestCount());

    var reader: Io.Reader = .fixed(r.request(1).body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "gRPC partial success fails export and reports collector message" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp grpc trace exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };

    const response: collector_trace.ExportTraceServiceResponse = .{
        .partial_success = .{ .rejected_spans = 3, .error_message = "dropped invalid spans" },
    };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var capture: Capture = .{};
    const exporter = try GrpcTraceExporter.create(gpa, io, .{
        .endpoint = url,
        .on_error = .{ .ptr = &capture, .report = Capture.report },
    });
    defer exporter.destroy();
    var simple: processor.SimpleSpanProcessor = .init(io, exporter.exporter(), .{});
    const provider = try tracer_mod.TracerProvider.create(gpa, io, .{ .processors = &.{simple.processor()} });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};

    var s = provider.tracer(.{ .name = "t" }).start(.background, "op", .{});
    s.end();
    try testing.expectEqualStrings("OTLP partial success: dropped invalid spans (3 spans rejected)", capture.detail[0..capture.len]);
}

test "gRPC exporter works with mutual TLS and ALPN h2 via env.fromEnv" {
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

    const TestEnv = struct {
        pairs: []const [2][]const u8,
        pub fn get(e: @This(), k: []const u8) ?[]const u8 {
            for (e.pairs) |pair| if (std.mem.eql(u8, pair[0], k)) return pair[1];
            return null;
        }
    };
    var env_opts = try env.fromEnv(gpa, TestEnv{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", url },
        .{ "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
        .{ "OTEL_EXPORTER_OTLP_CERTIFICATE", ca },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert },
        .{ "OTEL_EXPORTER_OTLP_CLIENT_KEY", key },
        .{ "OTEL_EXPORTER_OTLP_HEADERS", "x-env=from-env" },
    } }, .traces);
    defer env_opts.deinit();
    try testing.expectEqual(.grpc, env_opts.protocol);

    var p = try Pipeline.init(.{
        .endpoint = env_opts.endpoint,
        .headers = env_opts.headers,
        .compression = env_opts.compression,
        .timeout = env_opts.timeout,
        .tls = env_opts.tls,
    }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("h2", r.request(0).alpn_protocol.?);
    try testing.expectEqualStrings("from-env", r.request(0).header("x-env").?);

    var reader: Io.Reader = .fixed(r.request(0).body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "gRPC shutdown respects deadline against hanging receiver and rejects later exports" {
    const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p = try Pipeline.init(.{ .endpoint = url }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();
    p.emit();

    const started = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(250))));
    const took = -deadline.remaining(io, started).toMilliseconds();
    try testing.expect(took >= 200);
    try testing.expect(took < 2500);
    try testing.expectEqual(@as(usize, 1), r.requestCount());

    const exporter = try GrpcTraceExporter.create(gpa, io, .{});
    defer exporter.destroy();
    const e = exporter.exporter();
    try e.shutdown(deadline.after(io, .fromSeconds(1)));
    try testing.expectError(error.Shutdown, e.exportSpans(&.{}, deadline.after(io, .fromSeconds(1))));
}
