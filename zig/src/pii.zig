//! The PII token under the hash mode and the canonical rendering it hashes,
//! as Go's sensitivity policy computes them (go/policy.go, canonicalAttr and
//! token). See conformance/README.md, "pii-hash.json".
//!
//! A scalar renders as its text: a string as its raw bytes, an integer in
//! decimal, a float in Go's shortest strconv 'g' form, a bool as true or
//! false and bytes as standard base64. An array or a map renders as JSON of
//! its members' canonical forms, with map keys in UTF-8 byte order and
//! strings escaped as Go's encoding/json escapes them. The walk is bounded:
//! the root is depth 0, a node deeper than max_depth renders as truncated,
//! and once walk_budget nodes are spent every remaining node renders as
//! truncated too.

const std = @import("std");

const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;

/// The shortest key the hash mode accepts: 256 bits, the SHA-256 output
/// size, so the key is never the weakest part of the token.
pub const min_key_len = 32;

/// What every token starts with.
pub const token_prefix = "hmac-sha256:";

/// The length of a token: the prefix and 32 hex digits, 128 bits of the MAC.
pub const token_len = token_prefix.len + 32;

/// The deepest node the walk renders. The root is depth 0.
pub const max_depth = 16;

/// The nodes one walk may spend.
pub const walk_budget = 2048;

/// What stands in for a node past the depth bound or the node budget.
pub const truncated = "truncated";

/// A buffer of this length holds any float formatFloat renders.
pub const float_buffer_len = 32;

/// A value to tokenize. It mirrors the attribute values the bridges carry:
/// scalars, byte strings, arrays and maps.
pub const Value = union(enum) {
    string: []const u8,
    int: i64,
    float: f64,
    bool: bool,
    bytes: []const u8,
    array: []const Value,
    map: []const Member,
};

/// One member of a map value. A map may hold a key more than once. As with
/// a Go attribute map, every member is walked and the last one with a key is
/// rendered.
pub const Member = struct {
    key: []const u8,
    value: Value,
};

/// The errors canonical returns.
pub const Error = error{OutOfMemory};

/// The errors writeCanonical returns.
pub const WriteError = error{ OutOfMemory, WriteFailed };

/// Returns the canonical rendering of value, owned by the caller.
pub fn canonical(gpa: Allocator, value: Value) Error![]u8 {
    var out: Writer.Allocating = .init(gpa);
    defer out.deinit();
    // The allocating writer fails only when it cannot grow.
    writeCanonical(gpa, &out.writer, value) catch return error.OutOfMemory;
    return out.toOwnedSlice();
}

/// Writes the canonical rendering of value to w. gpa holds the scratch
/// space a map's sorted key order needs.
pub fn writeCanonical(gpa: Allocator, w: *Writer, value: Value) WriteError!void {
    switch (value) {
        .array, .map => {
            var walk: Walk = .{ .gpa = gpa };
            try walk.node(w, value, 0);
        },
        else => try writeScalar(w, value),
    }
}

/// Writes the token of a canonical rendering under key into out and returns
/// it: the prefix and the lowercase hex of the first 16 bytes of
/// HMAC-SHA256(key, canonical_text). The caller enforces min_key_len.
pub fn token(out: *[token_len]u8, key: []const u8, canonical_text: []const u8) []const u8 {
    var mac: [HmacSha256.mac_length]u8 = undefined;
    HmacSha256.create(&mac, canonical_text, key);
    @memcpy(out[0..token_prefix.len], token_prefix);
    const hex = std.fmt.bytesToHex(mac[0..16].*, .lower);
    @memcpy(out[token_prefix.len..], &hex);
    return out;
}

