//! The OTLP/gRPC transport over HTTP/2 (h2c or TLS with ALPN "h2").
//!
//! Implements unary gRPC calls (5-byte length-prefixed framing with optional
//! gzip compression, required gRPC HTTP/2 headers, `grpc-timeout`, trailers
//! and trailers-only responses, `grpc-status`, percent-decoded `grpc-message`,
//! and `google.rpc.RetryInfo` in `grpc-status-details-bin`).
//!
//! Retry policy matches Go's `otlptracegrpc` v1.47.0 and the OTLP spec:
//! - CANCELLED (1), DEADLINE_EXCEEDED (4), ABORTED (10), OUT_OF_RANGE (11),
//!   UNAVAILABLE (14) and DATA_LOSS (15) are retried with exponential backoff
//!   (initial 5s, multiplier 1.5, +-50% jitter, max 30s, max elapsed 60s),
//!   honouring any server-supplied throttle delay.
//! - RESOURCE_EXHAUSTED (8) is retried only when the server provides a
//!   throttle delay (`RetryInfo`, `grpc-retry-pushback-ms` >= 0 or
//!   `retry-after`).
//! - All other gRPC status codes fail immediately with `error.Rejected`.
//! - Each attempt is raced against the deadline via `io.concurrent` and
//!   canceled on timeout or `close`, matching `transport.zig`.

const std = @import("std");
const tls = @import("tls");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const deadline = @import("../deadline.zig");
const Deadline = deadline.Deadline;
const http = @import("http.zig");
const hpack = @import("hpack.zig");
const h2 = @import("h2.zig");
const transport = @import("transport.zig");

pub const Compression = transport.Compression;
pub const Header = transport.Header;
pub const TlsOptions = transport.TlsOptions;
pub const RetryOptions = transport.RetryOptions;
pub const InitError = transport.InitError;
pub const SendError = transport.SendError;

/// gRPC status codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html).
pub const StatusCode = enum(u32) {
    ok = 0,
    cancelled = 1,
    unknown = 2,
    invalid_argument = 3,
    deadline_exceeded = 4,
    not_found = 5,
    already_exists = 6,
    permission_denied = 7,
    resource_exhausted = 8,
    failed_precondition = 9,
    aborted = 10,
    out_of_range = 11,
    unimplemented = 12,
    internal = 13,
    unavailable = 14,
    data_loss = 15,
    unauthenticated = 16,
    _,

    /// Human-readable status code name.
    pub fn name(code: StatusCode) []const u8 {
        return switch (code) {
            .ok => "OK",
            .cancelled => "CANCELLED",
            .unknown => "UNKNOWN",
            .invalid_argument => "INVALID_ARGUMENT",
            .deadline_exceeded => "DEADLINE_EXCEEDED",
            .not_found => "NOT_FOUND",
            .already_exists => "ALREADY_EXISTS",
            .permission_denied => "PERMISSION_DENIED",
            .resource_exhausted => "RESOURCE_EXHAUSTED",
            .failed_precondition => "FAILED_PRECONDITION",
            .aborted => "ABORTED",
            .out_of_range => "OUT_OF_RANGE",
            .unimplemented => "UNIMPLEMENTED",
            .internal => "INTERNAL",
            .unavailable => "UNAVAILABLE",
            .data_loss => "DATA_LOSS",
            .unauthenticated => "UNAUTHENTICATED",
            _ => "UNKNOWN",
        };
    }

    /// Reports whether this status code is retryable per the OTLP spec and
    /// Go's `otlptracegrpc`. `RESOURCE_EXHAUSTED` requires a server throttle.
    pub fn isRetryable(code: StatusCode, has_throttle: bool) bool {
        return switch (code) {
            .cancelled,
            .deadline_exceeded,
            .aborted,
            .out_of_range,
            .unavailable,
            .data_loss,
            => true,
            .resource_exhausted => has_throttle,
            else => false,
        };
    }
};

/// Transport options for `grpc.Transport.create`. Every string is copied.
pub const Options = struct {
    /// Absolute `http://host:port` (h2c) or `https://host:port` (TLS ALPN h2).
    endpoint: []const u8,
    /// Full gRPC method path, e.g. `/opentelemetry.proto.collector.trace.v1.TraceService/Export`.
    method: []const u8,
    /// Extra request metadata headers (lowercased automatically for HTTP/2).
    headers: []const Header = &.{},
    /// gzip compresses each gRPC message payload.
    compression: Compression = .none,
    /// Bounds each call including retries, together with the caller's deadline.
    timeout: Io.Duration = .fromSeconds(10),
    /// Used only for `https://` endpoints.
    tls: TlsOptions = .{},
    retry: RetryOptions = .{},
};

/// A successful (`grpc-status: 0`) unary gRPC response.
pub const Response = struct {
    /// Unframed, decompressed protobuf response bytes.
    body: []u8,

    pub fn deinit(r: *Response, gpa: Allocator) void {
        gpa.free(r.body);
        r.* = undefined;
    }
};

