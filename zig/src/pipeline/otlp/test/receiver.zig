//! A loopback OTLP/HTTP receiver for tests, plain or over TLS.
//!
//! It listens on 127.0.0.1 with an ephemeral port and serves each
//! connection with `std.http.Server` in an `io.concurrent` task. It
//! records every request, with a gzip body decoded, and answers with
//! scripted replies in order, then with 200 and an empty
//! `ExportTraceServiceResponse` (zero bytes). `stop` ends every task, even
//! one that is hanging on purpose, and frees everything.

const std = @import("std");
const tls = @import("tls");
const http = @import("../http.zig");
const Io = std.Io;
const net = Io.net;
const Allocator = std.mem.Allocator;

/// The PEM fixtures in certs/ (see certs/README.md).
pub const certs = struct {
    /// The CA that signs the server and client certificates.
    pub const ca = @embedFile("certs/ca.pem");
    /// An unrelated CA, for wrong-CA tests.
    pub const other_ca = @embedFile("certs/other-ca.pem");
    /// The server certificate, for localhost and 127.0.0.1.
    pub const server = @embedFile("certs/server.pem");
    /// The server key.
    pub const server_key = @embedFile("certs/server-key.pem");
    /// The client certificate.
    pub const client = @embedFile("certs/client.pem");
    /// The client key.
    pub const client_key = @embedFile("certs/client-key.pem");

    /// The fixture file names, for `writeAll`.
    pub const names = [_][]const u8{ "ca.pem", "other-ca.pem", "server.pem", "server-key.pem", "client.pem", "client-key.pem" };
    const contents = [_][]const u8{ ca, other_ca, server, server_key, client, client_key };

    /// Writes every fixture into `dir`.
    pub fn writeAll(io: Io, dir: Io.Dir) !void {
        for (names, contents) |name, data| try dir.writeFile(io, .{ .sub_path = name, .data = data });
    }

    /// The path of fixture `name` inside a `std.testing.tmpDir`, relative to
    /// the working directory.
    pub fn path(gpa: Allocator, tmp: *const std.testing.TmpDir, name: []const u8) ![]u8 {
        return std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}/{s}", .{ tmp.sub_path, name });
    }
};

/// One scripted reply.
pub const Reply = struct {
    status: u16 = 200,
    /// Sent as the Retry-After header.
    retry_after: ?[]const u8 = null,
    body: []const u8 = "",
    content_type: []const u8 = "application/x-protobuf",
    /// Read the request and never answer, until `stop`.
    hang: bool = false,
    /// Close the connection after the reply, without a `Connection: close`
    /// header, like a server whose idle timeout fired.
    close_after: bool = false,
};

/// TLS settings, as PEM text.
pub const TlsOptions = struct {
    cert_pem: []const u8 = certs.server,
    key_pem: []const u8 = certs.server_key,
    /// When set, a client certificate signed by this CA is required.
    client_ca_pem: ?[]const u8 = null,
};

/// Receiver options. `start` copies them.
pub const Options = struct {
    replies: []const Reply = &.{},
    tls: ?TlsOptions = null,
};

/// One recorded request. Its memory lives until `stop`.
pub const Request = struct {
    method: []const u8,
    path: []const u8,
    content_type: ?[]const u8,
    content_encoding: ?[]const u8,
    headers: []const http.Header,
    /// The body after gzip decoding.
    body: []const u8,
    /// The index of the accepted connection that carried it.
    connection: usize,

    /// Returns the first header named `name`, ignoring case.
    pub fn header(r: *const Request, name: []const u8) ?[]const u8 {
        for (r.headers) |h| if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        return null;
    }
};

