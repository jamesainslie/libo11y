//! Wire tests for `GrpcLogExporter` through `LoggerProvider` and
//! `BatchLogProcessor` against the loopback HTTP/2 gRPC receiver.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const proto = @import("opentelemetry-proto");
const collector_logs = proto.collector_logs_v1;
const logs_v1 = proto.logs_v1;
const common = proto.common_v1;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const deadline = @import("../deadline.zig");
const ids = @import("../ids.zig");
const log_processor = @import("../log_processor.zig");
const log_record = @import("../log_record.zig");
const kv = log_record.kv;
const logger_mod = @import("../logger.zig");
const processor = @import("../processor.zig");
const tracer_mod = @import("../tracer.zig");
const InMemoryExporter = @import("../memory_exporter.zig").InMemoryExporter;
const grpc = @import("grpc.zig");
const grpc_log_exporter = @import("grpc_log_exporter.zig");
const GrpcLogExporter = grpc_log_exporter.GrpcLogExporter;
const grpc_receiver = @import("test/grpc_receiver.zig");
const GrpcReceiver = grpc_receiver.GrpcReceiver;

const io = testing.io;
const gpa = testing.allocator;

const resource_attrs = [_]attribute.KeyValue{
    attribute.kv("service.name", "checkout"),
    attribute.kv("deployment.environment.name", "test"),
};
const schema_url = "https://schemas.o11y.ing/1.1.0";
const scope_name = "github.com/jamesainslie/libo11y/zig";

const Pipeline = struct {
    exporter: *GrpcLogExporter,
    blp: *log_processor.BatchLogProcessor,
    provider: *logger_mod.LoggerProvider,
    spans: InMemoryExporter,
    simple_spans: processor.SimpleSpanProcessor,
    tracer_provider: *tracer_mod.TracerProvider,

    fn init(p: *Pipeline, options: grpc_log_exporter.Options) !void {
        const exporter = try GrpcLogExporter.create(gpa, io, options);
        errdefer exporter.destroy();
        return p.initWithExporter(exporter);
    }

    fn initWithExporter(p: *Pipeline, exporter: *GrpcLogExporter) !void {
        p.exporter = exporter;
        errdefer p.exporter.destroy();
        var config = log_processor.default_batch_config;
        config.schedule_delay = .fromSeconds(60);
        p.blp = try log_processor.BatchLogProcessor.create(gpa, io, p.exporter.exporter(), .{ .config = config });
        errdefer p.blp.destroy();
        p.provider = try logger_mod.LoggerProvider.create(gpa, io, .{
            .resource = .{ .attributes = &resource_attrs, .schema_url = schema_url },
            .processors = &.{p.blp.processor()},
        });
        errdefer p.provider.destroy();
        p.spans = .init(gpa, io);
        p.simple_spans = .init(io, p.spans.exporter(), .{});
        p.tracer_provider = try tracer_mod.TracerProvider.create(gpa, io, .{ .processors = &.{p.simple_spans.processor()} });
    }

    fn deinit(p: *Pipeline) void {
        p.provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        p.provider.destroy();
        p.blp.destroy();
        p.exporter.destroy();
        p.tracer_provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        p.tracer_provider.destroy();
        p.spans.deinit();
    }

    fn emit(p: *Pipeline) ids.SpanContext {
        var span = p.tracer_provider.tracer(.{ .name = "t" }).start(.background, "GET /orders/{id}", .{ .kind = .server });
        defer span.end();
        const ctx = Context.background.withSpan(&span);
        const line_items = [_]log_record.Value{ .{ .string = "A-1" }, .{ .int = 2 } };
        const order = [_]log_record.KeyValue{
            kv("id", "ord-42"),
            .{ .key = "items", .value = .{ .array = &line_items } },
            kv("total", 19.5),
        };
        const body = [_]log_record.KeyValue{
            kv("msg", "order placed"),
            .{ .key = "order", .value = .{ .map = &order } },
            .{ .key = "raw", .value = .{ .bytes = "\x00\x01\xfe" } },
        };
        p.provider.logger(.{ .name = scope_name, .version = "0.0.0" }).emit(ctx, .{
            .timestamp = 1_700_000_000_000_000_001,
            .severity = .warn,
            .severity_text = "WARN",
            .body = .{ .map = &body },
            .attributes = &.{ kv("http.response.status_code", 504), kv("retry", true) },
            .event_name = "order.placed",
        });
        return span.spanContext();
    }
};

fn str(v: ?common.AnyValue) ![]const u8 {
    return v.?.value.?.string_value;
}

fn expectEmitted(request: collector_logs.ExportLogsServiceRequest, sc: ids.SpanContext) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_logs.items.len);
    const rl = request.resource_logs.items[0];
    try testing.expectEqualStrings(schema_url, rl.schema_url);
    const res = rl.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", try str(res[0].value));
    const sl = rl.scope_logs.items[0];
    try testing.expectEqualStrings(scope_name, sl.scope.?.name);
    try testing.expectEqual(@as(usize, 1), sl.log_records.items.len);
    const rec = sl.log_records.items[0];

    try testing.expectEqual(logs_v1.SeverityNumber.SEVERITY_NUMBER_WARN, rec.severity_number);
    try testing.expectEqualStrings("WARN", rec.severity_text);
    try testing.expectEqual(@as(u64, 1_700_000_000_000_000_001), rec.time_unix_nano);
    try testing.expectEqualStrings("order.placed", rec.event_name);
    try testing.expectEqualSlices(u8, &sc.trace_id.bytes, rec.trace_id);
    try testing.expectEqualSlices(u8, &sc.span_id.bytes, rec.span_id);
    try testing.expectEqual(@as(u32, 1), rec.flags);

    const attrs = rec.attributes.items;
    try testing.expectEqual(@as(usize, 2), attrs.len);
    try testing.expectEqual(@as(i64, 504), attrs[0].value.?.value.?.int_value);
    try testing.expect(attrs[1].value.?.value.?.bool_value);

    const body = rec.body.?.value.?.kvlist_value.values.items;
    try testing.expectEqualStrings("order placed", try str(body[0].value));
    try testing.expectEqualSlices(u8, "\x00\x01\xfe", body[2].value.?.value.?.bytes_value);
}

