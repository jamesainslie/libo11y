//! Minimal HTTP/2 client (RFC 9113) for unary OTLP/gRPC calls.
//!
//! Supports cleartext HTTP/2 with prior knowledge (h2c) and TLS with ALPN
//! "h2" over tls.zig. Implements frame encoding/decoding, HPACK header
//! compression/decompression, connection and stream flow control, SETTINGS/PING
//! handshakes, GOAWAY/RST_STREAM handling and response body size caps.

const std = @import("std");
const tls = @import("tls");
const Io = std.Io;
const net = Io.net;
const Allocator = std.mem.Allocator;
const http = @import("http.zig");
const hpack = @import("hpack.zig");

/// RFC 9113 Section 3.4 client connection preface.
pub const client_preface = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

/// Fixed HTTP/2 frame header size in bytes.
pub const frame_header_len: usize = 9;

/// RFC 9113 default maximum frame payload length.
pub const default_max_frame_size: u32 = 16384;

/// RFC 9113 maximum legal frame payload length (2^24 - 1).
pub const max_allowed_frame_size: u32 = 16_777_215;

/// RFC 9113 default initial flow-control window size.
pub const default_initial_window_size: i64 = 65535;

/// RFC 9113 maximum flow-control window size (2^31 - 1).
pub const max_window_size: i64 = 0x7fffffff;

/// Flow-control window advertised by this client for incoming data.
pub const local_initial_window_size: u31 = 1024 * 1024;

/// Maximum valid client-initiated odd stream ID.
pub const max_stream_id: u31 = 0x7fffffff;

/// Maximum accumulated header block bytes across HEADERS + CONTINUATION.
pub const max_header_block_size: usize = 64 * 1024;

/// HTTP/2 frame type identifiers (RFC 9113 Section 6).
pub const FrameType = enum(u8) {
    data = 0x0,
    headers = 0x1,
    priority = 0x2,
    rst_stream = 0x3,
    settings = 0x4,
    push_promise = 0x5,
    ping = 0x6,
    goaway = 0x7,
    window_update = 0x8,
    continuation = 0x9,
    _,
};

/// HTTP/2 frame flag bits.
pub const Flags = struct {
    pub const end_stream: u8 = 0x01;
    pub const ack: u8 = 0x01;
    pub const end_headers: u8 = 0x04;
    pub const padded: u8 = 0x08;
    pub const priority: u8 = 0x20;
};

/// HTTP/2 SETTINGS parameter identifiers (RFC 9113 Section 6.5.2).
pub const SettingId = enum(u16) {
    header_table_size = 0x1,
    enable_push = 0x2,
    max_concurrent_streams = 0x3,
    initial_window_size = 0x4,
    max_frame_size = 0x5,
    max_header_list_size = 0x6,
    _,
};

/// HTTP/2 error codes (RFC 9113 Section 7).
pub const ErrorCode = enum(u32) {
    no_error = 0x0,
    protocol_error = 0x1,
    internal_error = 0x2,
    flow_control_error = 0x3,
    settings_timeout = 0x4,
    stream_closed = 0x5,
    frame_size_error = 0x6,
    refused_stream = 0x7,
    cancel = 0x8,
    compression_error = 0x9,
    connect_error = 0xa,
    enhance_your_calm = 0xb,
    inadequate_security = 0xc,
    http_1_1_required = 0xd,
    _,

    /// Human-readable name for diagnostics.
    pub fn name(code: u32) []const u8 {
        return switch (@as(ErrorCode, @fromBackingInt(@intCast(code)))) {
            .no_error => "NO_ERROR",
            .protocol_error => "PROTOCOL_ERROR",
            .internal_error => "INTERNAL_ERROR",
            .flow_control_error => "FLOW_CONTROL_ERROR",
            .settings_timeout => "SETTINGS_TIMEOUT",
            .stream_closed => "STREAM_CLOSED",
            .frame_size_error => "FRAME_SIZE_ERROR",
            .refused_stream => "REFUSED_STREAM",
            .cancel => "CANCEL",
            .compression_error => "COMPRESSION_ERROR",
            .connect_error => "CONNECT_ERROR",
            .enhance_your_calm => "ENHANCE_YOUR_CALM",
            .inadequate_security => "INADEQUATE_SECURITY",
            .http_1_1_required => "HTTP_1_1_REQUIRED",
            else => "UNKNOWN_ERROR",
        };
    }
};

/// One SETTINGS key-value pair.
pub const Setting = struct {
    id: u16,
    value: u32,
};

/// Decoded 9-byte HTTP/2 frame header.
pub const FrameHeader = struct {
    length: u24,
    frame_type: u8,
    flags: u8,
    stream_id: u31,

    /// Parses a 9-byte frame header from wire order.
    pub fn parse(buf: [frame_header_len]u8) FrameHeader {
        const len: u24 = (@as(u24, buf[0]) << 16) | (@as(u24, buf[1]) << 8) | buf[2];
        const raw_stream = std.mem.readInt(u32, buf[5..9], .big);
        return .{
            .length = len,
            .frame_type = buf[3],
            .flags = buf[4],
            .stream_id = @intCast(raw_stream & 0x7fffffff),
        };
    }

    /// Serializes the frame header to 9 bytes in wire order.
    pub fn encode(h: FrameHeader) [frame_header_len]u8 {
        var out: [frame_header_len]u8 = undefined;
        out[0] = @truncate(h.length >> 16);
        out[1] = @truncate(h.length >> 8);
        out[2] = @truncate(h.length);
        out[3] = h.frame_type;
        out[4] = h.flags;
        std.mem.writeInt(u32, out[5..9], h.stream_id, .big);
        return out;
    }
};

