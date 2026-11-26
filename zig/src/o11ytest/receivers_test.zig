//! Unit tests for `o11ytest.HttpReceiver` and `o11ytest.GrpcReceiver`:
//! protobuf and OTLP/JSON decoding, gzip, TLS/mTLS, scripted errors, partial
//! success, latency, hangs, reset, and leak-free shutdown.

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const o11y_wire = @import("o11y_wire");
const o11ytest = @import("o11ytest.zig");
const proto = o11ytest.proto;

test "HttpReceiver decodes OTLP/JSON with hex IDs, integer enums, lowerCamelCase, and 64-bit string ints across all three signals" {
    const io = testing.io;
    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{});
    defer recv.deinit();

    var client: std.http.Client = .{ .allocator = testing.allocator, .io = io };
    defer client.deinit();

    // 1. OTLP/JSON trace payload (hand-crafted to verify spec rules directly).
    const trace_json =
        \\{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"json-svc"}}]},"scopeSpans":[{"scope":{"name":"t"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7","name":"json-op","kind":2,"startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000005000000","attributes":[{"key":"http.response.status_code","value":{"intValue":"200"}}]}]}],"schemaUrl":"https://schemas.o11y.ing/libo11y/1.1.0"}]}
    ;
    {
        const u = try recv.url(testing.allocator, "/v1/traces");
        defer testing.allocator.free(u);
        const res = try client.fetch(.{
            .location = .{ .url = u },
            .method = .POST,
            .payload = trace_json,
            .headers = .{ .content_type = .{ .override = "application/json; charset=utf-8" } },
        });
        try testing.expectEqual(.ok, res.status);
    }

    // 2. OTLP/JSON metrics payload with 64-bit string int and hex exemplar trace/span IDs.
    const metrics_json =
        \\{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"json-svc"}}]},"scopeMetrics":[{"scope":{"name":"m"},"metrics":[{"name":"json.requests","unit":"1","sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{"timeUnixNano":"1700000000000000000","asInt":"42","exemplars":[{"timeUnixNano":"1700000000000000000","asInt":"42","traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7"}]}]}}]}],"schemaUrl":"https://schemas.o11y.ing/libo11y/1.1.0"}]}
    ;
    {
        const u = try recv.url(testing.allocator, "/v1/metrics");
        defer testing.allocator.free(u);
        const res = try client.fetch(.{
            .location = .{ .url = u },
            .method = .POST,
            .payload = metrics_json,
            .headers = .{ .content_type = .{ .override = "application/json" } },
        });
        try testing.expectEqual(.ok, res.status);
    }

    // 3. OTLP/JSON logs payload with integer severity enum and hex trace/span IDs.
    const logs_json =
        \\{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"json-svc"}}]},"scopeLogs":[{"scope":{"name":"l"},"logRecords":[{"timeUnixNano":"1700000000000000000","severityNumber":9,"severityText":"INFO","body":{"stringValue":"json log"},"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7"}]}],"schemaUrl":"https://schemas.o11y.ing/libo11y/1.1.0"}]}
    ;
    {
        const u = try recv.url(testing.allocator, "/v1/logs");
        defer testing.allocator.free(u);
        const res = try client.fetch(.{
            .location = .{ .url = u },
            .method = .POST,
            .payload = logs_json,
            .headers = .{ .content_type = .{ .override = "application/json" } },
        });
        try testing.expectEqual(.ok, res.status);
    }

    try recv.waitForRequests(3, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());

    const want_tid = o11y.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?;
    const want_sid = o11y.SpanId.parseHex("00f067aa0ba902b7").?;

    // Verify decoded trace.
    try testing.expectEqual(@as(usize, 1), recv.traces().len);
    const sp = o11ytest.inspect.findSpan(recv.traces(), "json-op").?;
    try testing.expectEqualSlices(u8, &want_tid.bytes, sp.trace_id);
    try testing.expectEqualSlices(u8, &want_sid.bytes, sp.span_id);
    try testing.expectEqual(proto.trace_v1.Span.SpanKind.SPAN_KIND_SERVER, sp.kind);
    try testing.expectEqual(@as(u64, 1700000000000000000), sp.start_time_unix_nano);
    try testing.expectEqual(@as(i64, 200), o11ytest.inspect.attrInt(sp.attributes.items, "http.response.status_code").?);

    // Verify decoded metric + exemplar.
    try testing.expectEqual(@as(usize, 1), recv.metrics().len);
    const m = o11ytest.inspect.findMetric(recv.metrics(), "json.requests").?;
    const dp = m.data.?.sum.data_points.items[0];
    try testing.expectEqual(@as(i64, 42), dp.value.?.as_int);
    try testing.expectEqualSlices(u8, &want_tid.bytes, dp.exemplars.items[0].trace_id);
    try testing.expectEqualSlices(u8, &want_sid.bytes, dp.exemplars.items[0].span_id);

    // Verify decoded log.
    try testing.expectEqual(@as(usize, 1), recv.logs().len);
    const lr = o11ytest.inspect.findLogByBody(recv.logs(), "json log").?;
    try testing.expectEqual(proto.logs_v1.SeverityNumber.SEVERITY_NUMBER_INFO, lr.severity_number);
    try testing.expectEqualSlices(u8, &want_tid.bytes, lr.trace_id);
    try testing.expectEqualSlices(u8, &want_sid.bytes, lr.span_id);

    // Reset clears recorded requests and decoded slices cleanly.
    recv.reset();
    try testing.expectEqual(@as(usize, 0), recv.requestCount());
    try testing.expectEqual(@as(usize, 0), recv.traces().len);
    try testing.expectEqual(@as(usize, 0), recv.metrics().len);
    try testing.expectEqual(@as(usize, 0), recv.logs().len);
}

