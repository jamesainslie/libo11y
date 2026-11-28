//! Unit and loopback wire tests for the OTLP/gRPC transport.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const deadline = @import("../deadline.zig");
const transport = @import("transport.zig");
const h2 = @import("o11y_wire").h2;
const grpc = @import("grpc.zig");
const grpc_receiver = @import("test/grpc_receiver.zig");
const GrpcReceiver = grpc_receiver.GrpcReceiver;

const fast_retry: grpc.RetryOptions = .{
    .initial_interval = .fromMilliseconds(15),
    .max_interval = .fromMilliseconds(30),
    .max_elapsed = .fromSeconds(5),
};

const test_method = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";

fn soon() deadline.Deadline {
    return deadline.after(testing.io, .fromSeconds(10));
}

fn now() Io.Clock.Timestamp {
    return Io.Clock.Timestamp.now(testing.io, .awake);
}

fn elapsedMs(since: Io.Clock.Timestamp) i64 {
    return since.untilNow(testing.io).raw.toMilliseconds();
}

fn newTransport(r: *GrpcReceiver, options: grpc.Options) !*grpc.Transport {
    const url = try r.url(testing.allocator);
    defer testing.allocator.free(url);
    var o = options;
    o.endpoint = url;
    if (o.method.len == 0) o.method = test_method;
    return grpc.Transport.create(testing.allocator, testing.io, o);
}

test "frameEncode and frameDecode round-trip plain and gzip" {
    const msg = "hello protobuf payload repeated repeated repeated repeated";
    const plain = try grpc.frameEncode(testing.allocator, msg, .none);
    defer testing.allocator.free(plain);
    try testing.expectEqual(@as(u8, 0), plain[0]);
    try testing.expectEqual(@as(u32, @intCast(msg.len)), std.mem.readInt(u32, plain[1..5], .big));
    const dec_plain = try grpc.frameDecode(testing.allocator, plain, null, 1024);
    defer testing.allocator.free(dec_plain);
    try testing.expectEqualStrings(msg, dec_plain);

    const zipped = try grpc.frameEncode(testing.allocator, msg, .gzip);
    defer testing.allocator.free(zipped);
    try testing.expectEqual(@as(u8, 1), zipped[0]);
    const dec_zip = try grpc.frameDecode(testing.allocator, zipped, "gzip", 1024);
    defer testing.allocator.free(dec_zip);
    try testing.expectEqualStrings(msg, dec_zip);

    // Invalid frames and size caps
    try testing.expectError(error.InvalidFrame, grpc.frameDecode(testing.allocator, &.{ 0, 0, 0 }, null, 1024));
    try testing.expectError(error.InvalidFrame, grpc.frameDecode(testing.allocator, &.{ 2, 0, 0, 0, 0 }, null, 1024));
    try testing.expectError(error.InvalidFrame, grpc.frameDecode(testing.allocator, &.{ 0, 0, 0, 0, 5, 'a' }, null, 1024));
    try testing.expectError(error.InvalidFrame, grpc.frameDecode(testing.allocator, &.{ 0, 0xff, 0xff, 0xff, 0xff }, null, 1024));
    try testing.expectError(error.ResponseTooLarge, grpc.frameDecode(testing.allocator, plain, null, 4));
    try testing.expectError(error.UnsupportedEncoding, grpc.frameDecode(testing.allocator, zipped, null, 1024));
    try testing.expectError(error.UnsupportedEncoding, grpc.frameDecode(testing.allocator, zipped, "deflate", 1024));
}

