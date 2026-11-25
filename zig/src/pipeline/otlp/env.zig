//! Maps the `OTEL_EXPORTER_OTLP_*` environment variables onto OTLP
//! exporter options, following the Go exporters (otlptracehttp v1.47.0
//! `internal/otlpconfig` and `internal/envconfig`, and autoexport v0.72.0
//! for the protocol).
//!
//! The mapping is a pure function of an environment lookup, so tests pass
//! a small map and setup passes the environment map Zig hands to `main`.
//! It reads no files: certificate paths are passed on, and the transport
//! loads them when it is created.
//!
//! Rules, per signal (traces shown):
//! - Every value is trimmed of whitespace, and an empty value counts as
//!   unset, except the protocol, which autoexport reads untrimmed.
//! - `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used as-is: its path is kept,
//!   and an empty path becomes `/`. `OTEL_EXPORTER_OTLP_ENDPOINT` gets
//!   `/v1/traces` joined onto its path (`path.Join`, so `/` and `//` collapse).
//!   The per-signal variable wins. The query and fragment are dropped, as
//!   Go keeps only the host and path. The default is
//!   `https://localhost:4318/v1/traces`: Go's HTTP exporter is secure unless
//!   told otherwise. A value Go cannot parse, or one without an
//!   `http://` or `https://`-style scheme and a host (Go would build an
//!   unusable URL from it), is ignored.
//! - The scheme decides security: `http` (and `unix`) is insecure, any other
//!   scheme is secure. `OTEL_EXPORTER_OTLP_INSECURE` and the per-signal
//!   `_INSECURE`, applied after the endpoints as in Go, override it: `true`
//!   in any case is insecure and any other value is secure.
//! - `_HEADERS` is a comma-separated `key=value` list. A pair without `=`,
//!   with a key that is not an HTTP token, or with a value that does not
//!   percent-decode, is skipped. Values are percent-decoded and trimmed. A
//!   repeated key keeps the last value. The per-signal variable replaces
//!   the generic list entirely, as Go's `WithHeaders` does.
//! - `_COMPRESSION` is gzip only for exactly `gzip`, and none otherwise.
//! - `_TIMEOUT` is an integer number of milliseconds. A value that is not an
//!   integer, or is negative, is ignored. Zero means no export timeout, as a
//!   zero `http.Client.Timeout` does in Go.
//! - `_CERTIFICATE` names the CA file. `_CLIENT_CERTIFICATE` and
//!   `_CLIENT_KEY` are used only as a pair. The per-signal values win. Go
//!   ignores a file it cannot read; here the transport fails to start with
//!   `error.TlsConfig` instead, because this function reads no files.
//! - `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` wins over
//!   `OTEL_EXPORTER_OTLP_PROTOCOL`. Unset means `http/protobuf`. `grpc`,
//!   `http/protobuf` and `http/json` are accepted, and any other value fails
//!   with `error.UnsupportedProtocol`, as autoexport fails. For grpc the
//!   endpoint is `scheme://host` with no path, and the default port is 4317.

const std = @import("std");
const transport = @import("transport.zig");
const Allocator = std.mem.Allocator;
const Io = std.Io;

/// The telemetry signal whose variables are read.
pub const Signal = enum { traces, metrics, logs };

/// The OTLP protocol from `OTEL_EXPORTER_OTLP_PROTOCOL`.
pub const Protocol = enum {
    http_protobuf,
    http_json,
    grpc,

    /// The request Content-Type for the protocol.
    pub fn contentType(p: Protocol) []const u8 {
        return switch (p) {
            .http_protobuf => "application/x-protobuf",
            .http_json => "application/json",
            .grpc => "application/grpc",
        };
    }
};

/// Errors from `fromEnv`.
pub const EnvError = error{ OutOfMemory, UnsupportedProtocol };