/// Writes f as Go's strconv.FormatFloat(f, 'g', -1, 64) renders it into buf
/// and returns it: the shortest digits that round-trip, in %e form when the
/// decimal exponent is below -4 or at least 6 and in %f form otherwise, with
/// NaN, +Inf, -Inf and -0 spelled as Go spells them.
pub fn formatFloat(buf: *[float_buffer_len]u8, f: f64) []const u8 {
    if (std.math.isNan(f)) return copy(buf, "NaN");
    if (std.math.isInf(f)) return copy(buf, if (f > 0) "+Inf" else "-Inf");
    var len: usize = 0;
    if (std.math.signbit(f)) {
        buf[0] = '-';
        len = 1;
    }
    if (f == 0) {
        buf[len] = '0';
        return buf[0 .. len + 1];
    }

    const decimal = std.fmt.float.binaryToDecimal(u64, @bitCast(f), 52, 11, false, &std.fmt.float.Backend64_TablesFull);
    var mantissa = decimal.mantissa;
    var exponent = decimal.exponent;
    while (mantissa % 10 == 0) {
        mantissa /= 10;
        exponent += 1;
    }
    var digit_buf: [20]u8 = undefined;
    var nd: usize = 0;
    while (mantissa != 0) : (mantissa /= 10) {
        digit_buf[digit_buf.len - 1 - nd] = '0' + @as(u8, @intCast(mantissa % 10));
        nd += 1;
    }
    const digits = digit_buf[digit_buf.len - nd ..];
    // The value is 0.<digits> times ten to the power dp.
    const dp: i32 = exponent + @as(i32, @intCast(nd));
    const exp = dp - 1;

    if (exp < -4 or exp >= 6) {
        buf[len] = digits[0];
        len += 1;
        if (nd > 1) {
            buf[len] = '.';
            len += 1;
            @memcpy(buf[len..][0 .. nd - 1], digits[1..]);
            len += nd - 1;
        }
        buf[len] = 'e';
        buf[len + 1] = if (exp < 0) '-' else '+';
        len += 2;
        const abs: u32 = @abs(exp);
        if (abs >= 100) {
            buf[len] = '0' + @as(u8, @intCast(abs / 100));
            len += 1;
        }
        buf[len] = '0' + @as(u8, @intCast(abs / 10 % 10));
        buf[len + 1] = '0' + @as(u8, @intCast(abs % 10));
        return buf[0 .. len + 2];
    }
    if (dp <= 0) {
        const zeros: usize = @intCast(-dp);
        @memcpy(buf[len..][0..2], "0.");
        len += 2;
        @memset(buf[len..][0..zeros], '0');
        len += zeros;
        @memcpy(buf[len..][0..nd], digits);
        return buf[0 .. len + nd];
    }
    const int_len: usize = @intCast(dp);
    if (nd <= int_len) {
        @memcpy(buf[len..][0..nd], digits);
        len += nd;
        @memset(buf[len..][0 .. int_len - nd], '0');
        return buf[0 .. len + int_len - nd];
    }
    @memcpy(buf[len..][0..int_len], digits[0..int_len]);
    len += int_len;
    buf[len] = '.';
    len += 1;
    @memcpy(buf[len..][0 .. nd - int_len], digits[int_len..]);
    return buf[0 .. len + nd - int_len];
}

fn copy(buf: *[float_buffer_len]u8, text: []const u8) []const u8 {
    @memcpy(buf[0..text.len], text);
    return buf[0..text.len];
}

/// Writes a scalar's canonical text. A string is written as its raw bytes.
fn writeScalar(w: *Writer, value: Value) Writer.Error!void {
    switch (value) {
        .string => |s| try w.writeAll(s),
        .int => |i| try w.print("{d}", .{i}),
        .float => |f| {
            var buf: [float_buffer_len]u8 = undefined;
            try w.writeAll(formatFloat(&buf, f));
        },
        .bool => |b| try w.writeAll(if (b) "true" else "false"),
        .bytes => |b| try std.base64.standard.Encoder.encodeWriter(w, b),
        .array, .map => {},
    }
}

