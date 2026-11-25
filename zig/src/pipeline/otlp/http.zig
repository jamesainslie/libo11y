//! A small HTTP/1.1 client for the OTLP/HTTP transport.
//!
//! `std.http.Client` cannot run over tls.zig, so this file has the pieces
//! the transport needs: endpoint parsing, request writing, response
//! reading, gzip, `Retry-After` parsing and a connection that carries the
//! bytes over plain TCP or tls.zig. It reuses std's HTTP head and body
//! parsers. The retry and deadline logic lives in transport.zig.

const std = @import("std");
const tls = @import("tls");
const Io = std.Io;
const net = Io.net;
const Allocator = std.mem.Allocator;
const flate = std.compress.flate;

/// One request header.
pub const Header = struct { name: []const u8, value: []const u8 };

/// A parsed `http://` or `https://` endpoint URL. Every slice points into
/// the URL passed to `parse`.
pub const Endpoint = struct {
    /// True for https.
    secure: bool,
    /// The host without IPv6 brackets, for DNS or an IP literal.
    host: []const u8,
    /// The port, 80 or 443 when the URL has none.
    port: u16,
    /// `host[:port]` as written in the URL, for the Host header.
    authority: []const u8,
    /// The path and query. It can be empty or start with `?`, in which
    /// case the request line gets a leading `/`.
    target: []const u8,

    /// The only parse error.
    pub const ParseError = error{InvalidEndpoint};

    /// Parses an absolute http or https URL. The scheme is case-insensitive,
    /// a fragment is dropped, and user information (`user@`) is rejected.
    pub fn parse(url: []const u8) ParseError!Endpoint {
        const sep = std.mem.indexOf(u8, url, "://") orelse return error.InvalidEndpoint;
        const scheme = url[0..sep];
        const secure = if (std.ascii.eqlIgnoreCase(scheme, "https"))
            true
        else if (std.ascii.eqlIgnoreCase(scheme, "http"))
            false
        else
            return error.InvalidEndpoint;

        const rest = url[sep + 3 ..];
        const authority_end = std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len;
        const authority = rest[0..authority_end];
        if (authority.len == 0) return error.InvalidEndpoint;
        if (std.mem.indexOfScalar(u8, authority, '@') != null) return error.InvalidEndpoint;
        if (hasControlOrSpace(authority)) return error.InvalidEndpoint;

        var host: []const u8 = authority;
        var port_text: ?[]const u8 = null;
        if (authority[0] == '[') {
            const close = std.mem.indexOfScalar(u8, authority, ']') orelse return error.InvalidEndpoint;
            host = authority[1..close];
            const after = authority[close + 1 ..];
            if (after.len > 0) {
                if (after[0] != ':') return error.InvalidEndpoint;
                port_text = after[1..];
            }
            if (std.mem.indexOfScalar(u8, host, ':') == null) return error.InvalidEndpoint;
        } else if (std.mem.lastIndexOfScalar(u8, authority, ':')) |colon| {
            host = authority[0..colon];
            port_text = authority[colon + 1 ..];
        }
        if (host.len == 0) return error.InvalidEndpoint;
        if (authority[0] != '[') {
            if (std.mem.indexOfAny(u8, host, "[]") != null) return error.InvalidEndpoint;
            net.HostName.validate(host) catch return error.InvalidEndpoint;
        }

        var port: u16 = if (secure) 443 else 80;
        if (port_text) |text| if (text.len > 0) {
            for (text) |ch| if (!std.ascii.isDigit(ch)) return error.InvalidEndpoint;
            port = std.fmt.parseInt(u16, text, 10) catch return error.InvalidEndpoint;
            if (port == 0) return error.InvalidEndpoint;
        };

        var target = rest[authority_end..];
        if (std.mem.indexOfScalar(u8, target, '#')) |hash| target = target[0..hash];
        if (hasControlOrSpace(target)) return error.InvalidEndpoint;

        return .{
            .secure = secure,
            .host = host,
            .port = port,
            .authority = authority,
            .target = target,
        };
    }
};

fn hasControlOrSpace(text: []const u8) bool {
    for (text) |ch| if (ch <= ' ' or ch == 0x7f) return true;
    return false;
}

