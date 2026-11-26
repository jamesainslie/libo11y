//! Wire tests for the OTLP/HTTP log exporter: records emitted inside a
//! live span go through the batch log processor and the exporter to the
//! in-process receiver, and the tests decode the payloads with the
//! vendored bindings and with the OTLP/JSON decoder.

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
const env_mod = @import("env.zig");
const json = @import("json.zig");
const log_exporter = @import("log_exporter.zig");
const LogExporter = log_exporter.LogExporter;
const receiver = @import("test/receiver.zig");

const io = testing.io;
const gpa = testing.allocator;

const resource_attrs = [_]attribute.KeyValue{
    attribute.kv("service.name", "checkout"),
    attribute.kv("deployment.environment.name", "test"),
};
const schema_url = "https://schemas.o11y.ing/1.1.0";
const scope_name = "github.com/jamesainslie/libo11y/zig";

/// A logger provider wired to a batch log processor and an OTLP/HTTP log
/// exporter, and a tracer provider for the span the records sit in.
const Pipeline = struct {
    exporter: *LogExporter,
    blp: *log_processor.BatchLogProcessor,
    provider: *logger_mod.LoggerProvider,
    spans: InMemoryExporter,
    simple_spans: processor.SimpleSpanProcessor,
    tracer_provider: *tracer_mod.TracerProvider,

    fn init(p: *Pipeline, options: log_exporter.Options) !void {
        p.exporter = try LogExporter.create(gpa, io, options);
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

    /// Emits a warning with a nested body and attributes inside a live
    /// span, and returns the span's context.
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

fn endpoint(r: *receiver.Receiver) ![]u8 {
    return r.url(gpa, "/v1/logs");
}

fn str(v: ?common.AnyValue) ![]const u8 {
    return v.?.value.?.string_value;
}

/// Checks the decoded request carries the resource, the scope and the
/// record `Pipeline.emit` makes, with the span's trace identity.
fn expectEmitted(request: collector_logs.ExportLogsServiceRequest, sc: ids.SpanContext) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_logs.items.len);
    const rl = request.resource_logs.items[0];
    try testing.expectEqualStrings(schema_url, rl.schema_url);
    const res = rl.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", try str(res[0].value));
    try testing.expectEqual(@as(usize, 1), rl.scope_logs.items.len);
    const sl = rl.scope_logs.items[0];
    try testing.expectEqualStrings(scope_name, sl.scope.?.name);
    try testing.expectEqualStrings("0.0.0", sl.scope.?.version);
    try testing.expectEqual(@as(usize, 1), sl.log_records.items.len);
    const r = sl.log_records.items[0];

    try testing.expectEqual(logs_v1.SeverityNumber.SEVERITY_NUMBER_WARN, r.severity_number);
    try testing.expectEqualStrings("WARN", r.severity_text);
    try testing.expectEqual(@as(u64, 1_700_000_000_000_000_001), r.time_unix_nano);
    try testing.expect(r.observed_time_unix_nano > 0);
    try testing.expectEqualStrings("order.placed", r.event_name);

    try testing.expectEqualSlices(u8, &sc.trace_id.bytes, r.trace_id);
    try testing.expectEqualSlices(u8, &sc.span_id.bytes, r.span_id);
    try testing.expectEqual(@as(u32, sc.flags.toByte()), r.flags);
    try testing.expectEqual(@as(u32, 1), r.flags);

    const attrs = r.attributes.items;
    try testing.expectEqual(@as(usize, 2), attrs.len);
    try testing.expectEqualStrings("http.response.status_code", attrs[0].key);
    try testing.expectEqual(@as(i64, 504), attrs[0].value.?.value.?.int_value);
    try testing.expectEqualStrings("retry", attrs[1].key);
    try testing.expect(attrs[1].value.?.value.?.bool_value);

    const body = r.body.?.value.?.kvlist_value.values.items;
    try testing.expectEqual(@as(usize, 3), body.len);
    try testing.expectEqualStrings("msg", body[0].key);
    try testing.expectEqualStrings("order placed", try str(body[0].value));
    try testing.expectEqualStrings("order", body[1].key);
    const order = body[1].value.?.value.?.kvlist_value.values.items;
    try testing.expectEqualStrings("id", order[0].key);
    try testing.expectEqualStrings("ord-42", try str(order[0].value));
    const items = order[1].value.?.value.?.array_value.values.items;
    try testing.expectEqualStrings("A-1", items[0].value.?.string_value);
    try testing.expectEqual(@as(i64, 2), items[1].value.?.int_value);
    try testing.expectEqual(@as(f64, 19.5), order[2].value.?.value.?.double_value);
    try testing.expectEqualStrings("raw", body[2].key);
    try testing.expectEqualSlices(u8, "\x00\x01\xfe", body[2].value.?.value.?.bytes_value);
}