/// Errors from parsing an HTTP/2 frame payload.
pub const FrameError = error{
    ProtocolError,
    FrameSizeError,
    FlowControlError,
};

/// A parsed HTTP/2 frame borrowing its payload slices from the read buffer.
pub const Frame = union(enum) {
    data: struct {
        stream_id: u31,
        end_stream: bool,
        payload: []const u8,
        /// Original wire payload length (including padding) for flow control.
        wire_len: u24,
    },
    headers: struct {
        stream_id: u31,
        end_stream: bool,
        end_headers: bool,
        fragment: []const u8,
    },
    continuation: struct {
        stream_id: u31,
        end_headers: bool,
        fragment: []const u8,
    },
    priority: struct {
        stream_id: u31,
    },
    rst_stream: struct {
        stream_id: u31,
        error_code: u32,
    },
    settings: struct {
        ack: bool,
        payload: []const u8,
    },
    ping: struct {
        ack: bool,
        opaque_data: [8]u8,
    },
    goaway: struct {
        last_stream_id: u31,
        error_code: u32,
        debug_data: []const u8,
    },
    window_update: struct {
        stream_id: u31,
        increment: u31,
    },
    unknown: struct {
        frame_type: u8,
        stream_id: u31,
    },
};

/// Iterates over 6-byte settings entries in a non-ACK SETTINGS payload.
pub const SettingIterator = struct {
    payload: []const u8,
    pos: usize = 0,

    pub fn next(it: *SettingIterator) ?Setting {
        if (it.pos + 6 > it.payload.len) return null;
        const id = std.mem.readInt(u16, it.payload[it.pos..][0..2], .big);
        const value = std.mem.readInt(u32, it.payload[it.pos + 2 ..][0..4], .big);
        it.pos += 6;
        return .{ .id = id, .value = value };
    }
};

/// Parses one HTTP/2 frame given its decoded header and exact payload slice.
pub fn parseFrame(header: FrameHeader, payload: []const u8) FrameError!Frame {
    if (payload.len != header.length) return error.FrameSizeError;

    return switch (@as(FrameType, @fromBackingInt(@intCast(header.frame_type)))) {
        .data => blk: {
            if (header.stream_id == 0) return error.ProtocolError;
            const data = try stripPadding(payload, (header.flags & Flags.padded) != 0);
            break :blk .{ .data = .{
                .stream_id = header.stream_id,
                .end_stream = (header.flags & Flags.end_stream) != 0,
                .payload = data,
                .wire_len = header.length,
            } };
        },
        .headers => blk: {
            if (header.stream_id == 0) return error.ProtocolError;
            var slice = try stripPadding(payload, (header.flags & Flags.padded) != 0);
            if ((header.flags & Flags.priority) != 0) {
                if (slice.len < 5) return error.FrameSizeError;
                const dep: u31 = @intCast(std.mem.readInt(u32, slice[0..4], .big) & 0x7fffffff);
                if (dep == header.stream_id) return error.ProtocolError;
                slice = slice[5..];
            }
            break :blk .{ .headers = .{
                .stream_id = header.stream_id,
                .end_stream = (header.flags & Flags.end_stream) != 0,
                .end_headers = (header.flags & Flags.end_headers) != 0,
                .fragment = slice,
            } };
        },
        .continuation => blk: {
            if (header.stream_id == 0) return error.ProtocolError;
            break :blk .{ .continuation = .{
                .stream_id = header.stream_id,
                .end_headers = (header.flags & Flags.end_headers) != 0,
                .fragment = payload,
            } };
        },
        .priority => blk: {
            if (header.stream_id == 0) return error.ProtocolError;
            if (payload.len != 5) return error.FrameSizeError;
            break :blk .{ .priority = .{ .stream_id = header.stream_id } };
        },
        .rst_stream => blk: {
            if (header.stream_id == 0) return error.ProtocolError;
            if (payload.len != 4) return error.FrameSizeError;
            break :blk .{ .rst_stream = .{
                .stream_id = header.stream_id,
                .error_code = std.mem.readInt(u32, payload[0..4], .big),
            } };
        },
        .settings => blk: {
            if (header.stream_id != 0) return error.ProtocolError;
            const is_ack = (header.flags & Flags.ack) != 0;
            if (is_ack) {
                if (payload.len != 0) return error.FrameSizeError;
            } else if (payload.len % 6 != 0) {
                return error.FrameSizeError;
            }
            break :blk .{ .settings = .{ .ack = is_ack, .payload = payload } };
        },
        .push_promise => error.ProtocolError,
        .ping => blk: {
            if (header.stream_id != 0) return error.ProtocolError;
            if (payload.len != 8) return error.FrameSizeError;
            break :blk .{ .ping = .{
                .ack = (header.flags & Flags.ack) != 0,
                .opaque_data = payload[0..8].*,
            } };
        },
        .goaway => blk: {
            if (header.stream_id != 0) return error.ProtocolError;
            if (payload.len < 8) return error.FrameSizeError;
            const last_id: u31 = @intCast(std.mem.readInt(u32, payload[0..4], .big) & 0x7fffffff);
            const code = std.mem.readInt(u32, payload[4..8], .big);
            break :blk .{ .goaway = .{
                .last_stream_id = last_id,
                .error_code = code,
                .debug_data = payload[8..],
            } };
        },
        .window_update => blk: {
            if (payload.len != 4) return error.FrameSizeError;
            const inc: u31 = @intCast(std.mem.readInt(u32, payload[0..4], .big) & 0x7fffffff);
            if (inc == 0) return error.ProtocolError;
            break :blk .{ .window_update = .{
                .stream_id = header.stream_id,
                .increment = inc,
            } };
        },
        _ => .{ .unknown = .{ .frame_type = header.frame_type, .stream_id = header.stream_id } },
    };
}