test "HttpReceiver handles scripted errors, partial success, latency, and hang cancellation" {
    const io = testing.io;
    // Build a partial success protobuf response body.
    var ps_buf: std.Io.Writer.Allocating = .init(testing.allocator);
    defer ps_buf.deinit();
    const ps_msg: proto.collector_trace_v1.ExportTraceServiceResponse = .{
        .partial_success = .{ .rejected_spans = 2, .error_message = "bad attr" },
    };
    try ps_msg.encode(&ps_buf.writer, testing.allocator);

    const recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{
        .replies = &.{
            .{ .status = 400, .body = "bad request" },
            .{ .status = 200, .body = ps_buf.written(), .content_type = "application/x-protobuf", .delay = .fromMilliseconds(15) },
            .{ .hang = true },
        },
    });
    defer recv.deinit();

    const traces_url = try recv.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(traces_url);

    const ErrRec = struct {
        count: std.atomic.Value(usize) = .init(0),
        last_err: ?o11y.ExportError = null,
        fn handler(self: *@This()) o11y.ErrorHandler {
            return .{ .ptr = self, .report = report };
        }
        fn report(ptr: ?*anyopaque, _: []const u8, err: o11y.ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            self.last_err = err;
            _ = self.count.fetchAdd(1, .acq_rel);
        }
    };
    var errs: ErrRec = .{};

    const exp = try o11y.otlp.TraceExporter.create(testing.allocator, io, .{
        .endpoint = traces_url,
        .retry = .{ .enabled = false },
        .on_error = errs.handler(),
    });
    defer exp.destroy();

    const sdk = try o11y.init(testing.allocator, io, .{
        .service_name = "err-test",
        .environment = "test",
        .span_exporter = exp.exporter(),
        .error_handler = errs.handler(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    // 1. 400 error is reported as ExportFailed.
    var s1 = sdk.tracer("t").start(.background, "s1", .{});
    s1.end();
    _ = sdk.forceFlush(.fromSeconds(5));
    try testing.expect(errs.count.load(.acquire) >= 1);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), errs.last_err);

    // 2. Partial success response after delay is reported as ExportFailed.
    const before_ps = errs.count.load(.acquire);
    var s2 = sdk.tracer("t").start(.background, "s2", .{});
    s2.end();
    _ = sdk.forceFlush(.fromSeconds(5));
    try testing.expect(errs.count.load(.acquire) > before_ps);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), errs.last_err);

    // 3. Hanging request times out cleanly and receiver deinit cancels it immediately.
    var s3 = sdk.tracer("t").start(.background, "s3", .{});
    s3.end();
    const r3 = sdk.forceFlush(.fromMilliseconds(80));
    try testing.expectEqual(@as(?o11y.ExportError, error.Timeout), r3.traces);
    try testing.expectEqual(@as(usize, 3), recv.requestCount());
}