/// The options read from the environment. It owns every string.
pub const EnvOptions = struct {
    arena: std.heap.ArenaAllocator,
    protocol: Protocol,
    /// An absolute URL. For HTTP it includes the signal path.
    endpoint: []const u8,
    headers: []const transport.Header,
    compression: transport.Compression,
    timeout: Io.Duration,
    tls: transport.TlsOptions,

    /// Frees every string.
    pub fn deinit(e: *EnvOptions) void {
        e.arena.deinit();
        e.* = undefined;
    }

    /// The transport options these settings describe. The slices point
    /// into `e`, which must outlive the result until `Transport.create`
    /// has copied them.
    pub fn transportOptions(e: *const EnvOptions) transport.Options {
        return .{
            .endpoint = e.endpoint,
            .content_type = e.protocol.contentType(),
            .headers = e.headers,
            .compression = e.compression,
            .timeout = e.timeout,
            .tls = e.tls,
        };
    }
};

/// The default export timeout, 10 seconds as in Go.
pub const default_timeout: Io.Duration = .fromSeconds(10);

/// What a zero `_TIMEOUT` maps to: long enough that only the caller's
/// deadline bounds an export.
pub const no_timeout: Io.Duration = .fromSeconds(100 * 365 * 24 * 3600);

const prefix = "OTEL_EXPORTER_OTLP_";

/// Reads the OTLP exporter variables for `signal`. `env` is any value
/// with a method `get(self, key: []const u8) ?[]const u8`, such as
/// `std.process.Environ.Map` or a test map.
pub fn fromEnv(gpa: Allocator, env: anytype, signal: Signal) EnvError!EnvOptions {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena.deinit();
    const a = arena.allocator();
    const reader: Reader(@TypeOf(env)) = .{ .env = env, .signal = signal };

    const protocol = try readProtocol(reader);

    // Endpoint and security, applied in Go's order.
    var authority: ?[]const u8 = null;
    var path: []const u8 = signalPath(signal);
    var insecure = false;
    if (reader.generic("ENDPOINT")) |value| if (parseUrl(value)) |u| {
        insecure = schemeInsecure(u.scheme);
        authority = u.host;
        path = try joinSignalPath(a, u.path, signalPath(signal));
    };
    if (reader.specific("ENDPOINT")) |value| if (parseUrl(value)) |u| {
        insecure = schemeInsecure(u.scheme);
        authority = u.host;
        path = if (u.path.len == 0) "/" else try a.dupe(u8, u.path);
    };
    if (reader.generic("INSECURE")) |value| insecure = std.ascii.eqlIgnoreCase(value, "true");
    if (reader.specific("INSECURE")) |value| insecure = std.ascii.eqlIgnoreCase(value, "true");

    const scheme = if (insecure) "http" else "https";
    const endpoint = if (protocol == .grpc)
        try std.fmt.allocPrint(a, "{s}://{s}", .{ scheme, authority orelse "localhost:4317" })
    else
        try std.fmt.allocPrint(a, "{s}://{s}{s}", .{ scheme, authority orelse "localhost:4318", path });

    var headers: []const transport.Header = &.{};
    if (reader.generic("HEADERS")) |value| headers = try parseHeaders(a, value);
    if (reader.specific("HEADERS")) |value| headers = try parseHeaders(a, value);

    var compression: transport.Compression = .none;
    if (reader.generic("COMPRESSION")) |value| compression = parseCompression(value);
    if (reader.specific("COMPRESSION")) |value| compression = parseCompression(value);

    var timeout = default_timeout;
    if (reader.generic("TIMEOUT")) |value| timeout = parseTimeout(value) orelse timeout;
    if (reader.specific("TIMEOUT")) |value| timeout = parseTimeout(value) orelse timeout;

    var tls: transport.TlsOptions = .{};
    if (reader.generic("CERTIFICATE")) |value| tls.ca_file = try a.dupe(u8, value);
    if (reader.specific("CERTIFICATE")) |value| tls.ca_file = try a.dupe(u8, value);
    if (reader.generic("CLIENT_CERTIFICATE")) |cert| if (reader.generic("CLIENT_KEY")) |key| {
        tls.client_cert_file = try a.dupe(u8, cert);
        tls.client_key_file = try a.dupe(u8, key);
    };
    if (reader.specific("CLIENT_CERTIFICATE")) |cert| if (reader.specific("CLIENT_KEY")) |key| {
        tls.client_cert_file = try a.dupe(u8, cert);
        tls.client_key_file = try a.dupe(u8, key);
    };

    return .{
        .arena = arena,
        .protocol = protocol,
        .endpoint = endpoint,
        .headers = headers,
        .compression = compression,
        .timeout = timeout,
        .tls = tls,
    };
}