test "formatTimeout, decodeGrpcMessage and parseRetryInfo" {
    var buf: [16]u8 = undefined;
    try testing.expectEqualStrings("1n", grpc.formatTimeout(&buf, .fromNanoseconds(-50)));
    try testing.expectEqualStrings("500n", grpc.formatTimeout(&buf, .fromNanoseconds(500)));
    try testing.expectEqualStrings("250000u", grpc.formatTimeout(&buf, .fromMilliseconds(250)));
    try testing.expectEqualStrings("100000S", grpc.formatTimeout(&buf, .fromSeconds(100_000)));
    try testing.expectEqualStrings("10000000u", grpc.formatTimeout(&buf, .fromSeconds(10)));

    var msg_buf: [64]u8 = undefined;
    try testing.expectEqualStrings("bad span: 50%", grpc.decodeGrpcMessage(&msg_buf, "bad%20span%3A%2050%25"));
    try testing.expectEqualStrings("keep %zz", grpc.decodeGrpcMessage(&msg_buf, "keep%20%zz"));

    const b64 = try grpc_receiver.encodeRetryInfoBase64(testing.allocator, .fromMilliseconds(1500));
    defer testing.allocator.free(b64);
    const parsed = grpc.parseRetryInfo(testing.allocator, b64).?;
    try testing.expectEqual(Io.Duration.fromMilliseconds(1500), parsed);
    try testing.expectEqual(@as(?Io.Duration, null), grpc.parseRetryInfo(testing.allocator, "!!!not-base64!!!"));

    // Large seconds (10_000_000_000 > i64 max / 1e9) must not overflow i64.
    const huge_b64 = try grpc_receiver.encodeRetryInfoBase64(testing.allocator, .fromSeconds(10_000_000_000));
    defer testing.allocator.free(huge_b64);
    const huge = grpc.parseRetryInfo(testing.allocator, huge_b64).?;
    try testing.expectEqual(Io.Duration.fromSeconds(10_000_000_000), huge);
}

test "h2c unary call arrives with required gRPC headers and lowercased custom headers" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var t = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .headers = &.{
            .{ .name = "X-Tenant", .value = "acme" },
            .{ .name = "Authorization", .value = "Bearer tok" },
        },
    });
    defer t.destroy();

    var resp = try t.send("proto-bytes", soon());
    defer resp.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 0), resp.body.len);

    try testing.expectEqual(@as(usize, 1), r.requestCount());
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("http", req.scheme);
    try testing.expectEqualStrings(test_method, req.path);
    try testing.expect(std.mem.startsWith(u8, req.authority, "127.0.0.1:"));
    try testing.expectEqualStrings("application/grpc", req.content_type.?);
    try testing.expectEqualStrings("trailers", req.header("te").?);
    try testing.expectEqualStrings(transport.user_agent, req.header("user-agent").?);
    try testing.expectEqualStrings("gzip,identity", req.header("grpc-accept-encoding").?);
    try testing.expect(req.header("grpc-timeout") != null);
    try testing.expectEqual(@as(?[]const u8, null), req.grpc_encoding);
    try testing.expectEqualStrings("acme", req.header("x-tenant").?);
    try testing.expectEqualStrings("Bearer tok", req.header("authorization").?);
    try testing.expectEqualStrings("proto-bytes", req.body);
    try testing.expectEqual(@as(u31, 1), req.stream_id);
}

test "gzip request and compressed response round-trip" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{.{ .body = "response-payload-for-gzip-check", .compress_response = true }},
    });
    defer r.stop();
    var t = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .compression = .gzip,
    });
    defer t.destroy();

    var resp = try t.send("compressed-request-body-with-repetition-repetition", soon());
    defer resp.deinit(testing.allocator);
    try testing.expectEqualStrings("response-payload-for-gzip-check", resp.body);
    const req = r.request(0);
    try testing.expectEqualStrings("gzip", req.grpc_encoding.?);
    try testing.expectEqualStrings("compressed-request-body-with-repetition-repetition", req.body);
}

test "connection reuse sends odd stream IDs and decodes dynamic HPACK table across calls" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{
            .{ .use_dynamic_table = true, .use_huffman = true },
            .{ .use_dynamic_table = true, .use_huffman = true },
            .{ .use_dynamic_table = true, .use_huffman = true },
        },
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method });
    defer t.destroy();

    for (0..3) |_| {
        var resp = try t.send("ping", soon());
        resp.deinit(testing.allocator);
    }
    try testing.expectEqual(@as(usize, 3), r.requestCount());
    try testing.expectEqual(@as(usize, 1), r.connectionCount());
    try testing.expectEqual(@as(u31, 1), r.request(0).stream_id);
    try testing.expectEqual(@as(u31, 3), r.request(1).stream_id);
    try testing.expectEqual(@as(u31, 5), r.request(2).stream_id);
}

