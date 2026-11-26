//! How the startup summary shows an OTLP endpoint: without userinfo, query
//! or fragment, and "unparseable" when anything is ambiguous, so a
//! credential is never echoed. It reproduces Go's sanitizeEndpoint
//! (go/summary.go), which formats with net/url's URL.String: only the scheme
//! is lowercased, and the host and path are escaped. A WHATWG URL parser
//! normalizes far more, so this is a port of Go 1.26's url.Parse over bytes
//! (conformance/vectors/endpoint-sanitize.json).

const std = @import("std");

const Allocator = std.mem.Allocator;
const mem = std.mem;

/// What sanitize returns for a value it withholds.
pub const withheld = "unparseable";

/// The errors sanitize returns.
pub const Error = error{OutOfMemory};

/// Returns raw without credentials, owned by the caller: userinfo, the query
/// and the fragment are removed. A scheme-less gRPC endpoint (host:port) is
/// supported. A value Go's url.Parse rejects, one without a host, and one
/// whose '@' is anything but a single userinfo separator are withheld as
/// "unparseable".
pub fn sanitize(gpa: Allocator, raw: []const u8) Error![]u8 {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    defer arena_state.deinit();
    return gpa.dupe(u8, try sanitizeIn(arena_state.allocator(), raw));
}

fn sanitizeIn(arena: Allocator, raw: []const u8) Error![]const u8 {
    const schemeless = mem.indexOf(u8, raw, "://") == null;
    const input = if (schemeless) try mem.concat(arena, u8, &.{ "//", raw }) else raw;
    const url = parse(arena, input) catch |err| switch (err) {
        error.Invalid => return withheld,
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (url.host.len == 0) return withheld;
    // A credential holding an unencoded '/', '?' or '#' ends the authority
    // early, and an '@' in a password before a '?' or '#' moves its tail
    // into the host, so any other '@' withholds the value.
    const ats = mem.count(u8, input, "@");
    if (ats > 1 or (ats == 1 and !url.has_user)) return withheld;
    const out = try format(arena, url);
    if (mem.indexOfScalar(u8, out, '@') != null) return withheld;
    if (schemeless and mem.startsWith(u8, out, "//")) return out[2..];
    return out;
}

const ParseError = error{ Invalid, OutOfMemory };

/// The fields of Go's url.URL that sanitizeEndpoint reads. The host and the
/// path are unescaped, as in Go.
const Url = struct {
    scheme: []const u8 = "",
    opaque_text: []const u8 = "",
    has_user: bool = false,
    host: []const u8 = "",
    path: []const u8 = "",
    raw_path: []const u8 = "",
    omit_host: bool = false,
};

/// The encoding modes of Go's net/url that the parser needs.
const Mode = enum { path, host, zone, user_password, fragment };

/// Go's shouldEscape: whether c is escaped in a URL part of the given mode.
fn shouldEscape(c: u8, mode: Mode) bool {
    if (std.ascii.isAlphanumeric(c)) return false;
    if (mode == .host or mode == .zone) {
        switch (c) {
            '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', ':', '[', ']', '<', '>', '"' => return false,
            else => {},
        }
    }
    switch (c) {
        '-', '_', '.', '~' => return false,
        '$', '&', '+', ',', '/', ':', ';', '=', '?', '@' => return switch (mode) {
            .path => c == '?',
            .user_password => c == '@' or c == '/' or c == '?' or c == ':',
            .fragment => false,
            .host, .zone => true,
        },
        else => {},
    }
    if (mode == .fragment) {
        switch (c) {
            '!', '(', ')', '*' => return false,
            else => {},
        }
    }
    return true;
}

fn unhex(c: u8) u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => c - 'A' + 10,
    };
}

/// Go's unescape: validates the escapes of s for mode and decodes them.
fn unescape(arena: Allocator, s: []const u8, mode: Mode) ParseError![]const u8 {
    var n: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        if (s[i] == '%') {
            n += 1;
            if (i + 2 >= s.len or !std.ascii.isHex(s[i + 1]) or !std.ascii.isHex(s[i + 2])) return error.Invalid;
            const pct25 = mem.eql(u8, s[i..][0..3], "%25");
            // In a host, an escape may only encode a non-ASCII byte, or the
            // percent sign that introduces an IPv6 zone.
            if (mode == .host and unhex(s[i + 1]) < 8 and !pct25) return error.Invalid;
            if (mode == .zone) {
                const v = unhex(s[i + 1]) << 4 | unhex(s[i + 2]);
                if (!pct25 and v != ' ' and shouldEscape(v, .host)) return error.Invalid;
            }
            i += 3;
        } else {
            if ((mode == .host or mode == .zone) and s[i] < 0x80 and shouldEscape(s[i], mode)) return error.Invalid;
            i += 1;
        }
    }
    if (n == 0) return s;
    const out = try arena.alloc(u8, s.len - 2 * n);
    var j: usize = 0;
    i = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '%') {
            out[j] = unhex(s[i + 1]) << 4 | unhex(s[i + 2]);
            i += 2;
        } else {
            out[j] = s[i];
        }
        j += 1;
    }
    return out;
}

