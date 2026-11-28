//! The OTLP/HTTP transport: one persistent HTTP/1.1 connection per
//! exporter, with TLS, gzip and Go's retry policy.
//!
//! It ports otlptracehttp v1.47.0 (`client.go`, `internal/retry`):
//! - 429, 502, 503 and 504 are retried, and `Retry-After` is a throttle
//!   that the next wait honours. Any other non-2xx status fails at once.
//! - Transport errors are retried only when Go's `Temporary()` would say
//!   so: timeouts and file descriptor limits. A refused connection, an
//!   unknown host or a TLS failure fails at once.
//! - The backoff starts at `initial_interval`, grows by 1.5 up to
//!   `max_interval`, and is randomized by plus or minus half. The wait is
//!   the larger of the backoff and the throttle. Retrying stops once
//!   `max_elapsed` has passed, or when the elapsed time plus the throttle
//!   would pass it, with the last failure.
//! - `options.timeout` and the caller's deadline bound the whole send,
//!   retries included. When the next wait would end after that bound, the
//!   send gives up at once with `error.Timeout`, where Go would wait for
//!   its context to expire and then report the deadline.
//!
//! Connections are reused (HTTP/1.1 keep-alive) and dialed lazily. A
//! reused connection that turns out to be closed before any byte of the
//! response arrives is redialed once and the request resent, without
//! counting as a retry, as Go's transport does for a stale idle
//! connection. A connection that failed, timed out or was canceled is
//! closed, and the next attempt dials a new one.
//!
//! Deadlines: socket reads cannot time out, so each attempt runs as an
//! `io.concurrent` task while the caller waits on an event with the
//! deadline. When the deadline passes, the caller cancels the attempt
//! and waits for it to end, so nothing runs after `send` returns. When
//! the Io has no concurrency left (`error.ConcurrencyUnavailable`), the
//! attempt does not run, because an inline read could outlive the
//! deadline. It counts as a retryable failure, so the retry loop tries
//! again until the deadline.

const std = @import("std");
const tls = @import("tls");
const build_options = @import("build_options");
const http = @import("o11y_wire").http;
const deadline = @import("../deadline.zig");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Deadline = deadline.Deadline;

/// The request body compression.
pub const Compression = enum { none, gzip };

/// One request header.
pub const Header = http.Header;

/// TLS settings for https endpoints.
pub const TlsOptions = struct {
    /// PEM file of CA certificates that verify the server. Null uses the system roots.
    ca_file: ?[]const u8 = null,
    /// PEM client certificate and key for mutual TLS. Both or neither.
    client_cert_file: ?[]const u8 = null,
    client_key_file: ?[]const u8 = null,
};

/// Exponential backoff settings, with Go's defaults.
pub const RetryOptions = struct {
    /// False sends each request once.
    enabled: bool = true,
    /// The first backoff, before randomization.
    initial_interval: Io.Duration = .fromSeconds(5),
    /// The cap on the backoff, before randomization.
    max_interval: Io.Duration = .fromSeconds(30),
    /// Zero means no limit other than the send's deadline.
    max_elapsed: Io.Duration = .fromSeconds(60),
};

/// Transport options. `create` copies every string.
pub const Options = struct {
    /// Absolute http:// or https:// URL including the signal path, e.g. http://localhost:4318/v1/traces.
    endpoint: []const u8,
    /// Request Content-Type, e.g. application/x-protobuf or application/json.
    content_type: []const u8,
    /// Extra request headers, such as authentication.
    headers: []const Header = &.{},
    /// gzip compresses each request body.
    compression: Compression = .none,
    /// Bounds each send including its retries, together with the caller's deadline.
    timeout: Io.Duration = .fromSeconds(10),
    /// Used only for https:// endpoints.
    tls: TlsOptions = .{},
    retry: RetryOptions = .{},
};

/// Errors from `Transport.create`. InvalidHeader is a header name that is
/// not an HTTP token, or a header value or content type with CR, LF or NUL.
/// TlsConfig also covers TLS files given for an http:// endpoint, which Go
/// rejects in the same way.
pub const InitError = error{ InvalidEndpoint, InvalidHeader, TlsConfig, OutOfMemory };

/// Errors from `Transport.send`. Rejected is a non-retryable HTTP status,
/// retries exhausted on a retryable status, or a request or response body
/// over the size limit. Unreachable is a connection or TLS failure, or an
/// invalid HTTP response.
pub const SendError = error{ Timeout, Rejected, Unreachable, Shutdown, Canceled, OutOfMemory };