fn Reader(comptime Env: type) type {
    return struct {
        env: Env,
        signal: Signal,

        const Self = @This();

        fn raw(r: Self, key: []const u8) ?[]const u8 {
            return r.env.get(key);
        }

        fn trimmed(r: Self, key: []const u8) ?[]const u8 {
            const value = std.mem.trim(u8, r.raw(key) orelse return null, " \t\r\n\x0b\x0c");
            return if (value.len == 0) null else value;
        }

        fn generic(r: Self, comptime name: []const u8) ?[]const u8 {
            return r.trimmed(prefix ++ name);
        }

        fn specific(r: Self, comptime name: []const u8) ?[]const u8 {
            return switch (r.signal) {
                inline else => |s| r.trimmed(prefix ++ comptime upper(@tagName(s)) ++ "_" ++ name),
            };
        }

        fn specificRaw(r: Self, comptime name: []const u8) ?[]const u8 {
            return switch (r.signal) {
                inline else => |s| r.raw(prefix ++ comptime upper(@tagName(s)) ++ "_" ++ name),
            };
        }
    };
}

fn upper(comptime text: []const u8) []const u8 {
    comptime {
        var out: [text.len]u8 = undefined;
        for (text, 0..) |ch, i| out[i] = std.ascii.toUpper(ch);
        const final = out;
        return &final;
    }
}

fn signalPath(signal: Signal) []const u8 {
    return switch (signal) {
        .traces => "/v1/traces",
        .metrics => "/v1/metrics",
        .logs => "/v1/logs",
    };
}

fn readProtocol(reader: anytype) EnvError!Protocol {
    var value = reader.specificRaw("PROTOCOL") orelse "";
    if (value.len == 0) value = reader.raw(prefix ++ "PROTOCOL") orelse "";
    if (value.len == 0) return .http_protobuf;
    if (std.mem.eql(u8, value, "http/protobuf")) return .http_protobuf;
    if (std.mem.eql(u8, value, "http/json")) return .http_json;
    if (std.mem.eql(u8, value, "grpc")) return .grpc;
    return error.UnsupportedProtocol;
}

const Url = struct { scheme: []const u8, host: []const u8, path: []const u8 };

/// Splits `scheme://host/path?query#fragment`, keeping what Go's exporter
/// keeps. Returns null for what Go's url.Parse rejects (control
/// characters, a bad percent escape) and for a URL without `://` or host.
fn parseUrl(text: []const u8) ?Url {
    for (text) |ch| if (ch < ' ' or ch == 0x7f) return null;
    const sep = std.mem.indexOf(u8, text, "://") orelse return null;
    const scheme = text[0..sep];
    if (scheme.len == 0 or !std.ascii.isAlphabetic(scheme[0])) return null;
    for (scheme) |ch| if (!(std.ascii.isAlphanumeric(ch) or ch == '+' or ch == '-' or ch == '.')) return null;
    const rest = text[sep + 3 ..];
    const host_end = std.mem.indexOfAny(u8, rest, "/?#") orelse rest.len;
    var host = rest[0..host_end];
    if (std.mem.lastIndexOfScalar(u8, host, '@')) |at| host = host[at + 1 ..];
    if (host.len == 0 or std.mem.indexOfScalar(u8, host, ' ') != null) return null;
    var path = rest[host_end..];
    if (std.mem.indexOfAny(u8, path, "?#")) |cut| path = path[0..cut];
    if (!validEscapes(path)) return null;
    return .{ .scheme = scheme, .host = host, .path = path };
}