/// Go's escape: percent-encodes, in uppercase hex, each byte of s that mode
/// escapes.
fn escape(arena: Allocator, s: []const u8, mode: Mode) Error![]const u8 {
    var count: usize = 0;
    for (s) |c| {
        if (shouldEscape(c, mode)) count += 1;
    }
    if (count == 0) return s;
    const hex = "0123456789ABCDEF";
    const out = try arena.alloc(u8, s.len + 2 * count);
    var j: usize = 0;
    for (s) |c| {
        if (shouldEscape(c, mode)) {
            out[j..][0..3].* = .{ '%', hex[c >> 4], hex[c & 0x0f] };
            j += 3;
        } else {
            out[j] = c;
            j += 1;
        }
    }
    return out;
}

/// Go's validEncoded: whether s holds no byte that escaping would change.
fn validEncoded(s: []const u8, mode: Mode) bool {
    for (s) |c| {
        switch (c) {
            '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', ':', '@', '[', ']', '%' => {},
            else => if (shouldEscape(c, mode)) return false,
        }
    }
    return true;
}

/// Go's validOptionalPort: empty, or a colon and decimal digits.
fn validOptionalPort(port: []const u8) bool {
    if (port.len == 0) return true;
    if (port[0] != ':') return false;
    for (port[1..]) |c| {
        if (!std.ascii.isDigit(c)) return false;
    }
    return true;
}

/// Go's validUserinfo. Go checks runes, and every non-ASCII rune fails, so
/// checking bytes gives the same answer.
fn validUserinfo(s: []const u8) bool {
    for (s) |c| {
        if (std.ascii.isAlphanumeric(c)) continue;
        switch (c) {
            '-', '.', '_', ':', '~', '!', '$', '&', '\'', '(', ')', '*', '+', ',', ';', '=', '%', '@' => {},
            else => return false,
        }
    }
    return true;
}

/// Go's getScheme: splits off a leading [a-zA-Z][a-zA-Z0-9+.-]* and colon.
fn getScheme(raw: []const u8) ParseError!struct { []const u8, []const u8 } {
    for (raw, 0..) |c, i| {
        switch (c) {
            'a'...'z', 'A'...'Z' => {},
            '0'...'9', '+', '-', '.' => if (i == 0) return .{ "", raw },
            ':' => {
                if (i == 0) return error.Invalid;
                return .{ raw[0..i], raw[i + 1 ..] };
            },
            else => return .{ "", raw },
        }
    }
    return .{ "", raw };
}

/// Go's url.Parse, keeping only what sanitizeEndpoint reads.
fn parse(arena: Allocator, raw: []const u8) ParseError!Url {
    const hash = mem.indexOfScalar(u8, raw, '#');
    const url = try parseReference(arena, if (hash) |h| raw[0..h] else raw);
    // Only the validity of the fragment matters, since it is dropped.
    if (hash) |h| {
        if (h + 1 < raw.len) _ = try unescape(arena, raw[h + 1 ..], .fragment);
    }
    return url;
}

