//! Wire tests for the OTLP/HTTP trace exporter: real spans go through the
//! batch processor and the exporter to the in-process receiver, which
//! records each request, and the tests decode the payloads with the
//! vendored bindings or a JSON parse.

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
const json = @import("json.zig");
const receiver = @import("test/receiver.zig");
const trace_exporter = @import("trace_exporter.zig");
const TraceExporter = trace_exporter.TraceExporter;

const io = testing.io;
const gpa = testing.allocator;

const resource_attrs = [_]attribute.KeyValue{
    kv("service.name", "checkout"),
    kv("deployment.environment.name", "test"),
};
const schema_url = "https://schemas.o11y.ing/1.1.0";

/// A provider wired to a batch processor and an OTLP/HTTP exporter.
const Pipeline = struct {
    exporter: *TraceExporter,
    bsp: *batch.BatchSpanProcessor,
    provider: *tracer_mod.TracerProvider,

    fn init(options: trace_exporter.Options, config: batch.Config) !Pipeline {
        const exporter = try TraceExporter.create(gpa, io, options);
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

    /// A server span with a child, an event and an error status.
    fn emit(p: *Pipeline) void {
        const t = p.provider.tracer(.{ .name = "github.com/jamesainslie/libo11y/zig", .version = "0.0.0" });
        var server = t.start(.background, "GET /orders/{id}", .{ .kind = .server, .attributes = &.{kv("http.response.status_code", 504)} });
        var child = t.start(Context.background.withSpan(&server), "SELECT orders", .{ .kind = .client });
        child.addEvent("retry", .{ .attributes = &.{kv("attempt", 2)} });
        child.end();
        server.setStatus(.@"error", "upstream timed out");
        server.end();
    }
};

fn endpoint(r: *receiver.Receiver) ![]u8 {
    return r.url(gpa, "/v1/traces");
}

/// Checks the decoded request carries the resource, the scope and the two
/// spans `Pipeline.emit` makes, with the child under the server span.
fn expectEmitted(request: collector_trace.ExportTraceServiceRequest) !void {
    try testing.expectEqual(@as(usize, 1), request.resource_spans.items.len);
    const rs = request.resource_spans.items[0];
    try testing.expectEqualStrings(schema_url, rs.schema_url);
    const res = rs.resource.?.attributes.items;
    try testing.expectEqualStrings("service.name", res[0].key);
    try testing.expectEqualStrings("checkout", res[0].value.?.value.?.string_value);
    try testing.expectEqualStrings("test", res[1].value.?.value.?.string_value);
    const ss = rs.scope_spans.items[0];
    try testing.expectEqualStrings("github.com/jamesainslie/libo11y/zig", ss.scope.?.name);
    try testing.expectEqualStrings("0.0.0", ss.scope.?.version);
    try testing.expectEqual(@as(usize, 2), ss.spans.items.len);
    const child = ss.spans.items[0];
    const server = ss.spans.items[1];
    try testing.expectEqualStrings("SELECT orders", child.name);
    try testing.expectEqualStrings("GET /orders/{id}", server.name);
    try testing.expectEqualSlices(u8, server.trace_id, child.trace_id);
    try testing.expectEqualSlices(u8, server.span_id, child.parent_span_id);
    try testing.expectEqual(@as(usize, 0), server.parent_span_id.len);
    try testing.expectEqual(@as(usize, 16), server.trace_id.len);
    try testing.expectEqual(@as(usize, 8), server.span_id.len);
    try testing.expectEqual(proto.trace_v1.Span.SpanKind.SPAN_KIND_SERVER, server.kind);
    try testing.expectEqual(proto.trace_v1.Span.SpanKind.SPAN_KIND_CLIENT, child.kind);
    try testing.expectEqual(@as(i64, 504), server.attributes.items[0].value.?.value.?.int_value);
    try testing.expectEqual(proto.trace_v1.Status.StatusCode.STATUS_CODE_ERROR, server.status.?.code);
    try testing.expectEqualStrings("upstream timed out", server.status.?.message);
    try testing.expectEqualStrings("retry", child.events.items[0].name);
    try testing.expectEqual(@as(i64, 2), child.events.items[0].attributes.items[0].value.?.value.?.int_value);
    try testing.expect(server.end_time_unix_nano >= server.start_time_unix_nano);
}

test "protobuf export reaches the receiver with resource, scope, spans and events" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{ .endpoint = url, .headers = &.{.{ .name = "x-tenant", .value = "acme" }} }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/traces", req.path);
    try testing.expectEqualStrings("application/x-protobuf", req.content_type.?);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);

    var reader: Io.Reader = .fixed(req.body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "gzip JSON export follows the OTLP/JSON mapping" {
    const r = try receiver.Receiver.start(gpa, io, .{});
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{ .endpoint = url, .protocol = .http_json, .compression = .gzip }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();

    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);

    // A plain JSON parse sees the OTLP/JSON forms.
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, req.body, .{});
    defer parsed.deinit();
    const span = parsed.value.object.get("resourceSpans").?.array.items[0].object.get("scopeSpans").?.array.items[0].object.get("spans").?.array.items[1].object;
    const trace_id = span.get("traceId").?.string;
    try testing.expectEqual(@as(usize, 32), trace_id.len);
    for (trace_id) |c| try testing.expect(std.ascii.isDigit(c) or (c >= 'a' and c <= 'f'));
    try testing.expectEqual(@as(i64, 2), span.get("kind").?.integer);
    try testing.expect(span.get("startTimeUnixNano").? == .string);
    try testing.expectEqual(@as(i64, 2), span.get("status").?.object.get("code").?.integer);

    // The JSON decoder gives back the same message.
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    try expectEmitted(try json.decode(collector_trace.ExportTraceServiceRequest, arena.allocator(), req.body));
}