/// Errors from gRPC 5-byte message framing/unframing.
pub const FrameError = error{
    InvalidFrame,
    ResponseTooLarge,
    UnsupportedEncoding,
    OutOfMemory,
};

/// Durations are clamped to this so deadline arithmetic cannot overflow.
const max_duration: Io.Duration = .fromSeconds(1000 * 365 * 24 * 3600);

/// Wraps `payload` in a 5-byte gRPC length-prefixed message frame, gzip-
/// compressing it first when `compression == .gzip`.
pub fn frameEncode(gpa: Allocator, payload: []const u8, compression: Compression) error{ OutOfMemory, PayloadTooLarge }![]u8 {
    const body: []const u8, const owned_zip: ?[]u8 = if (compression == .gzip) blk: {
        const z = try http.gzip(gpa, payload);
        break :blk .{ z, z };
    } else .{ payload, null };
    defer if (owned_zip) |z| gpa.free(z);

    if (body.len > std.math.maxInt(u32)) return error.PayloadTooLarge;
    const out = try gpa.alloc(u8, 5 + body.len);
    out[0] = if (compression == .gzip) 1 else 0;
    std.mem.writeInt(u32, out[1..5], @intCast(body.len), .big);
    @memcpy(out[5..], body);
    return out;
}

/// Decodes a single unary gRPC length-prefixed message from `raw`, gunzipping
/// when the compressed flag is 1 and enforcing `max_size`.
pub fn frameDecode(gpa: Allocator, raw: []const u8, encoding: ?[]const u8, max_size: usize) FrameError![]u8 {
    if (raw.len == 0) return try gpa.alloc(u8, 0);
    if (raw.len < 5) return error.InvalidFrame;
    const compressed = raw[0];
    if (compressed != 0 and compressed != 1) return error.InvalidFrame;
    const msg_len: usize = std.mem.readInt(u32, raw[1..5], .big);
    if (5 + msg_len != raw.len) return error.InvalidFrame;
    const msg = raw[5..];

    if (compressed == 0) {
        if (msg.len > max_size) return error.ResponseTooLarge;
        return try gpa.dupe(u8, msg);
    }

    if (encoding) |enc| {
        if (!std.ascii.eqlIgnoreCase(enc, "gzip")) return error.UnsupportedEncoding;
    }
    return http.gunzip(gpa, msg, max_size) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.InvalidData => error.InvalidFrame,
    };
}

/// Formats remaining time into a gRPC `grpc-timeout` header value (max 8
/// digits plus unit `n`, `u`, `m`, `S`, `M`, or `H`).
pub fn formatTimeout(buf: *[16]u8, rem: Io.Duration) []const u8 {
    const ns: i96 = @max(rem.nanoseconds, 1);
    const max_8: i96 = 99_999_999;
    if (ns <= max_8) return std.fmt.bufPrint(buf, "{d}n", .{ns}) catch "1n";
    const us = @divTrunc(ns, 1000);
    if (us <= max_8) return std.fmt.bufPrint(buf, "{d}u", .{us}) catch "1u";
    const ms = @divTrunc(ns, 1_000_000);
    if (ms <= max_8) return std.fmt.bufPrint(buf, "{d}m", .{ms}) catch "1m";
    const secs = @divTrunc(ns, 1_000_000_000);
    if (secs <= max_8) return std.fmt.bufPrint(buf, "{d}S", .{secs}) catch "1S";
    const mins = @divTrunc(secs, 60);
    if (mins <= max_8) return std.fmt.bufPrint(buf, "{d}M", .{mins}) catch "1M";
    const hours = @min(@divTrunc(secs, 3600), max_8);
    return std.fmt.bufPrint(buf, "{d}H", .{hours}) catch "1H";
}

/// Percent-decodes a `grpc-message` trailer value into `out`, returning the
/// written slice. Invalid `%` escapes are copied verbatim.
pub fn decodeGrpcMessage(out: []u8, encoded: []const u8) []const u8 {
    var dst: usize = 0;
    var i: usize = 0;
    while (i < encoded.len and dst < out.len) {
        if (encoded[i] == '%' and i + 2 < encoded.len) {
            const hi = std.fmt.charToDigit(encoded[i + 1], 16) catch null;
            const lo = std.fmt.charToDigit(encoded[i + 2], 16) catch null;
            if (hi != null and lo != null) {
                out[dst] = hi.? * 16 + lo.?;
                dst += 1;
                i += 3;
                continue;
            }
        }
        out[dst] = encoded[i];
        dst += 1;
        i += 1;
    }
    return out[0..dst];
}

