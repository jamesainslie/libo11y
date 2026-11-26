//! Shared HTTP semantic-convention helpers for `o11yhttp` server and client
//! instrumentation, matching `go/o11yhttp/o11yhttp.go` and
//! `ts/packages/server/src/http-common.ts`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");

/// Instrumentation scope name for `o11yhttp` spans and metrics.
pub const scope_name = "github.com/jamesainslie/libo11y/zig/o11yhttp";

/// Stable OpenTelemetry HTTP duration histogram bucket boundaries (in seconds).
pub const duration_buckets = [_]f64{
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
};

/// Normalized value for methods outside the standard HTTP semantic-convention set.
pub const method_other = "_OTHER";

/// Exact byte length of `traceparent;desc="00-<32>-<16>-<2>"`.
pub const server_timing_len: usize = 74;

pub const NormalizedMethod = struct {
    normalized: []const u8,
    /// True when `http.request.method_original` can be omitted (already exact
    /// or empty).
    exact: bool,
};

const known_methods = [_][]const u8{
    "CONNECT",
    "DELETE",
    "GET",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
    "TRACE",
};

/// Maps an HTTP method string onto the bounded semantic-convention set
/// (matching Go's `normalizeMethod`).
pub fn normalizeMethod(raw: []const u8) NormalizedMethod {
    if (raw.len == 0) return .{ .normalized = method_other, .exact = true };
    for (known_methods) |m| {
        if (std.mem.eql(u8, raw, m)) return .{ .normalized = m, .exact = true };
    }
    for (known_methods) |m| {
        if (std.ascii.eqlIgnoreCase(raw, m)) return .{ .normalized = m, .exact = false };
    }
    return .{ .normalized = method_other, .exact = false };
}

/// Returns the method token used in span names (`"HTTP"` for `_OTHER`).
pub fn methodSpanToken(normalized: []const u8) []const u8 {
    return if (std.mem.eql(u8, normalized, method_other)) "HTTP" else normalized;
}

/// Strips a leading method from a route template (`"GET /users/{id}"` -> `"/users/{id}"`).
pub fn routeOnly(pattern: []const u8) []const u8 {
    if (std.mem.indexOfScalar(u8, pattern, ' ')) |sp| {
        return pattern[sp + 1 ..];
    }
    return pattern;
}

/// Formats the route-aware span name into `arena`, following Go's
/// `defaultSpanName` and stable HTTP semantic conventions:
/// - If `route` is non-empty and contains a space (e.g. `"GET /users/{id}"`),
///   uses `route` verbatim.
/// - Else if `route` is non-empty, returns `"{METHOD_TOKEN} {route}"`.
/// - Else if `operation` is non-empty, returns `operation`.
/// - Else returns `METHOD_TOKEN` (e.g. `"GET"`, `"HTTP"`).
pub fn formatSpanName(
    arena: Allocator,
    normalized_method: []const u8,
    route: ?[]const u8,
    operation: ?[]const u8,
) Allocator.Error![]const u8 {
    const token = methodSpanToken(normalized_method);
    if (route) |r| {
        if (r.len > 0) {
            if (std.mem.indexOfScalar(u8, r, ' ') != null) return r;
            return std.fmt.allocPrint(arena, "{s} {s}", .{ token, r });
        }
    }
    if (operation) |op| {
        if (op.len > 0) return op;
    }
    return token;
}

/// Formats `Server-Timing` traceparent value:
/// `traceparent;desc="00-<trace_id>-<span_id>-<flags>"`.
/// Returns `null` when `sc` is not valid.
pub fn formatServerTiming(buf: *[server_timing_len]u8, sc: o11y.SpanContext) ?[]const u8 {
    if (!sc.isValid()) return null;
    const tp = o11y.TraceContextPropagator.formatTraceparent(sc);
    const prefix = "traceparent;desc=\"";
    @memcpy(buf[0..prefix.len], prefix);
    @memcpy(buf[prefix.len .. prefix.len + tp.len], &tp);
    buf[prefix.len + tp.len] = '"';
    return buf[0..server_timing_len];
}

pub const TargetParts = struct {
    path: []const u8,
    query: []const u8,
};