/// Reports whether `name` is a valid HTTP header name (an RFC 9110 token).
pub fn validHeaderName(name: []const u8) bool {
    if (name.len == 0) return false;
    for (name) |ch| {
        const ok = std.ascii.isAlphanumeric(ch) or switch (ch) {
            '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~' => true,
            else => false,
        };
        if (!ok) return false;
    }
    return true;
}

/// Reports whether `value` can be sent as a header value: no CR, LF or NUL.
pub fn validHeaderValue(value: []const u8) bool {
    return std.mem.indexOfAny(u8, value, "\r\n\x00") == null;
}

/// What `writeRequest` sends.
pub const Request = struct {
    /// The parsed endpoint, for the request line and Host header.
    endpoint: *const Endpoint,
    /// The Content-Type header value.
    content_type: []const u8,
    /// Adds `Content-Encoding: gzip`. The body must already be compressed.
    gzip: bool,
    /// The default User-Agent header value.
    user_agent: []const u8,
    /// Extra headers. A `User-Agent` here replaces the default one, as in
    /// Go. Host, Content-Type, Content-Length, Transfer-Encoding and
    /// Connection are owned by the client and skipped, and so is
    /// Content-Encoding when the body is gzipped.
    headers: []const Header,
    /// The body, sent with Content-Length.
    body: []const u8,
};

/// Writes one POST request with a Content-Length body and flushes `w`.
pub fn writeRequest(w: *Io.Writer, req: Request) Io.Writer.Error!void {
    const slash = req.endpoint.target.len == 0 or req.endpoint.target[0] == '?';
    try w.print("POST {s}{s} HTTP/1.1\r\nHost: {s}\r\n", .{
        if (slash) "/" else "",
        req.endpoint.target,
        req.endpoint.authority,
    });
    var user_agent = req.user_agent;
    for (req.headers) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "user-agent")) user_agent = h.value;
    }
    try w.print("User-Agent: {s}\r\n", .{user_agent});
    for (req.headers) |h| {
        if (reserved(h.name, req.gzip)) continue;
        try w.print("{s}: {s}\r\n", .{ h.name, h.value });
    }
    try w.print("Content-Type: {s}\r\n", .{req.content_type});
    if (req.gzip) try w.writeAll("Content-Encoding: gzip\r\n");
    try w.print("Content-Length: {d}\r\n\r\n", .{req.body.len});
    try w.writeAll(req.body);
    try w.flush();
}

fn reserved(name: []const u8, gzip_body: bool) bool {
    const always = [_][]const u8{ "user-agent", "host", "content-type", "content-length", "transfer-encoding", "connection" };
    for (always) |r| if (std.ascii.eqlIgnoreCase(name, r)) return true;
    return gzip_body and std.ascii.eqlIgnoreCase(name, "content-encoding");
}

/// A response read by `readResponse`.
pub const Response = struct {
    status: u16,
    /// Whether the connection can carry another request.
    keep_alive: bool,
    /// The parsed `Retry-After` header, if present and valid.
    retry_after: ?Io.Duration,
    /// The response Content-Type, empty when absent, owned like `body`.
    content_type: []u8,
    /// The decoded body, owned by the allocator passed to `readResponse`.
    body: []u8,

    /// Frees the content type and the body.
    pub fn deinit(r: *Response, gpa: Allocator) void {
        gpa.free(r.content_type);
        gpa.free(r.body);
        r.* = undefined;
    }
};

/// Errors from `readResponse`.
pub const ReadError = error{
    /// The connection ended before the first byte of the response.
    ConnectionClosing,
    /// The connection failed or ended inside the response. The stream's
    /// reader or writer holds the cause.
    ReadFailed,
    /// The response is not valid HTTP/1.1, or uses an encoding this client
    /// cannot decode.
    InvalidResponse,
    /// The body is longer than the limit.
    ResponseTooLarge,
    OutOfMemory,
};

/// Options for `readResponse`.
pub const ReadOptions = struct {
    /// The longest body accepted.
    max_body: usize,
    /// The current real time in seconds since the epoch, for an HTTP-date
    /// `Retry-After`.
    now_seconds: i64,
    /// The buffer of the body reader. It must hold at least 16 bytes.
    transfer_buffer: []u8,
};