test "GrpcReceiver handles scripted errors, RetryInfo, delay, and hang cancellation" {
    const io = testing.io;
    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{
        .replies = &.{
            .{ .grpc_status = 3, .grpc_message = "invalid arg", .trailers_only = true },
            .{ .grpc_status = 0, .delay = .fromMilliseconds(15) },
            .{ .hang = true },
        },
    });
    defer recv.deinit();

    const grpc_url = try recv.url(testing.allocator);
    defer testing.allocator.free(grpc_url);

    const ErrRec = struct {
        count: std.atomic.Value(usize) = .init(0),
        last_err: ?o11y.ExportError = null,
        fn handler(self: *@This()) o11y.ErrorHandler {
            return .{ .ptr = self, .report = report };
        }
        fn report(ptr: ?*anyopaque, _: []const u8, err: o11y.ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            self.last_err = err;
            _ = self.count.fetchAdd(1, .acq_rel);
        }
    };
    var errs: ErrRec = .{};

    const exp = try o11y.otlp.GrpcTraceExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .retry = .{ .enabled = false },
        .on_error = errs.handler(),
    });
    defer exp.destroy();

    const sdk = try o11y.init(testing.allocator, io, .{
        .service_name = "grpc-err-test",
        .environment = "test",
        .span_exporter = exp.exporter(),
        .error_handler = errs.handler(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    // 1. INVALID_ARGUMENT fails immediately and reports ExportFailed.
    var s1 = sdk.tracer("t").start(.background, "s1", .{});
    s1.end();
    _ = sdk.forceFlush(.fromSeconds(5));
    try testing.expect(errs.count.load(.acquire) >= 1);
    try testing.expectEqual(@as(?o11y.ExportError, error.ExportFailed), errs.last_err);

    // 2. Delayed OK succeeds and decodes the span.
    var s2 = sdk.tracer("t").start(.background, "s2", .{});
    s2.end();
    const r2 = sdk.forceFlush(.fromSeconds(5));
    try testing.expect(r2.ok());
    try testing.expect(o11ytest.inspect.findSpan(recv.traces(), "s2") != null);

    // 3. Hanging call times out cleanly and deinit unblocks the server immediately.
    var s3 = sdk.tracer("t").start(.background, "s3", .{});
    s3.end();
    const r3 = sdk.forceFlush(.fromMilliseconds(80));
    try testing.expectEqual(@as(?o11y.ExportError, error.Timeout), r3.traces);
    try testing.expectEqual(@as(usize, 3), recv.requestCount());
}

fn encodeGrpcHeaders(gpa: std.mem.Allocator, path: []const u8, extra: []const o11y_wire.hpack.Header) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    const base = [_]o11y_wire.hpack.Header{
        .{ .name = ":method", .value = "POST" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = path },
        .{ .name = ":authority", .value = "127.0.0.1" },
        .{ .name = "content-type", .value = "application/grpc" },
    };
    for (base) |h| try o11y_wire.hpack.encodeHeader(&out.writer, h, .{}, gpa);
    for (extra) |h| try o11y_wire.hpack.encodeHeader(&out.writer, h, .{}, gpa);
    return out.toOwnedSlice();
}

test "GrpcReceiver does not double-free req_headers when a malformed HPACK block follows a valid request" {
    const io = testing.io;
    const h2 = o11y_wire.h2;
    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{});
    defer recv.deinit();

    const addr = try std.Io.net.IpAddress.parse("127.0.0.1", recv.port());
    const stream = try addr.connect(io, .{ .mode = .stream });
    defer stream.close(io);

    var rbuf: [4096]u8 = undefined;
    var wbuf: [4096]u8 = undefined;
    var reader = stream.reader(io, &rbuf);
    var writer = stream.writer(io, &wbuf);
    const in = &reader.interface;
    const out = &writer.interface;

    // HTTP/2 preface + client SETTINGS.
    try out.writeAll(h2.client_preface);
    try h2.writeSettings(out, &.{});

    // Stream 1: valid unary gRPC request with empty protobuf payload.
    const hdr_bytes = try encodeGrpcHeaders(testing.allocator, o11y.otlp.grpc_trace_method, &.{});
    defer testing.allocator.free(hdr_bytes);
    try h2.writeFrame(out, .headers, h2.Flags.end_headers, 1, hdr_bytes);
    const empty_frame = try o11y_wire.grpc_frame.frameEncode(testing.allocator, "", .none);
    defer testing.allocator.free(empty_frame);
    try h2.writeFrame(out, .data, h2.Flags.end_stream, 1, empty_frame);
    try out.flush();

    try recv.waitForRequests(1, .fromSeconds(5));

    // Stream 3 on the same connection: invalid HPACK indexed field (index 0).
    try h2.writeFrame(out, .headers, h2.Flags.end_headers, 3, &[_]u8{0x80});
    try out.flush();

    // Wait for server to close the connection cleanly after rejecting stream 3.
    var drain: [256]u8 = undefined;
    while (true) {
        const n = in.readSliceShort(&drain) catch break;
        if (n == 0) break;
    }
    try testing.expectEqual(@as(usize, 1), recv.requestCount());
}