/// Go's parse with viaRequest false, for a URL without its fragment.
fn parseReference(arena: Allocator, raw: []const u8) ParseError!Url {
    for (raw) |c| {
        if (c < ' ' or c == 0x7f) return error.Invalid;
    }
    var url: Url = .{};
    if (mem.eql(u8, raw, "*")) {
        url.path = "*";
        return url;
    }

    const scheme, var rest = try getScheme(raw);
    url.scheme = try std.ascii.allocLowerString(arena, scheme);

    if (mem.endsWith(u8, rest, "?") and mem.count(u8, rest, "?") == 1) {
        rest = rest[0 .. rest.len - 1];
    } else if (mem.indexOfScalar(u8, rest, '?')) |q| {
        rest = rest[0..q];
    }

    if (!mem.startsWith(u8, rest, "/")) {
        if (url.scheme.len != 0) {
            // A rootless path is opaque.
            url.opaque_text = rest;
            return url;
        }
        // The first segment of a relative reference cannot hold a colon.
        const segment = rest[0 .. mem.indexOfScalar(u8, rest, '/') orelse rest.len];
        if (mem.indexOfScalar(u8, segment, ':') != null) return error.Invalid;
    }

    if ((url.scheme.len != 0 or !mem.startsWith(u8, rest, "///")) and mem.startsWith(u8, rest, "//")) {
        var authority = rest[2..];
        rest = "";
        if (mem.indexOfScalar(u8, authority, '/')) |i| {
            rest = authority[i..];
            authority = authority[0..i];
        }
        try parseAuthority(arena, &url, authority);
    } else if (url.scheme.len != 0 and mem.startsWith(u8, rest, "/")) {
        url.omit_host = true;
    }

    url.path = try unescape(arena, rest, .path);
    const escaped = try escape(arena, url.path, .path);
    url.raw_path = if (mem.eql(u8, rest, escaped)) "" else rest;
    return url;
}

/// Go's parseAuthority: the host after the last '@', and the userinfo
/// before it validated.
fn parseAuthority(arena: Allocator, url: *Url, authority: []const u8) ParseError!void {
    const at = mem.lastIndexOfScalar(u8, authority, '@');
    url.host = try parseHost(arena, url.scheme, if (at) |i| authority[i + 1 ..] else authority);
    const i = at orelse return;
    const userinfo = authority[0..i];
    if (!validUserinfo(userinfo)) return error.Invalid;
    if (mem.indexOfScalar(u8, userinfo, ':')) |colon| {
        _ = try unescape(arena, userinfo[0..colon], .user_password);
        _ = try unescape(arena, userinfo[colon + 1 ..], .user_password);
    } else {
        _ = try unescape(arena, userinfo, .user_password);
    }
    url.has_user = true;
}

/// Go's parseHost: host[:port], or an IPv6 literal in brackets with an
/// optional zone and port. It returns the host unescaped.
fn parseHost(arena: Allocator, scheme: []const u8, host: []const u8) ParseError![]const u8 {
    if (mem.lastIndexOfScalar(u8, host, '[')) |open| {
        if (open > 0) return error.Invalid;
        const close = mem.lastIndexOfScalar(u8, host, ']') orelse return error.Invalid;
        const colon_port = host[close + 1 ..];
        if (!validOptionalPort(colon_port)) return error.Invalid;
        const port = try unescape(arena, colon_port, .host);
        // The search for ']' runs from the end, so it can precede '['
        // only when '[' is not at 0, which was rejected above.
        const hostname = host[1..close];
        const unescaped = if (mem.indexOf(u8, hostname, "%25")) |zone|
            try mem.concat(arena, u8, &.{
                try unescape(arena, hostname[0..zone], .host),
                try unescape(arena, hostname[zone..], .zone),
            })
        else
            try unescape(arena, hostname, .host);
        if (!isIpv6Literal(unescaped)) return error.Invalid;
        return mem.concat(arena, u8, &.{ "[", unescaped, "]", port });
    }
    if (mem.indexOfScalar(u8, host, ':')) |first| {
        var i = first;
        const last = mem.lastIndexOfScalar(u8, host, ':').?;
        // Go 1.26 rejects a second colon in an http or https host
        // (GODEBUG urlstrictcolons=1, the default) and keeps the last one
        // as the port separator for other schemes.
        if (last != first and !mem.eql(u8, scheme, "http") and !mem.eql(u8, scheme, "https")) i = last;
        if (!validOptionalPort(host[i..])) return error.Invalid;
    }
    return unescape(arena, host, .host);
}

/// Whether netip.ParseAddr accepts s as an address that is not IPv4, the
/// only kind Go allows in brackets.
fn isIpv6Literal(s: []const u8) bool {
    for (s) |c| {
        switch (c) {
            // An IPv4 address, valid or not, is rejected either way.
            '.' => return false,
            ':' => return parseIpv6(s),
            '%' => return false,
            else => {},
        }
    }
    return false;
}