/// A 2xx response.
pub const Response = struct {
    status: u16,
    /// The response Content-Type, empty when absent, owned like the body.
    content_type: []u8,
    /// The response body (decoded from chunked or content-length), owned by the transport's allocator.
    body: []u8,

    /// Frees the body and the content type.
    pub fn deinit(r: *Response, gpa: Allocator) void {
        gpa.free(r.content_type);
        gpa.free(r.body);
        r.* = undefined;
    }
};

/// The User-Agent header value.
pub const user_agent = "libo11y-zig/" ++ build_options.version;

/// The largest uncompressed request body, as in Go.
pub const max_request_size: usize = 64 * 1024 * 1024;

/// The largest response body, as in Go.
pub const max_response_size: usize = 4 * 1024 * 1024;

/// Durations are clamped to this so deadline arithmetic cannot overflow.
const max_duration: Io.Duration = .fromSeconds(1000 * 365 * 24 * 3600);

/// An OTLP/HTTP transport. Create it with `create` and free it with
/// `destroy`.
pub const Transport = struct {
    gpa: Allocator,
    io: Io,
    url: []u8,
    endpoint: http.Endpoint,
    content_type: []u8,
    headers: []Header,
    compression: Compression,
    timeout: Io.Duration,
    retry: RetryOptions,
    tls_config: ?*http.TlsConfig,

    /// Guards `busy`, `closed` and `waiter`.
    mutex: Io.Mutex = .init,
    cond: Io.Condition = .init,
    /// A send holds the transport, and with it `conn` and the error text.
    busy: bool = false,
    closed: bool = false,
    /// The event the current send waits on, which `close` sets.
    waiter: ?*Io.Event = null,
    conn: ?*http.Connection = null,
    err_buf: [512]u8 = undefined,
    err_len: usize = 0,

    /// Copies every option string. Loads the TLS files now (failing with error.TlsConfig) but dials lazily on the first send.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*Transport {
        const t = try gpa.create(Transport);
        errdefer gpa.destroy(t);
        const url = try gpa.dupe(u8, options.endpoint);
        errdefer gpa.free(url);
        const endpoint = http.Endpoint.parse(url) catch return error.InvalidEndpoint;
        if (!http.validHeaderValue(options.content_type)) return error.InvalidHeader;
        for (options.headers) |h| {
            if (!http.validHeaderName(h.name) or !http.validHeaderValue(h.value)) return error.InvalidHeader;
        }
        const content_type = try gpa.dupe(u8, options.content_type);
        errdefer gpa.free(content_type);
        const headers = try dupeHeaders(gpa, options.headers);
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
            .content_type = content_type,
            .headers = headers,
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

    /// Closes the transport and frees it. No send may be in progress or
    /// start once `destroy` is called; use `close` to stop a send first.
    pub fn destroy(t: *Transport) void {
        t.close();
        const gpa = t.gpa;
        if (t.tls_config) |cfg| freeTls(gpa, cfg);
        freeHeaders(gpa, t.headers);
        gpa.free(t.content_type);
        gpa.free(t.url);
        gpa.destroy(t);
    }

    /// Sends one POST with `body` (uncompressed; the transport gzips it when configured), retrying as Go does.
    /// Every wait (dial, TLS handshake, write, read, backoff) ends by min(now + options.timeout, deadline).
    /// Returns the 2xx response. Thread-safe: concurrent callers are serialized.
    pub fn send(t: *Transport, body: []const u8, until: Deadline) SendError!Response {
        return t.sendDetail(body, until, null, null);
    }

    /// Sends like `send`, and on failure copies the description of that
    /// failure into `err_dst` before the next caller's send can start, so
    /// concurrent callers each get their own. `err_len_out` receives the
    /// length copied, which is zero on success.
    pub fn sendDetail(
        t: *Transport,
        body: []const u8,
        until: Deadline,
        err_dst: ?[]u8,
        err_len_out: ?*usize,
    ) SendError!Response {
        if (err_len_out) |out_len| out_len.* = 0;
        const limit = deadline.earliest(until, deadline.after(t.io, t.timeout));
        try t.acquire(limit);
        defer t.release();
        t.err_len = 0;
        return t.sendLocked(body, limit) catch |err| {
            if (err_dst) |dst| {
                const n = @min(t.err_len, dst.len);
                @memcpy(dst[0..n], t.err_buf[0..n]);
                if (err_len_out) |out_len| out_len.* = n;
            }
            return err;
        };
    }

    fn sendLocked(t: *Transport, body: []const u8, limit: Deadline) SendError!Response {
        if (body.len > max_request_size) {
            t.setError("request body too large: exceeded {d} bytes", .{max_request_size});
            return error.Rejected;
        }
        const zipped: ?[]u8 = if (t.compression == .gzip) try http.gzip(t.gpa, body) else null;
        defer if (zipped) |z| t.gpa.free(z);
        return t.exchange(zipped orelse body, limit);
    }

    /// Closes the connection; later sends return error.Shutdown. Idempotent.
    /// A send in progress is interrupted and returns error.Shutdown, and
    /// `close` waits for it to return.
    pub fn close(t: *Transport) void {
        t.mutex.lockUncancelable(t.io);
        defer t.mutex.unlock(t.io);
        t.closed = true;
        if (t.waiter) |w| w.set(t.io);
        while (t.busy) t.cond.waitUncancelable(t.io, &t.mutex);
        t.dropConn(true);
    }

    /// A human-readable description of the most recent failure (status code
    /// and a bounded excerpt of the body, or the network error), valid until
    /// the next send. Safe only while no other caller can send: a caller
    /// that shares the transport uses `sendDetail`, which copies the
    /// description before the next send starts.
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

    /// Makes `event` the one `close` sets. Returns false once closed.
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

    /// The retry loop of Go's `retry.Config.RequestFunc`.
    fn exchange(t: *Transport, payload: []const u8, limit: Deadline) SendError!Response {
        const start = Io.Clock.Timestamp.now(t.io, deadline.clock);
        var interval = t.retry.initial_interval;
        while (true) {
            const failed: struct { err: SendError, throttle: Io.Duration } = switch (t.runAttempt(payload, limit)) {
                .ok => |resp| return resp,
                .shutdown => return error.Shutdown,
                .canceled => return error.Canceled,
                .oom => return error.OutOfMemory,
                .rejected => return error.Rejected,
                .timeout => {
                    t.setError("deadline exceeded while sending to {s}", .{t.url});
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

    /// Go's `backoff.ExponentialBackOff.NextBackOff` with randomization
    /// 0.5 and multiplier 1.5.
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

    /// Waits until `wake`, unless `close` interrupts the wait.
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
        /// A transport failure; the payload is whether it is retryable.
        failure: bool,
        rejected,
        timeout,
        shutdown,
        canceled,
        oom,
    };

    const Attempt = struct {
        t: *Transport,
        payload: []const u8,
        done: Io.Event = .unset,
        finished: std.atomic.Value(bool) = .init(false),

        fn run(a: *Attempt) Outcome {
            const outcome = a.t.attemptOnce(a.payload);
            a.finished.store(true, .release);
            a.done.set(a.t.io);
            return outcome;
        }
    };

    /// Runs one attempt as a concurrent task bounded by `limit`.
    fn runAttempt(t: *Transport, payload: []const u8, limit: Deadline) Outcome {
        var attempt: Attempt = .{ .t = t, .payload = payload };
        if (!t.register(&attempt.done)) return .shutdown;
        defer t.unregister();
        var future = t.io.concurrent(Attempt.run, .{&attempt}) catch |err| switch (err) {
            error.ConcurrencyUnavailable => {
                t.setError("no concurrent task available to bound the request to {s}", .{t.url});
                return .{ .failure = true };
            },
        };
        const waited = attempt.done.waitTimeout(t.io, deadline.timeout(limit));
        if (attempt.finished.load(.acquire)) return future.await(t.io);
        // Out of time, canceled or closed: stop the attempt and wait for it.
        // A connection the attempt was using is closed by the attempt.
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

    /// One request and response on the current connection, dialing first
    /// when there is none.
    fn attemptOnce(t: *Transport, payload: []const u8) Outcome {
        var may_redial = true;
        while (true) {
            const c = t.conn orelse c: {
                var failure: http.Failure = undefined;
                const opened = http.Connection.open(t.gpa, t.io, &t.endpoint, t.tls_config, &failure) catch |err| switch (err) {
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

            http.writeRequest(c.writer(), .{
                .endpoint = &t.endpoint,
                .content_type = t.content_type,
                .gzip = t.compression == .gzip,
                .user_agent = user_agent,
                .headers = t.headers,
                .body = payload,
            }) catch {
                const f = c.lastFailure() orelse http.Failure{ .kind = .fatal, .name = "WriteFailed" };
                t.dropConn(false);
                switch (f.kind) {
                    .canceled => return .canceled,
                    .closed => if (reused and may_redial) {
                        may_redial = false;
                        continue;
                    },
                    else => {},
                }
                t.setError("failed to send to {s}: {s}", .{ t.url, f.name });
                return .{ .failure = f.kind == .temporary };
            };

            const now_seconds = Io.Clock.real.now(t.io).toSeconds();
            var resp = http.readResponse(&c.http_reader, t.gpa, .{
                .max_body = max_response_size,
                .now_seconds = now_seconds,
                .transfer_buffer = &c.transfer,
            }) catch |err| {
                const f = c.lastFailure();
                t.dropConn(false);
                if (f) |x| if (x.kind == .canceled) return .canceled;
                switch (err) {
                    error.OutOfMemory => return .oom,
                    error.ResponseTooLarge => {
                        t.setError("response body from {s} too large: exceeded {d} bytes", .{ t.url, max_response_size });
                        return .rejected;
                    },
                    error.InvalidResponse => {
                        t.setError("invalid HTTP response from {s}", .{t.url});
                        return .{ .failure = false };
                    },
                    error.ConnectionClosing => {
                        if (reused and may_redial) {
                            may_redial = false;
                            continue;
                        }
                        t.setError("{s} closed the connection without a response", .{t.url});
                        return .{ .failure = false };
                    },
                    error.ReadFailed => {
                        const x = f orelse {
                            t.setError("{s} closed the connection inside the response, or its body did not decode", .{t.url});
                            return .{ .failure = false };
                        };
                        if (x.kind == .closed and reused and may_redial) {
                            may_redial = false;
                            continue;
                        }
                        t.setError("failed to read the response from {s}: {s}", .{ t.url, x.name });
                        return .{ .failure = x.kind == .temporary };
                    },
                }
            };
            c.reused = true;
            if (!resp.keep_alive) t.dropConn(true);

            const code = resp.status;
            if (code >= 200 and code <= 299) {
                return .{ .ok = .{ .status = code, .content_type = resp.content_type, .body = resp.body } };
            }
            t.setStatusError(code, resp.body);
            const throttle = resp.retry_after orelse Io.Duration.zero;
            resp.deinit(t.gpa);
            return switch (code) {
                429, 502, 503, 504 => .{ .status = .{ .retryable = true, .throttle = clamp(throttle) } },
                else => .{ .status = .{ .retryable = false, .throttle = .zero } },
            };
        }
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

    /// Go's message: `failed to send to URL: 503 Service Unavailable (body: ...)`.
    fn setStatusError(t: *Transport, code: u16, body: []const u8) void {
        const status: std.http.Status = @fromBackingInt(@as(u10, @intCast(@min(code, 999))));
        var excerpt: [256]u8 = undefined;
        const trimmed = std.mem.trim(u8, body, " \t\r\n");
        const n = @min(trimmed.len, excerpt.len);
        for (trimmed[0..n], excerpt[0..n]) |ch, *out| out.* = if (ch >= ' ' and ch < 0x7f) ch else '.';
        t.setError("failed to send to {s}: {d} {s} (body: {s})", .{
            t.url,
            code,
            status.phrase() orelse "",
            if (n == 0) "(empty)" else excerpt[0..n],
        });
    }
};

fn clamp(d: Io.Duration) Io.Duration {
    return .fromNanoseconds(std.math.clamp(d.nanoseconds, 0, max_duration.nanoseconds));
}

fn dupeHeaders(gpa: Allocator, headers: []const Header) Allocator.Error![]Header {
    const out = try gpa.alloc(Header, headers.len);
    var done: usize = 0;
    errdefer {
        for (out[0..done]) |h| {
            gpa.free(h.name);
            gpa.free(h.value);
        }
        gpa.free(out);
    }
    for (headers, out) |h, *o| {
        const name = try gpa.dupe(u8, h.name);
        errdefer gpa.free(name);
        o.* = .{ .name = name, .value = try gpa.dupe(u8, h.value) };
        done += 1;
    }
    return out;
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
    _ = @import("test/receiver.zig");
    _ = @import("test/transport_test.zig");
}