/// The receiver. Create it with `start`; `stop` frees it.
pub const Receiver = struct {
    gpa: Allocator,
    io: Io,
    /// Holds the replies and every recorded request.
    arena: std.heap.ArenaAllocator,
    listener: net.Server,
    secure: bool,
    replies: []const Reply,
    cert_key: tls.config.CertKeyPair = undefined,
    client_ca: ?tls.config.cert.Bundle = null,
    accept_task: Io.Future(Io.Cancelable!void) = undefined,
    group: Io.Group = .init,
    stop_event: Io.Event = .unset,

    mutex: Io.Mutex = .init,
    cond: Io.Condition = .init,
    recorded: std.ArrayList(*Request) = .empty,
    next_reply: usize = 0,
    accepted: usize = 0,
    handshake_failures: usize = 0,
    open: std.ArrayList(net.Socket.Handle) = .empty,

    /// Listens on 127.0.0.1 with an ephemeral port and starts accepting.
    pub fn start(gpa: Allocator, io: Io, options: Options) !*Receiver {
        const r = try gpa.create(Receiver);
        errdefer gpa.destroy(r);
        r.* = .{
            .gpa = gpa,
            .io = io,
            .arena = .init(gpa),
            .listener = undefined,
            .secure = options.tls != null,
            .replies = &.{},
        };
        errdefer r.arena.deinit();
        const a = r.arena.allocator();
        const replies = try a.alloc(Reply, options.replies.len);
        for (options.replies, replies) |src, *dst| {
            dst.* = src;
            dst.body = try a.dupe(u8, src.body);
            dst.content_type = try a.dupe(u8, src.content_type);
            if (src.retry_after) |v| dst.retry_after = try a.dupe(u8, v);
        }
        r.replies = replies;

        if (options.tls) |t| {
            r.cert_key = try tls.config.CertKeyPair.fromSlice(gpa, io, t.cert_pem, t.key_pem);
            if (t.client_ca_pem) |pem| r.client_ca = try tls.config.cert.fromSlice(gpa, io, pem);
        }
        errdefer r.freeTls();

        const address = try net.IpAddress.parse("127.0.0.1", 0);
        r.listener = try address.listen(io, .{ .reuse_address = true });
        errdefer r.listener.deinit(io);
        r.accept_task = try io.concurrent(acceptLoop, .{r});
        return r;
    }

    /// Ends every task, closes every connection and frees the receiver.
    pub fn stop(r: *Receiver) void {
        const io = r.io;
        r.stop_event.set(io);
        // Unblock accept, then cancel the loop and wait for it, so no
        // connection task starts after this point.
        const listener_stream: net.Stream = .{ .socket = r.listener.socket };
        listener_stream.shutdown(io, .both) catch {};
        r.accept_task.cancel(io) catch {};
        {
            r.mutex.lockUncancelable(io);
            defer r.mutex.unlock(io);
            for (r.open.items) |handle| {
                const s: net.Stream = .{ .socket = .{ .handle = handle, .address = r.listener.socket.address } };
                s.shutdown(io, .both) catch {};
            }
        }
        r.group.cancel(io);
        r.listener.deinit(io);
        r.freeTls();
        r.open.deinit(r.gpa);
        r.recorded.deinit(r.gpa);
        r.arena.deinit();
        r.gpa.destroy(r);
    }

    fn freeTls(r: *Receiver) void {
        if (!r.secure) return;
        r.cert_key.deinit(r.gpa);
        if (r.client_ca) |*b| b.deinit(r.gpa);
    }

    /// The listening port.
    pub fn port(r: *const Receiver) u16 {
        return r.listener.socket.address.getPort();
    }

    /// `http://127.0.0.1:<port><path>`, or `https://localhost:<port><path>`
    /// in TLS mode (the server certificate names localhost).
    pub fn url(r: *const Receiver, gpa: Allocator, path: []const u8) ![]u8 {
        if (r.secure) return std.fmt.allocPrint(gpa, "https://localhost:{d}{s}", .{ r.port(), path });
        return std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}{s}", .{ r.port(), path });
    }

    /// The number of requests recorded so far.
    pub fn requestCount(r: *Receiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items.len;
    }

    /// Request `i`, in arrival order. It stays valid until `stop`.
    pub fn request(r: *Receiver, i: usize) *const Request {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items[i];
    }

    /// The number of connections accepted so far.
    pub fn connectionCount(r: *Receiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.accepted;
    }

    /// The number of TLS handshakes that failed.
    pub fn handshakeFailures(r: *Receiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.handshake_failures;
    }

    /// Waits until at least `n` requests are recorded.
    pub fn waitForRequests(r: *Receiver, n: usize, timeout: Io.Duration) error{ Timeout, Canceled }!void {
        const io = r.io;
        const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = timeout, .clock = .awake } }).toDeadline(io);
        r.mutex.lockUncancelable(io);
        defer r.mutex.unlock(io);
        while (r.recorded.items.len < n) try r.cond.waitTimeout(io, &r.mutex, until);
    }

    fn acceptLoop(r: *Receiver) Io.Cancelable!void {
        const io = r.io;
        while (true) {
            const stream = r.listener.accept(io) catch |err| switch (err) {
                error.Canceled => return error.Canceled,
                error.ConnectionAborted => continue,
                else => return,
            };
            const index = index: {
                r.mutex.lockUncancelable(io);
                defer r.mutex.unlock(io);
                r.open.append(r.gpa, stream.socket.handle) catch {
                    stream.close(io);
                    continue;
                };
                r.accepted += 1;
                break :index r.accepted - 1;
            };
            r.group.concurrent(io, serve, .{ r, stream, index }) catch {
                r.forget(stream.socket.handle);
                stream.close(io);
            };
        }
    }

    fn forget(r: *Receiver, handle: net.Socket.Handle) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        for (r.open.items, 0..) |h, i| if (h == handle) {
            _ = r.open.swapRemove(i);
            return;
        };
    }

    const Conn = struct {
        tcp_reader: net.Stream.Reader,
        tcp_writer: net.Stream.Writer,
        tls_conn: tls.Connection,
        tls_reader: tls.Connection.Reader,
        tls_writer: tls.Connection.Writer,
        rng_source: std.Random.IoSource,
        tcp_in: [tls.input_buffer_len]u8,
        tcp_out: [tls.output_buffer_len]u8,
        clear_in: [16 * 1024]u8,
        clear_out: [16 * 1024]u8,
        transfer: [4096]u8,
    };

    fn serve(r: *Receiver, stream: net.Stream, index: usize) Io.Cancelable!void {
        const io = r.io;
        defer {
            r.forget(stream.socket.handle);
            stream.close(io);
        }
        if (r.stop_event.isSet()) return;
        const c = r.gpa.create(Conn) catch return;
        defer r.gpa.destroy(c);
        c.rng_source = .{ .io = io };
        c.tcp_reader = stream.reader(io, &c.tcp_in);
        c.tcp_writer = stream.writer(io, &c.tcp_out);
        var in: *Io.Reader = &c.tcp_reader.interface;
        var out: *Io.Writer = &c.tcp_writer.interface;
        if (r.secure) {
            c.tls_conn = tls.server(in, out, .{
                .rng = c.rng_source.interface(),
                .auth = &r.cert_key,
                .client_auth = if (r.client_ca) |b| .{ .root_ca = b, .auth_type = .require } else null,
                .now = Io.Clock.real.now(io),
            }) catch {
                r.mutex.lockUncancelable(io);
                defer r.mutex.unlock(io);
                r.handshake_failures += 1;
                return;
            };
            c.tls_reader = c.tls_conn.reader(&c.clear_in);
            c.tls_writer = c.tls_conn.writer(&c.clear_out);
            in = &c.tls_reader.interface;
            out = &c.tls_writer.interface;
        }

        var server = std.http.Server.init(in, out);
        while (true) {
            var req = server.receiveHead() catch return;
            _ = r.record(&req, index, &c.transfer) catch return;
            const reply = r.takeReply();
            if (reply.hang) {
                r.stop_event.wait(io) catch {};
                return;
            }
            var extra: [2]std.http.Header = undefined;
            var n: usize = 0;
            extra[n] = .{ .name = "content-type", .value = reply.content_type };
            n += 1;
            if (reply.retry_after) |v| {
                extra[n] = .{ .name = "retry-after", .value = v };
                n += 1;
            }
            req.respond(reply.body, .{
                .status = @fromBackingInt(@as(u10, @intCast(@min(reply.status, 999)))),
                .keep_alive = true,
                .extra_headers = extra[0..n],
            }) catch return;
            if (reply.close_after) return;
            if (!req.head.keep_alive) return;
        }
    }

    fn takeReply(r: *Receiver) Reply {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        if (r.next_reply < r.replies.len) {
            r.next_reply += 1;
            return r.replies[r.next_reply - 1];
        }
        return .{};
    }

    fn record(r: *Receiver, req: *std.http.Server.Request, index: usize, transfer: []u8) !*Request {
        const io = r.io;
        // Copy the head first: reading the body invalidates it.
        var local: std.heap.ArenaAllocator = .init(r.gpa);
        defer local.deinit();
        const la = local.allocator();
        const method = try la.dupe(u8, @tagName(req.head.method));
        const target = try la.dupe(u8, req.head.target);
        var headers: std.ArrayList(http.Header) = .empty;
        var it = req.iterateHeaders();
        while (it.next()) |h| try headers.append(la, .{ .name = try la.dupe(u8, h.name), .value = try la.dupe(u8, h.value) });

        const body_reader = try req.readerExpectContinue(transfer);
        const raw = try body_reader.allocRemaining(la, .limited(64 * 1024 * 1024));

        var tmp: Request = .{
            .method = method,
            .path = target,
            .content_type = null,
            .content_encoding = null,
            .headers = headers.items,
            .body = raw,
            .connection = index,
        };
        tmp.content_type = tmp.header("content-type");
        tmp.content_encoding = tmp.header("content-encoding");
        const gzipped = if (tmp.content_encoding) |ce| std.ascii.eqlIgnoreCase(ce, "gzip") else false;

        r.mutex.lockUncancelable(io);
        defer r.mutex.unlock(io);
        const a = r.arena.allocator();
        const out = try a.create(Request);
        var hs = try a.alloc(http.Header, tmp.headers.len);
        for (tmp.headers, 0..) |h, i| hs[i] = .{ .name = try a.dupe(u8, h.name), .value = try a.dupe(u8, h.value) };
        out.* = .{
            .method = try a.dupe(u8, tmp.method),
            .path = try a.dupe(u8, tmp.path),
            .content_type = null,
            .content_encoding = null,
            .headers = hs,
            .body = if (gzipped) try http.gunzip(a, raw, 64 * 1024 * 1024) else try a.dupe(u8, raw),
            .connection = index,
        };
        out.content_type = out.header("content-type");
        out.content_encoding = out.header("content-encoding");
        try r.recorded.append(r.gpa, out);
        r.cond.broadcast(io);
        return out;
    }
};