test "GrpcReceiver accepts single DATA frames larger than 16 KiB when max_frame_size is increased" {
    const io = testing.io;
    const h2 = o11y_wire.h2;
    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{
        .max_frame_size = 32768,
    });
    defer recv.deinit();

    // Build a >20 KiB protobuf ExportTraceServiceRequest.
    const big_val = try testing.allocator.alloc(u8, 20 * 1024);
    defer testing.allocator.free(big_val);
    @memset(big_val, 'x');

    var req_arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer req_arena.deinit();
    const a = req_arena.allocator();

    var attrs: std.ArrayList(proto.common_v1.KeyValue) = .empty;
    try attrs.append(a, .{
        .key = "payload.blob",
        .value = .{ .value = .{ .string_value = big_val } },
    });
    const tid: [16]u8 = @splat(1);
    const sid: [8]u8 = @splat(2);
    var spans: std.ArrayList(proto.trace_v1.Span) = .empty;
    try spans.append(a, .{
        .trace_id = &tid,
        .span_id = &sid,
        .name = "big-frame-span",
        .attributes = attrs,
    });
    var scope_spans: std.ArrayList(proto.trace_v1.ScopeSpans) = .empty;
    try scope_spans.append(a, .{ .spans = spans });
    var res_spans: std.ArrayList(proto.trace_v1.ResourceSpans) = .empty;
    try res_spans.append(a, .{ .scope_spans = scope_spans });
    const export_req: proto.collector_trace_v1.ExportTraceServiceRequest = .{ .resource_spans = res_spans };

    var pb_buf: std.Io.Writer.Allocating = .init(testing.allocator);
    defer pb_buf.deinit();
    try export_req.encode(&pb_buf.writer, testing.allocator);

    const framed = try o11y_wire.grpc_frame.frameEncode(testing.allocator, pb_buf.written(), .none);
    defer testing.allocator.free(framed);
    try testing.expect(framed.len > h2.default_max_frame_size);
    try testing.expect(framed.len < 32768);

    const addr = try std.Io.net.IpAddress.parse("127.0.0.1", recv.port());
    const stream = try addr.connect(io, .{ .mode = .stream });
    defer stream.close(io);

    var wbuf: [4096]u8 = undefined;
    var writer = stream.writer(io, &wbuf);
    const out = &writer.interface;

    try out.writeAll(h2.client_preface);
    try h2.writeSettings(out, &.{});

    const hdr_bytes = try encodeGrpcHeaders(testing.allocator, o11y.otlp.grpc_trace_method, &.{});
    defer testing.allocator.free(hdr_bytes);
    try h2.writeFrame(out, .headers, h2.Flags.end_headers, 1, hdr_bytes);
    // Send the entire >20 KiB payload in a single HTTP/2 DATA frame.
    try h2.writeFrame(out, .data, h2.Flags.end_stream, 1, framed);
    try out.flush();

    try recv.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqual(@as(usize, 0), recv.decodeErrors());
    const sp = o11ytest.inspect.findSpan(recv.traces(), "big-frame-span").?;
    try testing.expectEqualStrings(big_val, o11ytest.inspect.attrString(sp.attributes.items, "payload.blob").?);
}