fn stripPadding(payload: []const u8, padded: bool) FrameError![]const u8 {
    if (!padded) return payload;
    if (payload.len == 0) return error.ProtocolError;
    const pad_len: usize = payload[0];
    if (1 + pad_len > payload.len) return error.ProtocolError;
    return payload[1 .. payload.len - pad_len];
}

/// Writes a raw HTTP/2 frame (9-byte header + payload).
pub fn writeFrame(w: *Io.Writer, frame_type: FrameType, flags: u8, stream_id: u31, payload: []const u8) Io.Writer.Error!void {
    const hdr: FrameHeader = .{
        .length = @intCast(payload.len),
        .frame_type = @backingInt(frame_type),
        .flags = flags,
        .stream_id = stream_id,
    };
    try w.writeAll(&hdr.encode());
    if (payload.len > 0) try w.writeAll(payload);
}

/// Writes a SETTINGS frame with the given pairs.
pub fn writeSettings(w: *Io.Writer, settings: []const Setting) Io.Writer.Error!void {
    const hdr: FrameHeader = .{
        .length = @intCast(settings.len * 6),
        .frame_type = @backingInt(FrameType.settings),
        .flags = 0,
        .stream_id = 0,
    };
    try w.writeAll(&hdr.encode());
    var pair: [6]u8 = undefined;
    for (settings) |s| {
        std.mem.writeInt(u16, pair[0..2], s.id, .big);
        std.mem.writeInt(u32, pair[2..6], s.value, .big);
        try w.writeAll(&pair);
    }
}

/// Writes a SETTINGS ACK frame.
pub fn writeSettingsAck(w: *Io.Writer) Io.Writer.Error!void {
    try writeFrame(w, .settings, Flags.ack, 0, &.{});
}

/// Writes a PING or PING ACK frame.
pub fn writePing(w: *Io.Writer, ack: bool, opaque_data: [8]u8) Io.Writer.Error!void {
    try writeFrame(w, .ping, if (ack) Flags.ack else 0, 0, &opaque_data);
}

/// Writes a WINDOW_UPDATE frame.
pub fn writeWindowUpdate(w: *Io.Writer, stream_id: u31, increment: u31) Io.Writer.Error!void {
    var payload: [4]u8 = undefined;
    std.mem.writeInt(u32, &payload, increment, .big);
    try writeFrame(w, .window_update, 0, stream_id, &payload);
}

/// Writes a GOAWAY frame.
pub fn writeGoAway(w: *Io.Writer, last_stream_id: u31, error_code: ErrorCode, debug_data: []const u8) Io.Writer.Error!void {
    const hdr: FrameHeader = .{
        .length = @intCast(8 + debug_data.len),
        .frame_type = @backingInt(FrameType.goaway),
        .flags = 0,
        .stream_id = 0,
    };
    try w.writeAll(&hdr.encode());
    var fixed: [8]u8 = undefined;
    std.mem.writeInt(u32, fixed[0..4], last_stream_id, .big);
    std.mem.writeInt(u32, fixed[4..8], @backingInt(error_code), .big);
    try w.writeAll(&fixed);
    if (debug_data.len > 0) try w.writeAll(debug_data);
}

/// Writes a RST_STREAM frame.
pub fn writeRstStream(w: *Io.Writer, stream_id: u31, error_code: ErrorCode) Io.Writer.Error!void {
    var payload: [4]u8 = undefined;
    std.mem.writeInt(u32, &payload, @backingInt(error_code), .big);
    try writeFrame(w, .rst_stream, 0, stream_id, &payload);
}