fn validEscapes(text: []const u8) bool {
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] != '%') continue;
        if (i + 2 >= text.len) return false;
        if (!std.ascii.isHex(text[i + 1]) or !std.ascii.isHex(text[i + 2])) return false;
        i += 2;
    }
    return true;
}

fn schemeInsecure(scheme: []const u8) bool {
    return std.ascii.eqlIgnoreCase(scheme, "http") or std.ascii.eqlIgnoreCase(scheme, "unix");
}

/// Go's `path.Join(base, signal_path)`: joins with `/` and cleans the result.
fn joinSignalPath(a: Allocator, base: []const u8, signal_path: []const u8) Allocator.Error![]const u8 {
    if (base.len == 0) return cleanPath(a, signal_path);
    const joined = try std.fmt.allocPrint(a, "{s}/{s}", .{ base, signal_path });
    return cleanPath(a, joined);
}

/// Go's `path.Clean`, for the joined generic path.
fn cleanPath(a: Allocator, raw: []const u8) Allocator.Error![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, raw, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".")) continue;
        if (std.mem.eql(u8, part, "..")) {
            _ = parts.pop();
            continue;
        }
        try parts.append(a, part);
    }
    var out: std.ArrayList(u8) = .empty;
    for (parts.items) |part| {
        try out.append(a, '/');
        try out.appendSlice(a, part);
    }
    if (out.items.len == 0) try out.append(a, '/');
    return out.items;
}

fn parseHeaders(a: Allocator, value: []const u8) Allocator.Error![]const transport.Header {
    var list: std.ArrayList(transport.Header) = .empty;
    var pairs = std.mem.splitScalar(u8, value, ',');
    next: while (pairs.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        const name = std.mem.trim(u8, pair[0..eq], " \t\r\n\x0b\x0c");
        if (!validToken(name)) continue;
        const decoded = try percentDecode(a, pair[eq + 1 ..]) orelse continue;
        const v = std.mem.trim(u8, decoded, " \t\r\n\x0b\x0c");
        for (list.items) |*h| {
            if (std.mem.eql(u8, h.name, name)) {
                h.value = v;
                continue :next;
            }
        }
        try list.append(a, .{ .name = try a.dupe(u8, name), .value = v });
    }
    return list.items;
}

fn validToken(name: []const u8) bool {
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

/// Go's `url.PathUnescape`: decodes `%XX`, keeps `+`, and fails (null) on a
/// malformed escape.
fn percentDecode(a: Allocator, text: []const u8) Allocator.Error!?[]const u8 {
    var out = try a.alloc(u8, text.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] != '%') {
            out[n] = text[i];
            n += 1;
            continue;
        }
        if (i + 2 >= text.len) return null;
        const hi = std.fmt.charToDigit(text[i + 1], 16) catch return null;
        const lo = std.fmt.charToDigit(text[i + 2], 16) catch return null;
        out[n] = hi * 16 + lo;
        n += 1;
        i += 2;
    }
    return out[0..n];
}

fn parseCompression(value: []const u8) transport.Compression {
    return if (std.mem.eql(u8, value, "gzip")) .gzip else .none;
}

fn parseTimeout(value: []const u8) ?Io.Duration {
    const ms = std.fmt.parseInt(i64, value, 10) catch return null;
    if (ms < 0) return null;
    if (ms == 0) return no_timeout;
    return .fromMilliseconds(ms);
}

const testing = std.testing;

/// A test environment.
const TestEnv = struct {
    pairs: []const [2][]const u8,

    /// Returns the value of `key`, if set.
    pub fn get(e: TestEnv, key: []const u8) ?[]const u8 {
        for (e.pairs) |p| if (std.mem.eql(u8, p[0], key)) return p[1];
        return null;
    }
};

fn load(pairs: []const [2][]const u8, signal: Signal) !EnvOptions {
    return fromEnv(testing.allocator, TestEnv{ .pairs = pairs }, signal);
}