test "GrpcReceiver waits for CONTINUATION when HEADERS has END_STREAM=1 and END_HEADERS=0" {
    const io = testing.io;
    const h2 = o11y_wire.h2;
    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{});
    defer recv.deinit();

    const addr = try std.Io.net.IpAddress.parse("127.0.0.1", recv.port());
    const stream = try addr.connect(io, .{ .mode = .stream });
    defer stream.close(io);

    var wbuf: [4096]u8 = undefined;
    var writer = stream.writer(io, &wbuf);
    const out = &writer.interface;

    try out.writeAll(h2.client_preface);
    try h2.writeSettings(out, &.{});

    const hdr_bytes = try encodeGrpcHeaders(testing.allocator, o11y.otlp.grpc_trace_method, &.{
        .{ .name = "x-split-test", .value = "continuation-ok" },
    });
    defer testing.allocator.free(hdr_bytes);
    const split_at = hdr_bytes.len / 2;

    // HEADERS with END_STREAM=1, END_HEADERS=0 followed by CONTINUATION with END_HEADERS=1.
    try h2.writeFrame(out, .headers, h2.Flags.end_stream, 1, hdr_bytes[0..split_at]);
    try h2.writeFrame(out, .continuation, h2.Flags.end_headers, 1, hdr_bytes[split_at..]);
    try out.flush();

    try recv.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("continuation-ok", recv.request(0).header("x-split-test").?);
}