/// Parses `google.rpc.RetryInfo.retry_delay` from a base64-encoded
/// `grpc-status-details-bin` header value (`google.rpc.Status` protobuf).
/// Returns null if absent or malformed.
pub fn parseRetryInfo(gpa: Allocator, b64_value: []const u8) ?Io.Duration {
    const trimmed = std.mem.trim(u8, b64_value, " \t");
    if (trimmed.len == 0 or trimmed.len > 64 * 1024) return null;

    // gRPC -bin headers use standard base64 without padding, though peers may
    // include '=' padding. Strip trailing '=' and decode with no_pad.
    const unpadded = std.mem.trimEnd(u8, trimmed, "=");
    const decoder = std.base64.standard_no_pad.Decoder;
    const dec_len = decoder.calcSizeForSlice(unpadded) catch return null;
    const bytes = gpa.alloc(u8, dec_len) catch return null;
    defer gpa.free(bytes);
    decoder.decode(bytes, unpadded) catch return null;

    return parseStatusProtoRetryDelay(bytes);
}

fn parseStatusProtoRetryDelay(status_bytes: []const u8) ?Io.Duration {
    var pos: usize = 0;
    while (pos < status_bytes.len) {
        const tag = readVarint(status_bytes, &pos) orelse return null;
        const field_num = tag >> 3;
        const wire_type: u3 = @truncate(tag);
        if (field_num == 3 and wire_type == 2) {
            const any_bytes = readBytes(status_bytes, &pos) orelse return null;
            if (parseAnyRetryInfo(any_bytes)) |d| return d;
        } else {
            skipWireField(status_bytes, &pos, wire_type) orelse return null;
        }
    }
    return null;
}

fn parseAnyRetryInfo(any_bytes: []const u8) ?Io.Duration {
    var pos: usize = 0;
    var type_url: []const u8 = "";
    var value: []const u8 = "";
    while (pos < any_bytes.len) {
        const tag = readVarint(any_bytes, &pos) orelse return null;
        const field_num = tag >> 3;
        const wire_type: u3 = @truncate(tag);
        if (field_num == 1 and wire_type == 2) {
            type_url = readBytes(any_bytes, &pos) orelse return null;
        } else if (field_num == 2 and wire_type == 2) {
            value = readBytes(any_bytes, &pos) orelse return null;
        } else {
            skipWireField(any_bytes, &pos, wire_type) orelse return null;
        }
    }
    if (!std.mem.eql(u8, type_url, "type.googleapis.com/google.rpc.RetryInfo")) return null;

    var rpos: usize = 0;
    while (rpos < value.len) {
        const tag = readVarint(value, &rpos) orelse return null;
        const field_num = tag >> 3;
        const wire_type: u3 = @truncate(tag);
        if (field_num == 1 and wire_type == 2) {
            const dur_bytes = readBytes(value, &rpos) orelse return null;
            return parseProtoDuration(dur_bytes);
        } else {
            skipWireField(value, &rpos, wire_type) orelse return null;
        }
    }
    return null;
}

fn parseProtoDuration(dur_bytes: []const u8) ?Io.Duration {
    var pos: usize = 0;
    var seconds: i64 = 0;
    var nanos: i64 = 0;
    while (pos < dur_bytes.len) {
        const tag = readVarint(dur_bytes, &pos) orelse return null;
        const field_num = tag >> 3;
        const wire_type: u3 = @truncate(tag);
        if (field_num == 1 and wire_type == 0) {
            seconds = @bitCast(readVarint(dur_bytes, &pos) orelse return null);
        } else if (field_num == 2 and wire_type == 0) {
            nanos = @bitCast(readVarint(dur_bytes, &pos) orelse return null);
        } else {
            skipWireField(dur_bytes, &pos, wire_type) orelse return null;
        }
    }
    if (seconds < 0 or nanos < 0) return .zero;
    const max_secs = @divTrunc(max_duration.nanoseconds, std.time.ns_per_s);
    if (seconds >= max_secs) return max_duration;
    const total = seconds * std.time.ns_per_s + @min(nanos, std.time.ns_per_s - 1);
    return clamp(.fromNanoseconds(total));
}

fn readVarint(buf: []const u8, pos: *usize) ?u64 {
    var result: u64 = 0;
    var shift: u7 = 0;
    while (pos.* < buf.len) {
        const b = buf[pos.*];
        pos.* += 1;
        if (shift >= 64) return null;
        result |= @as(u64, b & 0x7f) << @intCast(shift);
        if ((b & 0x80) == 0) return result;
        shift += 7;
    }
    return null;
}

fn readBytes(buf: []const u8, pos: *usize) ?[]const u8 {
    const len_u64 = readVarint(buf, pos) orelse return null;
    if (len_u64 > buf.len - pos.*) return null;
    const len: usize = @intCast(len_u64);
    const slice = buf[pos.* .. pos.* + len];
    pos.* += len;
    return slice;
}

fn skipWireField(buf: []const u8, pos: *usize, wire_type: u3) ?void {
    switch (wire_type) {
        0 => _ = readVarint(buf, pos) orelse return null,
        1 => {
            if (pos.* + 8 > buf.len) return null;
            pos.* += 8;
        },
        2 => _ = readBytes(buf, pos) orelse return null,
        5 => {
            if (pos.* + 4 > buf.len) return null;
            pos.* += 4;
        },
        else => return null,
    }
}