test "protobuf export reaches /v1/logs with severity, body, attributes and trace identity" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p: Pipeline = undefined;
    try p.init(.{ .endpoint = url, .headers = &.{.{ .name = "x-tenant", .value = "acme" }} });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/logs", req.path);
    try testing.expectEqualStrings("application/x-protobuf", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var reader: Io.Reader = .fixed(req.body);
    var decoded = try collector_logs.ExportLogsServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);
}

test "JSON export follows the OTLP/JSON mapping and decodes to the same record" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p: Pipeline = undefined;
    try p.init(.{ .endpoint = url, .protocol = .http_json, .compression = .gzip });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("/v1/logs", req.path);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);

    // A plain JSON parse sees the OTLP/JSON forms: hex ids, an integer
    // severity, 64-bit times as strings and base64 bytes.
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, req.body, .{});
    defer parsed.deinit();
    const record = parsed.value.object.get("resourceLogs").?.array.items[0].object.get("scopeLogs").?.array.items[0].object.get("logRecords").?.array.items[0].object;
    const trace_hex = sc.trace_id.hex();
    const span_hex = sc.span_id.hex();
    try testing.expectEqualStrings(&trace_hex, record.get("traceId").?.string);
    try testing.expectEqualStrings(&span_hex, record.get("spanId").?.string);
    try testing.expectEqual(@as(i64, 13), record.get("severityNumber").?.integer);
    try testing.expectEqualStrings("WARN", record.get("severityText").?.string);
    try testing.expectEqualStrings("1700000000000000001", record.get("timeUnixNano").?.string);
    const body = record.get("body").?.object.get("kvlistValue").?.object.get("values").?.array.items;
    try testing.expectEqualStrings("AAH+", body[2].object.get("value").?.object.get("bytesValue").?.string);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try expectEmitted(try json.decode(collector_logs.ExportLogsServiceRequest, arena.allocator(), req.body), sc);
}

test "shutdown sends the queued records before it closes the exporter" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p: Pipeline = undefined;
    try p.init(.{ .endpoint = url });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.shutdown(deadline.after(io, .fromSeconds(10)));
    try testing.expectEqual(@as(usize, 1), r.requestCount());
    var reader: Io.Reader = .fixed(r.request(0).body);
    var decoded = try collector_logs.ExportLogsServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded, sc);
    try testing.expectError(error.Shutdown, p.exporter.exporter().exportLogs(&.{}, deadline.after(io, .fromSeconds(1))));
}

test "a partial success fails the export and reports the collector's message" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp log exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };
    const response: collector_logs.ExportLogsServiceResponse = .{ .partial_success = .{ .rejected_log_records = 3, .error_message = "logs too old" } };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var capture: Capture = .{};
    const exporter = try LogExporter.create(gpa, io, .{ .endpoint = url, .on_error = .{ .ptr = &capture, .report = Capture.report } });
    defer exporter.destroy();
    var simple: log_processor.SimpleLogProcessor = .init(io, exporter.exporter(), .{});
    const provider = try logger_mod.LoggerProvider.create(gpa, io, .{ .processors = &.{simple.processor()} });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
    provider.logger(.{ .name = "t" }).emit(.background, .{ .body = .from("x") });
    try testing.expectEqualStrings("OTLP partial success: logs too old (3 log records rejected)", capture.detail[0..capture.len]);
}