/// Reads one response from `r`, skipping 1xx interim responses, and
/// decodes a chunked or gzip body. A body that runs until the connection
/// closes clears `keep_alive`.
pub fn readResponse(r: *std.http.Reader, gpa: Allocator, options: ReadOptions) ReadError!Response {
    while (true) {
        r.state = .ready;
        const head_bytes = r.receiveHead() catch |err| return switch (err) {
            error.HttpConnectionClosing => error.ConnectionClosing,
            error.HttpRequestTruncated, error.ReadFailed => error.ReadFailed,
            error.HttpHeadersOversize => error.InvalidResponse,
        };
        if (head_bytes.len < 12) return error.InvalidResponse;
        for (head_bytes[9..12]) |ch| if (!std.ascii.isDigit(ch)) return error.InvalidResponse;
        const head = std.http.Client.Response.Head.parse(head_bytes) catch return error.InvalidResponse;
        const code: u16 = @backingInt(head.status);
        if (code < 100) return error.InvalidResponse;
        if (code < 200) {
            if (code == 101) return error.InvalidResponse;
            continue;
        }

        var retry_after: ?Io.Duration = null;
        var it = std.http.HeaderIterator.init(head_bytes);
        while (it.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "retry-after")) retry_after = parseRetryAfter(h.value, options.now_seconds);
        }

        const content_type = try gpa.dupe(u8, head.content_type orelse "");
        errdefer gpa.free(content_type);

        var keep_alive = head.keep_alive;
        if (code == 204 or code == 304) {
            r.state = .ready;
            return .{ .status = code, .keep_alive = keep_alive, .retry_after = retry_after, .content_type = content_type, .body = &.{} };
        }
        if (head.transfer_encoding == .none and head.content_length == null) keep_alive = false;

        const body = switch (head.content_encoding) {
            .identity => try readAll(r.bodyReader(options.transfer_buffer, head.transfer_encoding, head.content_length), r, gpa, options.max_body),
            .gzip, .deflate => body: {
                const window = try gpa.alloc(u8, flate.max_window_len);
                defer gpa.free(window);
                var decompress: std.http.Decompress = undefined;
                const reader = r.bodyReaderDecompressing(
                    options.transfer_buffer,
                    head.transfer_encoding,
                    head.content_length,
                    head.content_encoding,
                    &decompress,
                    window,
                );
                break :body try readAll(reader, r, gpa, options.max_body);
            },
            .zstd, .compress => return error.InvalidResponse,
        };
        return .{ .status = code, .keep_alive = keep_alive, .retry_after = retry_after, .content_type = content_type, .body = body };
    }
}

fn readAll(reader: *Io.Reader, r: *std.http.Reader, gpa: Allocator, max: usize) ReadError![]u8 {
    return reader.allocRemaining(gpa, .limited(max)) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.StreamTooLong => error.ResponseTooLarge,
        error.ReadFailed => if (r.body_err != null) error.InvalidResponse else error.ReadFailed,
    };
}

/// Parses a `Retry-After` value: a number of seconds, or an IMF-fixdate
/// such as `Sun, 06 Nov 1994 08:49:37 GMT`, relative to `now_seconds`.
/// A date in the past gives zero. Anything else gives null, which Go
/// treats as no throttle. The obsolete RFC 850 and asctime date forms are
/// not supported.
pub fn parseRetryAfter(value: []const u8, now_seconds: i64) ?Io.Duration {
    const text = std.mem.trim(u8, value, " \t");
    if (text.len == 0) return null;
    if (allDigits(text)) {
        const max_seconds = std.math.maxInt(i64) / std.time.ns_per_s;
        const seconds = std.fmt.parseInt(i64, text, 10) catch max_seconds;
        return .fromSeconds(@min(seconds, max_seconds));
    }
    const at = parseImfFixdate(text) orelse return null;
    return .fromSeconds(@max(at - now_seconds, 0));
}