/// One bounded walk over a composite value, rendering as it goes.
const Walk = struct {
    gpa: Allocator,
    budget: usize = walk_budget,

    /// Takes one node from the budget and reports whether any remained.
    fn spend(walk: *Walk) bool {
        if (walk.budget == 0) return false;
        walk.budget -= 1;
        return true;
    }

    fn node(walk: *Walk, w: *Writer, value: Value, depth: usize) WriteError!void {
        // As in Go, a node past the depth bound does not spend the budget.
        if (depth > max_depth or !walk.spend()) return writeJsonString(w, truncated);
        switch (value) {
            .string => |s| try writeJsonString(w, s),
            .array => |items| {
                try w.writeByte('[');
                for (items, 0..) |item, i| {
                    if (i != 0) try w.writeByte(',');
                    try walk.node(w, item, depth + 1);
                }
                try w.writeByte(']');
            },
            .map => |members| try walk.map(w, members, depth),
            // The text of the other scalars never needs a JSON escape.
            else => {
                try w.writeByte('"');
                try writeScalar(w, value);
                try w.writeByte('"');
            },
        }
    }

    fn map(walk: *Walk, w: *Writer, members: []const Member, depth: usize) WriteError!void {
        const order = try walk.gpa.alloc(usize, members.len);
        defer walk.gpa.free(order);
        for (order, 0..) |*o, i| o.* = i;
        std.mem.sort(usize, order, members, keyLessThan);

        try w.writeByte('{');
        var first = true;
        for (order, 0..) |m, i| {
            const member = members[m];
            if (i + 1 < order.len and std.mem.eql(u8, members[order[i + 1]].key, member.key)) {
                // Go walks every member of an attribute map and keeps the
                // last with a key, so an earlier one spends its nodes but
                // is not rendered.
                var discard: Writer.Discarding = .init(&.{});
                try walk.node(&discard.writer, member.value, depth + 1);
                continue;
            }
            if (!first) try w.writeByte(',');
            first = false;
            try writeJsonString(w, member.key);
            try w.writeByte(':');
            try walk.node(w, member.value, depth + 1);
        }
        try w.writeByte('}');
    }

    /// Orders map members by key in UTF-8 byte order, then by position, so
    /// members sharing a key keep their order.
    fn keyLessThan(members: []const Member, a: usize, b: usize) bool {
        return switch (std.mem.order(u8, members[a].key, members[b].key)) {
            .lt => true,
            .gt => false,
            .eq => a < b,
        };
    }
};

/// Writes s as a JSON string the way Go's encoding/json does with HTML
/// escaping on: <, > and & as \u003c, \u003e and \u0026, U+2028 and U+2029
/// escaped, \b, \f, \n, \r and \t as themselves, other control characters
/// as \u00XX, and each byte of invalid UTF-8 as \ufffd.
fn writeJsonString(w: *Writer, s: []const u8) Writer.Error!void {
    const hex = "0123456789abcdef";
    try w.writeByte('"');
    var start: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const b = s[i];
        if (b < 0x80) {
            if (b >= 0x20 and b != '"' and b != '\\' and b != '<' and b != '>' and b != '&') {
                i += 1;
                continue;
            }
            try w.writeAll(s[start..i]);
            switch (b) {
                '"', '\\' => try w.writeAll(&.{ '\\', b }),
                0x08 => try w.writeAll("\\b"),
                0x0c => try w.writeAll("\\f"),
                '\n' => try w.writeAll("\\n"),
                '\r' => try w.writeAll("\\r"),
                '\t' => try w.writeAll("\\t"),
                else => try w.writeAll(&.{ '\\', 'u', '0', '0', hex[b >> 4], hex[b & 0x0f] }),
            }
            i += 1;
            start = i;
            continue;
        }
        const n = runeLen(s[i..]);
        if (n == 0) {
            try w.writeAll(s[start..i]);
            try w.writeAll("\\ufffd");
            i += 1;
            start = i;
            continue;
        }
        if (n == 3 and b == 0xe2 and s[i + 1] == 0x80 and (s[i + 2] == 0xa8 or s[i + 2] == 0xa9)) {
            try w.writeAll(s[start..i]);
            try w.writeAll(&.{ '\\', 'u', '2', '0', '2', hex[s[i + 2] & 0x0f] });
            i += 3;
            start = i;
            continue;
        }
        i += n;
    }
    try w.writeAll(s[start..]);
    try w.writeByte('"');
}

/// Returns the length of the valid UTF-8 sequence at the start of p, which
/// begins with a byte of 0x80 or more, or 0 when it is invalid, as Go's
/// utf8.DecodeRune decides: overlong forms, surrogates, values past
/// U+10FFFF and truncated sequences are invalid.
fn runeLen(p: []const u8) usize {
    var len: usize = 3;
    var lo: u8 = 0x80;
    var hi: u8 = 0xbf;
    switch (p[0]) {
        0xc2...0xdf => len = 2,
        0xe0 => lo = 0xa0,
        0xe1...0xec, 0xee, 0xef => {},
        0xed => hi = 0x9f,
        0xf0 => {
            len = 4;
            lo = 0x90;
        },
        0xf1...0xf3 => len = 4,
        0xf4 => {
            len = 4;
            hi = 0x8f;
        },
        else => return 0,
    }
    if (p.len < len or p[1] < lo or p[1] > hi) return 0;
    for (p[2..len]) |c| {
        if (c < 0x80 or c > 0xbf) return 0;
    }
    return len;
}