/// Splits an HTTP request target (`"/users/42?expand=1#frag"`) into path and
/// query slices (stripping any fragment).
pub fn splitTarget(target: []const u8) TargetParts {
    const no_frag = if (std.mem.indexOfScalar(u8, target, '#')) |h| target[0..h] else target;
    if (std.mem.indexOfScalar(u8, no_frag, '?')) |q| {
        return .{ .path = no_frag[0..q], .query = no_frag[q + 1 ..] };
    }
    return .{ .path = no_frag, .query = "" };
}

/// Percent-decodes a URL path into `arena` for `ignore_paths` glob matching
/// (matching Go's `r.URL.Path`). Malformed `%` escapes are left verbatim.
pub fn decodePath(arena: Allocator, path: []const u8) Allocator.Error![]const u8 {
    if (std.mem.indexOfScalar(u8, path, '%') == null) return path;
    const out = try arena.alloc(u8, path.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < path.len) : (i += 1) {
        if (path[i] == '%' and i + 2 < path.len) {
            const hi = std.fmt.charToDigit(path[i + 1], 16) catch null;
            const lo = std.fmt.charToDigit(path[i + 2], 16) catch null;
            if (hi != null and lo != null) {
                out[n] = (hi.? << 4) | lo.?;
                n += 1;
                i += 2;
                continue;
            }
        }
        out[n] = path[i];
        n += 1;
    }
    return out[0..n];
}

pub const HostPort = struct {
    address: []const u8,
    port: u16,
};

/// Parses a `Host` header value (`"example.com:8080"`, `"[::1]:8080"`,
/// `"example.com"`) into unbracketed `server.address` and `server.port`.
pub fn parseHostPort(host_header: []const u8, default_port: u16) HostPort {
    const trimmed = std.mem.trim(u8, host_header, " \t");
    if (trimmed.len == 0) return .{ .address = "", .port = default_port };

    if (trimmed[0] == '[') {
        if (std.mem.indexOfScalar(u8, trimmed, ']')) |close| {
            const addr = trimmed[1..close];
            if (close + 1 < trimmed.len and trimmed[close + 1] == ':') {
                const port = std.fmt.parseInt(u16, trimmed[close + 2 ..], 10) catch default_port;
                return .{ .address = addr, .port = port };
            }
            return .{ .address = addr, .port = default_port };
        }
        return .{ .address = trimmed, .port = default_port };
    }

    if (std.mem.lastIndexOfScalar(u8, trimmed, ':')) |colon| {
        if (std.fmt.parseInt(u16, trimmed[colon + 1 ..], 10)) |port| {
            return .{ .address = trimmed[0..colon], .port = port };
        } else |_| {}
    }
    return .{ .address = trimmed, .port = default_port };
}

/// Returns the default TCP port for an HTTP scheme (`443` for https/wss, `80`
/// otherwise).
pub fn defaultPortForScheme(scheme: []const u8) u16 {
    if (std.ascii.eqlIgnoreCase(scheme, "https") or std.ascii.eqlIgnoreCase(scheme, "wss")) return 443;
    return 80;
}

/// Extracts `server.address` (without IPv6 brackets) and `server.port` from a
/// `std.Uri`.
pub fn serverAddressFromUri(arena: Allocator, uri: std.Uri) Allocator.Error!HostPort {
    const port = uri.port orelse defaultPortForScheme(uri.scheme);
    const host_comp = uri.host orelse return .{ .address = "", .port = port };
    const raw = try host_comp.toRawMaybeAlloc(arena);
    const stripped = if (raw.len >= 2 and raw[0] == '[' and raw[raw.len - 1] == ']')
        raw[1 .. raw.len - 1]
    else
        raw;
    return .{ .address = stripped, .port = port };
}

/// Formats `uri` as `url.full` with `user` and `password` stripped so
/// credentials embedded in URLs never leak into spans.
pub fn sanitizeUrlFull(arena: Allocator, uri: std.Uri) Allocator.Error![]const u8 {
    var clean = uri;
    clean.user = null;
    clean.password = null;
    var out: Io.Writer.Allocating = .init(arena);
    clean.writeToStream(&out.writer, .{
        .scheme = true,
        .authentication = false,
        .authority = true,
        .path = true,
        .query = true,
        .fragment = true,
    }) catch return error.OutOfMemory;
    return out.written();
}