fn allDigits(text: []const u8) bool {
    for (text) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

/// Parses `Sun, 06 Nov 1994 08:49:37 GMT` into seconds since the epoch.
fn parseImfFixdate(text: []const u8) ?i64 {
    if (text.len != 29) return null;
    if (text[3] != ',' or text[4] != ' ' or text[7] != ' ' or text[11] != ' ' or
        text[16] != ' ' or text[19] != ':' or text[22] != ':' or !std.mem.eql(u8, text[25..], " GMT"))
        return null;
    const months = [_][]const u8{ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    var month: ?u32 = null;
    for (months, 1..) |m, i| {
        if (std.mem.eql(u8, text[8..11], m)) month = @intCast(i);
    }
    const day = digits(text[5..7]) orelse return null;
    const year = digits(text[12..16]) orelse return null;
    const hour = digits(text[17..19]) orelse return null;
    const minute = digits(text[20..22]) orelse return null;
    const second = digits(text[23..25]) orelse return null;
    const mon = month orelse return null;
    if (day < 1 or day > 31 or hour > 23 or minute > 59 or second > 60) return null;
    return daysFromCivil(year, mon, day) * 86400 + hour * 3600 + minute * 60 + second;
}

fn digits(text: []const u8) ?i64 {
    if (!allDigits(text)) return null;
    return std.fmt.parseInt(i64, text, 10) catch null;
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// days_from_civil).
fn daysFromCivil(year_in: i64, month: u32, day: i64) i64 {
    const year = if (month <= 2) year_in - 1 else year_in;
    const era = @divFloor(year, 400);
    const yoe = year - era * 400;
    const m: i64 = month;
    const doy = @divFloor(153 * (if (m > 2) m - 3 else m + 9) + 2, 5) + day - 1;
    const doe = yoe * 365 + @divFloor(yoe, 4) - @divFloor(yoe, 100) + doy;
    return era * 146097 + doe - 719468;
}

/// Compresses `data` into a new gzip stream owned by the caller.
pub fn gzip(gpa: Allocator, data: []const u8) error{OutOfMemory}![]u8 {
    var out: Io.Writer.Allocating = try .initCapacity(gpa, 64 + data.len / 2);
    errdefer out.deinit();
    const window = try gpa.alloc(u8, flate.max_window_len);
    defer gpa.free(window);
    const compress = try gpa.create(flate.Compress);
    defer gpa.destroy(compress);
    compress.* = flate.Compress.init(&out.writer, window, .gzip, .default) catch return error.OutOfMemory;
    compress.writer.writeAll(data) catch return error.OutOfMemory;
    compress.finish() catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// Decompresses a whole gzip stream into memory owned by the caller.
pub fn gunzip(gpa: Allocator, data: []const u8, max: usize) error{ OutOfMemory, InvalidData }![]u8 {
    var in: Io.Reader = .fixed(data);
    const window = try gpa.alloc(u8, flate.max_window_len);
    defer gpa.free(window);
    var decompress: flate.Decompress = .init(&in, .gzip, window);
    return decompress.reader.allocRemaining(gpa, .limited(max)) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.StreamTooLong, error.ReadFailed => error.InvalidData,
    };
}

/// The TLS settings of a connection.
pub const TlsConfig = struct {
    /// Verifies the server certificate.
    root_ca: tls.config.cert.Bundle,
    /// The client certificate and key, for mutual TLS.
    auth: ?*tls.config.CertKeyPair = null,
};

/// How a connection failed, for retry decisions and messages.
pub const Failure = struct {
    kind: Kind,
    /// The name of the underlying error, or a short phrase.
    name: []const u8,

    /// The class of a failure.
    pub const Kind = enum {
        /// The task was canceled.
        canceled,
        /// A temporary condition that Go's `Temporary()` would report, such
        /// as a timeout or a file descriptor limit. Worth a retry.
        temporary,
        /// The peer closed or reset the connection. On a reused connection
        /// this means it went stale while idle, and a redial is safe.
        closed,
        /// Anything else, such as a refused connection, an unknown host or
        /// a TLS failure.
        fatal,
    };
};

/// One TCP connection, with TLS when the endpoint is https. It owns every
/// buffer, so it lives on the heap and never moves.
pub const Connection = struct {
    io: Io,
    stream: net.Stream,
    secure: bool,
    /// Set once the TLS reader and writer exist.
    handshaken: bool = false,
    /// Set after the first complete response, so a later failure before
    /// any response byte can be taken as a stale keep-alive connection.
    reused: bool = false,
    tcp_reader: net.Stream.Reader,
    tcp_writer: net.Stream.Writer,
    tls_conn: tls.Connection,
    tls_reader: tls.Connection.Reader,
    tls_writer: tls.Connection.Writer,
    /// The response parser over `reader()`.
    http_reader: std.http.Reader,
    rng_source: std.Random.IoSource,
    tcp_in: [tls.input_buffer_len]u8,
    tcp_out: [tls.output_buffer_len]u8,
    clear_in: [16 * 1024]u8,
    clear_out: [16 * 1024]u8,
    /// The buffer for `ReadOptions.transfer_buffer`.
    transfer: [4096]u8,

    /// Errors from `open`. `failure` describes the cause.
    pub const OpenError = error{ Canceled, OutOfMemory, ConnectFailed, HandshakeFailed };

    /// Dials the endpoint and runs the TLS handshake when it is https.
    pub fn open(
        gpa: Allocator,
        io: Io,
        endpoint: *const Endpoint,
        tls_config: ?*const TlsConfig,
        failure: *Failure,
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
            .tcp_reader = undefined,
            .tcp_writer = undefined,
            .tls_conn = undefined,
            .tls_reader = undefined,
            .tls_writer = undefined,
            .http_reader = undefined,
            .rng_source = .{ .io = io },
            .tcp_in = undefined,
            .tcp_out = undefined,
            .clear_in = undefined,
            .clear_out = undefined,
            .transfer = undefined,
        };
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
                .alpn_protocols = &.{"http/1.1"},
                .now = Io.Clock.real.now(io),
                .rng = c.rng_source.interface(),
            }) catch |err| {
                failure.* = c.lastFailure() orelse .{ .kind = .fatal, .name = @errorName(err) };
                return if (failure.kind == .canceled) error.Canceled else error.HandshakeFailed;
            };
            c.tls_reader = c.tls_conn.reader(&c.clear_in);
            c.tls_writer = c.tls_conn.writer(&c.clear_out);
            c.handshaken = true;
        }
        const in = c.reader();
        c.http_reader = .{
            .in = in,
            .interface = undefined,
            .state = .ready,
            .max_head_len = in.buffer.len,
            .side = .response,
        };
        return c;
    }

    /// Closes the connection and frees it. With `graceful`, a TLS
    /// connection first sends close_notify.
    pub fn close(c: *Connection, gpa: Allocator, graceful: bool) void {
        if (c.handshaken and graceful) c.tls_conn.close() catch {};
        c.stream.close(c.io);
        gpa.destroy(c);
    }

    /// The cleartext reader: the TLS reader or the TCP reader.
    pub fn reader(c: *Connection) *Io.Reader {
        return if (c.secure) &c.tls_reader.interface else &c.tcp_reader.interface;
    }

    /// The cleartext writer: the TLS writer or the TCP writer.
    pub fn writer(c: *Connection) *Io.Writer {
        return if (c.secure) &c.tls_writer.interface else &c.tcp_writer.interface;
    }

    /// Describes why the last read or write failed, from the TCP stream's
    /// recorded error, then the TLS layer's. Null when neither recorded one.
    pub fn lastFailure(c: *Connection) ?Failure {
        if (c.tcp_reader.err) |err| return classifyRead(err);
        if (c.tcp_writer.err) |err| return classifyWrite(err);
        if (c.handshaken) {
            if (c.tls_reader.err) |err| return .{ .kind = .fatal, .name = @errorName(err) };
            if (c.tls_writer.err) |err| return .{ .kind = .fatal, .name = @errorName(err) };
        }
        return null;
    }
};

