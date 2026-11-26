//! Go `path.Match` glob matcher for `ignore_paths`, ported from Go's stdlib
//! `path/match.go` (and matching `ts/packages/server/src/glob.ts`).
//!
//! Shell patterns over slash-separated paths:
//! - `*` matches any sequence of non-`/` characters;
//! - `?` matches any single non-`/` UTF-8 codepoint;
//! - `[...]` matches a character class (negated with `^`, ranges with `-`,
//!   escapes with `\`);
//! - `\` escapes the next character.
//!
//! A malformed pattern returns `error.BadPattern`, and `matchesAny` treats
//! malformed patterns as non-matching (matching Go's `WithIgnorePaths`).

const std = @import("std");

/// Returned by `pathMatch` when the pattern has invalid syntax (for example
/// an unclosed `[` or a trailing `\`).
pub const MatchError = error{BadPattern};

/// Reports whether `path` matches ANY pattern in `patterns`. Malformed
/// patterns never match.
pub fn matchesAny(patterns: []const []const u8, path: []const u8) bool {
    for (patterns) |pat| {
        const matched = pathMatch(pat, path) catch false;
        if (matched) return true;
    }
    return false;
}

/// Reports whether `name` matches the whole shell pattern `pattern`.
pub fn pathMatch(pattern: []const u8, name: []const u8) MatchError!bool {
    var p = pattern;
    var n = name;
    chunks: while (p.len > 0) {
        const sc = scanChunk(p);
        p = sc.rest;
        if (sc.star and sc.chunk.len == 0) {
            return std.mem.indexOfScalar(u8, n, '/') == null;
        }
        if (try matchChunk(sc.chunk, n)) |rest| {
            if (rest.len == 0 or p.len > 0) {
                n = rest;
                continue;
            }
        }
        if (sc.star) {
            var i: usize = 0;
            while (i < n.len and n[i] != '/') {
                const step = utf8Step(n[i..]);
                i += step;
                if (try matchChunk(sc.chunk, n[i..])) |rest| {
                    if (p.len == 0 and rest.len > 0) continue;
                    n = rest;
                    continue :chunks;
                }
            }
        }
        // Validate remaining pattern syntax even after mismatch (matches Go).
        while (p.len > 0) {
            const next = scanChunk(p);
            p = next.rest;
            _ = try matchChunk(next.chunk, "");
        }
        return false;
    }
    return n.len == 0;
}

const ScanResult = struct {
    star: bool,
    chunk: []const u8,
    rest: []const u8,
};

fn scanChunk(pattern: []const u8) ScanResult {
    var i: usize = 0;
    while (i < pattern.len and pattern[i] == '*') : (i += 1) {}
    const star = i > 0;
    const p = pattern[i..];
    var in_range = false;
    var j: usize = 0;
    while (j < p.len) : (j += 1) {
        switch (p[j]) {
            '\\' => {
                if (j + 1 < p.len) j += 1;
            },
            '[' => in_range = true,
            ']' => in_range = false,
            '*' => {
                if (!in_range) return .{ .star = star, .chunk = p[0..j], .rest = p[j..] };
            },
            else => {},
        }
    }
    return .{ .star = star, .chunk = p, .rest = "" };
}

fn matchChunk(chunk_in: []const u8, s_in: []const u8) MatchError!?[]const u8 {
    var chunk = chunk_in;
    var s = s_in;
    var failed = false;
    while (chunk.len > 0) {
        if (s.len == 0) failed = true;
        switch (chunk[0]) {
            '[' => {
                var r: u21 = 0;
                if (!failed) {
                    const dec = decodeUtf8(s);
                    r = dec.cp;
                    s = s[dec.len..];
                }
                chunk = chunk[1..];
                var negated = false;
                if (chunk.len > 0 and chunk[0] == '^') {
                    negated = true;
                    chunk = chunk[1..];
                }
                var matched = false;
                var nrange: usize = 0;
                while (true) {
                    if (chunk.len > 0 and chunk[0] == ']' and nrange > 0) {
                        chunk = chunk[1..];
                        break;
                    }
                    const lo = try getEsc(chunk);
                    chunk = lo.rest;
                    var hi = lo.cp;
                    if (chunk.len > 0 and chunk[0] == '-') {
                        const h = try getEsc(chunk[1..]);
                        chunk = h.rest;
                        hi = h.cp;
                    }
                    if (!failed and lo.cp <= r and r <= hi) {
                        matched = true;
                    }
                    nrange += 1;
                }
                if (matched == negated) failed = true;
            },
            '?' => {
                if (!failed) {
                    if (s[0] == '/') failed = true;
                    const step = utf8Step(s);
                    s = s[step..];
                }
                chunk = chunk[1..];
            },
            '\\' => {
                chunk = chunk[1..];
                if (chunk.len == 0) return error.BadPattern;
                const pc = decodeUtf8(chunk);
                chunk = chunk[pc.len..];
                if (!failed) {
                    const sc = decodeUtf8(s);
                    if (sc.cp != pc.cp) failed = true;
                    s = s[sc.len..];
                }
            },
            else => {
                const pc = decodeUtf8(chunk);
                chunk = chunk[pc.len..];
                if (!failed) {
                    const sc = decodeUtf8(s);
                    if (sc.cp != pc.cp) failed = true;
                    s = s[sc.len..];
                }
            },
        }
    }
    if (failed) return null;
    return s;
}

