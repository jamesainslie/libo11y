//! In-process OTLP/HTTP receiver for wire tests, plain HTTP or TLS/mTLS.
//!
//! Listens on `127.0.0.1:0`, serves each connection concurrently with
//! `std.http.Server`, accepts `/v1/traces`, `/v1/metrics`, and `/v1/logs` in
//! both protobuf (`application/x-protobuf`) and OTLP/JSON (`application/json`)
//! with optional gzip decompression, and decodes payloads into structured
//! `ResourceSpans`, `ResourceMetrics`, and `ResourceLogs`.
//!
//! Supports scripted status codes, partial success responses, latency,
//! connection drops, and hangs. `deinit()` (alias `stop()`) cancels every task
//! and frees all memory cleanly.

const std = @import("std");
const Io = std.Io;
const net = Io.net;
const Allocator = std.mem.Allocator;
const tls = @import("tls");
const proto = @import("opentelemetry-proto");
const o11y = @import("o11y");
const otlp_json = o11y.otlp.json;
const wire_http = o11y.wire.http;
const test_certs = @import("test_certs.zig");

/// One HTTP header recorded on a request.
pub const Header = wire_http.Header;

/// One scripted HTTP reply.
pub const Reply = struct {
    status: u16 = 200,
    /// Optional `Retry-After` header value.
    retry_after: ?[]const u8 = null,
    /// Response body bytes.
    body: []const u8 = "",
    /// Response `Content-Type` header value.
    content_type: []const u8 = "application/x-protobuf",
    /// Artificial delay before sending the response (interrupted by `deinit`).
    delay: Io.Duration = .zero,
    /// Read the request and never answer until `deinit()`.
    hang: bool = false,
    /// Close the TCP connection right after replying.
    close_after: bool = false,
};

/// TLS settings for `HttpReceiver`, as PEM text.
pub const TlsOptions = struct {
    cert_pem: []const u8 = test_certs.server,
    key_pem: []const u8 = test_certs.server_key,
    /// When set, clients must present a certificate signed by this CA.
    client_ca_pem: ?[]const u8 = null,
};

/// Options for `HttpReceiver.start`. Strings are copied into the receiver.
pub const Options = struct {
    replies: []const Reply = &.{},
    tls: ?TlsOptions = null,
};

