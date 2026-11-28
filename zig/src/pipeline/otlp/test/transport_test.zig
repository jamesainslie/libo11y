//! Loopback tests of the OTLP/HTTP transport against the test receiver.

const std = @import("std");
const transport = @import("../transport.zig");
const receiver = @import("receiver.zig");
const deadline = @import("../../deadline.zig");
const Io = std.Io;
const testing = std.testing;
const Receiver = receiver.Receiver;
const Transport = transport.Transport;

const fast_retry: transport.RetryOptions = .{
    .initial_interval = .fromMilliseconds(20),
    .max_interval = .fromMilliseconds(40),
    .max_elapsed = .fromSeconds(5),
};

const slow_elapsed: transport.RetryOptions = .{
    .initial_interval = .fromMilliseconds(20),
    .max_interval = .fromMilliseconds(40),
    .max_elapsed = .fromSeconds(60),
};

fn soon() deadline.Deadline {
    return deadline.after(testing.io, .fromSeconds(10));
}

fn elapsedMs(since: Io.Clock.Timestamp) i64 {
    return since.untilNow(testing.io).raw.toMilliseconds();
}

fn now() Io.Clock.Timestamp {
    return Io.Clock.Timestamp.now(testing.io, .awake);
}

fn newTransport(r: *Receiver, options: transport.Options) !*Transport {
    const url = try r.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(url);
    var o = options;
    o.endpoint = url;
    return Transport.create(testing.allocator, testing.io, o);
}

test "a plain POST arrives with its headers and content type" {
    var r = try Receiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var t = try newTransport(r, .{
        .endpoint = "",
        .content_type = "application/x-protobuf",
        .headers = &.{ .{ .name = "api-key", .value = "s3cret" }, .{ .name = "x-tenant", .value = "a b" } },
    });
    defer t.destroy();

    var resp = try t.send("payload-bytes", soon());
    defer resp.deinit(testing.allocator);
    try testing.expectEqual(200, resp.status);
    try testing.expectEqualStrings("application/x-protobuf", resp.content_type);
    try testing.expectEqual(0, resp.body.len);

    try testing.expectEqual(1, r.requestCount());
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/traces", req.path);
    try testing.expectEqualStrings("application/x-protobuf", req.content_type.?);
    try testing.expectEqual(null, req.content_encoding);
    try testing.expectEqualStrings("s3cret", req.header("api-key").?);
    try testing.expectEqualStrings("a b", req.header("x-tenant").?);
    try testing.expectEqualStrings(transport.user_agent, req.header("user-agent").?);
    try testing.expect(std.mem.startsWith(u8, req.header("host").?, "127.0.0.1:"));
    try testing.expectEqualStrings("13", req.header("content-length").?);
    try testing.expectEqualStrings("payload-bytes", req.body);
}

test "a gzip body decodes on the receiver" {
    var r = try Receiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/json", .compression = .gzip });
    defer t.destroy();
    const body = "{\"resourceSpans\":[]}";
    var resp = try t.send(body, soon());
    resp.deinit(testing.allocator);
    const req = r.request(0);
    try testing.expectEqualStrings("gzip", req.content_encoding.?);
    try testing.expectEqualStrings("application/json", req.content_type.?);
    try testing.expectEqualStrings(body, req.body);
}

test "the connection is reused across sends" {
    var r = try Receiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf" });
    defer t.destroy();
    for (0..3) |_| {
        var resp = try t.send("x", soon());
        resp.deinit(testing.allocator);
    }
    try testing.expectEqual(3, r.requestCount());
    try testing.expectEqual(1, r.connectionCount());
    try testing.expectEqual(r.request(0).connection, r.request(2).connection);
}

test "a server that closes the idle connection gets a transparent redial" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .close_after = true }} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = .{ .enabled = false } });
    defer t.destroy();
    var first = try t.send("one", soon());
    first.deinit(testing.allocator);
    // Let the close reach the client before the next send.
    try testing.io.sleep(.fromMilliseconds(50), .awake);
    var second = try t.send("two", soon());
    second.deinit(testing.allocator);
    try testing.expectEqual(2, r.requestCount());
    try testing.expectEqual(2, r.connectionCount());
    try testing.expectEqualStrings("two", r.request(1).body);
}