const testing = std.testing;

/// The 32-byte key of conformance/vectors/pii-hash.json, bytes 0 to 31.
const vector_key: [32]u8 = blk: {
    var key: [32]u8 = undefined;
    for (&key, 0..) |*b, i| b.* = @intCast(i);
    break :blk key;
};

fn expectCanonical(value: Value, want_canonical: []const u8, want_token: []const u8) !void {
    const got = try canonical(testing.allocator, value);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(want_canonical, got);
    var buf: [token_len]u8 = undefined;
    try testing.expectEqualStrings(want_token, token(&buf, &vector_key, got));
}

fn expectRendering(value: Value, want: []const u8) !void {
    const got = try canonical(testing.allocator, value);
    defer testing.allocator.free(got);
    try testing.expectEqualStrings(want, got);
}

/// Returns s repeated n times, at compile time.
fn repeat(comptime s: []const u8, comptime n: usize) *const [s.len * n]u8 {
    const result = comptime blk: {
        var out: [s.len * n]u8 = undefined;
        for (0..n) |i| @memcpy(out[i * s.len ..][0..s.len], s);
        break :blk out;
    };
    return &result;
}

test "the minimum key is 32 bytes" {
    try testing.expectEqual(32, min_key_len);
    try testing.expectEqual(44, token_len);
}