test "HttpReceiver and GrpcReceiver free TLS state on start error and own non-static alpn_protocols" {
    const io = testing.io;

    const bad_ca_pem = "-----BEGIN CERTIFICATE-----\n!!!invalid-base64!!!\n-----END CERTIFICATE-----\n";

    // 1. HttpReceiver partial TLS init failure must not leak cert_key.
    if (o11ytest.HttpReceiver.start(testing.allocator, io, .{
        .tls = .{ .client_ca_pem = bad_ca_pem },
    })) |r| {
        r.deinit();
        return error.TestUnexpectedResult;
    } else |_| {}

    // 2. GrpcReceiver partial TLS init failure must not leak cert_key.
    if (o11ytest.GrpcReceiver.start(testing.allocator, io, .{
        .tls = .{ .client_ca_pem = bad_ca_pem },
    })) |r| {
        r.deinit();
        return error.TestUnexpectedResult;
    } else |_| {}

    // 3. GrpcReceiver dupes alpn_protocols so freeing caller's slice/strings is safe.
    const proto_str = try testing.allocator.dupe(u8, "h2");
    const alpn_list = try testing.allocator.alloc([]const u8, 1);
    alpn_list[0] = proto_str;

    const recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{
        .tls = .{ .alpn_protocols = alpn_list },
    });
    defer recv.deinit();

    // Free caller-owned ALPN memory immediately before any connection arrives.
    testing.allocator.free(proto_str);
    testing.allocator.free(alpn_list);

    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    try o11ytest.certs.writeAll(io, tmp.dir);
    const ca_file = try o11ytest.certs.path(testing.allocator, &tmp, "ca.pem");
    defer testing.allocator.free(ca_file);

    const grpc_url = try recv.url(testing.allocator);
    defer testing.allocator.free(grpc_url);

    const exp = try o11y.otlp.GrpcTraceExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .tls = .{ .ca_file = ca_file },
        .retry = .{ .enabled = false },
    });
    defer exp.destroy();

    const sdk = try o11y.init(testing.allocator, io, .{
        .service_name = "alpn-copy-test",
        .environment = "test",
        .span_exporter = exp.exporter(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    var sp = sdk.tracer("t").start(.background, "alpn-span", .{});
    sp.end();
    try testing.expect(sdk.forceFlush(.fromSeconds(5)).ok());
    try recv.waitForRequests(1, .fromSeconds(5));
    try testing.expectEqualStrings("h2", recv.request(0).alpn_protocol.?);
}

test "HttpReceiver and GrpcReceiver snapshots stay valid during concurrent ingestion" {
    const io = testing.io;
    const http_recv = try o11ytest.HttpReceiver.start(testing.allocator, io, .{});
    defer http_recv.deinit();
    const grpc_recv = try o11ytest.GrpcReceiver.start(testing.allocator, io, .{});
    defer grpc_recv.deinit();

    const http_url = try http_recv.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(http_url);
    const grpc_url = try grpc_recv.url(testing.allocator);
    defer testing.allocator.free(grpc_url);

    const http_exp = try o11y.otlp.TraceExporter.create(testing.allocator, io, .{
        .endpoint = http_url,
        .retry = .{ .enabled = false },
    });
    defer http_exp.destroy();
    const grpc_exp = try o11y.otlp.GrpcTraceExporter.create(testing.allocator, io, .{
        .endpoint = grpc_url,
        .retry = .{ .enabled = false },
    });
    defer grpc_exp.destroy();

    const http_sdk = try o11y.init(testing.allocator, io, .{
        .service_name = "conc-http",
        .environment = "test",
        .span_exporter = http_exp.exporter(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer http_sdk.deinit();
    const grpc_sdk = try o11y.init(testing.allocator, io, .{
        .service_name = "conc-grpc",
        .environment = "test",
        .span_exporter = grpc_exp.exporter(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer grpc_sdk.deinit();

    const Sender = struct {
        fn run(sdk: *o11y.Telemetry) anyerror!void {
            for (0..12) |_| {
                var sp = sdk.tracer("t").start(.background, "conc-span", .{});
                sp.end();
                _ = sdk.forceFlush(.fromSeconds(5));
            }
        }
    };

    var http_fut = try io.concurrent(Sender.run, .{http_sdk});
    var grpc_fut = try io.concurrent(Sender.run, .{grpc_sdk});

    // Concurrently read snapshots while receivers are appending decoded traces.
    var early_http: []const proto.trace_v1.ResourceSpans = &.{};
    var early_grpc: []const proto.trace_v1.ResourceSpans = &.{};
    for (0..40) |_| {
        const hs = http_recv.traces();
        const gs = grpc_recv.traces();
        if (early_http.len == 0 and hs.len > 0) early_http = hs;
        if (early_grpc.len == 0 and gs.len > 0) early_grpc = gs;
        for (hs) |rs| {
            for (rs.scope_spans.items) |ss| {
                for (ss.spans.items) |sp| try testing.expectEqualStrings("conc-span", sp.name);
            }
        }
        for (gs) |rs| {
            for (rs.scope_spans.items) |ss| {
                for (ss.spans.items) |sp| try testing.expectEqualStrings("conc-span", sp.name);
            }
        }
        try io.sleep(.fromMilliseconds(1), .awake);
    }

    try http_fut.await(io);
    try grpc_fut.await(io);

    // Earlier snapshots remain valid and intact after all subsequent appends.
    for (early_http) |rs| {
        for (rs.scope_spans.items) |ss| {
            for (ss.spans.items) |sp| try testing.expectEqualStrings("conc-span", sp.name);
        }
    }
    for (early_grpc) |rs| {
        for (rs.scope_spans.items) |ss| {
            for (ss.spans.items) |sp| try testing.expectEqualStrings("conc-span", sp.name);
        }
    }
    try testing.expectEqual(@as(usize, 12), http_recv.traces().len);
    try testing.expectEqual(@as(usize, 12), grpc_recv.traces().len);
}
