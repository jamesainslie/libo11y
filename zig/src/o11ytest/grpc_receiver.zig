//! In-process OTLP/gRPC receiver over HTTP/2 (h2c or TLS ALPN "h2" with
//! optional mutual TLS) for wire tests.
//!
//! Accepts unary calls to:
//! - `/opentelemetry.proto.collector.trace.v1.TraceService/Export`
//! - `/opentelemetry.proto.collector.metrics.v1.MetricsService/Export`
//! - `/opentelemetry.proto.collector.logs.v1.LogsService/Export`
//!
//! Automatically unframes, gunzips, and decodes protobuf payloads into
//! structured `ResourceSpans`, `ResourceMetrics`, and `ResourceLogs`.
//! Supports scripted gRPC errors, RetryInfo, partial success bodies, latency,
//! GOAWAY, RST_STREAM, and hangs. `deinit()` (alias `stop()`) cancels every
//! task and frees all memory cleanly.

const std = @import("std");
const Io = std.Io;
const net = Io.net;
const Allocator = std.mem.Allocator;
const tls = @import("tls");
const proto = @import("opentelemetry-proto");
const o11y = @import("o11y");
const o11y_wire = @import("o11y_wire");
const hpack = o11y_wire.hpack;
const h2 = o11y_wire.h2;
const grpc_frame = o11y_wire.grpc_frame;
const test_certs = @import("test_certs.zig");

/// One scripted gRPC reply.
pub const Reply = struct {
    http_status: u16 = 200,
    grpc_status: u32 = 0,
    grpc_message: ?[]const u8 = null,
    /// Encoded as `google.rpc.RetryInfo` inside `grpc-status-details-bin`.
    retry_info_delay: ?Io.Duration = null,
    /// Optional `grpc-retry-pushback-ms` trailer value.
    retry_pushback_ms: ?[]const u8 = null,
    /// Protobuf response bytes (wrapped in a 5-byte gRPC frame).
    body: []const u8 = "",
    /// Artificial delay before replying (interrupted by `deinit`).
    delay: Io.Duration = .zero,
    /// Gzip-compress the gRPC response frame.
    compress_response: bool = false,
    /// Send a single HEADERS frame with END_STREAM (trailers-only response).
    trailers_only: bool = false,
    /// Encode response headers and trailers with RFC 7541 Huffman coding.
    use_huffman: bool = true,
    /// Insert custom headers into the HPACK dynamic table.
    use_dynamic_table: bool = false,
    /// Send GOAWAY(last_stream_id=0) before answering.
    send_goaway_before: bool = false,
    /// Send GOAWAY(last_stream_id=stream_id) after answering.
    send_goaway_after: bool = false,
    /// Send RST_STREAM with this HTTP/2 error code instead of a response.
    rst_stream: ?u32 = null,
    /// Read the request and hang until `deinit()`.
    hang: bool = false,
    /// Close the TCP connection right after replying.
    close_after: bool = false,
};

/// TLS settings for `GrpcReceiver`, as PEM text.
pub const TlsOptions = struct {
    cert_pem: []const u8 = test_certs.server,
    key_pem: []const u8 = test_certs.server_key,
    client_ca_pem: ?[]const u8 = null,
    alpn_protocols: []const []const u8 = &.{"h2"},
};

/// Options for `GrpcReceiver.start`.
pub const Options = struct {
    replies: []const Reply = &.{},
    tls: ?TlsOptions = null,
    max_frame_size: u32 = h2.default_max_frame_size,
    initial_window_size: u32 = 65535,
};

/// One recorded unary gRPC request. Valid until `deinit()`.
pub const Request = struct {
    method: []const u8,
    scheme: []const u8,
    path: []const u8,
    authority: []const u8,
    content_type: ?[]const u8,
    grpc_encoding: ?[]const u8,
    headers: []const hpack.Header,
    /// Unframed, decompressed protobuf request bytes.
    body: []const u8,
    connection: usize,
    stream_id: u31,
    alpn_protocol: ?[]const u8,

    /// Returns the first header named `name` (HTTP/2 header names are lowercase).
    pub fn header(r: *const Request, name: []const u8) ?[]const u8 {
        for (r.headers) |h| {
            if (std.mem.eql(u8, h.name, name)) return h.value;
        }
        return null;
    }
};