test "canonical and token match the small cases of conformance/vectors/pii-hash.json" {
    const s = struct {
        fn str(x: []const u8) Value {
            return .{ .string = x };
        }
    };
    const cases = [_]struct { name: []const u8, value: Value, canonical: []const u8, token: []const u8 }{
        .{ .name = "email", .value = s.str("alice@example.com"), .canonical = "alice@example.com", .token = "hmac-sha256:a59fc578d4cb46faab1d6eb348e7c74b" },
        .{ .name = "empty string", .value = s.str(""), .canonical = "", .token = "hmac-sha256:d38b42096d80f45f826b44a9d5607de7" },
        .{ .name = "non-ascii string", .value = s.str("café 日本 🎉"), .canonical = "café 日本 🎉", .token = "hmac-sha256:17208e8ff3b1cfd57bca94970128aae6" },
        .{ .name = "html in a scalar stays raw", .value = s.str("<a href='x'>&amp;</a>"), .canonical = "<a href='x'>&amp;</a>", .token = "hmac-sha256:155f6481a36cc3ee7cddc0fd89d76ee4" },
        .{ .name = "zero", .value = .{ .int = 0 }, .canonical = "0", .token = "hmac-sha256:3a8b171143bc3fe5972827cf3a413e96" },
        .{ .name = "negative int", .value = .{ .int = -42 }, .canonical = "-42", .token = "hmac-sha256:2156a1be40679f64ac98cbf96a0f1ecb" },
        .{ .name = "largest safe int", .value = .{ .int = 9007199254740991 }, .canonical = "9007199254740991", .token = "hmac-sha256:0a0b794f6e56fdac13bd198cb44f3ef2" },
        .{ .name = "tenth", .value = .{ .float = 0.1 }, .canonical = "0.1", .token = "hmac-sha256:c68a3e99cfa273f05af4a18d4c754703" },
        .{ .name = "small negative float", .value = .{ .float = -2.5e-7 }, .canonical = "-2.5e-07", .token = "hmac-sha256:2a57a0b77992578a46a7bbfbeace9b95" },
        .{ .name = "float below the exponent threshold", .value = .{ .float = 0.00001 }, .canonical = "1e-05", .token = "hmac-sha256:77c479dcdaf815f4f9c58f721a14a447" },
        .{ .name = "float with a fraction", .value = .{ .float = 123456.789 }, .canonical = "123456.789", .token = "hmac-sha256:c64edf4b45861fbc3d47220982d6c76a" },
        .{ .name = "float past six digits", .value = .{ .float = 1234567.5 }, .canonical = "1.2345675e+06", .token = "hmac-sha256:7024eaef4243d7399e1443b421150b57" },
        .{ .name = "float past the safe range", .value = .{ .float = 1e21 }, .canonical = "1e+21", .token = "hmac-sha256:0e08c007c8e1e18b34d2d22c513bf23f" },
        .{ .name = "largest float", .value = .{ .float = 1.7976931348623157e308 }, .canonical = "1.7976931348623157e+308", .token = "hmac-sha256:a071b269ae5d91d7c825dc8c61d84b03" },
        .{ .name = "true", .value = .{ .bool = true }, .canonical = "true", .token = "hmac-sha256:4476aeee13a643ca50916f9b6ef8acc9" },
        .{ .name = "false", .value = .{ .bool = false }, .canonical = "false", .token = "hmac-sha256:a290a0a8027b071c7aa39d6678a6a5cd" },
        .{ .name = "string array", .value = .{ .array = &.{ s.str("10.0.0.1"), s.str("10.0.0.2") } }, .canonical = "[\"10.0.0.1\",\"10.0.0.2\"]", .token = "hmac-sha256:74fd8811b927fee646edd1bb631dcc4d" },
        .{ .name = "html-escaped array members", .value = .{ .array = &.{ s.str("<a&b>"), s.str("\u{2028}\u{2029}") } }, .canonical = "[\"\\u003ca\\u0026b\\u003e\",\"\\u2028\\u2029\"]", .token = "hmac-sha256:72d41a69c75361aebef29a135472296b" },
        .{ .name = "control characters in an array", .value = .{ .array = &.{s.str("\x08\x0c\x01\t\n\"\\")} }, .canonical = "[\"\\b\\f\\u0001\\t\\n\\\"\\\\\"]", .token = "hmac-sha256:d6835b7e9986f560aaa5e9293ba9c5fa" },
        .{ .name = "empty array", .value = .{ .array = &.{} }, .canonical = "[]", .token = "hmac-sha256:445cf8baebc4c11c8a0e0d9e2d8923e8" },
        .{ .name = "int array", .value = .{ .array = &.{ .{ .int = 1 }, .{ .int = 2 }, .{ .int = 3 } } }, .canonical = "[\"1\",\"2\",\"3\"]", .token = "hmac-sha256:48f379dedb1e561ba627147182f88c43" },
        .{ .name = "float array", .value = .{ .array = &.{ .{ .float = 0.5 }, .{ .float = 1e-7 } } }, .canonical = "[\"0.5\",\"1e-07\"]", .token = "hmac-sha256:6c968f55412b67535375f0f6084c5632" },
        .{ .name = "bool array", .value = .{ .array = &.{ .{ .bool = true }, .{ .bool = false } } }, .canonical = "[\"true\",\"false\"]", .token = "hmac-sha256:97117ff63b1152ff0654322a4a19c711" },
        .{ .name = "bytes", .value = .{ .bytes = &.{ 0, 1, 2, 3, 255 } }, .canonical = "AAECA/8=", .token = "hmac-sha256:0c3581e68e6e420b259b927babaf0f70" },
        .{ .name = "map with unsorted keys", .value = .{ .map = &.{ .{ .key = "b", .value = s.str("2") }, .{ .key = "a", .value = s.str("x") } } }, .canonical = "{\"a\":\"x\",\"b\":\"2\"}", .token = "hmac-sha256:8f869d729defead815553c4042ebdc88" },
        .{ .name = "map keys in utf-8 byte order", .value = .{ .map = &.{
            .{ .key = "😀", .value = s.str("e") },
            .{ .key = "a", .value = s.str("c") },
            .{ .key = "\u{ff61}", .value = s.str("d") },
            .{ .key = "2", .value = s.str("b") },
            .{ .key = "10", .value = s.str("a") },
        } }, .canonical = "{\"10\":\"a\",\"2\":\"b\",\"a\":\"c\",\"\u{ff61}\":\"d\",\"😀\":\"e\"}", .token = "hmac-sha256:2083d83c4caeaade64ef515c0ddb56d7" },
        .{ .name = "nested map with an array", .value = .{ .map = &.{
            .{ .key = "z", .value = .{ .map = &.{.{ .key = "y", .value = .{ .array = &.{ .{ .int = 1 }, s.str("<") } } }} } },
            .{ .key = "a", .value = .{ .bool = true } },
        } }, .canonical = "{\"a\":\"true\",\"z\":{\"y\":[\"1\",\"\\u003c\"]}}", .token = "hmac-sha256:38ac6f83a91a94c656b1ab01c1983059" },
    };
    for (cases) |c| {
        expectCanonical(c.value, c.canonical, c.token) catch |err| {
            std.debug.print("case {s}\n", .{c.name});
            return err;
        };
    }
}