test "503 then 200 retries and succeeds" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{
        .{ .status = 503, .body = "busy" },
        .{ .status = 502 },
    } });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = fast_retry });
    defer t.destroy();
    const start = now();
    var resp = try t.send("x", soon());
    resp.deinit(testing.allocator);
    try testing.expectEqual(3, r.requestCount());
    try testing.expect(elapsedMs(start) < 1000);
    try testing.expectEqualStrings("x", r.request(2).body);
}

test "Retry-After is honoured" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{
        .{ .status = 429, .retry_after = "1" },
    } });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = fast_retry });
    defer t.destroy();
    const start = now();
    var resp = try t.send("x", soon());
    resp.deinit(testing.allocator);
    const ms = elapsedMs(start);
    try testing.expectEqual(2, r.requestCount());
    try testing.expect(ms >= 900);
    try testing.expect(ms < 3000);
}

test "a Retry-After past the deadline gives up at once with Timeout" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{
        .{ .status = 503, .retry_after = "30" },
    } });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = slow_elapsed, .timeout = .fromSeconds(2) });
    defer t.destroy();
    const start = now();
    try testing.expectError(error.Timeout, t.send("x", soon()));
    try testing.expect(elapsedMs(start) < 1000);
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "503") != null);
    try testing.expectEqual(1, r.requestCount());
}

test "a Retry-After past max_elapsed gives the last failure, as Go does" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{
        .{ .status = 503, .retry_after = "30" },
    } });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = fast_retry });
    defer t.destroy();
    try testing.expectError(error.Rejected, t.send("x", soon()));
    try testing.expectEqual(1, r.requestCount());
}

test "400 is not retried and gives Rejected with the status in lastError" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{
        .{ .status = 400, .body = "bad span\n", .content_type = "text/plain" },
    } });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = fast_retry });
    defer t.destroy();
    try testing.expectError(error.Rejected, t.send("x", soon()));
    try testing.expectEqual(1, r.requestCount());
    const msg = t.lastError();
    try testing.expect(std.mem.indexOf(u8, msg, "400 Bad Request") != null);
    try testing.expect(std.mem.indexOf(u8, msg, "(body: bad span)") != null);
    // The connection stays usable after a rejected request.
    var ok = try t.send("y", soon());
    ok.deinit(testing.allocator);
    try testing.expectEqual(1, r.connectionCount());
}

test "retries exhausted on a retryable status give Rejected" {
    const replies: [50]receiver.Reply = @splat(.{ .status = 503 });
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &replies });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = .{
        .initial_interval = .fromMilliseconds(10),
        .max_interval = .fromMilliseconds(10),
        .max_elapsed = .fromMilliseconds(100),
    } });
    defer t.destroy();
    try testing.expectError(error.Rejected, t.send("x", soon()));
    try testing.expect(r.requestCount() >= 3);
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "503") != null);
}

test "retries stop at the deadline even when max_elapsed is longer" {
    const replies: [100]receiver.Reply = @splat(.{ .status = 503 });
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &replies });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = .{
        .initial_interval = .fromMilliseconds(50),
        .max_interval = .fromMilliseconds(50),
        .max_elapsed = .fromSeconds(60),
    } });
    defer t.destroy();
    const start = now();
    try testing.expectError(error.Timeout, t.send("x", deadline.after(testing.io, .fromMilliseconds(300))));
    const ms = elapsedMs(start);
    try testing.expect(ms < 1000);
    try testing.expect(r.requestCount() >= 2);
}

test "a hanging receiver times out the send and stop returns promptly" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .retry = fast_retry });
    defer t.destroy();
    const start = now();
    try testing.expectError(error.Timeout, t.send("x", deadline.after(testing.io, .fromMilliseconds(300))));
    const ms = elapsedMs(start);
    try testing.expect(ms >= 250);
    try testing.expect(ms < 1000);
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "deadline exceeded") != null);
    const stop_start = now();
    r.stop();
    try testing.expect(elapsedMs(stop_start) < 1000);
}

test "options.timeout bounds a send without a caller deadline" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .timeout = .fromMilliseconds(200) });
    defer t.destroy();
    const start = now();
    try testing.expectError(error.Timeout, t.send("x", soon()));
    try testing.expect(elapsedMs(start) < 1000);
}