/// Maps an HTTP status code to a gRPC status code per the gRPC over HTTP/2
/// specification when `grpc-status` is absent.
pub fn httpStatusToGrpc(http_status: u16) StatusCode {
    return switch (http_status) {
        400 => .internal,
        401 => .unauthenticated,
        403 => .permission_denied,
        404 => .unimplemented,
        429, 502, 503, 504 => .unavailable,
        else => .unknown,
    };
}

/// Maps an HTTP/2 RST_STREAM error code to a gRPC status code per the gRPC
/// over HTTP/2 specification.
fn rstErrorToGrpc(code: u32) StatusCode {
    return switch (@as(h2.ErrorCode, @fromBackingInt(@intCast(code)))) {
        .no_error,
        .protocol_error,
        .internal_error,
        .flow_control_error,
        .settings_timeout,
        .frame_size_error,
        .compression_error,
        .connect_error,
        => .internal,
        .refused_stream => .unavailable,
        .cancel => .cancelled,
        .enhance_your_calm => .resource_exhausted,
        .inadequate_security => .permission_denied,
        else => .unknown,
    };
}

/// An OTLP/gRPC transport over one lazily dialed, reused HTTP/2 connection.
pub const Transport = struct {
    gpa: Allocator,
    io: Io,
    url: []u8,
    endpoint: http.Endpoint,
    method: []u8,
    headers: []Header,
    user_agent_val: []u8,
    compression: Compression,
    timeout: Io.Duration,
    retry: RetryOptions,
    tls_config: ?*http.TlsConfig,

    mutex: Io.Mutex = .init,
    cond: Io.Condition = .init,
    busy: bool = false,
    closed: bool = false,
    waiter: ?*Io.Event = null,
    conn: ?*h2.Connection = null,
    err_buf: [512]u8 = undefined,
    err_len: usize = 0,

    /// Validates options, copies strings and loads TLS files now, dialing
    /// lazily on the first `send`.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*Transport {
        const t = try gpa.create(Transport);
        errdefer gpa.destroy(t);

        const url = try gpa.dupe(u8, options.endpoint);
        errdefer gpa.free(url);
        const endpoint = http.Endpoint.parse(url) catch return error.InvalidEndpoint;

        if (options.method.len == 0 or options.method[0] != '/' or !hpack.validHeaderValue(options.method)) {
            return error.InvalidEndpoint;
        }
        const method = try gpa.dupe(u8, options.method);
        errdefer gpa.free(method);

        var ua_override: ?[]const u8 = null;
        for (options.headers) |h| {
            if (!http.validHeaderName(h.name) or !http.validHeaderValue(h.value)) return error.InvalidHeader;
            if (std.ascii.eqlIgnoreCase(h.name, "user-agent")) ua_override = h.value;
        }
        const user_agent_val = try gpa.dupe(u8, ua_override orelse transport.user_agent);
        errdefer gpa.free(user_agent_val);

        const headers = try dupeLowerHeaders(gpa, options.headers);
        errdefer freeHeaders(gpa, headers);

        const o = options.tls;
        if ((o.client_cert_file == null) != (o.client_key_file == null)) return error.TlsConfig;
        const any_file = o.ca_file != null or o.client_cert_file != null;
        if (!endpoint.secure and any_file) return error.TlsConfig;
        const tls_config = if (endpoint.secure) try loadTls(gpa, io, o) else null;

        t.* = .{
            .gpa = gpa,
            .io = io,
            .url = url,
            .endpoint = endpoint,
            .method = method,
            .headers = headers,
            .user_agent_val = user_agent_val,
            .compression = options.compression,
            .timeout = clamp(options.timeout),
            .retry = .{
                .enabled = options.retry.enabled,
                .initial_interval = clamp(options.retry.initial_interval),
                .max_interval = clamp(options.retry.max_interval),
                .max_elapsed = clamp(options.retry.max_elapsed),
            },
            .tls_config = tls_config,
        };
        return t;
    }

    /// Closes the transport and frees all resources.
    pub fn destroy(t: *Transport) void {
        t.close();
        const gpa = t.gpa;
        if (t.tls_config) |cfg| freeTls(gpa, cfg);
        freeHeaders(gpa, t.headers);
        gpa.free(t.user_agent_val);
        gpa.free(t.method);
        gpa.free(t.url);
        gpa.destroy(t);
    }

    /// Sends one unary gRPC request with protobuf `payload` (uncompressed; the
    /// transport gzips and frames it), retrying per OTLP/gRPC rules inside
    /// `min(now + options.timeout, until)`.
    pub fn send(t: *Transport, payload: []const u8, until: Deadline) SendError!Response {
        const limit = deadline.earliest(until, deadline.after(t.io, t.timeout));
        try t.acquire(limit);
        defer t.release();
        t.err_len = 0;

        if (payload.len > transport.max_request_size) {
            t.setError("request message too large: exceeded {d} bytes", .{transport.max_request_size});
            return error.Rejected;
        }
        const framed = frameEncode(t.gpa, payload, t.compression) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.PayloadTooLarge => {
                t.setError("request message too large: exceeded {d} bytes", .{transport.max_request_size});
                return error.Rejected;
            },
        };
        defer t.gpa.free(framed);
        return t.exchange(framed, limit);
    }

    /// Closes the connection and interrupts any in-flight call. Idempotent.
    pub fn close(t: *Transport) void {
        t.mutex.lockUncancelable(t.io);
        defer t.mutex.unlock(t.io);
        t.closed = true;
        if (t.waiter) |w| w.set(t.io);
        while (t.busy) t.cond.waitUncancelable(t.io, &t.mutex);
        t.dropConn(true);
    }

    /// Human-readable description of the most recent failure.
    pub fn lastError(t: *Transport) []const u8 {
        return t.err_buf[0..t.err_len];
    }

    fn acquire(t: *Transport, limit: Deadline) SendError!void {
        t.mutex.lock(t.io) catch return error.Canceled;
        defer t.mutex.unlock(t.io);
        while (true) {
            if (t.closed) return error.Shutdown;
            if (!t.busy) {
                t.busy = true;
                return;
            }
            t.cond.waitTimeout(t.io, &t.mutex, deadline.timeout(limit)) catch |err| return switch (err) {
                error.Timeout => error.Timeout,
                error.Canceled => error.Canceled,
            };
        }
    }

    fn release(t: *Transport) void {
        t.mutex.lockUncancelable(t.io);
        defer t.mutex.unlock(t.io);
        t.busy = false;
        t.cond.broadcast(t.io);
    }

    fn register(t: *Transport, event: *Io.Event) bool {
        t.mutex.lockUncancelable(t.io);
        defer t.mutex.unlock(t.io);
        if (t.closed) return false;
        t.waiter = event;
        return true;
    }

    fn unregister(t: *Transport) void {
        t.mutex.lockUncancelable(t.io);
        defer t.mutex.unlock(t.io);
        t.waiter = null;
    }

    fn exchange(t: *Transport, framed: []const u8, limit: Deadline) SendError!Response {
        const start = Io.Clock.Timestamp.now(t.io, deadline.clock);
        var interval = t.retry.initial_interval;
        while (true) {
            const failed: struct { err: SendError, throttle: Io.Duration } = switch (t.runAttempt(framed, limit)) {
                .ok => |resp| return resp,
                .shutdown => return error.Shutdown,
                .canceled => return error.Canceled,
                .oom => return error.OutOfMemory,
                .rejected => return error.Rejected,
                .timeout => {
                    t.setError("deadline exceeded while sending to {s}{s}", .{ t.url, t.method });
                    return error.Timeout;
                },
                .status => |s| if (s.retryable)
                    .{ .err = error.Rejected, .throttle = s.throttle }
                else
                    return error.Rejected,
                .failure => |retryable| if (retryable)
                    .{ .err = error.Unreachable, .throttle = .zero }
                else
                    return error.Unreachable,
            };
            if (!t.retry.enabled) return failed.err;

            const max_elapsed = t.retry.max_elapsed.nanoseconds;
            const elapsed = start.untilNow(t.io).raw.nanoseconds;
            if (max_elapsed != 0 and elapsed > max_elapsed) return failed.err;
            const backoff = t.nextBackoff(&interval);
            const delay: Io.Duration = .fromNanoseconds(@max(failed.throttle.nanoseconds, backoff.nanoseconds));
            if (max_elapsed != 0 and elapsed + failed.throttle.nanoseconds > max_elapsed) return failed.err;

            const wake = deadline.after(t.io, delay);
            if (wake.compare(.gt, limit)) {
                t.prefixError("deadline exceeded before the next retry; last failure: ");
                return error.Timeout;
            }
            try t.sleepUntil(wake);
        }
    }

    fn nextBackoff(t: *Transport, interval: *Io.Duration) Io.Duration {
        const current: f64 = @floatFromInt(interval.nanoseconds);
        const max: f64 = @floatFromInt(t.retry.max_interval.nanoseconds);
        var bytes: [8]u8 = undefined;
        t.io.random(&bytes);
        const random = @as(f64, @floatFromInt(std.mem.readInt(u64, &bytes, .little) >> 11)) / @as(f64, 1 << 53);
        const delta = 0.5 * current;
        const low = current - delta;
        const high = current + delta;
        const next = low + random * (high - low + 1);
        interval.* = if (current >= max / 1.5) t.retry.max_interval else .fromNanoseconds(@intFromFloat(current * 1.5));
        return .fromNanoseconds(@intFromFloat(@min(next, @as(f64, @floatFromInt(max_duration.nanoseconds)))));
    }

    fn sleepUntil(t: *Transport, wake: Deadline) SendError!void {
        var event: Io.Event = .unset;
        if (!t.register(&event)) return error.Shutdown;
        defer t.unregister();
        event.waitTimeout(t.io, deadline.timeout(wake)) catch |err| return switch (err) {
            error.Timeout => {},
            error.Canceled => error.Canceled,
        };
        return error.Shutdown;
    }

    const Outcome = union(enum) {
        ok: Response,
        status: struct { retryable: bool, throttle: Io.Duration },
        failure: bool,
        rejected,
        timeout,
        shutdown,
        canceled,
        oom,
    };

    const Attempt = struct {
        t: *Transport,
        framed: []const u8,
        limit: Deadline,
        done: Io.Event = .unset,
        finished: std.atomic.Value(bool) = .init(false),

        fn run(a: *Attempt) Outcome {
            const outcome = a.t.attemptOnce(a.framed, a.limit);
            a.finished.store(true, .release);
            a.done.set(a.t.io);
            return outcome;
        }
    };

    fn runAttempt(t: *Transport, framed: []const u8, limit: Deadline) Outcome {
        var attempt: Attempt = .{ .t = t, .framed = framed, .limit = limit };
        if (!t.register(&attempt.done)) return .shutdown;
        defer t.unregister();
        var future = t.io.concurrent(Attempt.run, .{&attempt}) catch |err| switch (err) {
            error.ConcurrencyUnavailable => return t.attemptOnce(framed, limit),
        };
        const waited = attempt.done.waitTimeout(t.io, deadline.timeout(limit));
        if (attempt.finished.load(.acquire)) return future.await(t.io);
        const outcome = future.cancel(t.io);
        switch (outcome) {
            .ok => return outcome,
            else => {},
        }
        if (waited) |_| {
            return .shutdown;
        } else |err| return switch (err) {
            error.Timeout => .timeout,
            error.Canceled => .canceled,
        };
    }

    fn attemptOnce(t: *Transport, framed: []const u8, limit: Deadline) Outcome {
        var may_redial = true;
        while (true) {
            const c = t.conn orelse c: {
                var failure: http.Failure = undefined;
                const opened = h2.Connection.open(t.gpa, t.io, &t.endpoint, t.tls_config, &failure) catch |err| switch (err) {
                    error.Canceled => return .canceled,
                    error.OutOfMemory => return .oom,
                    error.ConnectFailed => {
                        t.setError("failed to connect to {s}: {s}", .{ t.url, failure.name });
                        return .{ .failure = failure.kind == .temporary };
                    },
                    error.HandshakeFailed => {
                        t.setError("TLS handshake with {s} failed: {s}", .{ t.url, failure.name });
                        return .{ .failure = failure.kind == .temporary };
                    },
                };
                t.conn = opened;
                break :c opened;
            };
            const reused = c.reused;

            // Build required gRPC HTTP/2 request headers.
            var timeout_buf: [16]u8 = undefined;
            const timeout_val = formatTimeout(&timeout_buf, deadline.remaining(t.io, limit));

            var req_headers: std.ArrayList(hpack.Header) = .empty;
            defer req_headers.deinit(t.gpa);
            req_headers.ensureTotalCapacity(t.gpa, 10 + t.headers.len) catch return .oom;
            req_headers.appendAssumeCapacity(.{ .name = ":method", .value = "POST" });
            req_headers.appendAssumeCapacity(.{ .name = ":scheme", .value = if (t.endpoint.secure) "https" else "http" });
            req_headers.appendAssumeCapacity(.{ .name = ":path", .value = t.method });
            req_headers.appendAssumeCapacity(.{ .name = ":authority", .value = t.endpoint.authority });
            req_headers.appendAssumeCapacity(.{ .name = "content-type", .value = "application/grpc" });
            req_headers.appendAssumeCapacity(.{ .name = "te", .value = "trailers" });
            req_headers.appendAssumeCapacity(.{ .name = "user-agent", .value = t.user_agent_val });
            if (t.compression == .gzip) {
                req_headers.appendAssumeCapacity(.{ .name = "grpc-encoding", .value = "gzip" });
            }
            req_headers.appendAssumeCapacity(.{ .name = "grpc-accept-encoding", .value = "gzip,identity" });
            req_headers.appendAssumeCapacity(.{ .name = "grpc-timeout", .value = timeout_val });
            for (t.headers) |h| {
                req_headers.appendAssumeCapacity(.{ .name = h.name, .value = h.value });
            }

            var resp = c.roundTrip(t.gpa, req_headers.items, framed, transport.max_response_size) catch |err| {
                const f = c.lastFailure();
                const rst_code = c.last_rst_error_code;
                const goaway_code = c.goaway_error_code;
                if (f) |x| if (x.kind == .canceled) {
                    t.dropConn(false);
                    return .canceled;
                };
                switch (err) {
                    error.OutOfMemory => {
                        t.dropConn(false);
                        return .oom;
                    },
                    error.StreamRefused => {
                        // Peer sent GOAWAY with last_stream_id < stream_id: safe to redial.
                        t.dropConn(false);
                        if (may_redial) {
                            may_redial = false;
                            continue;
                        }
                        t.setError("peer {s} refused stream with GOAWAY ({s})", .{ t.url, h2.ErrorCode.name(goaway_code) });
                        return .{ .status = .{ .retryable = true, .throttle = .zero } };
                    },
                    error.StreamReset => {
                        t.dropConn(false);
                        if (rst_code == @backingInt(h2.ErrorCode.refused_stream) and may_redial) {
                            may_redial = false;
                            continue;
                        }
                        const grpc_code = rstErrorToGrpc(rst_code);
                        t.setError("stream reset by {s}: {s} (gRPC {s})", .{ t.url, h2.ErrorCode.name(rst_code), grpc_code.name() });
                        return .{ .status = .{ .retryable = grpc_code.isRetryable(false), .throttle = .zero } };
                    },
                    error.ConnectionClosing => {
                        t.dropConn(false);
                        if (reused and may_redial) {
                            may_redial = false;
                            continue;
                        }
                        t.setError("{s} closed the connection without a response", .{t.url});
                        return .{ .failure = false };
                    },
                    error.ResponseTooLarge => {
                        t.dropConn(false);
                        t.setError("response body from {s} too large: exceeded {d} bytes", .{ t.url, transport.max_response_size });
                        return .rejected;
                    },
                    error.ProtocolError, error.CompressionError => {
                        t.dropConn(false);
                        t.setError("HTTP/2 protocol error from {s}: {s}", .{ t.url, @errorName(err) });
                        return .{ .failure = false };
                    },
                    error.InvalidHeader => {
                        t.setError("invalid HTTP/2 request header for {s}", .{t.url});
                        return .rejected;
                    },
                    error.ReadFailed, error.WriteFailed => {
                        t.dropConn(false);
                        const x = f orelse {
                            t.setError("failed to communicate with {s}: {s}", .{ t.url, @errorName(err) });
                            return .{ .failure = false };
                        };
                        if (x.kind == .closed and reused and may_redial) {
                            may_redial = false;
                            continue;
                        }
                        t.setError("failed to communicate with {s}: {s}", .{ t.url, x.name });
                        return .{ .failure = x.kind == .temporary };
                    },
                }
            };
            defer resp.deinit(t.gpa);

            // If peer sent GOAWAY during this stream, close so next send dials fresh.
            if (!c.usable()) t.dropConn(true);

            return t.interpretResponse(&resp);
        }
    }

    fn interpretResponse(t: *Transport, resp: *const h2.Response) Outcome {
        const now_seconds = Io.Clock.real.now(t.io).toSeconds();

        // Determine gRPC status code.
        const grpc_status: StatusCode = blk: {
            if (resp.trailer("grpc-status")) |raw| {
                const trimmed = std.mem.trim(u8, raw, " \t");
                const num = std.fmt.parseInt(u32, trimmed, 10) catch {
                    t.setError("invalid grpc-status header from {s}: {s}", .{ t.url, trimmed });
                    return .{ .failure = false };
                };
                break :blk @fromBackingInt(@intCast(num));
            }
            if (resp.status != 200) {
                break :blk httpStatusToGrpc(resp.status);
            }
            t.setError("missing grpc-status trailer from {s}", .{t.url});
            return .{ .failure = false };
        };

        if (grpc_status == .ok) {
            if (resp.status != 200) {
                t.setError("unexpected HTTP {d} with grpc-status OK from {s}", .{ resp.status, t.url });
                return .rejected;
            }
            const decoded = frameDecode(t.gpa, resp.body, resp.header("grpc-encoding"), transport.max_response_size) catch |err| switch (err) {
                error.OutOfMemory => return .oom,
                error.ResponseTooLarge => {
                    t.setError("gRPC response from {s} too large: exceeded {d} bytes", .{ t.url, transport.max_response_size });
                    return .rejected;
                },
                error.InvalidFrame, error.UnsupportedEncoding => {
                    t.setError("invalid gRPC response frame from {s}: {s}", .{ t.url, @errorName(err) });
                    return .{ .failure = false };
                },
            };
            return .{ .ok = .{ .body = decoded } };
        }

        // Non-OK gRPC status: extract message and optional throttle delay.
        var msg_buf: [256]u8 = undefined;
        const msg = if (resp.trailer("grpc-message")) |raw_msg|
            decodeGrpcMessage(&msg_buf, raw_msg)
        else
            "";
        if (msg.len > 0) {
            t.setError("gRPC export to {s}{s} failed: {s} ({d}): {s}", .{
                t.url,
                t.method,
                grpc_status.name(),
                @backingInt(grpc_status),
                msg,
            });
        } else {
            t.setError("gRPC export to {s}{s} failed: {s} ({d})", .{
                t.url,
                t.method,
                grpc_status.name(),
                @backingInt(grpc_status),
            });
        }

        var pushback_forbids_retry = false;
        var throttle: ?Io.Duration = null;

        if (resp.trailer("grpc-status-details-bin")) |details_b64| {
            if (parseRetryInfo(t.gpa, details_b64)) |d| throttle = d;
        }
        if (resp.trailer("grpc-retry-pushback-ms")) |pb| {
            const trimmed = std.mem.trim(u8, pb, " \t");
            if (std.fmt.parseInt(i64, trimmed, 10)) |ms| {
                if (ms < 0) {
                    pushback_forbids_retry = true;
                } else {
                    const pb_dur = clamp(.fromMilliseconds(ms));
                    throttle = if (throttle) |cur|
                        .fromNanoseconds(@max(cur.nanoseconds, pb_dur.nanoseconds))
                    else
                        pb_dur;
                }
            } else |_| {}
        }
        if (throttle == null) {
            if (resp.trailer("retry-after") orelse resp.header("retry-after")) |ra| {
                throttle = http.parseRetryAfter(ra, now_seconds);
            }
        }

        const retryable = !pushback_forbids_retry and grpc_status.isRetryable(throttle != null);
        return .{ .status = .{
            .retryable = retryable,
            .throttle = clamp(throttle orelse .zero),
        } };
    }

    fn dropConn(t: *Transport, graceful: bool) void {
        if (t.conn) |c| {
            c.close(t.gpa, graceful);
            t.conn = null;
        }
    }

    fn setError(t: *Transport, comptime fmt: []const u8, args: anytype) void {
        var w: Io.Writer = .fixed(&t.err_buf);
        w.print(fmt, args) catch {};
        t.err_len = w.end;
    }

    fn prefixError(t: *Transport, prefix: []const u8) void {
        var previous: [512]u8 = undefined;
        const old = previous[0..t.err_len];
        @memcpy(old, t.err_buf[0..t.err_len]);
        t.setError("{s}{s}", .{ prefix, old });
    }
};