/// Builds the cycledStrings values of go/vectors_internal_test.go: n
/// one-character strings cycling through a to j.
fn cycledStrings(gpa: Allocator, n: usize) ![]Value {
    const alphabet = "abcdefghij";
    const out = try gpa.alloc(Value, n);
    for (out, 0..) |*v, i| v.* = .{ .string = alphabet[i % alphabet.len ..][0..1] };
    return out;
}

/// Renders the expected canonical form of a string array: the first kept
/// elements of items, then truncated for the rest.
fn expectedArray(gpa: Allocator, items: []const Value, kept: usize) ![]u8 {
    var out: Writer.Allocating = .init(gpa);
    defer out.deinit();
    try out.writer.writeByte('[');
    for (items, 0..) |item, i| {
        if (i != 0) try out.writer.writeByte(',');
        try out.writer.print("\"{s}\"", .{if (i < kept) item.string else truncated});
    }
    try out.writer.writeByte(']');
    return out.toOwnedSlice();
}

test "a string array of 2047 elements spends the whole budget untruncated" {
    const items = try cycledStrings(testing.allocator, walk_budget - 1);
    defer testing.allocator.free(items);
    const want = try expectedArray(testing.allocator, items, items.len);
    defer testing.allocator.free(want);
    try testing.expectEqual(8189, want.len);
    try expectCanonical(.{ .array = items }, want, "hmac-sha256:9c25d0b77a813f3b2541005617797db9");
}

test "a string array of 2048 elements truncates its last element" {
    const items = try cycledStrings(testing.allocator, walk_budget);
    defer testing.allocator.free(items);
    const want = try expectedArray(testing.allocator, items, items.len - 1);
    defer testing.allocator.free(want);
    try testing.expectEqual(8201, want.len);
    try expectCanonical(.{ .array = items }, want, "hmac-sha256:ebe37915a400148972d082ce883b0c08");
}

test "a map nested 20 deep truncates at depth 17" {
    // deepMap(20) of go/vectors_internal_test.go.
    var levels: [21]Value = undefined;
    var members: [20]Member = undefined;
    levels[0] = .{ .string = "leaf" };
    for (&members, 0..) |*m, i| {
        m.* = .{ .key = "n", .value = levels[i] };
        levels[i + 1] = .{ .map = members[i..][0..1] };
    }
    const want = repeat("{\"n\":", 17) ++ "\"truncated\"" ++ repeat("}", 17);
    try expectCanonical(levels[20], want, "hmac-sha256:cbddae48935e0c2a3f1bff53d9e67533");
}

test "an array of 2100 elements under a map keeps 2046 of them" {
    const wide = try testing.allocator.alloc(Value, 2100);
    defer testing.allocator.free(wide);
    @memset(wide, .{ .string = "x" });
    const inner = try expectedArray(testing.allocator, wide, walk_budget - 2);
    defer testing.allocator.free(inner);
    const want = try std.mem.concat(testing.allocator, u8, &.{ "{\"a\":", inner, "}" });
    defer testing.allocator.free(want);
    try testing.expectEqual(8839, want.len);
    try testing.expectEqual(54, std.mem.count(u8, want, truncated));
    try expectCanonical(.{ .map = &.{.{ .key = "a", .value = .{ .array = wide } }} }, want, "hmac-sha256:50659edacd5ed8c49981d5be52ad27be");
}