test "the send after a timeout redials" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf" });
    defer t.destroy();
    try testing.expectError(error.Timeout, t.send("x", deadline.after(testing.io, .fromMilliseconds(100))));
    var resp = try t.send("y", soon());
    resp.deinit(testing.allocator);
    try testing.expectEqual(2, r.connectionCount());
}

test "close interrupts a send and later sends fail with Shutdown" {
    var r = try Receiver.start(testing.allocator, testing.io, .{ .replies = &.{.{ .hang = true }} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf" });
    defer t.destroy();
    const Sender = struct {
        fn run(tr: *Transport) transport.SendError!void {
            var resp = try tr.send("x", deadline.after(testing.io, .fromSeconds(30)));
            resp.deinit(testing.allocator);
        }
    };
    var future = try testing.io.concurrent(Sender.run, .{t});
    try r.waitForRequests(1, .fromSeconds(5));
    const start = now();
    t.close();
    try testing.expectError(error.Shutdown, future.await(testing.io));
    try testing.expect(elapsedMs(start) < 1000);
    try testing.expectError(error.Shutdown, t.send("y", soon()));
    t.close();
}

test "a refused connection is Unreachable and not retried" {
    // Find a free port by listening and closing.
    const address = try Io.net.IpAddress.parse("127.0.0.1", 0);
    var server = try address.listen(testing.io, .{});
    const port = server.socket.address.getPort();
    server.deinit(testing.io);
    const url = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/v1/traces", .{port});
    defer testing.allocator.free(url);
    var t = try Transport.create(testing.allocator, testing.io, .{ .endpoint = url, .content_type = "application/x-protobuf" });
    defer t.destroy();
    const start = now();
    try testing.expectError(error.Unreachable, t.send("x", soon()));
    try testing.expect(elapsedMs(start) < 1000);
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "ConnectionRefused") != null);
}

test "create validates the endpoint, headers and TLS options" {
    const gpa = testing.allocator;
    const io = testing.io;
    try testing.expectError(error.InvalidEndpoint, Transport.create(gpa, io, .{ .endpoint = "localhost:4318", .content_type = "a" }));
    try testing.expectError(error.InvalidHeader, Transport.create(gpa, io, .{
        .endpoint = "http://h/",
        .content_type = "a",
        .headers = &.{.{ .name = "bad name", .value = "v" }},
    }));
    try testing.expectError(error.InvalidHeader, Transport.create(gpa, io, .{
        .endpoint = "http://h/",
        .content_type = "a",
        .headers = &.{.{ .name = "x", .value = "v\r\nInjected: 1" }},
    }));
    try testing.expectError(error.TlsConfig, Transport.create(gpa, io, .{
        .endpoint = "http://h/",
        .content_type = "a",
        .tls = .{ .ca_file = "ca.pem" },
    }));
    try testing.expectError(error.TlsConfig, Transport.create(gpa, io, .{
        .endpoint = "https://h/",
        .content_type = "a",
        .tls = .{ .ca_file = "/nonexistent/ca.pem" },
    }));
    try testing.expectError(error.TlsConfig, Transport.create(gpa, io, .{
        .endpoint = "https://h/",
        .content_type = "a",
        .tls = .{ .client_cert_file = "c.pem" },
    }));
}

test "send rejects a body over the request size limit" {
    var t = try Transport.create(testing.allocator, testing.io, .{ .endpoint = "http://127.0.0.1:9/", .content_type = "a" });
    defer t.destroy();
    const big = try testing.allocator.alloc(u8, transport.max_request_size + 1);
    defer testing.allocator.free(big);
    try testing.expectError(error.Rejected, t.send(big, soon()));
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "too large") != null);
}

const TlsFixture = struct {
    tmp: testing.TmpDir,

    fn init() !TlsFixture {
        var tmp = testing.tmpDir(.{});
        errdefer tmp.cleanup();
        try receiver.certs.writeAll(testing.io, tmp.dir);
        return .{ .tmp = tmp };
    }

    fn deinit(f: *TlsFixture) void {
        f.tmp.cleanup();
    }

    fn path(f: *const TlsFixture, name: []const u8) ![]u8 {
        return receiver.certs.path(testing.allocator, &f.tmp, name);
    }
};