/// netip's parseIPv6: groups of up to four hex digits, at most one "::",
/// an optional trailing dotted IPv4 and an optional non-empty zone.
fn parseIpv6(in: []const u8) bool {
    var s = in;
    if (mem.indexOfScalar(u8, s, '%')) |p| {
        if (p + 1 == s.len) return false;
        s = s[0..p];
    }
    var ellipsis: ?usize = null;
    if (s.len >= 2 and s[0] == ':' and s[1] == ':') {
        ellipsis = 0;
        s = s[2..];
        if (s.len == 0) return true;
    }
    var i: usize = 0;
    while (i < 16) {
        var off: usize = 0;
        var acc: u32 = 0;
        while (off < s.len) : (off += 1) {
            const c = s[off];
            if (!std.ascii.isHex(c)) break;
            acc = (acc << 4) + unhex(c);
            if (off > 3) return false;
            if (acc > 0xffff) return false;
        }
        if (off == 0) return false;
        if (off < s.len and s[off] == '.') {
            if (ellipsis == null and i != 12) return false;
            if (i + 4 > 16) return false;
            if (!validIpv4(s)) return false;
            s = "";
            i += 4;
            break;
        }
        i += 2;
        s = s[off..];
        if (s.len == 0) break;
        if (s[0] != ':' or s.len == 1) return false;
        s = s[1..];
        if (s[0] == ':') {
            if (ellipsis != null) return false;
            ellipsis = i;
            s = s[1..];
            if (s.len == 0) break;
        }
    }
    if (s.len != 0) return false;
    // Short of 16 bytes needs a "::" to fill, and a full address cannot
    // have one, since it must stand for at least one group.
    return (i < 16) == (ellipsis != null);
}

/// netip's parseIPv4Fields: four dotted decimal fields, each at most 255,
/// without leading zeros.
fn validIpv4(s: []const u8) bool {
    var val: u32 = 0;
    var pos: usize = 0;
    var dig_len: usize = 0;
    for (s, 0..) |c, i| {
        if (std.ascii.isDigit(c)) {
            if (dig_len == 1 and val == 0) return false;
            val = val * 10 + (c - '0');
            dig_len += 1;
            if (val > 255) return false;
        } else if (c == '.') {
            if (i == 0 or i == s.len - 1 or s[i - 1] == '.') return false;
            if (pos == 3) return false;
            pos += 1;
            val = 0;
            dig_len = 0;
        } else {
            return false;
        }
    }
    return pos == 3;
}

/// Go's URL.EscapedPath.
fn escapedPath(arena: Allocator, url: Url) Error![]const u8 {
    if (url.raw_path.len != 0 and validEncoded(url.raw_path, .path)) {
        if (unescape(arena, url.raw_path, .path)) |p| {
            if (mem.eql(u8, p, url.path)) return url.raw_path;
        } else |err| switch (err) {
            error.Invalid => {},
            error.OutOfMemory => return error.OutOfMemory,
        }
    }
    if (mem.eql(u8, url.path, "*")) return "*";
    return escape(arena, url.path, .path);
}

/// Go's URL.String for a URL without userinfo, query or fragment.
fn format(arena: Allocator, url: Url) Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    if (url.scheme.len != 0) {
        try out.appendSlice(arena, url.scheme);
        try out.append(arena, ':');
    }
    if (url.opaque_text.len != 0) {
        try out.appendSlice(arena, url.opaque_text);
        return out.items;
    }
    if ((url.scheme.len != 0 or url.host.len != 0) and !(url.omit_host and url.host.len == 0)) {
        if (url.host.len != 0 or url.path.len != 0) try out.appendSlice(arena, "//");
        if (url.host.len != 0) try out.appendSlice(arena, try escape(arena, url.host, .host));
    }
    const path = try escapedPath(arena, url);
    if (path.len != 0 and path[0] != '/' and url.host.len != 0) try out.append(arena, '/');
    if (out.items.len == 0) {
        // A first segment with a colon would read as a scheme.
        const segment = path[0 .. mem.indexOfScalar(u8, path, '/') orelse path.len];
        if (mem.indexOfScalar(u8, segment, ':') != null) try out.appendSlice(arena, "./");
    }
    try out.appendSlice(arena, path);
    return out.items;
}

const testing = std.testing;

const Case = struct { in: []const u8, want: []const u8 };

fn expectCase(c: Case) !void {
    const got = try sanitize(testing.allocator, c.in);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(c.want, got);
}