/// Writes an HPACK header block as one HEADERS frame followed by zero or more
/// CONTINUATION frames respecting `max_frame_size`.
pub fn writeHeaderBlock(
    w: *Io.Writer,
    stream_id: u31,
    block: []const u8,
    max_frame_size: u32,
    end_stream: bool,
) Io.Writer.Error!void {
    const limit: usize = @max(max_frame_size, default_max_frame_size);
    const first_len = @min(block.len, limit);
    const first_done = first_len == block.len;
    var flags: u8 = if (end_stream) Flags.end_stream else 0;
    if (first_done) flags |= Flags.end_headers;
    try writeFrame(w, .headers, flags, stream_id, block[0..first_len]);

    var pos = first_len;
    while (pos < block.len) {
        const chunk_len = @min(block.len - pos, limit);
        const done = pos + chunk_len == block.len;
        try writeFrame(w, .continuation, if (done) Flags.end_headers else 0, stream_id, block[pos .. pos + chunk_len]);
        pos += chunk_len;
    }
}

/// Response from a single HTTP/2 unary request.
pub const Response = struct {
    /// Decoded `:status` pseudo-header.
    status: u16,
    /// Initial response headers (and trailers when `trailers_only` is true).
    headers: []hpack.Header,
    /// Trailing response headers (empty when `trailers_only` is true or absent).
    trailers: []hpack.Header,
    /// True when the response carried END_STREAM on the initial HEADERS frame.
    trailers_only: bool,
    /// Concatenated DATA frame payload.
    body: []u8,

    pub fn deinit(r: *Response, gpa: Allocator) void {
        hpack.freeHeaders(gpa, r.headers);
        hpack.freeHeaders(gpa, r.trailers);
        gpa.free(r.body);
        r.* = undefined;
    }

    /// Returns the first header with `name` from `headers`.
    pub fn header(r: *const Response, name: []const u8) ?[]const u8 {
        for (r.headers) |h| if (std.mem.eql(u8, h.name, name)) return h.value;
        return null;
    }

    /// Returns the first trailer with `name`, falling back to `headers` when
    /// the response was trailers-only (or when the server sent gRPC status
    /// headers in the initial HEADERS frame).
    pub fn trailer(r: *const Response, name: []const u8) ?[]const u8 {
        for (r.trailers) |h| if (std.mem.eql(u8, h.name, name)) return h.value;
        if (r.trailers_only) {
            for (r.headers) |h| if (std.mem.eql(u8, h.name, name)) return h.value;
        }
        return null;
    }
};

/// Errors from `Connection.roundTrip`.
pub const RoundTripError = error{
    /// Peer closed connection or GOAWAY prevented opening a stream.
    ConnectionClosing,
    /// Peer sent GOAWAY with last_stream_id < our stream_id (unprocessed).
    StreamRefused,
    /// Peer sent RST_STREAM for our stream.
    StreamReset,
    /// Peer violated HTTP/2 framing or protocol rules.
    ProtocolError,
    /// Peer sent invalid HPACK headers.
    CompressionError,
    /// Response DATA exceeded `max_response_body`.
    ResponseTooLarge,
    /// Header encoding failed due to invalid header name or value.
    InvalidHeader,
    /// Underlying read error (check `lastFailure`).
    ReadFailed,
    /// Underlying write error (check `lastFailure`).
    WriteFailed,
    OutOfMemory,
};