/// One recorded raw HTTP request (body already gunzipped). Valid until `deinit()`.
pub const Request = struct {
    method: []const u8,
    path: []const u8,
    content_type: ?[]const u8,
    content_encoding: ?[]const u8,
    headers: []const Header,
    body: []const u8,
    connection: usize,

    /// Returns the first header named `name`, ignoring ASCII case.
    pub fn header(r: *const Request, name: []const u8) ?[]const u8 {
        for (r.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }
};

/// In-process loopback OTLP/HTTP receiver.
pub const HttpReceiver = struct {
    gpa: Allocator,
    io: Io,
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
    decoded_traces: std.ArrayList(proto.trace_v1.ResourceSpans) = .empty,
    decoded_metrics: std.ArrayList(proto.metrics_v1.ResourceMetrics) = .empty,
    decoded_logs: std.ArrayList(proto.logs_v1.ResourceLogs) = .empty,
    decode_errors: usize = 0,
    next_reply: usize = 0,
    accepted: usize = 0,
    handshake_failures: usize = 0,
    open: std.ArrayList(net.Socket.Handle) = .empty,

    /// Listens on `127.0.0.1:0` and starts accepting connections.
    pub fn start(gpa: Allocator, io: Io, options: Options) !*HttpReceiver {
        const r = try gpa.create(HttpReceiver);
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
            if (t.client_ca_pem) |pem| {
                r.client_ca = try tls.config.cert.fromSlice(gpa, io, pem);
            }
        }
        errdefer r.freeTls();

        const address = try net.IpAddress.parse("127.0.0.1", 0);
        r.listener = try address.listen(io, .{ .reuse_address = true });
        errdefer r.listener.deinit(io);

        r.accept_task = try io.concurrent(acceptLoop, .{r});
        return r;
    }

    /// Cancels every task, closes every socket, and frees the receiver.
    pub fn deinit(r: *HttpReceiver) void {
        r.stop();
    }

    /// Alias for `deinit`.
    pub fn stop(r: *HttpReceiver) void {
        const io = r.io;
        r.stop_event.set(io);
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
        r.decoded_traces.deinit(r.gpa);
        r.decoded_metrics.deinit(r.gpa);
        r.decoded_logs.deinit(r.gpa);
        r.arena.deinit();
        r.gpa.destroy(r);
    }

    fn freeTls(r: *HttpReceiver) void {
        if (!r.secure) return;
        r.cert_key.deinit(r.gpa);
        if (r.client_ca) |*b| b.deinit(r.gpa);
    }

    /// The bound ephemeral TCP port.
    pub fn port(r: *const HttpReceiver) u16 {
        return r.listener.socket.address.getPort();
    }

    /// Base endpoint URL (`http://127.0.0.1:<port>` or `https://localhost:<port>`).
    pub fn baseUrl(r: *const HttpReceiver, gpa: Allocator) Allocator.Error![]u8 {
        return r.url(gpa, "");
    }

    /// Full URL (`http://127.0.0.1:<port><path>` or `https://localhost:<port><path>`).
    pub fn url(r: *const HttpReceiver, gpa: Allocator, path: []const u8) Allocator.Error![]u8 {
        if (r.secure) return std.fmt.allocPrint(gpa, "https://localhost:{d}{s}", .{ r.port(), path });
        return std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}{s}", .{ r.port(), path });
    }

    /// Clears recorded requests and decoded payloads without restarting the listener.
    pub fn reset(r: *HttpReceiver) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        r.recorded.clearRetainingCapacity();
        r.decoded_traces.clearRetainingCapacity();
        r.decoded_metrics.clearRetainingCapacity();
        r.decoded_logs.clearRetainingCapacity();
        r.decode_errors = 0;
        r.next_reply = 0;
    }

    /// Number of HTTP requests recorded so far.
    pub fn requestCount(r: *HttpReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items.len;
    }

    /// Recorded request `i`, in arrival order. Valid until `deinit()`.
    pub fn request(r: *HttpReceiver, i: usize) *const Request {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items[i];
    }

    /// All decoded OTLP trace `ResourceSpans` received so far (protobuf and JSON).
    pub fn traces(r: *HttpReceiver) []const proto.trace_v1.ResourceSpans {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.decoded_traces.items;
    }

    /// All decoded OTLP metrics `ResourceMetrics` received so far (protobuf and JSON).
    pub fn metrics(r: *HttpReceiver) []const proto.metrics_v1.ResourceMetrics {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.decoded_metrics.items;
    }

    /// All decoded OTLP logs `ResourceLogs` received so far (protobuf and JSON).
    pub fn logs(r: *HttpReceiver) []const proto.logs_v1.ResourceLogs {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.decoded_logs.items;
    }

    /// Number of accepted TCP connections.
    pub fn connectionCount(r: *HttpReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.accepted;
    }

    /// Number of failed TLS handshakes.
    pub fn handshakeFailures(r: *HttpReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.handshake_failures;
    }

    /// Number of OTLP payloads that failed protobuf or JSON decoding.
    pub fn decodeErrors(r: *HttpReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.decode_errors;
    }

    /// Waits until at least `n` requests have been recorded or `timeout` expires.
    pub fn waitForRequests(r: *HttpReceiver, n: usize, timeout: Io.Duration) error{ Timeout, Canceled }!void {
        const io = r.io;
        const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = timeout, .clock = .awake } }).toDeadline(io);
        r.mutex.lockUncancelable(io);
        defer r.mutex.unlock(io);
        while (r.recorded.items.len < n) {
            try r.cond.waitTimeout(io, &r.mutex, until);
        }
    }

    fn acceptLoop(r: *HttpReceiver) Io.Cancelable!void {
        const io = r.io;
        while (true) {
            const stream = r.listener.accept(io) catch |err| switch (err) {
                error.Canceled => return error.Canceled,
                error.ConnectionAborted => continue,
                else => return,
            };
            const index = blk: {
                r.mutex.lockUncancelable(io);
                defer r.mutex.unlock(io);
                r.open.append(r.gpa, stream.socket.handle) catch {
                    stream.close(io);
                    continue;
                };
                r.accepted += 1;
                break :blk r.accepted - 1;
            };
            r.group.concurrent(io, serve, .{ r, stream, index }) catch {
                r.forget(stream.socket.handle);
                stream.close(io);
            };
        }
    }

    fn forget(r: *HttpReceiver, handle: net.Socket.Handle) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        for (r.open.items, 0..) |h, i| {
            if (h == handle) {
                _ = r.open.swapRemove(i);
                return;
            }
        }
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

    fn serve(r: *HttpReceiver, stream: net.Stream, index: usize) Io.Cancelable!void {
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
            if (reply.delay.nanoseconds > 0) {
                const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = reply.delay, .clock = .awake } }).toDeadline(io);
                r.stop_event.waitTimeout(io, until) catch |err| switch (err) {
                    error.Timeout => {},
                    error.Canceled => return,
                };
                if (r.stop_event.isSet()) return;
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

    fn takeReply(r: *HttpReceiver) Reply {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        if (r.next_reply < r.replies.len) {
            r.next_reply += 1;
            return r.replies[r.next_reply - 1];
        }
        return .{};
    }

    fn record(r: *HttpReceiver, req: *std.http.Server.Request, index: usize, transfer: []u8) !*Request {
        const io = r.io;
        var local: std.heap.ArenaAllocator = .init(r.gpa);
        defer local.deinit();
        const la = local.allocator();

        const method = try la.dupe(u8, @tagName(req.head.method));
        const target = try la.dupe(u8, req.head.target);
        var headers: std.ArrayList(Header) = .empty;
        var it = req.iterateHeaders();
        while (it.next()) |h| {
            try headers.append(la, .{ .name = try la.dupe(u8, h.name), .value = try la.dupe(u8, h.value) });
        }

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
        var hs = try a.alloc(Header, tmp.headers.len);
        for (tmp.headers, 0..) |h, i| {
            hs[i] = .{ .name = try a.dupe(u8, h.name), .value = try a.dupe(u8, h.value) };
        }
        const decoded_body = if (gzipped)
            try wire_http.gunzip(a, raw, 64 * 1024 * 1024)
        else
            try a.dupe(u8, raw);

        out.* = .{
            .method = try a.dupe(u8, tmp.method),
            .path = try a.dupe(u8, tmp.path),
            .content_type = null,
            .content_encoding = null,
            .headers = hs,
            .body = decoded_body,
            .connection = index,
        };
        out.content_type = out.header("content-type");
        out.content_encoding = out.header("content-encoding");

        r.decodePayloadLocked(a, out);

        try r.recorded.append(r.gpa, out);
        r.cond.broadcast(io);
        return out;
    }

    fn decodePayloadLocked(r: *HttpReceiver, a: Allocator, req: *const Request) void {
        if (req.body.len == 0) return;
        const path_only = req.path[0 .. std.mem.indexOfScalar(u8, req.path, '?') orelse req.path.len];
        const ct_raw = req.content_type orelse "";
        const media = std.mem.trim(u8, ct_raw[0 .. std.mem.indexOfScalar(u8, ct_raw, ';') orelse ct_raw.len], " \t");
        const is_json = std.ascii.eqlIgnoreCase(media, "application/json");
        const is_proto = media.len == 0 or std.ascii.eqlIgnoreCase(media, "application/x-protobuf");
        if (!is_json and !is_proto) return;

        if (std.mem.endsWith(u8, path_only, "/v1/traces")) {
            const msg = if (is_json)
                otlp_json.decode(proto.collector_trace_v1.ExportTraceServiceRequest, a, req.body)
            else blk: {
                var reader: Io.Reader = .fixed(req.body);
                break :blk proto.collector_trace_v1.ExportTraceServiceRequest.decode(&reader, a);
            };
            if (msg) |m| {
                r.decoded_traces.appendSlice(r.gpa, m.resource_spans.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        } else if (std.mem.endsWith(u8, path_only, "/v1/metrics")) {
            const msg = if (is_json)
                otlp_json.decode(proto.collector_metrics_v1.ExportMetricsServiceRequest, a, req.body)
            else blk: {
                var reader: Io.Reader = .fixed(req.body);
                break :blk proto.collector_metrics_v1.ExportMetricsServiceRequest.decode(&reader, a);
            };
            if (msg) |m| {
                r.decoded_metrics.appendSlice(r.gpa, m.resource_metrics.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        } else if (std.mem.endsWith(u8, path_only, "/v1/logs")) {
            const msg = if (is_json)
                otlp_json.decode(proto.collector_logs_v1.ExportLogsServiceRequest, a, req.body)
            else blk: {
                var reader: Io.Reader = .fixed(req.body);
                break :blk proto.collector_logs_v1.ExportLogsServiceRequest.decode(&reader, a);
            };
            if (msg) |m| {
                r.decoded_logs.appendSlice(r.gpa, m.resource_logs.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        }
    }
};