test "sanitize matches every case of conformance/vectors/endpoint-sanitize.json" {
    const cases = [_]Case{
        .{ .in = "https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag", .want = "https://collector.example:4318/v1" },
        .{ .in = "http://collector.example:4318", .want = "http://collector.example:4318" },
        .{ .in = "collector.example:4317", .want = "collector.example:4317" },
        .{ .in = "user:pw@collector.example:4317", .want = "collector.example:4317" },
        .{ .in = "https://collector.example/?", .want = "https://collector.example/" },
        .{ .in = "https://[::1]:4318/v1", .want = "https://[::1]:4318/v1" },
        .{ .in = "://bad", .want = "unparseable" },
        .{ .in = "http://%zz", .want = "unparseable" },
        .{ .in = "https://AbC/x+y@collector.example:4318", .want = "unparseable" },
        .{ .in = "AbC/x+y@collector.example:4317", .want = "unparseable" },
        .{ .in = "https://user:/s3cr3t@collector.example", .want = "unparseable" },
        .{ .in = "https://user:12?ab@collector.example:4318", .want = "unparseable" },
        .{ .in = "https://u:p@x/y@collector.example", .want = "unparseable" },
        .{ .in = "https://u:p@ss?word@collector.example:4318", .want = "unparseable" },
        .{ .in = "https://u:S3cr3t@abc?x@collector.example:4318/v1", .want = "unparseable" },
        .{ .in = "u:p@ss?word@collector.example:4317", .want = "unparseable" },
        .{ .in = "https://Collector.Example:443/a/../b", .want = "https://Collector.Example:443/a/../b" },
        .{ .in = "https://bücher.example/v1", .want = "https://b%C3%BCcher.example/v1" },
        .{ .in = "https://collector.example/a b", .want = "https://collector.example/a%20b" },
        .{ .in = "HTTPS://collector.example", .want = "https://collector.example" },
        .{ .in = "https://tok@collector.example", .want = "https://collector.example" },
        .{ .in = "", .want = "unparseable" },
    };
    for (cases) |c| expectCase(c) catch |err| {
        std.debug.print("input {s}\n", .{c.in});
        return err;
    };
}

test "sanitize follows Go's parser on hosts, ports and escapes" {
    // The further cases of the TypeScript port, checked against Go 1.26.
    const cases = [_]Case{
        .{ .in = "https://[fe80::1%25en0]:4318/v1", .want = "https://[fe80::1%25en0]:4318/v1" },
        .{ .in = "https://[::ffff:10.0.0.1]/", .want = "https://[::ffff:10.0.0.1]/" },
        .{ .in = "https://[10.0.0.1]/", .want = "unparseable" },
        .{ .in = "https://[::1/", .want = "unparseable" },
        .{ .in = "https://x[::1]/", .want = "unparseable" },
        .{ .in = "https://host:43a8", .want = "unparseable" },
        .{ .in = "https://host:1:2", .want = "unparseable" },
        .{ .in = "otel://host:1:2", .want = "otel://host:1:2" },
        .{ .in = "https://host:", .want = "https://host:" },
        .{ .in = "https://ho%41st", .want = "unparseable" },
        .{ .in = "https://ho%C3%BCst/", .want = "https://ho%C3%BCst/" },
        .{ .in = "https://host/%7e%2Fa", .want = "https://host/%7e%2Fa" },
        .{ .in = "https://host/a?b#c", .want = "https://host/a" },
        .{ .in = "https://host/#%zz", .want = "unparseable" },
        .{ .in = "https://host/\x07", .want = "unparseable" },
        .{ .in = "https://host/a%zz", .want = "unparseable" },
        .{ .in = "https:/path-only", .want = "https:/path-only" },
        .{ .in = "mailto:someone", .want = "unparseable" },
        .{ .in = "/relative", .want = "unparseable" },
        .{ .in = "https://user@", .want = "unparseable" },
        .{ .in = "https://us er:p@host", .want = "unparseable" },
        .{ .in = "https://u%zz:p@host", .want = "unparseable" },
        .{ .in = "HtTp://Host:80/", .want = "http://Host:80/" },
        .{ .in = "host:4317/v1/traces", .want = "host:4317/v1/traces" },
        .{ .in = "https://host/a:b", .want = "https://host/a:b" },
        .{ .in = "https://host/a;b,c=d&e", .want = "https://host/a;b,c=d&e" },
        .{ .in = "https://[::1%25]/", .want = "unparseable" },
        .{ .in = "https://[1::2::3]/", .want = "unparseable" },
        .{ .in = "https://[1:2:3:4:5:6:7:8:9]/", .want = "unparseable" },
        .{ .in = "https://[::1.2.3.4]/", .want = "https://[::1.2.3.4]/" },
        .{ .in = "https://[1:2:3:4:5:6:1.2.3.4]/", .want = "https://[1:2:3:4:5:6:1.2.3.4]/" },
        .{ .in = "https://[1:2:3:4:5:6:7:1.2.3.4]/", .want = "unparseable" },
        .{ .in = "https://[::01.2.3.4]/", .want = "unparseable" },
        .{ .in = "https://[12345::]/", .want = "unparseable" },
        .{ .in = "https://[1:2:3:4:5:6:7::]/", .want = "https://[1:2:3:4:5:6:7::]/" },
        .{ .in = "https://[1:2:3:4:5:6:7:8::]/", .want = "unparseable" },
        .{ .in = "https://[::]/", .want = "https://[::]/" },
        .{ .in = "https://[:1]/", .want = "unparseable" },
        .{ .in = "https://[1:]/", .want = "unparseable" },
        .{ .in = "https://[fe80::1%25%41]/", .want = "https://[fe80::1%25A]/" },
        .{ .in = "https://[fe80::1%25en%200]/", .want = "https://[fe80::1%25en%200]/" },
        .{ .in = "a b:1", .want = "unparseable" },
        .{ .in = "//x", .want = "unparseable" },
        .{ .in = "x:1/a:b", .want = "x:1/a:b" },
        .{ .in = "https://host/a%2fb%20c", .want = "https://host/a%2fb%20c" },
        .{ .in = "https://host/é", .want = "https://host/%C3%A9" },
        .{ .in = "https://host/%e9", .want = "https://host/%e9" },
        .{ .in = "https://host/*", .want = "https://host/*" },
        .{ .in = "*", .want = "*" },
        .{ .in = "https://host:80:", .want = "unparseable" },
        .{ .in = "h:1:2", .want = "h:1:2" },
        .{ .in = "https://[::1]x", .want = "unparseable" },
    };
    for (cases) |c| expectCase(c) catch |err| {
        std.debug.print("input {s}\n", .{c.in});
        return err;
    };
}