/// Reports whether a `Content-Type` header value has media type `text/html`
/// (case-insensitive, ignoring parameters).
pub fn isHtmlContentType(content_type: ?[]const u8) bool {
    const raw = content_type orelse return false;
    const media = if (std.mem.indexOfScalar(u8, raw, ';')) |semi| raw[0..semi] else raw;
    return std.ascii.eqlIgnoreCase(std.mem.trim(u8, media, " \t"), "text/html");
}

/// Computes non-negative elapsed seconds between two awake timestamps.
pub fn elapsedSeconds(start: Io.Timestamp, end: Io.Timestamp) f64 {
    const diff = end.nanoseconds - start.nanoseconds;
    if (diff <= 0) return 0.0;
    return @as(f64, @floatFromInt(diff)) / 1_000_000_000.0;
}

/// Formats an HTTP status code as an ASCII decimal string into `buf`.
pub fn formatStatusCode(buf: *[8]u8, status: u16) []const u8 {
    return std.fmt.bufPrint(buf, "{d}", .{status}) catch "500";
}

const testing = std.testing;

test "normalizeMethod and formatSpanName match Go o11yhttp" {
    const get = normalizeMethod("GET");
    try testing.expectEqualStrings("GET", get.normalized);
    try testing.expect(get.exact);

    const lower = normalizeMethod("get");
    try testing.expectEqualStrings("GET", lower.normalized);
    try testing.expect(!lower.exact);

    const custom = normalizeMethod("XQZ123");
    try testing.expectEqualStrings("_OTHER", custom.normalized);
    try testing.expect(!custom.exact);

    const empty = normalizeMethod("");
    try testing.expectEqualStrings("_OTHER", empty.normalized);
    try testing.expect(empty.exact);

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    try testing.expectEqualStrings("GET /users/{id}", try formatSpanName(a, "GET", "/users/{id}", "users"));
    try testing.expectEqualStrings("GET /users/{id}", try formatSpanName(a, "GET", "GET /users/{id}", "users"));
    try testing.expectEqualStrings("HTTP /items/{id}", try formatSpanName(a, "_OTHER", "/items/{id}", null));
    try testing.expectEqualStrings("users", try formatSpanName(a, "GET", null, "users"));
    try testing.expectEqualStrings("GET", try formatSpanName(a, "GET", null, null));
    try testing.expectEqualStrings("HTTP", try formatSpanName(a, "_OTHER", null, null));
    try testing.expectEqualStrings("/users/{id}", routeOnly("GET /users/{id}"));
    try testing.expectEqualStrings("/users/{id}", routeOnly("/users/{id}"));
}

test "sanitizeUrlFull strips credentials and parseHostPort handles IPv4, IPv6, and defaults" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const uri = try std.Uri.parse("https://alice:s3cr3t@api.example.com:8443/v1/orders?page=2");
    try testing.expectEqualStrings("https://api.example.com:8443/v1/orders?page=2", try sanitizeUrlFull(a, uri));

    const hp = try serverAddressFromUri(a, uri);
    try testing.expectEqualStrings("api.example.com", hp.address);
    try testing.expectEqual(@as(u16, 8443), hp.port);

    const v6 = parseHostPort("[::1]:9000", 80);
    try testing.expectEqualStrings("::1", v6.address);
    try testing.expectEqual(@as(u16, 9000), v6.port);

    const plain = parseHostPort("example.com", 443);
    try testing.expectEqualStrings("example.com", plain.address);
    try testing.expectEqual(@as(u16, 443), plain.port);
}

test "formatServerTiming encodes W3C traceparent desc" {
    const sc: o11y.SpanContext = .{
        .trace_id = o11y.TraceId.parseHex("0af7651916cd43dd8448eb211c80319c").?,
        .span_id = o11y.SpanId.parseHex("b7ad6b7169203331").?,
        .flags = .sampled_flag,
    };
    var buf: [server_timing_len]u8 = undefined;
    try testing.expectEqualStrings(
        "traceparent;desc=\"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01\"",
        formatServerTiming(&buf, sc).?,
    );
    try testing.expectEqual(@as(?[]const u8, null), formatServerTiming(&buf, .invalid));
}