test "a record outside any span carries no trace or span id on the wire" {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const res: @import("../resource.zig").Resource = .empty;
    const scope: @import("../resource.zig").InstrumentationScope = .{ .name = "t" };
    const data = log_record.LogData.create(gpa, .{ .severity = .info }, &res, &scope, .{}) orelse return error.OutOfMemory;
    defer data.release();
    var w: Io.Writer.Allocating = .init(a);
    try LogExporter.encodeRequest(.http_json, a, &.{data}, &w.writer);
    try testing.expect(std.mem.indexOf(u8, w.written(), "traceId") == null);
    try testing.expect(std.mem.indexOf(u8, w.written(), "spanId") == null);
    // An empty body is still sent, as Go sends it.
    try testing.expect(std.mem.indexOf(u8, w.written(), "\"body\":{}") != null);
}

test "env.fromEnv(.logs) configures the log exporter end to end" {
    const TestEnv = struct {
        pairs: []const [2][]const u8,
        pub fn get(e: @This(), key: []const u8) ?[]const u8 {
            for (e.pairs) |pair| if (std.mem.eql(u8, pair[0], key)) return pair[1];
            return null;
        }
    };
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const base_url = try r.url(gpa, "");
    defer gpa.free(base_url);
    var env_opts = try env_mod.fromEnv(gpa, TestEnv{ .pairs = &.{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "http/json" },
        .{ "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "x-signal=logs" },
        .{ "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION", "gzip" },
    } }, .logs);
    defer env_opts.deinit();

    const protocol: log_exporter.Protocol = switch (env_opts.protocol) {
        .http_protobuf => .http_protobuf,
        .http_json => .http_json,
        .grpc => return error.UnexpectedProtocol,
    };
    var p: Pipeline = undefined;
    try p.init(.{
        .protocol = protocol,
        .endpoint = env_opts.endpoint,
        .headers = env_opts.headers,
        .compression = env_opts.compression,
        .timeout = env_opts.timeout,
        .tls = env_opts.tls,
    });
    defer p.deinit();

    const sc = p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("/v1/logs", req.path);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);
    try testing.expectEqualStrings("logs", req.header("x-signal").?);
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try expectEmitted(try json.decode(collector_logs.ExportLogsServiceRequest, arena.allocator(), req.body), sc);
}

test "invalid UTF-8 in resource and scope schema URLs is sanitized on encode" {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const a = arena.allocator();
    const res: @import("../resource.zig").Resource = .{ .schema_url = "https://example.com/\xff/res" };
    const scope: @import("../resource.zig").InstrumentationScope = .{ .name = "t", .schema_url = "https://example.com/\xfe/scope" };
    const data = log_record.LogData.create(gpa, .{ .severity = .info }, &res, &scope, .{}) orelse return error.OutOfMemory;
    defer data.release();

    var pb_buf: Io.Writer.Allocating = .init(a);
    try LogExporter.encodeRequest(.http_protobuf, a, &.{data}, &pb_buf.writer);
    var pb_reader: Io.Reader = .fixed(pb_buf.written());
    var pb_decoded = try collector_logs.ExportLogsServiceRequest.decode(&pb_reader, gpa);
    defer pb_decoded.deinit(gpa);
    try testing.expectEqualStrings("https://example.com/\u{fffd}/res", pb_decoded.resource_logs.items[0].schema_url);
    try testing.expectEqualStrings("https://example.com/\u{fffd}/scope", pb_decoded.resource_logs.items[0].scope_logs.items[0].schema_url);

    var json_buf: Io.Writer.Allocating = .init(a);
    try LogExporter.encodeRequest(.http_json, a, &.{data}, &json_buf.writer);
    const json_decoded = try json.decode(collector_logs.ExportLogsServiceRequest, a, json_buf.written());
    try testing.expectEqualStrings("https://example.com/\u{fffd}/res", json_decoded.resource_logs.items[0].schema_url);
    try testing.expectEqualStrings("https://example.com/\u{fffd}/scope", json_decoded.resource_logs.items[0].scope_logs.items[0].schema_url);
}