test "defaults follow Go's HTTP exporter" {
    var e = try load(&.{}, .traces);
    defer e.deinit();
    try testing.expectEqual(.http_protobuf, e.protocol);
    try testing.expectEqualStrings("https://localhost:4318/v1/traces", e.endpoint);
    try testing.expectEqual(0, e.headers.len);
    try testing.expectEqual(.none, e.compression);
    try testing.expectEqual(default_timeout, e.timeout);
    try testing.expectEqual(null, e.tls.ca_file);
    const o = e.transportOptions();
    try testing.expectEqualStrings("application/x-protobuf", o.content_type);
}

test "endpoint table" {
    const Case = struct { signal: Signal, env: []const [2][]const u8, want: []const u8 };
    const cases = [_]Case{
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318" }}, .want = "http://collector:4318/v1/traces" },
        .{ .signal = .metrics, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4318/" }}, .want = "http://collector:4318/v1/metrics" },
        .{ .signal = .logs, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", " https://c.example/prefix/ " }}, .want = "https://c.example/prefix/v1/logs" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:1/a//b/../x?q=1#f" }}, .want = "http://c:1/a/x/v1/traces" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://c:4318/custom/path" }}, .want = "http://c:4318/custom/path" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://c:4318" }}, .want = "http://c:4318/" },
        .{ .signal = .traces, .env = &.{
            .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://generic:1" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://specific:2/t" },
        }, .want = "https://specific:2/t" },
        .{ .signal = .metrics, .env = &.{
            .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://generic:1" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://specific:2/t" },
        }, .want = "http://generic:1/v1/metrics" },
        // The scheme picks security: anything but http is secure.
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "grpcs://c:9" }}, .want = "https://c:9/v1/traces" },
        // INSECURE overrides the scheme, after the endpoints.
        .{ .signal = .traces, .env = &.{
            .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "https://c:9" },
            .{ "OTEL_EXPORTER_OTLP_INSECURE", "TRUE" },
        }, .want = "http://c:9/v1/traces" },
        .{ .signal = .traces, .env = &.{
            .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:9" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_INSECURE", "false" },
        }, .want = "https://c:9/v1/traces" },
        // Unusable values are ignored and the default stays.
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4318" }}, .want = "https://localhost:4318/v1/traces" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://c/%zz" }}, .want = "https://localhost:4318/v1/traces" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_ENDPOINT", "   " }}, .want = "https://localhost:4318/v1/traces" },
        // gRPC keeps only scheme and host.
        .{ .signal = .traces, .env = &.{
            .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
            .{ "OTEL_EXPORTER_OTLP_ENDPOINT", "http://c:4317/ignored" },
        }, .want = "http://c:4317" },
        .{ .signal = .traces, .env = &.{.{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" }}, .want = "https://localhost:4317" },
    };
    for (cases) |c| {
        var e = try load(c.env, c.signal);
        defer e.deinit();
        testing.expectEqualStrings(c.want, e.endpoint) catch |err| {
            std.debug.print("case {any}\n", .{c.env});
            return err;
        };
    }
}

test "headers parse like Go's stringToHeader" {
    var e = try load(&.{.{
        "OTEL_EXPORTER_OTLP_HEADERS",
        "api-key=se%20cret, bad key=x,noequals, x=1,x=2,y=a%zz,auth=Bearer%3Dtok+en ,empty=",
    }}, .traces);
    defer e.deinit();
    try testing.expectEqual(4, e.headers.len);
    try testing.expectEqualStrings("api-key", e.headers[0].name);
    try testing.expectEqualStrings("se cret", e.headers[0].value);
    try testing.expectEqualStrings("x", e.headers[1].name);
    try testing.expectEqualStrings("2", e.headers[1].value);
    try testing.expectEqualStrings("auth", e.headers[2].name);
    try testing.expectEqualStrings("Bearer=tok+en", e.headers[2].value);
    try testing.expectEqualStrings("empty", e.headers[3].name);
    try testing.expectEqualStrings("", e.headers[3].value);
}

test "per-signal headers replace the generic list" {
    var e = try load(&.{
        .{ "OTEL_EXPORTER_OTLP_HEADERS", "a=1,b=2" },
        .{ "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "c=3" },
    }, .logs);
    defer e.deinit();
    try testing.expectEqual(1, e.headers.len);
    try testing.expectEqualStrings("c", e.headers[0].name);
}

test "compression, timeout and protocol table" {
    const Case = struct {
        env: []const [2][]const u8,
        compression: transport.Compression = .none,
        timeout: Io.Duration = default_timeout,
        protocol: Protocol = .http_protobuf,
    };
    const cases = [_]Case{
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" }}, .compression = .gzip },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_COMPRESSION", "GZIP" }} },
        .{ .env = &.{
            .{ "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION", "none" },
        } },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_TIMEOUT", "2500" }}, .timeout = .fromMilliseconds(2500) },
        .{ .env = &.{
            .{ "OTEL_EXPORTER_OTLP_TIMEOUT", "2500" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "300" },
        }, .timeout = .fromMilliseconds(300) },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_TIMEOUT", "5s" }} },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_TIMEOUT", "-1" }} },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_TIMEOUT", "0" }}, .timeout = no_timeout },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http/json" }}, .protocol = .http_json },
        .{ .env = &.{
            .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "http/protobuf" },
        } },
        .{ .env = &.{.{ "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "" }} },
    };
    for (cases) |c| {
        var e = try load(c.env, .traces);
        defer e.deinit();
        try testing.expectEqual(c.compression, e.compression);
        try testing.expectEqual(c.timeout, e.timeout);
        try testing.expectEqual(c.protocol, e.protocol);
    }
}

test "an unknown protocol is rejected" {
    try testing.expectError(error.UnsupportedProtocol, load(&.{.{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http" }}, .traces));
    try testing.expectError(error.UnsupportedProtocol, load(&.{.{ "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", " grpc" }}, .metrics));
}

test "certificate paths and the client pair" {
    {
        var e = try load(&.{
            .{ "OTEL_EXPORTER_OTLP_CERTIFICATE", "/etc/ca.pem" },
            .{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", "/etc/c.pem" },
            .{ "OTEL_EXPORTER_OTLP_CLIENT_KEY", "/etc/k.pem" },
        }, .traces);
        defer e.deinit();
        try testing.expectEqualStrings("/etc/ca.pem", e.tls.ca_file.?);
        try testing.expectEqualStrings("/etc/c.pem", e.tls.client_cert_file.?);
        try testing.expectEqualStrings("/etc/k.pem", e.tls.client_key_file.?);
    }
    {
        // Per-signal values win; a lone per-signal certificate without its
        // key does not replace the generic pair.
        var e = try load(&.{
            .{ "OTEL_EXPORTER_OTLP_CERTIFICATE", "/etc/ca.pem" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", "/etc/traces-ca.pem" },
            .{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", "/etc/c.pem" },
            .{ "OTEL_EXPORTER_OTLP_CLIENT_KEY", "/etc/k.pem" },
            .{ "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE", "/etc/tc.pem" },
        }, .traces);
        defer e.deinit();
        try testing.expectEqualStrings("/etc/traces-ca.pem", e.tls.ca_file.?);
        try testing.expectEqualStrings("/etc/c.pem", e.tls.client_cert_file.?);
    }
    {
        // A certificate without a key is not a pair.
        var e = try load(&.{.{ "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", "/etc/c.pem" }}, .traces);
        defer e.deinit();
        try testing.expectEqual(null, e.tls.client_cert_file);
        try testing.expectEqual(null, e.tls.client_key_file);
    }
}

test "fromEnv reads std.process.Environ.Map" {
    var map: std.process.Environ.Map = .init(testing.allocator);
    defer map.deinit();
    try map.put("OTEL_EXPORTER_OTLP_ENDPOINT", "http://m:1");
    var e = try fromEnv(testing.allocator, &map, .logs);
    defer e.deinit();
    try testing.expectEqualStrings("http://m:1/v1/logs", e.endpoint);
}