fn clamp(d: Io.Duration) Io.Duration {
    return .fromNanoseconds(std.math.clamp(d.nanoseconds, 0, max_duration.nanoseconds));
}

fn isReservedHeader(name: []const u8) bool {
    const reserved = [_][]const u8{
        "host",
        "content-type",
        "content-length",
        "transfer-encoding",
        "connection",
        "te",
        "user-agent",
        "grpc-encoding",
        "grpc-accept-encoding",
        "grpc-timeout",
    };
    for (reserved) |r| if (std.ascii.eqlIgnoreCase(name, r)) return true;
    return false;
}

fn dupeLowerHeaders(gpa: Allocator, headers: []const Header) Allocator.Error![]Header {
    var list: std.ArrayList(Header) = .empty;
    errdefer {
        for (list.items) |h| {
            gpa.free(h.name);
            gpa.free(h.value);
        }
        list.deinit(gpa);
    }
    for (headers) |h| {
        if (isReservedHeader(h.name)) continue;
        const lower = try gpa.alloc(u8, h.name.len);
        errdefer gpa.free(lower);
        for (h.name, lower) |ch, *dst| dst.* = std.ascii.toLower(ch);
        const val = try gpa.dupe(u8, h.value);
        errdefer gpa.free(val);
        try list.append(gpa, .{ .name = lower, .value = val });
    }
    return list.toOwnedSlice(gpa);
}