/// One persistent HTTP/2 client connection (cleartext h2c or TLS ALPN "h2").
/// Lives on the heap because its reader/writer hold interior buffer pointers.
pub const Connection = struct {
    io: Io,
    stream: net.Stream,
    secure: bool,
    handshaken: bool = false,
    reused: bool = false,
    broken: bool = false,
    goaway_received: bool = false,
    goaway_last_stream_id: u31 = 0,
    goaway_error_code: u32 = 0,
    last_rst_error_code: u32 = 0,
    next_stream_id: u31 = 1,
    stream_exhausted: bool = false,

    peer_max_frame_size: u32 = default_max_frame_size,
    peer_initial_window_size: i64 = default_initial_window_size,
    peer_conn_window: i64 = default_initial_window_size,

    hpack_decoder: hpack.Decoder,

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
    frame_buf: [default_max_frame_size]u8,

    pub const OpenError = http.Connection.OpenError;

    /// Dials `endpoint`, performs the TLS handshake with ALPN "h2" when secure,
    /// and writes the HTTP/2 client connection preface and initial SETTINGS.
    pub fn open(
        gpa: Allocator,
        io: Io,
        endpoint: *const http.Endpoint,
        tls_config: ?*const http.TlsConfig,
        failure: *http.Failure,
    ) OpenError!*Connection {
        const stream = connect(io, endpoint) catch |err| {
            failure.* = classifyConnect(err);
            return if (failure.kind == .canceled) error.Canceled else error.ConnectFailed;
        };
        errdefer stream.close(io);

        const c = try gpa.create(Connection);
        errdefer gpa.destroy(c);
        c.* = .{
            .io = io,
            .stream = stream,
            .secure = endpoint.secure,
            .hpack_decoder = .init(gpa, hpack.default_table_size, hpack.default_max_header_list_size),
            .tcp_reader = undefined,
            .tcp_writer = undefined,
            .tls_conn = undefined,
            .tls_reader = undefined,
            .tls_writer = undefined,
            .rng_source = .{ .io = io },
            .tcp_in = undefined,
            .tcp_out = undefined,
            .clear_in = undefined,
            .clear_out = undefined,
            .frame_buf = undefined,
        };
        errdefer c.hpack_decoder.deinit();

        c.tcp_reader = stream.reader(io, &c.tcp_in);
        c.tcp_writer = stream.writer(io, &c.tcp_out);

        if (endpoint.secure) {
            const config = tls_config orelse {
                failure.* = .{ .kind = .fatal, .name = "no TLS configuration" };
                return error.HandshakeFailed;
            };
            c.tls_conn = tls.client(&c.tcp_reader.interface, &c.tcp_writer.interface, .{
                .host = endpoint.host,
                .root_ca = config.root_ca,
                .auth = config.auth,
                .alpn_protocols = &.{"h2"},
                .now = Io.Clock.real.now(io),
                .rng = c.rng_source.interface(),
            }) catch |err| {
                failure.* = c.lastFailure() orelse .{ .kind = .fatal, .name = @errorName(err) };
                return if (failure.kind == .canceled) error.Canceled else error.HandshakeFailed;
            };
            const negotiated = c.tls_conn.alpn_protocol orelse "";
            if (!std.mem.eql(u8, negotiated, "h2")) {
                c.tls_conn.close() catch {};
                failure.* = .{ .kind = .fatal, .name = "ALPN did not negotiate h2" };
                return error.HandshakeFailed;
            }
            c.tls_reader = c.tls_conn.reader(&c.clear_in);
            c.tls_writer = c.tls_conn.writer(&c.clear_out);
            c.handshaken = true;
        }

        // Write HTTP/2 connection preface, initial SETTINGS and connection
        // WINDOW_UPDATE (RFC 9113 Section 3.4).
        const w = c.writer();
        c.writePreface(w) catch {
            failure.* = c.lastFailure() orelse .{ .kind = .fatal, .name = "WriteFailed" };
            return if (failure.kind == .canceled) error.Canceled else error.ConnectFailed;
        };
        return c;
    }

    fn writePreface(c: *Connection, w: *Io.Writer) Io.Writer.Error!void {
        _ = c;
        try w.writeAll(client_preface);
        try writeSettings(w, &.{
            .{ .id = @backingInt(SettingId.header_table_size), .value = hpack.default_table_size },
            .{ .id = @backingInt(SettingId.enable_push), .value = 0 },
            .{ .id = @backingInt(SettingId.initial_window_size), .value = local_initial_window_size },
            .{ .id = @backingInt(SettingId.max_frame_size), .value = default_max_frame_size },
        });
        const conn_inc: u31 = local_initial_window_size - @as(u31, @intCast(default_initial_window_size));
        try writeWindowUpdate(w, 0, conn_inc);
        try w.flush();
    }

    /// Reports whether this connection can open another stream.
    pub fn usable(c: *const Connection) bool {
        return !c.broken and !c.goaway_received and !c.stream_exhausted;
    }

    /// Closes the connection and frees its memory. When `graceful` is true,
    /// sends GOAWAY(NO_ERROR) and TLS close_notify best-effort.
    pub fn close(c: *Connection, gpa: Allocator, graceful: bool) void {
        if (graceful and !c.broken) {
            const w = c.writer();
            writeGoAway(w, 0, .no_error, &.{}) catch {};
            w.flush() catch {};
        }
        if (c.handshaken and graceful) c.tls_conn.close() catch {};
        c.stream.close(c.io);
        c.hpack_decoder.deinit();
        gpa.destroy(c);
    }

    /// The cleartext reader (TLS or TCP).
    pub fn reader(c: *Connection) *Io.Reader {
        return if (c.secure) &c.tls_reader.interface else &c.tcp_reader.interface;
    }

    /// The cleartext writer (TLS or TCP).
    pub fn writer(c: *Connection) *Io.Writer {
        return if (c.secure) &c.tls_writer.interface else &c.tcp_writer.interface;
    }

    /// Describes why the last read or write failed, if recorded on TCP or TLS.
    pub fn lastFailure(c: *Connection) ?http.Failure {
        if (c.tcp_reader.err) |err| return classifyRead(err);
        if (c.tcp_writer.err) |err| return classifyWrite(err);
        if (c.handshaken) {
            if (c.tls_reader.err) |err| return .{ .kind = .fatal, .name = @errorName(err) };
            if (c.tls_writer.err) |err| return .{ .kind = .fatal, .name = @errorName(err) };
        }
        return null;
    }

    /// Executes one unary HTTP/2 request/response exchange on a new odd stream.
    pub fn roundTrip(
        c: *Connection,
        gpa: Allocator,
        req_headers: []const hpack.Header,
        req_body: []const u8,
        max_response_body: usize,
    ) RoundTripError!Response {
        if (!c.usable()) return error.ConnectionClosing;

        const stream_id = c.next_stream_id;
        if (c.next_stream_id <= max_stream_id - 2) {
            c.next_stream_id += 2;
        } else {
            c.stream_exhausted = true;
        }

        // Encode request headers before touching the wire so invalid headers
        // leave the connection intact.
        var hpack_out: Io.Writer.Allocating = .init(gpa);
        defer hpack_out.deinit();
        hpack.encodeHeaders(&hpack_out.writer, req_headers) catch |err| return switch (err) {
            error.InvalidHeader => error.InvalidHeader,
            error.OutOfMemory, error.WriteFailed => error.OutOfMemory,
        };

        var state: StreamState = .{
            .stream_id = stream_id,
            .max_response_body = max_response_body,
            .stream_send_window = c.peer_initial_window_size,
        };
        defer state.deinit(gpa);

        const w = c.writer();
        writeHeaderBlock(w, stream_id, hpack_out.written(), c.peer_max_frame_size, req_body.len == 0) catch {
            c.broken = true;
            return error.WriteFailed;
        };

        // Stream request body respecting peer max frame size and flow control.
        var sent: usize = 0;
        var sent_end_stream = (req_body.len == 0);
        while (sent < req_body.len and !state.ended) {
            const avail = @min(c.peer_conn_window, state.stream_send_window);
            if (avail <= 0) {
                w.flush() catch {
                    c.broken = true;
                    return error.WriteFailed;
                };
                try c.readOneFrame(gpa, &state);
                continue;
            }
            const chunk_len = @min(
                req_body.len - sent,
                @min(@as(usize, @intCast(avail)), c.peer_max_frame_size),
            );
            const is_last = (sent + chunk_len == req_body.len);
            writeFrame(w, .data, if (is_last) Flags.end_stream else 0, stream_id, req_body[sent .. sent + chunk_len]) catch {
                c.broken = true;
                return error.WriteFailed;
            };
            sent += chunk_len;
            if (is_last) sent_end_stream = true;
            c.peer_conn_window -= @intCast(chunk_len);
            state.stream_send_window -= @intCast(chunk_len);
        }

        if (state.ended and !sent_end_stream and !c.broken) {
            // Peer closed the stream early while we were still uploading the
            // request body; reset our half-open send side so server stream
            // slots do not leak.
            writeRstStream(w, stream_id, .no_error) catch {
                c.broken = true;
                return error.WriteFailed;
            };
        }

        w.flush() catch {
            c.broken = true;
            return error.WriteFailed;
        };

        while (!state.ended) {
            try c.readOneFrame(gpa, &state);
        }

        // Replenish any remaining consumed connection window so subsequent
        // streams on this connection keep full throughput.
        if (state.conn_consumed > 0 and !c.goaway_received and !c.broken) {
            writeWindowUpdate(w, 0, @intCast(state.conn_consumed)) catch {
                c.broken = true;
                return error.WriteFailed;
            };
            w.flush() catch {
                c.broken = true;
                return error.WriteFailed;
            };
            state.conn_consumed = 0;
        }

        if (!state.got_initial_headers) {
            c.broken = true;
            return error.ProtocolError;
        }

        c.reused = true;
        return state.takeResponse(gpa);
    }

    const StreamState = struct {
        stream_id: u31,
        max_response_body: usize,
        stream_send_window: i64,
        got_initial_headers: bool = false,
        ended: bool = false,
        trailers_only: bool = false,
        in_header_block: bool = false,
        header_block_end_stream: bool = false,
        status: u16 = 0,
        headers: []hpack.Header = &.{},
        trailers: []hpack.Header = &.{},
        header_block: std.ArrayList(u8) = .empty,
        body: std.ArrayList(u8) = .empty,
        conn_consumed: u32 = 0,
        stream_consumed: u32 = 0,

        fn deinit(s: *StreamState, gpa: Allocator) void {
            hpack.freeHeaders(gpa, s.headers);
            hpack.freeHeaders(gpa, s.trailers);
            s.header_block.deinit(gpa);
            s.body.deinit(gpa);
        }

        fn takeResponse(s: *StreamState, gpa: Allocator) Allocator.Error!Response {
            const body = try s.body.toOwnedSlice(gpa);
            const resp: Response = .{
                .status = s.status,
                .headers = s.headers,
                .trailers = s.trailers,
                .trailers_only = s.trailers_only,
                .body = body,
            };
            s.headers = &.{};
            s.trailers = &.{};
            return resp;
        }
    };

    fn readOneFrame(c: *Connection, gpa: Allocator, state: *StreamState) RoundTripError!void {
        const r = c.reader();
        var raw_hdr: [frame_header_len]u8 = undefined;
        r.readSliceAll(&raw_hdr) catch |err| {
            c.broken = true;
            return switch (err) {
                error.EndOfStream => if (!state.got_initial_headers and !state.in_header_block)
                    error.ConnectionClosing
                else
                    error.ReadFailed,
                error.ReadFailed => error.ReadFailed,
            };
        };

        const hdr = FrameHeader.parse(raw_hdr);
        if (hdr.length > default_max_frame_size) {
            c.broken = true;
            return error.ProtocolError;
        }
        const payload = c.frame_buf[0..hdr.length];
        if (payload.len > 0) {
            r.readSliceAll(payload) catch {
                c.broken = true;
                return error.ReadFailed;
            };
        }

        const frame = parseFrame(hdr, payload) catch {
            c.broken = true;
            return error.ProtocolError;
        };

        // RFC 9113 Section 6.10: no other frame may interleave a header block.
        if (state.in_header_block) {
            switch (frame) {
                .continuation => |cont| if (cont.stream_id != state.stream_id) {
                    c.broken = true;
                    return error.ProtocolError;
                },
                else => {
                    c.broken = true;
                    return error.ProtocolError;
                },
            }
        }

        switch (frame) {
            .settings => |s| {
                if (s.ack) return;
                var it: SettingIterator = .{ .payload = s.payload };
                while (it.next()) |setting| {
                    switch (@as(SettingId, @fromBackingInt(@intCast(setting.id)))) {
                        .initial_window_size => {
                            if (setting.value > max_window_size) {
                                c.broken = true;
                                return error.ProtocolError;
                            }
                            const new_val: i64 = setting.value;
                            const delta = new_val - c.peer_initial_window_size;
                            c.peer_initial_window_size = new_val;
                            state.stream_send_window += delta;
                            if (state.stream_send_window > max_window_size) {
                                c.broken = true;
                                return error.ProtocolError;
                            }
                        },
                        .max_frame_size => {
                            if (setting.value < default_max_frame_size or setting.value > max_allowed_frame_size) {
                                c.broken = true;
                                return error.ProtocolError;
                            }
                            c.peer_max_frame_size = setting.value;
                        },
                        else => {},
                    }
                }
                const w = c.writer();
                writeSettingsAck(w) catch {
                    c.broken = true;
                    return error.WriteFailed;
                };
                w.flush() catch {
                    c.broken = true;
                    return error.WriteFailed;
                };
            },
            .ping => |p| {
                if (p.ack) return;
                const w = c.writer();
                writePing(w, true, p.opaque_data) catch {
                    c.broken = true;
                    return error.WriteFailed;
                };
                w.flush() catch {
                    c.broken = true;
                    return error.WriteFailed;
                };
            },
            .window_update => |wu| {
                if (wu.stream_id == 0) {
                    c.peer_conn_window += wu.increment;
                    if (c.peer_conn_window > max_window_size) {
                        c.broken = true;
                        return error.ProtocolError;
                    }
                } else if (wu.stream_id == state.stream_id) {
                    state.stream_send_window += wu.increment;
                    if (state.stream_send_window > max_window_size) {
                        c.broken = true;
                        return error.ProtocolError;
                    }
                }
            },
            .goaway => |g| {
                c.goaway_received = true;
                c.goaway_last_stream_id = g.last_stream_id;
                c.goaway_error_code = g.error_code;
                if (state.stream_id > g.last_stream_id) {
                    return error.StreamRefused;
                }
            },
            .rst_stream => |rst| {
                if (rst.stream_id == state.stream_id) {
                    c.last_rst_error_code = rst.error_code;
                    return error.StreamReset;
                }
            },
            .headers => |h| {
                if (h.stream_id != state.stream_id) {
                    // Serialized unary client has only one active stream;
                    // skipping a foreign HEADERS block would desync HPACK.
                    c.broken = true;
                    return error.ProtocolError;
                }
                if (state.header_block.items.len + h.fragment.len > max_header_block_size) {
                    c.broken = true;
                    return error.CompressionError;
                }
                try state.header_block.appendSlice(gpa, h.fragment);
                state.header_block_end_stream = h.end_stream;
                if (h.end_headers) {
                    try c.finishHeaderBlock(gpa, state);
                } else {
                    state.in_header_block = true;
                }
            },
            .continuation => |cont| {
                // RFC 9113 Section 6.10: unsolicited CONTINUATION or mismatching
                // stream ID is a connection PROTOCOL_ERROR.
                if (!state.in_header_block or cont.stream_id != state.stream_id) {
                    c.broken = true;
                    return error.ProtocolError;
                }
                if (state.header_block.items.len + cont.fragment.len > max_header_block_size) {
                    c.broken = true;
                    return error.CompressionError;
                }
                try state.header_block.appendSlice(gpa, cont.fragment);
                if (cont.end_headers) {
                    state.in_header_block = false;
                    try c.finishHeaderBlock(gpa, state);
                }
            },
            .data => |d| {
                if (d.stream_id != state.stream_id) return;
                if (!state.got_initial_headers) {
                    c.broken = true;
                    return error.ProtocolError;
                }
                if (state.body.items.len + d.payload.len > state.max_response_body) {
                    c.broken = true;
                    return error.ResponseTooLarge;
                }
                try state.body.appendSlice(gpa, d.payload);

                // Replenish flow-control windows (RFC 9113 Section 6.9.1 counts
                // full frame payload length including padding).
                state.conn_consumed += d.wire_len;
                state.stream_consumed += d.wire_len;
                const threshold: u32 = local_initial_window_size / 2;
                const w = c.writer();
                var flushed_needed = false;
                if (state.conn_consumed >= threshold) {
                    writeWindowUpdate(w, 0, @intCast(state.conn_consumed)) catch {
                        c.broken = true;
                        return error.WriteFailed;
                    };
                    state.conn_consumed = 0;
                    flushed_needed = true;
                }
                if (!d.end_stream and state.stream_consumed >= threshold) {
                    writeWindowUpdate(w, state.stream_id, @intCast(state.stream_consumed)) catch {
                        c.broken = true;
                        return error.WriteFailed;
                    };
                    state.stream_consumed = 0;
                    flushed_needed = true;
                }
                if (flushed_needed) {
                    w.flush() catch {
                        c.broken = true;
                        return error.WriteFailed;
                    };
                }
                if (d.end_stream) state.ended = true;
            },
            .priority, .unknown => {},
        }
    }

    fn finishHeaderBlock(c: *Connection, gpa: Allocator, state: *StreamState) RoundTripError!void {
        const decoded = c.hpack_decoder.decode(state.header_block.items, gpa) catch |err| {
            c.broken = true;
            return switch (err) {
                error.OutOfMemory => error.OutOfMemory,
                else => error.CompressionError,
            };
        };
        state.header_block.clearRetainingCapacity();

        if (!state.got_initial_headers) {
            const status = validateResponseHeaders(decoded) orelse {
                hpack.freeHeaders(gpa, decoded);
                c.broken = true;
                return error.ProtocolError;
            };
            if (status >= 100 and status < 200) {
                // Interim 1xx informational response.
                hpack.freeHeaders(gpa, decoded);
                if (state.header_block_end_stream) {
                    c.broken = true;
                    return error.ProtocolError;
                }
                return;
            }
            state.status = status;
            state.headers = decoded;
            state.got_initial_headers = true;
            if (state.header_block_end_stream) {
                state.trailers_only = true;
                state.ended = true;
            }
        } else {
            // Trailing headers must terminate the stream and contain no
            // pseudo-headers (RFC 9113 Section 8.1).
            if (!state.header_block_end_stream or !validateTrailers(decoded)) {
                hpack.freeHeaders(gpa, decoded);
                c.broken = true;
                return error.ProtocolError;
            }
            hpack.freeHeaders(gpa, state.trailers);
            state.trailers = decoded;
            state.ended = true;
        }
    }
};