test "large request and response exercise HTTP/2 frame splitting and flow-control WINDOW_UPDATE" {
    const big_req = try testing.allocator.alloc(u8, 96 * 1024);
    defer testing.allocator.free(big_req);
    for (big_req, 0..) |*b, i| b.* = @truncate(i * 31 + 7);

    const big_resp = try testing.allocator.alloc(u8, 80 * 1024);
    defer testing.allocator.free(big_resp);
    for (big_resp, 0..) |*b, i| b.* = @truncate(i * 17 + 3);

    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{.{ .body = big_resp }},
        .initial_window_size = 32768,
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method });
    defer t.destroy();

    var resp = try t.send(big_req, soon());
    defer resp.deinit(testing.allocator);
    try testing.expectEqualSlices(u8, big_resp, resp.body);
    try testing.expectEqualSlices(u8, big_req, r.request(0).body);
}

test "UNAVAILABLE (14) retries and succeeds on second attempt" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{
            .{ .grpc_status = @backingInt(grpc.StatusCode.unavailable), .grpc_message = "try%20again" },
        },
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
    defer t.destroy();

    var resp = try t.send("retry-me", soon());
    defer resp.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 2), r.requestCount());
    try testing.expectEqualStrings("retry-me", r.request(1).body);
}

test "RESOURCE_EXHAUSTED (8) retries only when RetryInfo throttle is present" {
    // With RetryInfo: retried and succeeds.
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
            .replies = &.{
                .{
                    .grpc_status = @backingInt(grpc.StatusCode.resource_exhausted),
                    .grpc_message = "throttled",
                    .retry_info_delay = .fromMilliseconds(40),
                },
            },
        });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
        defer t.destroy();
        const start = now();
        var resp = try t.send("x", soon());
        resp.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 2), r.requestCount());
        try testing.expect(elapsedMs(start) >= 35);
    }
    // Without throttle: fails immediately.
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
            .replies = &.{
                .{ .grpc_status = @backingInt(grpc.StatusCode.resource_exhausted), .grpc_message = "quota" },
            },
        });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
        defer t.destroy();
        try testing.expectError(error.Rejected, t.send("x", soon()));
        try testing.expectEqual(@as(usize, 1), r.requestCount());
    }
}

test "INVALID_ARGUMENT (3) fails immediately without retry and reports decoded message" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{
            .{
                .grpc_status = @backingInt(grpc.StatusCode.invalid_argument),
                .grpc_message = "bad%20trace%20id",
            },
        },
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
    defer t.destroy();

    try testing.expectError(error.Rejected, t.send("x", soon()));
    try testing.expectEqual(@as(usize, 1), r.requestCount());
    var err_buf: [512]u8 = undefined;
    const err_text = t.copyLastError(&err_buf);
    try testing.expect(std.mem.indexOf(u8, err_text, "INVALID_ARGUMENT") != null);
    try testing.expect(std.mem.indexOf(u8, err_text, "bad trace id") != null);

    // Connection remains reusable after non-retryable gRPC status.
    var ok = try t.send("y", soon());
    ok.deinit(testing.allocator);
    try testing.expectEqual(@as(usize, 1), r.connectionCount());
}

test "trailers-only error response is handled cleanly" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{
            .{
                .grpc_status = @backingInt(grpc.StatusCode.unimplemented),
                .grpc_message = "no%20such%20method",
                .trailers_only = true,
            },
        },
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
    defer t.destroy();

    try testing.expectError(error.Rejected, t.send("x", soon()));
    try testing.expectEqual(@as(usize, 1), r.requestCount());
    var err_buf: [512]u8 = undefined;
    const err_text = t.copyLastError(&err_buf);
    try testing.expect(std.mem.indexOf(u8, err_text, "UNIMPLEMENTED") != null);
    try testing.expect(std.mem.indexOf(u8, err_text, "no such method") != null);
}