const EscResult = struct {
    cp: u21,
    rest: []const u8,
};

fn getEsc(chunk_in: []const u8) MatchError!EscResult {
    var chunk = chunk_in;
    if (chunk.len == 0 or chunk[0] == '-' or chunk[0] == ']') return error.BadPattern;
    if (chunk[0] == '\\') {
        chunk = chunk[1..];
        if (chunk.len == 0) return error.BadPattern;
    }
    const dec = decodeUtf8(chunk);
    const rest = chunk[dec.len..];
    if (rest.len == 0) return error.BadPattern;
    return .{ .cp = dec.cp, .rest = rest };
}

const DecodedCp = struct {
    cp: u21,
    len: usize,
};

fn utf8Step(s: []const u8) usize {
    if (s.len == 0) return 0;
    const n = std.unicode.utf8ByteSequenceLength(s[0]) catch return 1;
    if (n > s.len) return 1;
    return n;
}

fn decodeUtf8(s: []const u8) DecodedCp {
    if (s.len == 0) return .{ .cp = 0, .len = 0 };
    const n = std.unicode.utf8ByteSequenceLength(s[0]) catch return .{ .cp = 0xFFFD, .len = 1 };
    if (n > s.len) return .{ .cp = 0xFFFD, .len = 1 };
    const cp: u21 = switch (n) {
        1 => s[0],
        2 => std.unicode.utf8Decode2(s[0..2].*) catch return .{ .cp = 0xFFFD, .len = 1 },
        3 => std.unicode.utf8Decode3(s[0..3].*) catch return .{ .cp = 0xFFFD, .len = 1 },
        4 => std.unicode.utf8Decode4(s[0..4].*) catch return .{ .cp = 0xFFFD, .len = 1 },
        else => return .{ .cp = 0xFFFD, .len = 1 },
    };
    return .{ .cp = cp, .len = n };
}

const testing = std.testing;

test "pathMatch follows Go path.Match semantics" {
    try testing.expect(try pathMatch("/healthz", "/healthz"));
    try testing.expect(!try pathMatch("/healthz", "/healthz/"));
    try testing.expect(try pathMatch("/debug/*", "/debug/vars"));
    try testing.expect(!try pathMatch("/debug/*", "/debug/pprof/heap"));
    try testing.expect(try pathMatch("/api/v?/users", "/api/v1/users"));
    try testing.expect(!try pathMatch("/api/v?/users", "/api/v12/users"));
    try testing.expect(!try pathMatch("/api/?/users", "/api///users"));
    try testing.expect(try pathMatch("/[a-z]*/ok", "/foo/ok"));
    try testing.expect(!try pathMatch("/[^a-z]*/ok", "/foo/ok"));
    try testing.expect(try pathMatch("/café", "/café"));
    try testing.expect(try pathMatch("/caf?", "/café"));
    try testing.expect(try pathMatch("/\\*lit", "/*lit"));

    try testing.expectError(error.BadPattern, pathMatch("[", "/a"));
    try testing.expectError(error.BadPattern, pathMatch("/a\\", "/a"));
    try testing.expectError(error.BadPattern, pathMatch("a[b-", "ax"));

    // matchesAny ignores malformed patterns safely.
    try testing.expect(!matchesAny(&.{ "[", "/healthz" }, "/work"));
    try testing.expect(matchesAny(&.{ "[", "/healthz", "/debug/*" }, "/debug/vars"));
}