/// Validates decoded HTTP/2 response headers per RFC 9113 Sections 8.1-8.3:
/// only `:status` is permitted as a pseudo-header, it must appear exactly once
/// before any regular header, and all header names and values must obey HTTP/2
/// hygiene (lowercase token names, no CR/LF/NUL in values).
pub fn validateResponseHeaders(headers: []const hpack.Header) ?u16 {
    var found: ?u16 = null;
    var seen_regular = false;
    for (headers) |h| {
        if (h.name.len == 0 or !hpack.validHeaderValue(h.value)) return null;
        if (h.name[0] == ':') {
            if (seen_regular) return null;
            if (!std.mem.eql(u8, h.name, ":status")) return null;
            if (found != null) return null;
            if (h.value.len != 3) return null;
            for (h.value) |ch| if (!std.ascii.isDigit(ch)) return null;
            const code = std.fmt.parseInt(u16, h.value, 10) catch return null;
            if (code < 100 or code > 599) return null;
            found = code;
        } else {
            seen_regular = true;
            if (!hpack.validHeaderName(h.name)) return null;
        }
    }
    return found;
}

/// Validates decoded HTTP/2 trailers per RFC 9113 Sections 8.1-8.2:
/// no pseudo-headers are allowed, and all names/values must obey HTTP/2 hygiene.
pub fn validateTrailers(headers: []const hpack.Header) bool {
    for (headers) |h| {
        if (h.name.len == 0 or h.name[0] == ':') return false;
        if (!hpack.validHeaderName(h.name) or !hpack.validHeaderValue(h.value)) return false;
    }
    return true;
}