test "a 503 is retried within the export" {
    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .status = 503, .retry_after = "0" }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{
        .endpoint = url,
        .retry = .{ .initial_interval = .fromMilliseconds(5), .max_interval = .fromMilliseconds(20) },
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

test "a partial success fails the export and reports the collector's message" {
    const Capture = struct {
        mutex: Io.Mutex = .init,
        detail: [256]u8 = undefined,
        len: usize = 0,
        fn report(ptr: ?*anyopaque, component: []const u8, _: processor.ExportError, detail: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "otlp trace exporter")) return;
            self.mutex.lockUncancelable(io);
            defer self.mutex.unlock(io);
            self.len = @min(detail.len, self.detail.len);
            @memcpy(self.detail[0..self.len], detail[0..self.len]);
        }
    };
    const response: collector_trace.ExportTraceServiceResponse = .{ .partial_success = .{ .rejected_spans = 2, .error_message = "spans too old" } };
    var body: Io.Writer.Allocating = .init(gpa);
    defer body.deinit();
    try response.encode(&body.writer, gpa);

    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .body = body.written() }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var capture: Capture = .{};
    const exporter = try TraceExporter.create(gpa, io, .{ .endpoint = url, .on_error = .{ .ptr = &capture, .report = Capture.report } });
    defer exporter.destroy();
    var simple: processor.SimpleSpanProcessor = .init(io, exporter.exporter(), .{});
    const provider = try tracer_mod.TracerProvider.create(gpa, io, .{ .processors = &.{simple.processor()} });
    defer provider.destroy();
    defer provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
    var s = provider.tracer(.{ .name = "t" }).start(.background, "op", .{});
    s.end();
    try testing.expectEqualStrings("OTLP partial success: spans too old (2 spans rejected)", capture.detail[0..capture.len]);
}

test "shutdown with a deadline returns against a receiver that never answers" {
    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{ .endpoint = url }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();
    p.emit();

    const started = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(300))));
    const took = -deadline.remaining(io, started).toMilliseconds();
    try testing.expect(took >= 250);
    try testing.expect(took < 3000);
    try testing.expectEqual(@as(usize, 1), r.requestCount());
}

test "a full queue drops spans and counts them" {
    const r = try receiver.Receiver.start(gpa, io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    const url = try endpoint(r);
    defer gpa.free(url);
    var p = try Pipeline.init(.{ .endpoint = url }, .{ .max_queue_size = 4, .max_export_batch_size = 1, .schedule_delay = .fromSeconds(60) });
    defer p.deinit();
    const t = p.provider.tracer(.{ .name = "t" });
    var first = t.start(.background, "first", .{});
    first.end();
    // The worker takes the first span and hangs in its export.
    try r.waitForRequests(1, .fromSeconds(5));
    for (0..10) |_| {
        var s = t.start(.background, "queued", .{});
        s.end();
    }
    try testing.expectEqual(@as(u64, 6), p.bsp.droppedCount());
    try testing.expectError(error.Timeout, p.provider.shutdown(deadline.after(io, .fromMilliseconds(200))));
}

test "mutual TLS export to a receiver that requires a client certificate" {
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
    var p = try Pipeline.init(.{ .endpoint = url, .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key } }, .{ .schedule_delay = .fromSeconds(60) });
    defer p.deinit();
    p.emit();
    try p.provider.forceFlush(deadline.after(io, .fromSeconds(10)));
    try r.waitForRequests(1, .fromSeconds(5));
    var reader: Io.Reader = .fixed(r.request(0).body);
    var decoded = try collector_trace.ExportTraceServiceRequest.decode(&reader, gpa);
    defer decoded.deinit(gpa);
    try expectEmitted(decoded);
}

test "exports after shutdown fail with Shutdown" {
    const exporter = try TraceExporter.create(gpa, io, .{});
    defer exporter.destroy();
    const e = exporter.exporter();
    try e.shutdown(deadline.after(io, .fromSeconds(1)));
    try testing.expectError(error.Shutdown, e.exportSpans(&.{}, deadline.after(io, .fromSeconds(1))));
}
