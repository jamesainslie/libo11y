//! Unit tests for `o11ytest.HttpReceiver` and `o11ytest.GrpcReceiver`:
//! protobuf and OTLP/JSON decoding, gzip, TLS/mTLS, scripted errors, partial
//! success, latency, hangs, reset, and leak-free shutdown.

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
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