fn freeHeaders(gpa: Allocator, headers: []Header) void {
    for (headers) |h| {
        gpa.free(h.name);
        gpa.free(h.value);
    }
    gpa.free(headers);
}

fn loadTls(gpa: Allocator, io: Io, o: TlsOptions) InitError!*http.TlsConfig {
    const cfg = try gpa.create(http.TlsConfig);
    errdefer gpa.destroy(cfg);
    var bundle: tls.config.cert.Bundle = .empty;
    errdefer bundle.deinit(gpa);
    const now = Io.Clock.real.now(io);
    if (o.ca_file) |path| {
        bundle.addCertsFromFilePath(gpa, io, now, Io.Dir.cwd(), path) catch return error.TlsConfig;
        if (bundle.map.count() == 0) return error.TlsConfig;
    } else {
        bundle.rescan(gpa, io, now) catch return error.TlsConfig;
    }
    var auth: ?*tls.config.CertKeyPair = null;
    if (o.client_cert_file) |cert| if (o.client_key_file) |key| {
        const pair = try gpa.create(tls.config.CertKeyPair);
        errdefer gpa.destroy(pair);
        pair.* = tls.config.CertKeyPair.fromFilePath(gpa, io, Io.Dir.cwd(), cert, key) catch return error.TlsConfig;
        auth = pair;
    };
    cfg.* = .{ .root_ca = bundle, .auth = auth };
    return cfg;
}

fn freeTls(gpa: Allocator, cfg: *http.TlsConfig) void {
    cfg.root_ca.deinit(gpa);
    if (cfg.auth) |pair| {
        pair.deinit(gpa);
        gpa.destroy(pair);
    }
    gpa.destroy(cfg);
}

test {
    _ = @import("grpc_test.zig");
}