fn connect(io: Io, endpoint: *const http.Endpoint) net.HostName.ConnectError!net.Stream {
    if (net.IpAddress.parse(endpoint.host, endpoint.port)) |address| {
        return address.connect(io, .{ .mode = .stream });
    } else |_| {}
    const host = net.HostName.init(endpoint.host) catch return error.UnknownHostName;
    return host.connect(io, endpoint.port, .{ .mode = .stream });
}

fn classifyConnect(err: net.HostName.ConnectError) http.Failure {
    return .{ .name = @errorName(err), .kind = switch (err) {
        error.Canceled => .canceled,
        error.Timeout,
        error.WouldBlock,
        error.ProcessFdQuotaExceeded,
        error.SystemFdQuotaExceeded,
        => .temporary,
        else => .fatal,
    } };
}

fn classifyRead(err: net.Stream.Reader.Error) http.Failure {
    return .{ .name = @errorName(err), .kind = switch (err) {
        error.Canceled => .canceled,
        error.ConnectionTimedOut => .temporary,
        error.ConnectionResetByPeer, error.SocketUnconnected => .closed,
        else => .fatal,
    } };
}

fn classifyWrite(err: net.Stream.Writer.Error) http.Failure {
    return .{ .name = @errorName(err), .kind = switch (err) {
        error.Canceled => .canceled,
        error.ConnectionTimedOut => .temporary,
        error.ConnectionResetByPeer, error.SocketUnconnected => .closed,
        else => .fatal,
    } };
}

test {
    _ = @import("h2_test.zig");
}