fn connect(io: Io, endpoint: *const Endpoint) net.HostName.ConnectError!net.Stream {
    if (net.IpAddress.parse(endpoint.host, endpoint.port)) |address| {
        return address.connect(io, .{ .mode = .stream });
    } else |_| {}
    const host = net.HostName.init(endpoint.host) catch return error.UnknownHostName;
    return host.connect(io, endpoint.port, .{ .mode = .stream });
}

fn classifyConnect(err: net.HostName.ConnectError) Failure {
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

fn classifyRead(err: net.Stream.Reader.Error) Failure {
    return .{ .name = @errorName(err), .kind = switch (err) {
        error.Canceled => .canceled,
        error.ConnectionTimedOut => .temporary,
        error.ConnectionResetByPeer, error.SocketUnconnected => .closed,
        else => .fatal,
    } };
}

fn classifyWrite(err: net.Stream.Writer.Error) Failure {
    return .{ .name = @errorName(err), .kind = switch (err) {
        error.Canceled => .canceled,
        error.ConnectionTimedOut => .temporary,
        error.ConnectionResetByPeer, error.SocketUnconnected => .closed,
        else => .fatal,
    } };
}

const testing = std.testing;

test "Endpoint.parse splits scheme, host, port and target" {
    const e = try Endpoint.parse("http://localhost:4318/v1/traces");
    try testing.expect(!e.secure);
    try testing.expectEqualStrings("localhost", e.host);
    try testing.expectEqual(4318, e.port);
    try testing.expectEqualStrings("localhost:4318", e.authority);
    try testing.expectEqualStrings("/v1/traces", e.target);

    const s = try Endpoint.parse("HTTPS://collector.example/v1/logs?x=1#frag");
    try testing.expect(s.secure);
    try testing.expectEqual(443, s.port);
    try testing.expectEqualStrings("collector.example", s.authority);
    try testing.expectEqualStrings("/v1/logs?x=1", s.target);

    const v6 = try Endpoint.parse("http://[::1]:9000");
    try testing.expectEqualStrings("::1", v6.host);
    try testing.expectEqual(9000, v6.port);
    try testing.expectEqualStrings("[::1]:9000", v6.authority);
    try testing.expectEqualStrings("", v6.target);

    const ip = try Endpoint.parse("http://127.0.0.1:/x");
    try testing.expectEqualStrings("127.0.0.1", ip.host);
    try testing.expectEqual(80, ip.port);
}

test "Endpoint.parse rejects malformed URLs" {
    const bad = [_][]const u8{
        "localhost:4318",
        "ftp://host/",
        "http://",
        "http:///v1/traces",
        "http://user@host/",
        "http://host:0/",
        "http://host:70000/",
        "http://host:12a/",
        "http://host:+1/",
        "http://[::1/",
        "http://[::1]x/",
        "http://ho st/",
        "http://host/a b",
        "http://host/\r\nX: y",
    };
    for (bad) |url| {
        try testing.expectError(error.InvalidEndpoint, Endpoint.parse(url));
    }
}

test "writeRequest writes the head, the user headers and the body" {
    const e = try Endpoint.parse("http://localhost:4318?q=1");
    var buf: [1024]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    try writeRequest(&w, .{
        .endpoint = &e,
        .content_type = "application/x-protobuf",
        .gzip = true,
        .user_agent = "libo11y-zig/0.0.0",
        .headers = &.{
            .{ .name = "api-key", .value = "secret" },
            .{ .name = "Host", .value = "evil" },
            .{ .name = "content-encoding", .value = "br" },
            .{ .name = "content-length", .value = "1" },
        },
        .body = "abc",
    });
    try testing.expectEqualStrings("POST /?q=1 HTTP/1.1\r\n" ++
        "Host: localhost:4318\r\n" ++
        "User-Agent: libo11y-zig/0.0.0\r\n" ++
        "api-key: secret\r\n" ++
        "Content-Type: application/x-protobuf\r\n" ++
        "Content-Encoding: gzip\r\n" ++
        "Content-Length: 3\r\n\r\nabc", w.buffered());
}

test "writeRequest lets a user header replace the User-Agent" {
    const e = try Endpoint.parse("http://h/p");
    var buf: [512]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    try writeRequest(&w, .{
        .endpoint = &e,
        .content_type = "application/json",
        .gzip = false,
        .user_agent = "default",
        .headers = &.{.{ .name = "user-agent", .value = "mine" }},
        .body = "",
    });
    try testing.expectEqualStrings("POST /p HTTP/1.1\r\nHost: h\r\nUser-Agent: mine\r\n" ++
        "Content-Type: application/json\r\nContent-Length: 0\r\n\r\n", w.buffered());
}

fn testRead(bytes: []const u8) ReadError!Response {
    var in: Io.Reader = .fixed(bytes);
    var r: std.http.Reader = .{
        .in = &in,
        .interface = undefined,
        .state = .ready,
        .max_head_len = 4096,
        .side = .response,
    };
    var transfer: [64]u8 = undefined;
    return readResponse(&r, testing.allocator, .{ .max_body = 64, .now_seconds = 0, .transfer_buffer = &transfer });
}

test "readResponse reads content-length and chunked bodies" {
    {
        var resp = try testRead("HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 5\r\n\r\nhello");
        defer resp.deinit(testing.allocator);
        try testing.expectEqual(200, resp.status);
        try testing.expectEqualStrings("application/x-protobuf", resp.content_type);
        try testing.expect(resp.keep_alive);
        try testing.expectEqualStrings("hello", resp.body);
    }
    {
        var resp = try testRead("HTTP/1.1 100 Continue\r\n\r\n" ++
            "HTTP/1.1 503 Service Unavailable\r\nTransfer-Encoding: chunked\r\nRetry-After: 7\r\n\r\n" ++
            "3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n");
        defer resp.deinit(testing.allocator);
        try testing.expectEqual(503, resp.status);
        try testing.expectEqualStrings("abcde", resp.body);
        try testing.expectEqual(Io.Duration.fromSeconds(7), resp.retry_after.?);
    }
    {
        var resp = try testRead("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nuntil-eof");
        defer resp.deinit(testing.allocator);
        try testing.expect(!resp.keep_alive);
        try testing.expectEqualStrings("until-eof", resp.body);
    }
    {
        var resp = try testRead("HTTP/1.1 204 No Content\r\n\r\n");
        defer resp.deinit(testing.allocator);
        try testing.expectEqual(204, resp.status);
        try testing.expect(resp.keep_alive);
        try testing.expectEqual(0, resp.body.len);
    }
}

test "readResponse decodes a gzip body" {
    const zipped = try gzip(testing.allocator, "compressed reply");
    defer testing.allocator.free(zipped);
    const head = try std.fmt.allocPrint(testing.allocator, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {d}\r\n\r\n", .{zipped.len});
    defer testing.allocator.free(head);
    const bytes = try std.mem.concat(testing.allocator, u8, &.{ head, zipped });
    defer testing.allocator.free(bytes);
    var resp = try testRead(bytes);
    defer resp.deinit(testing.allocator);
    try testing.expectEqualStrings("compressed reply", resp.body);
}

test "readResponse reports closed, invalid and oversized responses" {
    try testing.expectError(error.ConnectionClosing, testRead(""));
    try testing.expectError(error.ReadFailed, testRead("HTTP/1.1 200 OK\r\n"));
    try testing.expectError(error.InvalidResponse, testRead("HTTP/1.1 2x0 OK\r\n\r\n"));
    try testing.expectError(error.InvalidResponse, testRead("garbage garbage\r\n\r\n"));
    try testing.expectError(error.InvalidResponse, testRead("HTTP/1.1 200 OK\r\nContent-Encoding: zstd\r\nContent-Length: 1\r\n\r\nx"));
    try testing.expectError(error.InvalidResponse, testRead("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n"));
    try testing.expectError(error.ResponseTooLarge, testRead("HTTP/1.1 200 OK\r\nContent-Length: 65\r\n\r\n" ++ @as([65]u8, @splat('x'))));
}

test "parseRetryAfter reads seconds and IMF-fixdate" {
    try testing.expectEqual(Io.Duration.fromSeconds(120), parseRetryAfter(" 120 ", 0).?);
    try testing.expectEqual(Io.Duration.fromSeconds(0), parseRetryAfter("0", 0).?);
    // 784111777 is Sun, 06 Nov 1994 08:49:37 GMT.
    try testing.expectEqual(Io.Duration.fromSeconds(10), parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", 784111767).?);
    try testing.expectEqual(Io.Duration.fromSeconds(0), parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", 784111800).?);
    try testing.expectEqual(null, parseRetryAfter("-5", 0));
    try testing.expectEqual(null, parseRetryAfter("soon", 0));
    try testing.expectEqual(null, parseRetryAfter("Sun, 06 Foo 1994 08:49:37 GMT", 0));
    try testing.expect(parseRetryAfter("99999999999999999999", 0) != null);
}

test "gzip and gunzip round-trip" {
    const data: []const u8 = &@as([1000]u8, @splat('q'));
    const zipped = try gzip(testing.allocator, data);
    defer testing.allocator.free(zipped);
    try testing.expect(zipped.len < data.len);
    const plain = try gunzip(testing.allocator, zipped, 1 << 20);
    defer testing.allocator.free(plain);
    try testing.expectEqualStrings(data, plain);
    try testing.expectError(error.InvalidData, gunzip(testing.allocator, "not gzip at all", 1 << 20));
}

test "validHeaderName and validHeaderValue" {
    try testing.expect(validHeaderName("x-api-key"));
    try testing.expect(!validHeaderName(""));
    try testing.expect(!validHeaderName("bad name"));
    try testing.expect(!validHeaderName("a:b"));
    try testing.expect(validHeaderValue("ok value"));
    try testing.expect(!validHeaderValue("a\r\nb"));
}