test "formatFloat renders as Go's strconv.FormatFloat with 'g' and shortest precision" {
    const cases = [_]struct { f: f64, want: []const u8 }{
        .{ .f = 0.1, .want = "0.1" },
        .{ .f = -2.5e-7, .want = "-2.5e-07" },
        .{ .f = 1e21, .want = "1e+21" },
        .{ .f = 1e20, .want = "1e+20" },
        .{ .f = 1e23, .want = "1e+23" },
        .{ .f = 1e6, .want = "1e+06" },
        .{ .f = 100000, .want = "100000" },
        .{ .f = 123456, .want = "123456" },
        .{ .f = 999999, .want = "999999" },
        .{ .f = 1234567, .want = "1.234567e+06" },
        .{ .f = 123456.789, .want = "123456.789" },
        .{ .f = 1e-4, .want = "0.0001" },
        .{ .f = 0.000123, .want = "0.000123" },
        .{ .f = 1e-5, .want = "1e-05" },
        .{ .f = 5e-324, .want = "5e-324" },
        .{ .f = 2.2250738585072014e-308, .want = "2.2250738585072014e-308" },
        .{ .f = 1.7976931348623157e308, .want = "1.7976931348623157e+308" },
        .{ .f = -1.7976931348623157e308, .want = "-1.7976931348623157e+308" },
        .{ .f = 1e100, .want = "1e+100" },
        .{ .f = 1.5, .want = "1.5" },
        .{ .f = -3, .want = "-3" },
        .{ .f = 1, .want = "1" },
        .{ .f = 10, .want = "10" },
        .{ .f = 9007199254740992, .want = "9.007199254740992e+15" },
        .{ .f = 0.3, .want = "0.3" },
        .{ .f = 0.30000000000000004, .want = "0.30000000000000004" },
        .{ .f = 1.0 / 3.0, .want = "0.3333333333333333" },
        .{ .f = 0, .want = "0" },
        .{ .f = -0.0, .want = "-0" },
        .{ .f = std.math.nan(f64), .want = "NaN" },
        .{ .f = -std.math.nan(f64), .want = "NaN" },
        .{ .f = std.math.inf(f64), .want = "+Inf" },
        .{ .f = -std.math.inf(f64), .want = "-Inf" },
    };
    for (cases) |c| {
        var buf: [float_buffer_len]u8 = undefined;
        testing.expectEqualStrings(c.want, formatFloat(&buf, c.f)) catch |err| {
            std.debug.print("float {e}\n", .{c.f});
            return err;
        };
    }
}

test "special floats render as Go spells them inside arrays too" {
    try expectRendering(.{ .array = &.{ .{ .float = std.math.nan(f64) }, .{ .float = -std.math.inf(f64) }, .{ .float = -0.0 } } }, "[\"NaN\",\"-Inf\",\"-0\"]");
}

test "a scalar string keeps its raw bytes, invalid UTF-8 included" {
    try expectRendering(.{ .string = "a\xffb<" }, "a\xffb<");
}

test "JSON strings escape as Go's encoding/json does" {
    const cases = [_]struct { in: []const u8, want: []const u8 }{
        .{ .in = "a\xffb", .want = "[\"a\\ufffdb\"]" },
        // A surrogate encoding is three invalid bytes.
        .{ .in = "\xed\xa0\x80", .want = "[\"\\ufffd\\ufffd\\ufffd\"]" },
        // An overlong NUL is two.
        .{ .in = "\xc0\x80", .want = "[\"\\ufffd\\ufffd\"]" },
        // A truncated sequence replaces each byte.
        .{ .in = "\xe6\x97", .want = "[\"\\ufffd\\ufffd\"]" },
        .{ .in = "\xe6\x97A", .want = "[\"\\ufffd\\ufffdA\"]" },
        .{ .in = "\xf4\x90\x80\x80", .want = "[\"\\ufffd\\ufffd\\ufffd\\ufffd\"]" },
        // U+FFFD itself and the largest code point are valid.
        .{ .in = "\u{fffd}\u{10ffff}", .want = "[\"\u{fffd}\u{10ffff}\"]" },
        .{ .in = "\r\x1f\x7f", .want = "[\"\\r\\u001f\x7f\"]" },
        .{ .in = "\x00", .want = "[\"\\u0000\"]" },
        .{ .in = "'/+=", .want = "[\"'/+=\"]" },
        .{ .in = "\u{2027}\u{202a}", .want = "[\"\u{2027}\u{202a}\"]" },
    };
    for (cases) |c| {
        expectRendering(.{ .array = &.{.{ .string = c.in }} }, c.want) catch |err| {
            std.debug.print("input {x}\n", .{c.in});
            return err;
        };
    }
}