test "TLS: a request over https with the CA file succeeds" {
    var fx = try TlsFixture.init();
    defer fx.deinit();
    const ca = try fx.path("ca.pem");
    defer testing.allocator.free(ca);
    var r = try Receiver.start(testing.allocator, testing.io, .{ .tls = .{} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .tls = .{ .ca_file = ca } });
    defer t.destroy();
    for (0..2) |_| {
        var resp = try t.send("secure", soon());
        resp.deinit(testing.allocator);
    }
    try testing.expectEqual(2, r.requestCount());
    try testing.expectEqual(1, r.connectionCount());
    try testing.expectEqualStrings("secure", r.request(1).body);
    try testing.expect(std.mem.startsWith(u8, r.request(0).header("host").?, "localhost:"));
}

test "TLS: a wrong CA fails with Unreachable" {
    var fx = try TlsFixture.init();
    defer fx.deinit();
    const other = try fx.path("other-ca.pem");
    defer testing.allocator.free(other);
    var r = try Receiver.start(testing.allocator, testing.io, .{ .tls = .{} });
    defer r.stop();
    var t = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .tls = .{ .ca_file = other }, .retry = fast_retry });
    defer t.destroy();
    try testing.expectError(error.Unreachable, t.send("x", soon()));
    try testing.expectEqual(0, r.requestCount());
    try testing.expect(std.mem.indexOf(u8, t.lastError(), "TLS handshake") != null);
}

test "TLS: mutual TLS needs the client certificate" {
    var fx = try TlsFixture.init();
    defer fx.deinit();
    const ca = try fx.path("ca.pem");
    defer testing.allocator.free(ca);
    const cert = try fx.path("client.pem");
    defer testing.allocator.free(cert);
    const key = try fx.path("client-key.pem");
    defer testing.allocator.free(key);
    var r = try Receiver.start(testing.allocator, testing.io, .{ .tls = .{ .client_ca_pem = receiver.certs.ca } });
    defer r.stop();

    var with = try newTransport(r, .{
        .endpoint = "",
        .content_type = "application/x-protobuf",
        .tls = .{ .ca_file = ca, .client_cert_file = cert, .client_key_file = key },
    });
    defer with.destroy();
    var resp = try with.send("mtls", soon());
    resp.deinit(testing.allocator);
    try testing.expectEqualStrings("mtls", r.request(0).body);

    var without = try newTransport(r, .{ .endpoint = "", .content_type = "application/x-protobuf", .tls = .{ .ca_file = ca }, .retry = fast_retry });
    defer without.destroy();
    // TLS 1.3 finishes the client side of the handshake before the server
    // checks the certificate, so the refusal arrives as an alert or a
    // closed connection on the first read: error.Unreachable.
    try testing.expectError(error.Unreachable, without.send("x", soon()));
    try testing.expectEqual(1, r.requestCount());
}

test "an Io without concurrency fails the send inside its deadline" {
    // Socket reads cannot time out, so an attempt that ran inline could
    // outlive the deadline. Without a concurrent task the send fails as a
    // retryable failure and never touches the network.
    var r = try Receiver.start(testing.allocator, testing.io, .{});
    defer r.stop();
    var threaded: Io.Threaded = .init(testing.allocator, .{ .concurrent_limit = .nothing });
    defer threaded.deinit();
    const url = try r.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(url);

    var once = try Transport.create(testing.allocator, threaded.io(), .{ .endpoint = url, .content_type = "application/x-protobuf", .retry = .{ .enabled = false } });
    defer once.destroy();
    try testing.expectError(error.Unreachable, once.send("x", deadline.after(threaded.io(), .fromSeconds(10))));
    try testing.expect(std.mem.indexOf(u8, once.lastError(), "no concurrent task") != null);

    // With retries on, the failure is retried until the deadline.
    var retried = try Transport.create(testing.allocator, threaded.io(), .{ .endpoint = url, .content_type = "application/x-protobuf", .retry = fast_retry });
    defer retried.destroy();
    const start = now();
    try testing.expectError(error.Timeout, retried.send("x", deadline.after(threaded.io(), .fromMilliseconds(150))));
    try testing.expect(elapsedMs(start) < 1500);
    try testing.expectEqual(0, r.requestCount());
}