const testing = std.testing;

test "receiver records a plain request and answers with the default reply" {
    const io = testing.io;
    var r = try Receiver.start(testing.allocator, io, .{});
    defer r.stop();

    var client: std.http.Client = .{ .allocator = testing.allocator, .io = io };
    defer client.deinit();
    const u = try r.url(testing.allocator, "/v1/traces");
    defer testing.allocator.free(u);
    const result = try client.fetch(.{
        .location = .{ .url = u },
        .method = .POST,
        .payload = "hello",
        .headers = .{ .content_type = .{ .override = "application/x-protobuf" } },
        .extra_headers = &.{.{ .name = "x-test", .value = "1" }},
    });
    try testing.expectEqual(.ok, result.status);
    try r.waitForRequests(1, .fromSeconds(5));
    const req = r.request(0);
    try testing.expectEqualStrings("POST", req.method);
    try testing.expectEqualStrings("/v1/traces", req.path);
    try testing.expectEqualStrings("application/x-protobuf", req.content_type.?);
    try testing.expectEqualStrings("1", req.header("X-Test").?);
    try testing.expectEqualStrings("hello", req.body);
    try testing.expectEqual(1, r.connectionCount());
}

test "the certificate fixtures parse and the chain verifies" {
    const io = testing.io;
    const now = Io.Clock.real.now(io).toSeconds();
    var bundle = try tls.config.cert.fromSlice(testing.allocator, io, certs.ca);
    defer bundle.deinit(testing.allocator);
    try testing.expectEqual(1, bundle.map.count());
    inline for (.{ certs.server, certs.client }) |pem| {
        var leaf = try tls.config.cert.fromSlice(testing.allocator, io, pem);
        defer leaf.deinit(testing.allocator);
        var it = leaf.map.valueIterator();
        const start = it.next().?.*;
        const cert: std.crypto.Certificate = .{ .buffer = leaf.bytes.items, .index = start };
        const parsed = try cert.parse();
        try bundle.verify(parsed, now);
    }
    var pair = try tls.config.CertKeyPair.fromSlice(testing.allocator, io, certs.client, certs.client_key);
    pair.deinit(testing.allocator);
    var server_pair = try tls.config.CertKeyPair.fromSlice(testing.allocator, io, certs.server, certs.server_key);
    server_pair.deinit(testing.allocator);
}

test "stop returns while a request hangs" {
    const io = testing.io;
    var r = try Receiver.start(testing.allocator, io, .{ .replies = &.{.{ .hang = true }} });
    const address = try net.IpAddress.parse("127.0.0.1", r.port());
    const stream = try address.connect(io, .{ .mode = .stream });
    defer stream.close(io);
    var buf: [256]u8 = undefined;
    var w = stream.writer(io, &buf);
    try w.interface.writeAll("POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 1\r\n\r\nz");
    try w.interface.flush();
    try r.waitForRequests(1, .fromSeconds(5));
    const before = Io.Clock.Timestamp.now(io, .awake);
    r.stop();
    try testing.expect(before.untilNow(io).raw.toMilliseconds() < 2000);
}