test "sanitize handles fragments, zones and raw paths as Go does" {
    const cases = [_]Case{
        // Go checks control characters only before the fragment, and the
        // fragment is dropped.
        .{ .in = "https://host/#\x07", .want = "https://host/" },
        .{ .in = "https://host/#", .want = "https://host/" },
        .{ .in = "https://host#a%zz", .want = "unparseable" },
        .{ .in = "https://host/a\x7f", .want = "unparseable" },
        // A zone may escape a space but not an ASCII byte that needs one.
        .{ .in = "https://[fe80::1%25%0a]/", .want = "unparseable" },
        .{ .in = "https://[fe80::1%25eth0.1]/", .want = "https://[fe80::1%25eth0.1]/" },
        .{ .in = "https://[::1]:/", .want = "https://[::1]:/" },
        .{ .in = "https://[::1]:x/", .want = "unparseable" },
        .{ .in = "https://[1:2:3:4:5:6:7:8]/", .want = "https://[1:2:3:4:5:6:7:8]/" },
        .{ .in = "https://[::12345]/", .want = "unparseable" },
        .{ .in = "https://[::1.2.3.256]/", .want = "unparseable" },
        .{ .in = "https://[::1.2.3]/", .want = "unparseable" },
        // A raw path with a byte that needs escaping is escaped afresh.
        .{ .in = "https://host/%41 b", .want = "https://host/A%20b" },
        .{ .in = "https://host/a%3Fb", .want = "https://host/a%3Fb" },
        .{ .in = "https://host/?x=1@y", .want = "unparseable" },
        .{ .in = "https://host/a#@", .want = "unparseable" },
        .{ .in = "https://u%40x:p@host", .want = "https://host" },
        .{ .in = "https://:p@host:1", .want = "https://host:1" },
        .{ .in = "https://host\xff/", .want = "https://host%FF/" },
        .{ .in = "1http://host", .want = "unparseable" },
        .{ .in = "a:b://c", .want = "unparseable" },
        .{ .in = "https:///path", .want = "unparseable" },
        .{ .in = "host", .want = "host" },
        .{ .in = "[::1]:4317", .want = "[::1]:4317" },
        .{ .in = "h<o>st:1", .want = "h<o>st:1" },
        .{ .in = "ho st:1", .want = "unparseable" },
    };
    for (cases) |c| expectCase(c) catch |err| {
        std.debug.print("input {s}\n", .{c.in});
        return err;
    };
}

test "sanitize reports allocation failure without leaking" {
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: Allocator) !void {
            const out = try sanitize(gpa, "u:p@b\xc3\xbccher.example:4317/a b/%41");
            gpa.free(out);
        }
    }.run, .{});
}