test "concurrent sendDetail callers receive isolated error details without races" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .replies = &.{
            .{ .grpc_status = @backingInt(grpc.StatusCode.invalid_argument), .grpc_message = "err-one" },
            .{ .grpc_status = @backingInt(grpc.StatusCode.permission_denied), .grpc_message = "err-two" },
        },
    });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = .{ .enabled = false } });
    defer t.destroy();

    const Caller = struct {
        buf: [512]u8 = undefined,
        len: usize = 0,
        err: ?grpc.SendError = null,
        fn run(self: *@This(), tr: *grpc.Transport) void {
            if (tr.sendDetail("x", soon(), &self.buf, &self.len)) |resp| {
                var owned = resp;
                owned.deinit(testing.allocator);
            } else |e| {
                self.err = e;
            }
        }
    };
    var c1: Caller = .{};
    var c2: Caller = .{};
    var f1 = try testing.io.concurrent(Caller.run, .{ &c1, t });
    var f2 = try testing.io.concurrent(Caller.run, .{ &c2, t });
    f1.await(testing.io);
    f2.await(testing.io);

    try testing.expectEqual(@as(?grpc.SendError, error.Rejected), c1.err);
    try testing.expectEqual(@as(?grpc.SendError, error.Rejected), c2.err);
    const s1 = c1.buf[0..c1.len];
    const s2 = c2.buf[0..c2.len];
    const got_one = std.mem.indexOf(u8, s1, "err-one") != null or std.mem.indexOf(u8, s2, "err-one") != null;
    const got_two = std.mem.indexOf(u8, s1, "err-two") != null or std.mem.indexOf(u8, s2, "err-two") != null;
    try testing.expect(got_one and got_two);
}

test "GOAWAY causes clean redial on next call and transparent redial when stream refused" {
    // GOAWAY after response: first call succeeds, second call redials.
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
            .replies = &.{.{ .send_goaway_after = true }},
        });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = .{ .enabled = false } });
        defer t.destroy();
        var r1 = try t.send("one", soon());
        r1.deinit(testing.allocator);
        try testing.io.sleep(.fromMilliseconds(30), .awake);
        var r2 = try t.send("two", soon());
        r2.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 2), r.connectionCount());
        try testing.expectEqualStrings("two", r.request(1).body);
    }
    // GOAWAY before response (last_stream_id=0): transparent redial within one send.
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
            .replies = &.{.{ .send_goaway_before = true }},
        });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = .{ .enabled = false } });
        defer t.destroy();
        var resp = try t.send("redialed", soon());
        resp.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 2), r.connectionCount());
        try testing.expectEqualStrings("redialed", r.request(1).body);
    }
    // RST_STREAM(REFUSED_STREAM): transparent redial within one send.
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
            .replies = &.{.{ .rst_stream = @backingInt(h2.ErrorCode.refused_stream) }},
        });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = .{ .enabled = false } });
        defer t.destroy();
        var resp = try t.send("refused-then-ok", soon());
        resp.deinit(testing.allocator);
        try testing.expectEqual(@as(usize, 2), r.connectionCount());
    }
}

test "an Io without concurrency fails the call inside its deadline" {
    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var threaded: Io.Threaded = .init(testing.allocator, .{ .concurrent_limit = .nothing });
    defer threaded.deinit();
    const url = try r.url(testing.allocator);
    defer testing.allocator.free(url);

    var t = try grpc.Transport.create(testing.allocator, threaded.io(), .{ .endpoint = url, .method = test_method, .retry = .{ .enabled = false } });
    defer t.destroy();
    var detail: [256]u8 = undefined;
    var detail_len: usize = 0;
    try testing.expectError(error.Unreachable, t.sendDetail("x", deadline.after(threaded.io(), .fromSeconds(10)), &detail, &detail_len));
    try testing.expect(std.mem.indexOf(u8, detail[0..detail_len], "no concurrent task") != null);
    try testing.expectEqual(0, r.requestCount());
}

test "hanging server respects deadline and close interrupts active send" {
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method, .retry = fast_retry });
        defer t.destroy();
        const start = now();
        try testing.expectError(error.Timeout, t.send("x", deadline.after(testing.io, .fromMilliseconds(250))));
        const ms = elapsedMs(start);
        try testing.expect(ms >= 200);
        try testing.expect(ms < 1500);
    }
    {
        var r = try GrpcReceiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
        defer r.stop();
        var t = try newTransport(r, .{ .endpoint = "", .method = test_method });
        defer t.destroy();
        const Sender = struct {
            fn run(tr: *grpc.Transport) grpc.SendError!void {
                var resp = try tr.send("x", deadline.after(testing.io, .fromSeconds(30)));
                resp.deinit(testing.allocator);
            }
        };
        var fut = try testing.io.concurrent(Sender.run, .{t});
        try r.waitForRequests(1, .fromSeconds(5));
        t.close();
        try testing.expectError(error.Shutdown, fut.await(testing.io));
        try testing.expectError(error.Shutdown, t.send("y", soon()));
    }
}