test "gRPC log exporter sends protobuf over h2c with trace correlation and nested body" {
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p: Pipeline = undefined;
    try p.init(.{
        .endpoint = url,
        .headers = &.{.{ .name = "X-Tenant", .value = "acme" }},
    });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings(grpc_log_exporter.method, req.path);
    try testing.expectEqualStrings("application/grpc", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var decoded = try req.decodeLogs(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);
}

test "gRPC log exporter supports gzip compression and UNAVAILABLE retry" {
    const r = try GrpcReceiver.start(gpa, io, .{
        .replies = &.{.{
            .grpc_status = @backingInt(grpc.StatusCode.unavailable),
            .grpc_message = "retry%20logs",
        }},
    });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var p: Pipeline = undefined;
    try p.init(.{
        .endpoint = url,
        .compression = .gzip,
        .retry = .{ .initial_interval = .fromMilliseconds(10), .max_interval = .fromMilliseconds(20) },
    });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try testing.expectEqual(@as(usize, 2), r.requestCount());
    try testing.expectEqualStrings("gzip", r.request(1).grpc_encoding.?);

    var decoded = try r.request(1).decodeLogs(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);
}

test "GrpcLogExporter.createFromEnv configures endpoint, headers and gzip" {
    const TestEnv = struct {
        pairs: []const [2][]const u8,
        pub fn get(e: @This(), key: []const u8) ?[]const u8 {
            for (e.pairs) |pair| if (std.mem.eql(u8, pair[0], key)) return pair[1];
            return null;
        }
    };
    const r = try GrpcReceiver.start(gpa, io, .{});
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    const exporter = try GrpcLogExporter.createFromEnv(gpa, io, TestEnv{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", url },
        .{ "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "grpc" },
        .{ "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "x-signal=logs" },
        .{ "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION", "gzip" },
    } }, .ignore);
    var p: Pipeline = undefined;
    try p.initWithExporter(exporter);
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings(grpc_log_exporter.method, req.path);
    try testing.expectEqualStrings("gzip", req.grpc_encoding.?);
    try testing.expectEqualStrings("logs", req.header("x-signal").?);

    var decoded = try req.decodeLogs(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);

    try testing.expectError(error.UnsupportedProtocol, GrpcLogExporter.createFromEnv(gpa, io, TestEnv{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "http/json" },
    } }, .ignore));
}

test "gRPC log partial success fails export and reports collector detail" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp grpc log exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };

    const response: collector_logs.ExportLogsServiceResponse = .{
        .partial_success = .{ .rejected_log_records = 3, .error_message = "logs too old" },
    };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try r.url(gpa);
    defer gpa.free(url);

    var capture: Capture = .{};
    const exporter = try GrpcLogExporter.create(gpa, io, .{
        .endpoint = url,
        .on_error = .{ .ptr = &capture, .report = Capture.report },
    });
    defer exporter.destroy();
    var simple: log_processor.SimpleLogProcessor = .init(io, exporter.exporter(), .{});
    const provider = try logger_mod.LoggerProvider.create(gpa, io, .{ .processors = &.{simple.processor()} });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};

    provider.logger(.{ .name = "t" }).emit(.background, .{ .body = .from("x") });
    try testing.expectEqualStrings("OTLP partial success: logs too old (3 log records rejected)", capture.detail[0..capture.len]);
}

test "gRPC log exporter works over mutual TLS with ALPN h2" {
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

    var p: Pipeline = undefined;
    try p.init(.{
        .endpoint = url,
        .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key },
    });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("h2", r.request(0).alpn_protocol.?);

    var decoded = try r.request(0).decodeLogs(gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);
}

test "gRPC log exporter flushes on shutdown, respects hanging deadline and rejects post-shutdown" {
    {
        const r = try GrpcReceiver.start(gpa, io, .{});
        defer r.stop();
        const url = try r.url(gpa);
        defer gpa.free(url);
        var p: Pipeline = undefined;
        try p.init(.{ .endpoint = url });
        defer p.deinit();

        const sc = p.emit();
        try p.provider.shutdown(deadline.after(io, .fromSeconds(10)));
        try testing.expectEqual(@as(usize, 1), r.requestCount());
        var decoded = try r.request(0).decodeLogs(gpa);
        defer decoded.deinit(gpa);
        try expectEmitted(decoded, sc);
        try testing.expectError(error.Shutdown, p.exporter.exporter().exportLogs(&.{}, deadline.after(io, .fromSeconds(1))));
        try testing.expectError(error.Shutdown, p.exporter.exporter().forceFlush(deadline.after(io, .fromSeconds(1))));
    }
    {
        const r = try GrpcReceiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
        defer r.stop();
        const url = try r.url(gpa);
        defer gpa.free(url);
        var p: Pipeline = undefined;
        try p.init(.{ .endpoint = url });
        defer p.deinit();
        _ = p.emit();
        try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(250))));
        try testing.expectEqual(@as(usize, 1), r.requestCount());
    }
}