/// In-process loopback OTLP/gRPC receiver.
pub const GrpcReceiver = struct {
    gpa: Allocator,
    io: Io,
    arena: std.heap.ArenaAllocator,
    listener: net.Server,
    secure: bool,
    replies: []const Reply,
    max_frame_size: u32,
    initial_window_size: u32,
    cert_key: ?tls.config.CertKeyPair = null,
    client_ca: ?tls.config.cert.Bundle = null,
    alpn_protocols: []const []const u8 = &.{"h2"},
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

    /// Listens on `127.0.0.1:0` and starts accepting HTTP/2 connections.
    pub fn start(gpa: Allocator, io: Io, options: Options) !*GrpcReceiver {
        const r = try gpa.create(GrpcReceiver);
        errdefer gpa.destroy(r);
        r.* = .{
            .gpa = gpa,
            .io = io,
            .arena = .init(gpa),
            .listener = undefined,
            .secure = options.tls != null,
            .replies = &.{},
            .max_frame_size = std.math.clamp(options.max_frame_size, h2.default_max_frame_size, h2.max_allowed_frame_size),
            .initial_window_size = options.initial_window_size,
        };
        errdefer r.arena.deinit();

        const a = r.arena.allocator();
        const replies = try a.alloc(Reply, options.replies.len);
        for (options.replies, replies) |src, *dst| {
            dst.* = src;
            dst.body = try a.dupe(u8, src.body);
            if (src.grpc_message) |m| dst.grpc_message = try a.dupe(u8, m);
            if (src.retry_pushback_ms) |p| dst.retry_pushback_ms = try a.dupe(u8, p);
        }
        r.replies = replies;

        // Allocate TLS material into `r.arena` so both `stop()` and partial
        // init errors (including upstream `tls.config.cert.fromSlice` parse
        // failures) release every byte via `r.arena.deinit()`.
        if (options.tls) |t| {
            r.cert_key = try tls.config.CertKeyPair.fromSlice(a, io, t.cert_pem, t.key_pem);
            if (t.client_ca_pem) |pem| {
                r.client_ca = try tls.config.cert.fromSlice(a, io, pem);
            }
            const alpn_copy = try a.alloc([]const u8, t.alpn_protocols.len);
            for (t.alpn_protocols, alpn_copy) |src_proto, *dst_proto| {
                dst_proto.* = try a.dupe(u8, src_proto);
            }
            r.alpn_protocols = alpn_copy;
        }

        const address = try net.IpAddress.parse("127.0.0.1", 0);
        r.listener = try address.listen(io, .{ .reuse_address = true });
        errdefer r.listener.deinit(io);

        r.accept_task = try io.concurrent(acceptLoop, .{r});
        return r;
    }

    /// Cancels every task, closes every connection, and frees the receiver.
    pub fn deinit(r: *GrpcReceiver) void {
        r.stop();
    }

    /// Alias for `deinit`.
    pub fn stop(r: *GrpcReceiver) void {
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
        r.open.deinit(r.gpa);
        r.recorded.deinit(r.gpa);
        r.decoded_traces.deinit(r.gpa);
        r.decoded_metrics.deinit(r.gpa);
        r.decoded_logs.deinit(r.gpa);
        r.arena.deinit();
        r.gpa.destroy(r);
    }

    /// The bound ephemeral TCP port.
    pub fn port(r: *const GrpcReceiver) u16 {
        return r.listener.socket.address.getPort();
    }

    /// `http://127.0.0.1:<port>` for h2c, or `https://localhost:<port>` for TLS.
    pub fn url(r: *const GrpcReceiver, gpa: Allocator) Allocator.Error![]u8 {
        if (r.secure) return std.fmt.allocPrint(gpa, "https://localhost:{d}", .{r.port()});
        return std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}", .{r.port()});
    }

    /// Clears recorded requests and decoded payloads without restarting the listener.
    pub fn reset(r: *GrpcReceiver) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        r.recorded.clearRetainingCapacity();
        r.decoded_traces.clearRetainingCapacity();
        r.decoded_metrics.clearRetainingCapacity();
        r.decoded_logs.clearRetainingCapacity();
        r.decode_errors = 0;
        r.next_reply = 0;
    }

    /// Number of unary gRPC requests recorded so far.
    pub fn requestCount(r: *GrpcReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items.len;
    }

    /// Recorded request `i`, in arrival order. Valid until `deinit()`.
    pub fn request(r: *GrpcReceiver, i: usize) *const Request {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.recorded.items[i];
    }

    /// Thread-safe snapshot of all decoded OTLP trace `ResourceSpans` received
    /// so far. Valid until `deinit()`.
    pub fn traces(r: *GrpcReceiver) []const proto.trace_v1.ResourceSpans {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.arena.allocator().dupe(proto.trace_v1.ResourceSpans, r.decoded_traces.items) catch &.{};
    }

    /// Thread-safe snapshot of all decoded OTLP metrics `ResourceMetrics`
    /// received so far. Valid until `deinit()`.
    pub fn metrics(r: *GrpcReceiver) []const proto.metrics_v1.ResourceMetrics {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.arena.allocator().dupe(proto.metrics_v1.ResourceMetrics, r.decoded_metrics.items) catch &.{};
    }

    /// Thread-safe snapshot of all decoded OTLP logs `ResourceLogs` received
    /// so far. Valid until `deinit()`.
    pub fn logs(r: *GrpcReceiver) []const proto.logs_v1.ResourceLogs {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.arena.allocator().dupe(proto.logs_v1.ResourceLogs, r.decoded_logs.items) catch &.{};
    }

    /// Number of accepted TCP connections.
    pub fn connectionCount(r: *GrpcReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.accepted;
    }

    /// Number of failed TLS handshakes.
    pub fn handshakeFailures(r: *GrpcReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.handshake_failures;
    }

    /// Number of protobuf payloads that failed to decode.
    pub fn decodeErrors(r: *GrpcReceiver) usize {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        return r.decode_errors;
    }

    /// Waits until at least `n` requests have been recorded or `timeout` expires.
    pub fn waitForRequests(r: *GrpcReceiver, n: usize, timeout: Io.Duration) error{ Timeout, Canceled }!void {
        const io = r.io;
        const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = timeout, .clock = .awake } }).toDeadline(io);
        r.mutex.lockUncancelable(io);
        defer r.mutex.unlock(io);
        while (r.recorded.items.len < n) {
            try r.cond.waitTimeout(io, &r.mutex, until);
        }
    }

    fn acceptLoop(r: *GrpcReceiver) Io.Cancelable!void {
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

    fn forget(r: *GrpcReceiver, handle: net.Socket.Handle) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        for (r.open.items, 0..) |h, i| {
            if (h == handle) {
                _ = r.open.swapRemove(i);
                return;
            }
        }
    }

    fn takeReply(r: *GrpcReceiver) Reply {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        if (r.next_reply < r.replies.len) {
            r.next_reply += 1;
            return r.replies[r.next_reply - 1];
        }
        return .{};
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
    };

    fn serve(r: *GrpcReceiver, stream: net.Stream, index: usize) Io.Cancelable!void {
        const io = r.io;
        defer {
            r.forget(stream.socket.handle);
            stream.close(io);
        }
        if (r.stop_event.isSet()) return;

        const c = r.gpa.create(Conn) catch return;
        defer r.gpa.destroy(c);
        const frame_buf = r.gpa.alloc(u8, r.max_frame_size) catch return;
        defer r.gpa.free(frame_buf);

        c.rng_source = .{ .io = io };
        c.tcp_reader = stream.reader(io, &c.tcp_in);
        c.tcp_writer = stream.writer(io, &c.tcp_out);
        var in: *Io.Reader = &c.tcp_reader.interface;
        var out: *Io.Writer = &c.tcp_writer.interface;
        var alpn_proto: ?[]const u8 = null;

        if (r.secure) {
            const auth_ptr = if (r.cert_key) |*ck| ck else return;
            c.tls_conn = tls.server(in, out, .{
                .rng = c.rng_source.interface(),
                .auth = auth_ptr,
                .client_auth = if (r.client_ca) |b| .{ .root_ca = b, .auth_type = .require } else null,
                .alpn_protocols = r.alpn_protocols,
                .now = Io.Clock.real.now(io),
            }) catch {
                r.mutex.lockUncancelable(io);
                defer r.mutex.unlock(io);
                r.handshake_failures += 1;
                return;
            };
            alpn_proto = c.tls_conn.alpn_protocol;
            c.tls_reader = c.tls_conn.reader(&c.clear_in);
            c.tls_writer = c.tls_conn.writer(&c.clear_out);
            in = &c.tls_reader.interface;
            out = &c.tls_writer.interface;
        }

        var preface: [h2.client_preface.len]u8 = undefined;
        in.readSliceAll(&preface) catch return;
        if (!std.mem.eql(u8, &preface, h2.client_preface)) return;

        h2.writeSettings(out, &.{
            .{ .id = @backingInt(h2.SettingId.max_frame_size), .value = r.max_frame_size },
            .{ .id = @backingInt(h2.SettingId.initial_window_size), .value = r.initial_window_size },
        }) catch return;
        out.flush() catch return;

        var hpack_dec: hpack.Decoder = .init(r.gpa, hpack.default_table_size, hpack.default_max_header_list_size);
        defer hpack_dec.deinit();

        var cur_stream: u31 = 0;
        var stream_end_seen = false;
        var hdr_block: std.ArrayList(u8) = .empty;
        defer hdr_block.deinit(r.gpa);
        var req_headers: []hpack.Header = &.{};
        defer hpack.freeHeaders(r.gpa, req_headers);
        var req_body: std.ArrayList(u8) = .empty;
        defer req_body.deinit(r.gpa);
        var dynamic_seq: usize = 0;

        while (true) {
            var raw_hdr: [h2.frame_header_len]u8 = undefined;
            in.readSliceAll(&raw_hdr) catch return;
            const hdr = h2.FrameHeader.parse(raw_hdr);
            if (hdr.length > frame_buf.len) return;
            const payload = frame_buf[0..hdr.length];
            if (payload.len > 0) in.readSliceAll(payload) catch return;

            const frame = h2.parseFrame(hdr, payload) catch return;
            switch (frame) {
                .settings => |s| {
                    if (!s.ack) {
                        h2.writeSettingsAck(out) catch return;
                        out.flush() catch return;
                    }
                },
                .ping => |p| {
                    if (!p.ack) {
                        h2.writePing(out, true, p.opaque_data) catch return;
                        out.flush() catch return;
                    }
                },
                .goaway => return,
                .window_update, .priority, .rst_stream, .unknown => {},
                .headers => |h| {
                    cur_stream = h.stream_id;
                    stream_end_seen = h.end_stream;
                    hdr_block.clearRetainingCapacity();
                    req_body.clearRetainingCapacity();
                    hdr_block.appendSlice(r.gpa, h.fragment) catch return;
                    if (h.end_headers) {
                        hpack.freeHeaders(r.gpa, req_headers);
                        req_headers = &.{};
                        req_headers = hpack_dec.decode(hdr_block.items, r.gpa) catch return;
                        hdr_block.clearRetainingCapacity();
                        if (stream_end_seen) {
                            stream_end_seen = false;
                            if (!r.handleStream(out, cur_stream, req_headers, req_body.items, index, alpn_proto, &dynamic_seq)) {
                                gracefulDrain(io, stream, in);
                                return;
                            }
                        }
                    }
                },
                .continuation => |cont| {
                    hdr_block.appendSlice(r.gpa, cont.fragment) catch return;
                    if (cont.end_headers) {
                        hpack.freeHeaders(r.gpa, req_headers);
                        req_headers = &.{};
                        req_headers = hpack_dec.decode(hdr_block.items, r.gpa) catch return;
                        hdr_block.clearRetainingCapacity();
                        if (stream_end_seen) {
                            stream_end_seen = false;
                            if (!r.handleStream(out, cur_stream, req_headers, req_body.items, index, alpn_proto, &dynamic_seq)) {
                                gracefulDrain(io, stream, in);
                                return;
                            }
                        }
                    }
                },
                .data => |d| {
                    req_body.appendSlice(r.gpa, d.payload) catch return;
                    if (d.wire_len > 0) {
                        h2.writeWindowUpdate(out, 0, d.wire_len) catch return;
                        if (!d.end_stream) h2.writeWindowUpdate(out, d.stream_id, d.wire_len) catch return;
                        out.flush() catch return;
                    }
                    if (d.end_stream) {
                        if (!r.handleStream(out, d.stream_id, req_headers, req_body.items, index, alpn_proto, &dynamic_seq)) {
                            gracefulDrain(io, stream, in);
                            return;
                        }
                    }
                },
            }
        }
    }

    fn gracefulDrain(io: Io, stream: net.Stream, in: *Io.Reader) void {
        stream.shutdown(io, .send) catch {};
        var discard_buf: [256]u8 = undefined;
        while (true) {
            const n = in.readSliceShort(&discard_buf) catch break;
            if (n == 0) break;
        }
    }

    fn handleStream(
        r: *GrpcReceiver,
        out: *Io.Writer,
        stream_id: u31,
        req_headers: []const hpack.Header,
        req_body: []const u8,
        conn_index: usize,
        alpn_proto: ?[]const u8,
        dynamic_seq: *usize,
    ) bool {
        r.recordRequest(stream_id, req_headers, req_body, conn_index, alpn_proto) catch return false;
        const reply = r.takeReply();

        if (reply.hang) {
            r.stop_event.wait(r.io) catch {};
            return false;
        }
        if (reply.delay.nanoseconds > 0) {
            const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = reply.delay, .clock = .awake } }).toDeadline(r.io);
            r.stop_event.waitTimeout(r.io, until) catch |err| switch (err) {
                error.Timeout => {},
                error.Canceled => return false,
            };
            if (r.stop_event.isSet()) return false;
        }
        if (reply.send_goaway_before) {
            h2.writeGoAway(out, 0, .no_error, "draining") catch return false;
            out.flush() catch return false;
            return false;
        }
        if (reply.rst_stream) |code| {
            h2.writeRstStream(out, stream_id, @fromBackingInt(@intCast(code))) catch return false;
            out.flush() catch return false;
            return !reply.close_after;
        }

        r.sendReply(out, stream_id, reply, dynamic_seq) catch return false;
        if (reply.send_goaway_after) {
            h2.writeGoAway(out, stream_id, .no_error, "going away") catch return false;
            out.flush() catch return false;
            return false;
        }
        return !reply.close_after;
    }

    fn sendReply(
        r: *GrpcReceiver,
        out: *Io.Writer,
        stream_id: u31,
        reply: Reply,
        dynamic_seq: *usize,
    ) !void {
        var status_buf: [8]u8 = undefined;
        const status_str = std.fmt.bufPrint(&status_buf, "{d}", .{reply.http_status}) catch "200";
        var grpc_status_buf: [16]u8 = undefined;
        const grpc_status_str = std.fmt.bufPrint(&grpc_status_buf, "{d}", .{reply.grpc_status}) catch "0";

        const details_b64: ?[]u8 = if (reply.retry_info_delay) |d|
            try encodeRetryInfoBase64(r.gpa, d)
        else
            null;
        defer if (details_b64) |b| r.gpa.free(b);

        const enc_opts: hpack.EncodeOptions = .{
            .huffman = reply.use_huffman,
            .indexing = if (reply.use_dynamic_table) .incremental else .auto,
        };

        var hdr_out: Io.Writer.Allocating = .init(r.gpa);
        defer hdr_out.deinit();

        try hpack.encodeHeader(&hdr_out.writer, .{ .name = ":status", .value = status_str }, enc_opts, r.gpa);
        try hpack.encodeHeader(&hdr_out.writer, .{ .name = "content-type", .value = "application/grpc" }, enc_opts, r.gpa);
        if (reply.compress_response) {
            try hpack.encodeHeader(&hdr_out.writer, .{ .name = "grpc-encoding", .value = "gzip" }, enc_opts, r.gpa);
        }
        if (reply.use_dynamic_table) {
            if (dynamic_seq.* > 0) {
                try hpack.encodeInt(&hdr_out.writer, 0x80, 7, 62);
            } else {
                try hpack.encodeHeader(&hdr_out.writer, .{ .name = "x-server-dyn", .value = "cached-val" }, .{
                    .huffman = reply.use_huffman,
                    .indexing = .incremental,
                }, r.gpa);
            }
            dynamic_seq.* += 1;
        }

        if (reply.trailers_only) {
            try hpack.encodeHeader(&hdr_out.writer, .{ .name = "grpc-status", .value = grpc_status_str }, enc_opts, r.gpa);
            if (reply.grpc_message) |m| {
                try hpack.encodeHeader(&hdr_out.writer, .{ .name = "grpc-message", .value = m }, enc_opts, r.gpa);
            }
            if (details_b64) |b| {
                try hpack.encodeHeader(&hdr_out.writer, .{ .name = "grpc-status-details-bin", .value = b }, enc_opts, r.gpa);
            }
            if (reply.retry_pushback_ms) |p| {
                try hpack.encodeHeader(&hdr_out.writer, .{ .name = "grpc-retry-pushback-ms", .value = p }, enc_opts, r.gpa);
            }
            try h2.writeHeaderBlock(out, stream_id, hdr_out.written(), h2.default_max_frame_size, true);
            try out.flush();
            return;
        }

        try h2.writeHeaderBlock(out, stream_id, hdr_out.written(), h2.default_max_frame_size, false);

        if (reply.grpc_status == 0 or reply.body.len > 0) {
            const framed = try grpc_frame.frameEncode(
                r.gpa,
                reply.body,
                if (reply.compress_response) .gzip else .none,
            );
            defer r.gpa.free(framed);
            var pos: usize = 0;
            while (pos < framed.len) {
                const n = @min(framed.len - pos, h2.default_max_frame_size);
                try h2.writeFrame(out, .data, 0, stream_id, framed[pos .. pos + n]);
                pos += n;
            }
        }

        var trl_out: Io.Writer.Allocating = .init(r.gpa);
        defer trl_out.deinit();
        try hpack.encodeHeader(&trl_out.writer, .{ .name = "grpc-status", .value = grpc_status_str }, enc_opts, r.gpa);
        if (reply.grpc_message) |m| {
            try hpack.encodeHeader(&trl_out.writer, .{ .name = "grpc-message", .value = m }, enc_opts, r.gpa);
        }
        if (details_b64) |b| {
            try hpack.encodeHeader(&trl_out.writer, .{ .name = "grpc-status-details-bin", .value = b }, enc_opts, r.gpa);
        }
        if (reply.retry_pushback_ms) |p| {
            try hpack.encodeHeader(&trl_out.writer, .{ .name = "grpc-retry-pushback-ms", .value = p }, enc_opts, r.gpa);
        }
        try h2.writeHeaderBlock(out, stream_id, trl_out.written(), h2.default_max_frame_size, true);
        try out.flush();
    }

    fn recordRequest(
        r: *GrpcReceiver,
        stream_id: u31,
        headers: []const hpack.Header,
        raw_body: []const u8,
        conn_index: usize,
        alpn_proto: ?[]const u8,
    ) !void {
        var enc: ?[]const u8 = null;
        for (headers) |h| {
            if (std.mem.eql(u8, h.name, "grpc-encoding")) enc = h.value;
        }
        const decoded_body = try grpc_frame.frameDecode(r.gpa, raw_body, enc, 64 * 1024 * 1024);
        defer r.gpa.free(decoded_body);

        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const a = r.arena.allocator();

        const hs = try a.alloc(hpack.Header, headers.len);
        var method: []const u8 = "";
        var scheme: []const u8 = "";
        var path: []const u8 = "";
        var authority: []const u8 = "";
        var content_type: ?[]const u8 = null;
        var grpc_encoding: ?[]const u8 = null;

        for (headers, 0..) |h, i| {
            const n = try a.dupe(u8, h.name);
            const v = try a.dupe(u8, h.value);
            hs[i] = .{ .name = n, .value = v };
            if (std.mem.eql(u8, n, ":method")) method = v;
            if (std.mem.eql(u8, n, ":scheme")) scheme = v;
            if (std.mem.eql(u8, n, ":path")) path = v;
            if (std.mem.eql(u8, n, ":authority")) authority = v;
            if (std.mem.eql(u8, n, "content-type")) content_type = v;
            if (std.mem.eql(u8, n, "grpc-encoding")) grpc_encoding = v;
        }

        const out = try a.create(Request);
        out.* = .{
            .method = method,
            .scheme = scheme,
            .path = path,
            .authority = authority,
            .content_type = content_type,
            .grpc_encoding = grpc_encoding,
            .headers = hs,
            .body = try a.dupe(u8, decoded_body),
            .connection = conn_index,
            .stream_id = stream_id,
            .alpn_protocol = if (alpn_proto) |p| try a.dupe(u8, p) else null,
        };

        r.decodePayloadLocked(a, out);

        try r.recorded.append(r.gpa, out);
        r.cond.broadcast(r.io);
    }

    fn decodePayloadLocked(r: *GrpcReceiver, a: Allocator, req: *const Request) void {
        if (req.body.len == 0) return;
        var reader: Io.Reader = .fixed(req.body);
        if (std.mem.eql(u8, req.path, o11y.otlp.grpc_trace_method)) {
            if (proto.collector_trace_v1.ExportTraceServiceRequest.decode(&reader, a)) |m| {
                r.decoded_traces.appendSlice(r.gpa, m.resource_spans.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        } else if (std.mem.eql(u8, req.path, o11y.otlp.grpc_metric_method)) {
            if (proto.collector_metrics_v1.ExportMetricsServiceRequest.decode(&reader, a)) |m| {
                r.decoded_metrics.appendSlice(r.gpa, m.resource_metrics.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        } else if (std.mem.eql(u8, req.path, o11y.otlp.grpc_log_method)) {
            if (proto.collector_logs_v1.ExportLogsServiceRequest.decode(&reader, a)) |m| {
                r.decoded_logs.appendSlice(r.gpa, m.resource_logs.items) catch {
                    r.decode_errors += 1;
                };
            } else |_| {
                r.decode_errors += 1;
            }
        }
    }
};

/// Encodes `google.rpc.Status { details: [Any { type_url: RetryInfo, value: Duration }] }`
/// as unpadded base64 for `grpc-status-details-bin`.
pub fn encodeRetryInfoBase64(gpa: Allocator, delay: Io.Duration) Allocator.Error![]u8 {
    const ns = @max(delay.nanoseconds, 0);
    const secs: u64 = @intCast(@divTrunc(ns, std.time.ns_per_s));
    const rem_ns: u64 = @intCast(@rem(ns, std.time.ns_per_s));

    var dur: std.ArrayList(u8) = .empty;
    defer dur.deinit(gpa);
    if (secs > 0) {
        try appendVarint(gpa, &dur, (1 << 3) | 0);
        try appendVarint(gpa, &dur, secs);
    }
    if (rem_ns > 0) {
        try appendVarint(gpa, &dur, (2 << 3) | 0);
        try appendVarint(gpa, &dur, rem_ns);
    }

    var retry_info: std.ArrayList(u8) = .empty;
    defer retry_info.deinit(gpa);
    try appendBytesField(gpa, &retry_info, 1, dur.items);

    var any_msg: std.ArrayList(u8) = .empty;
    defer any_msg.deinit(gpa);
    try appendBytesField(gpa, &any_msg, 1, "type.googleapis.com/google.rpc.RetryInfo");
    try appendBytesField(gpa, &any_msg, 2, retry_info.items);

    var status_msg: std.ArrayList(u8) = .empty;
    defer status_msg.deinit(gpa);
    try appendBytesField(gpa, &status_msg, 3, any_msg.items);

    const enc = std.base64.standard_no_pad.Encoder;
    const out = try gpa.alloc(u8, enc.calcSize(status_msg.items.len));
    _ = enc.encode(out, status_msg.items);
    return out;
}

fn appendVarint(gpa: Allocator, out: *std.ArrayList(u8), value: u64) Allocator.Error!void {
    var v = value;
    while (v >= 0x80) : (v >>= 7) {
        try out.append(gpa, @as(u8, @truncate(v)) | 0x80);
    }
    try out.append(gpa, @truncate(v));
}

fn appendBytesField(gpa: Allocator, out: *std.ArrayList(u8), field_num: u64, bytes: []const u8) Allocator.Error!void {
    try appendVarint(gpa, out, (field_num << 3) | 2);
    try appendVarint(gpa, out, bytes.len);
    try out.appendSlice(gpa, bytes);
}