const TlsFixture = struct {
    tmp: testing.TmpDir,

    fn init() !TlsFixture {
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        try grpc_receiver.certs.writeAll(testing.io, tmp.dir);
        return .{ .tmp = tmp };
    }

    fn deinit(f: *TlsFixture) void {
        f.tmp.cleanup();
    }

    fn path(f: *const TlsFixture, name: []const u8) ![]u8 {
        return grpc_receiver.certs.path(testing.allocator, &f.tmp, name);
    }
};

test "TLS with ALPN h2 and mutual TLS client certificate" {
    var fx = try TlsFixture.init();
    defer fx.deinit();
    const ca = try fx.path("ca.pem");
    defer testing.allocator.free(ca);
    const other_ca = try fx.path("other-ca.pem");
    defer testing.allocator.free(other_ca);
    const cert = try fx.path("client.pem");
    defer testing.allocator.free(cert);
    const key = try fx.path("client-key.pem");
    defer testing.allocator.free(key);

    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .tls = .{ .client_ca_pem = grpc_receiver.certs.ca },
    });
    defer r.stop();

    // Valid mTLS + ALPN h2 succeeds and reuses the TLS connection.
    var t = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key },
    });
    defer t.destroy();
    for (0..2) |_| {
        var resp = try t.send("mtls-h2", soon());
        resp.deinit(testing.allocator);
    }
    try testing.expectEqual(@as(usize, 2), r.requestCount());
    try testing.expectEqual(@as(usize, 1), r.connectionCount());
    try testing.expectEqualStrings("https", r.request(0).scheme);
    try testing.expectEqualStrings("h2", r.request(0).alpn_protocol.?);
    try testing.expectEqualStrings("mtls-h2", r.request(1).body);

    // Wrong CA fails with Unreachable.
    var bad_ca = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .tls = .{ .ca_file = other_ca, .client_cert_file = cert, .client_key_file = key },
        .retry = fast_retry,
    });
    defer bad_ca.destroy();
    try testing.expectError(error.Unreachable, bad_ca.send("x", soon()));
    var bad_ca_buf: [512]u8 = undefined;
    try testing.expect(std.mem.indexOf(u8, bad_ca.copyLastError(&bad_ca_buf), "TLS handshake") != null);

    // Missing client cert fails with Unreachable.
    var no_cert = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .tls = .{ .ca_file = ca },
        .retry = fast_retry,
    });
    defer no_cert.destroy();
    try testing.expectError(error.Unreachable, no_cert.send("x", soon()));
}

test "TLS rejects server that does not negotiate ALPN h2" {
    var fx = try TlsFixture.init();
    defer fx.deinit();
    const ca = try fx.path("ca.pem");
    defer testing.allocator.free(ca);

    var r = try GrpcReceiver.start(testing.allocator, testing.io, .{
        .tls = .{ .alpn_protocols = &.{"http/1.1"} },
    });
    defer r.stop();
    var t = try newTransport(r, .{
        .endpoint = "",
        .method = test_method,
        .tls = .{ .ca_file = ca },
        .retry = fast_retry,
    });
    defer t.destroy();
    try testing.expectError(error.Unreachable, t.send("x", soon()));
    var alpn_buf: [512]u8 = undefined;
    try testing.expect(std.mem.indexOf(u8, t.copyLastError(&alpn_buf), "TLS handshake") != null);
}

test "create validates endpoint, method, headers and TLS options" {
    const gpa = testing.allocator;
    const io = testing.io;
    try testing.expectError(error.InvalidEndpoint, grpc.Transport.create(gpa, io, .{ .endpoint = "localhost:4317", .method = test_method }));
    try testing.expectError(error.InvalidEndpoint, grpc.Transport.create(gpa, io, .{ .endpoint = "http://h:4317", .method = "no-leading-slash" }));
    try testing.expectError(error.InvalidHeader, grpc.Transport.create(gpa, io, .{
        .endpoint = "http://h:4317",
        .method = test_method,
        .headers = &.{.{ .name = "bad name", .value = "v" }},
    }));
    try testing.expectError(error.TlsConfig, grpc.Transport.create(gpa, io, .{
        .endpoint = "http://h:4317",
        .method = test_method,
        .tls = .{ .ca_file = "ca.pem" },
    }));
}