test "map keys are escaped and sorted by their raw bytes" {
    try expectRendering(.{ .map = &.{
        .{ .key = "b", .value = .{ .int = 2 } },
        .{ .key = "<", .value = .{ .string = "x" } },
        .{ .key = "\xff", .value = .{ .string = "y" } },
    } }, "{\"\\u003c\":\"x\",\"b\":\"2\",\"\\ufffd\":\"y\"}");
}

test "bytes inside a composite render as quoted base64" {
    try expectRendering(.{ .map = &.{.{ .key = "b", .value = .{ .bytes = &.{ 0, 1, 2 } } }} }, "{\"b\":\"AAEC\"}");
    try expectRendering(.{ .bytes = "" }, "");
}

test "a repeated map key renders its last member but spends every member's nodes" {
    try expectRendering(.{ .map = &.{
        .{ .key = "a", .value = .{ .int = 1 } },
        .{ .key = "b", .value = .{ .int = 3 } },
        .{ .key = "a", .value = .{ .int = 2 } },
    } }, "{\"a\":\"2\",\"b\":\"3\"}");

    // The first member spends the map node, itself and 2045 elements, so
    // the second has one node left and its elements truncate.
    const wide = try testing.allocator.alloc(Value, 2045);
    defer testing.allocator.free(wide);
    @memset(wide, .{ .string = "x" });
    try expectRendering(.{ .map = &.{
        .{ .key = "a", .value = .{ .array = wide } },
        .{ .key = "a", .value = .{ .array = &.{ .{ .int = 1 }, .{ .int = 2 } } } },
    } }, "{\"a\":[\"truncated\",\"truncated\"]}");
}

test "a scalar at depth 16 renders and one at depth 17 truncates" {
    // An array nested 16 deep holds its scalar at depth 16.
    var levels: [18]Value = undefined;
    var cells: [17]Value = undefined;
    levels[0] = .{ .int = 7 };
    for (&cells, 0..) |*cell, i| {
        cell.* = levels[i];
        levels[i + 1] = .{ .array = cells[i..][0..1] };
    }
    try expectRendering(levels[16], repeat("[", 16) ++ "\"7\"" ++ repeat("]", 16));
    try expectRendering(levels[17], repeat("[", 17) ++ "\"truncated\"" ++ repeat("]", 17));
}

test "a node past the depth bound does not spend the budget" {
    // An array at depth 16 whose 3000 elements sit at depth 17: none spends a
    // node, so the sibling after it still renders.
    const deep = try testing.allocator.alloc(Value, 3000);
    defer testing.allocator.free(deep);
    @memset(deep, .{ .string = "x" });
    var levels: [17]Value = undefined;
    var cells: [16]Value = undefined;
    levels[0] = .{ .array = deep };
    for (&cells, 0..) |*cell, i| {
        cell.* = levels[i];
        levels[i + 1] = .{ .array = cells[i..][0..1] };
    }
    const got = try canonical(testing.allocator, .{ .array = &.{ levels[15], .{ .string = "after" } } });
    defer testing.allocator.free(got);
    try testing.expect(std.mem.endsWith(u8, got, ",\"after\"]"));
    try testing.expectEqual(3000, std.mem.count(u8, got, truncated));
}

test "canonical reports allocation failure without leaking" {
    const value: Value = .{ .map = &.{
        .{ .key = "z", .value = .{ .map = &.{.{ .key = "y", .value = .{ .array = &.{ .{ .int = 1 }, .{ .string = "<" } } } }} } },
        .{ .key = "a", .value = .{ .bool = true } },
    } };
    try testing.checkAllAllocationFailures(testing.allocator, struct {
        fn run(gpa: Allocator, v: Value) !void {
            const out = try canonical(gpa, v);
            gpa.free(out);
        }
    }.run, .{value});
}

test "token is the prefix and 32 lowercase hex digits" {
    var buf: [token_len]u8 = undefined;
    const t = token(&buf, &vector_key, "alice@example.com");
    try testing.expectEqualStrings("hmac-sha256:a59fc578d4cb46faab1d6eb348e7c74b", t);
    // A different key gives a different token.
    var other: [token_len]u8 = undefined;
    try testing.expect(!std.mem.eql(u8, t, token(&other, repeat("k", min_key_len), "alice@example.com")));
}
