//! HPACK header compression for HTTP/2 (RFC 7541).
//!
//! The encoder writes request headers using static-table lookups and literal
//! header fields (without indexing, or never-indexed for sensitive headers),
//! enforcing HTTP/2 lowercase header hygiene. The decoder implements all of
//! RFC 7541: the 61-entry static table, the FIFO dynamic table with table size
//! updates, arbitrary-prefix integer decoding and Appendix B Huffman decoding
//! with strict EOS padding validation.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;

/// A single decoded or encoded HTTP/2 header field.
pub const Header = struct {
    name: []const u8,
    value: []const u8,
};

/// Default dynamic table size (RFC 9113 Section 6.5.2).
pub const default_table_size: usize = 4096;

/// Default maximum decoded header list size per block, counted with the
/// 32-byte per-field overhead of RFC 9113 Section 6.5.2.
pub const default_max_header_list_size: usize = 64 * 1024;

/// Per-entry overhead in the dynamic table (RFC 7541 Section 4.1).
const entry_overhead: usize = 32;

/// Errors returned by HPACK encoding.
pub const EncodeError = error{
    InvalidHeader,
    WriteFailed,
    OutOfMemory,
};

/// Errors returned by HPACK decoding.
pub const DecodeError = error{
    Truncated,
    IntegerOverflow,
    InvalidIndex,
    InvalidHuffman,
    InvalidTableSizeUpdate,
    HeaderListTooLarge,
    OutOfMemory,
};

/// Options controlling how a header field is encoded.
pub const EncodeOptions = struct {
    /// Encode literal strings with RFC 7541 Appendix B Huffman coding.
    huffman: bool = false,
    /// Representation choice. `auto` uses static indexed fields, literal
    /// never-indexed for sensitive headers, and literal without-indexing for
    /// all others.
    indexing: Indexing = .auto,

    pub const Indexing = enum {
        auto,
        without,
        never,
        incremental,
    };
};

/// RFC 7541 Appendix A static table (1-based indices 1..61).
pub const static_table = [61]Header{
    .{ .name = ":authority", .value = "" },
    .{ .name = ":method", .value = "GET" },
    .{ .name = ":method", .value = "POST" },
    .{ .name = ":path", .value = "/" },
    .{ .name = ":path", .value = "/index.html" },
    .{ .name = ":scheme", .value = "http" },
    .{ .name = ":scheme", .value = "https" },
    .{ .name = ":status", .value = "200" },
    .{ .name = ":status", .value = "204" },
    .{ .name = ":status", .value = "206" },
    .{ .name = ":status", .value = "304" },
    .{ .name = ":status", .value = "400" },
    .{ .name = ":status", .value = "404" },
    .{ .name = ":status", .value = "500" },
    .{ .name = "accept-charset", .value = "" },
    .{ .name = "accept-encoding", .value = "gzip, deflate" },
    .{ .name = "accept-language", .value = "" },
    .{ .name = "accept-ranges", .value = "" },
    .{ .name = "accept", .value = "" },
    .{ .name = "access-control-allow-origin", .value = "" },
    .{ .name = "age", .value = "" },
    .{ .name = "allow", .value = "" },
    .{ .name = "authorization", .value = "" },
    .{ .name = "cache-control", .value = "" },
    .{ .name = "content-disposition", .value = "" },
    .{ .name = "content-encoding", .value = "" },
    .{ .name = "content-language", .value = "" },
    .{ .name = "content-length", .value = "" },
    .{ .name = "content-location", .value = "" },
    .{ .name = "content-range", .value = "" },
    .{ .name = "content-type", .value = "" },
    .{ .name = "cookie", .value = "" },
    .{ .name = "date", .value = "" },
    .{ .name = "etag", .value = "" },
    .{ .name = "expect", .value = "" },
    .{ .name = "expires", .value = "" },
    .{ .name = "from", .value = "" },
    .{ .name = "host", .value = "" },
    .{ .name = "if-match", .value = "" },
    .{ .name = "if-modified-since", .value = "" },
    .{ .name = "if-none-match", .value = "" },
    .{ .name = "if-range", .value = "" },
    .{ .name = "if-unmodified-since", .value = "" },
    .{ .name = "last-modified", .value = "" },
    .{ .name = "link", .value = "" },
    .{ .name = "location", .value = "" },
    .{ .name = "max-forwards", .value = "" },
    .{ .name = "proxy-authenticate", .value = "" },
    .{ .name = "proxy-authorization", .value = "" },
    .{ .name = "range", .value = "" },
    .{ .name = "referer", .value = "" },
    .{ .name = "refresh", .value = "" },
    .{ .name = "retry-after", .value = "" },
    .{ .name = "server", .value = "" },
    .{ .name = "set-cookie", .value = "" },
    .{ .name = "strict-transport-security", .value = "" },
    .{ .name = "transfer-encoding", .value = "" },
    .{ .name = "user-agent", .value = "" },
    .{ .name = "vary", .value = "" },
    .{ .name = "via", .value = "" },
    .{ .name = "www-authenticate", .value = "" },
};

/// RFC 7541 Appendix B Huffman codes for bytes 0..255.
const huffman_codes = [256]u32{
    0x1ff8,    0x7fffd8,  0xfffffe2,  0xfffffe3, 0xfffffe4, 0xfffffe5,  0xfffffe6,  0xfffffe7,
    0xfffffe8, 0xffffea,  0x3ffffffc, 0xfffffe9, 0xfffffea, 0x3ffffffd, 0xfffffeb,  0xfffffec,
    0xfffffed, 0xfffffee, 0xfffffef,  0xffffff0, 0xffffff1, 0xffffff2,  0x3ffffffe, 0xffffff3,
    0xffffff4, 0xffffff5, 0xffffff6,  0xffffff7, 0xffffff8, 0xffffff9,  0xffffffa,  0xffffffb,
    0x14,      0x3f8,     0x3f9,      0xffa,     0x1ff9,    0x15,       0xf8,       0x7fa,
    0x3fa,     0x3fb,     0xf9,       0x7fb,     0xfa,      0x16,       0x17,       0x18,
    0x0,       0x1,       0x2,        0x19,      0x1a,      0x1b,       0x1c,       0x1d,
    0x1e,      0x1f,      0x5c,       0xfb,      0x7ffc,    0x20,       0xffb,      0x3fc,
    0x1ffa,    0x21,      0x5d,       0x5e,      0x5f,      0x60,       0x61,       0x62,
    0x63,      0x64,      0x65,       0x66,      0x67,      0x68,       0x69,       0x6a,
    0x6b,      0x6c,      0x6d,       0x6e,      0x6f,      0x70,       0x71,       0x72,
    0xfc,      0x73,      0xfd,       0x1ffb,    0x7fff0,   0x1ffc,     0x3ffc,     0x22,
    0x7ffd,    0x3,       0x23,       0x4,       0x24,      0x5,        0x25,       0x26,
    0x27,      0x6,       0x74,       0x75,      0x28,      0x29,       0x2a,       0x7,
    0x2b,      0x76,      0x2c,       0x8,       0x9,       0x2d,       0x77,       0x78,
    0x79,      0x7a,      0x7b,       0x7ffe,    0x7fc,     0x3ffd,     0x1ffd,     0xffffffc,
    0xfffe6,   0x3fffd2,  0xfffe7,    0xfffe8,   0x3fffd3,  0x3fffd4,   0x3fffd5,   0x7fffd9,
    0x3fffd6,  0x7fffda,  0x7fffdb,   0x7fffdc,  0x7fffdd,  0x7fffde,   0xffffeb,   0x7fffdf,
    0xffffec,  0xffffed,  0x3fffd7,   0x7fffe0,  0xffffee,  0x7fffe1,   0x7fffe2,   0x7fffe3,
    0x7fffe4,  0x1fffdc,  0x3fffd8,   0x7fffe5,  0x3fffd9,  0x7fffe6,   0x7fffe7,   0xffffef,
    0x3fffda,  0x1fffdd,  0xfffe9,    0x3fffdb,  0x3fffdc,  0x7fffe8,   0x7fffe9,   0x1fffde,
    0x7fffea,  0x3fffdd,  0x3fffde,   0xfffff0,  0x1fffdf,  0x3fffdf,   0x7fffeb,   0x7fffec,
    0x1fffe0,  0x1fffe1,  0x3fffe0,   0x1fffe2,  0x7fffed,  0x3fffe1,   0x7fffee,   0x7fffef,
    0xfffea,   0x3fffe2,  0x3fffe3,   0x3fffe4,  0x7ffff0,  0x3fffe5,   0x3fffe6,   0x7ffff1,
    0x3ffffe0, 0x3ffffe1, 0xfffeb,    0x7fff1,   0x3fffe7,  0x7ffff2,   0x3fffe8,   0x1ffffec,
    0x3ffffe2, 0x3ffffe3, 0x3ffffe4,  0x7ffffde, 0x7ffffdf, 0x3ffffe5,  0xfffff1,   0x1ffffed,
    0x7fff2,   0x1fffe3,  0x3ffffe6,  0x7ffffe0, 0x7ffffe1, 0x3ffffe7,  0x7ffffe2,  0xfffff2,
    0x1fffe4,  0x1fffe5,  0x3ffffe8,  0x3ffffe9, 0xffffffd, 0x7ffffe3,  0x7ffffe4,  0x7ffffe5,
    0xfffec,   0xfffff3,  0xfffed,    0x1fffe6,  0x3fffe9,  0x1fffe7,   0x1fffe8,   0x7ffff3,
    0x3fffea,  0x3fffeb,  0x1ffffee,  0x1ffffef, 0xfffff4,  0xfffff5,   0x3ffffea,  0x7ffff4,
    0x3ffffeb, 0x7ffffe6, 0x3ffffec,  0x3ffffed, 0x7ffffe7, 0x7ffffe8,  0x7ffffe9,  0x7ffffea,
    0x7ffffeb, 0xffffffe, 0x7ffffec,  0x7ffffed, 0x7ffffee, 0x7ffffef,  0x7fffff0,  0x3ffffee,
};

/// RFC 7541 Appendix B Huffman code bit lengths for bytes 0..255.
const huffman_lengths = [256]u5{
    13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28,
    28, 28, 28, 28, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 28,
    6,  10, 10, 12, 13, 6,  8,  11, 10, 10, 8,  11, 8,  6,  6,  6,
    5,  5,  5,  6,  6,  6,  6,  6,  6,  6,  7,  8,  15, 6,  12, 10,
    13, 6,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,  7,
    7,  7,  7,  7,  7,  7,  7,  7,  8,  7,  8,  13, 19, 13, 14, 6,
    15, 5,  6,  5,  6,  5,  6,  6,  6,  5,  7,  7,  6,  6,  6,  5,
    6,  7,  6,  5,  5,  6,  7,  7,  7,  7,  7,  15, 11, 14, 13, 28,
    20, 22, 20, 20, 22, 22, 22, 23, 22, 23, 23, 23, 23, 23, 24, 23,
    24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24,
    22, 21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23,
    21, 21, 22, 21, 23, 22, 23, 23, 20, 22, 22, 22, 23, 22, 22, 23,
    26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25,
    19, 21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27,
    20, 24, 20, 21, 22, 21, 21, 23, 22, 22, 25, 25, 24, 24, 26, 23,
    26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26,
};

const huffman_eos_code: u32 = 0x3fffffff;
const huffman_eos_len: u5 = 30;
const huffman_eos_sym: u16 = 256;
const huffman_no_sym: u16 = 0xffff;

const HuffmanNode = struct {
    child: [2]u16 = .{ 0, 0 },
    sym: u16 = huffman_no_sym,
};

/// Complete binary trie for RFC 7541 Appendix B (257 leaves -> 513 nodes).
/// Built and verified for prefix-freeness and completeness at compile time.
const huffman_trie: [513]HuffmanNode = buildHuffmanTrie();

fn buildHuffmanTrie() [513]HuffmanNode {
    @setEvalBranchQuota(50_000);
    var nodes: [513]HuffmanNode = @splat(.{});
    var next_id: u16 = 1;

    for (0..257) |sym| {
        const code: u32 = if (sym < 256) huffman_codes[sym] else huffman_eos_code;
        const bit_len: u5 = if (sym < 256) huffman_lengths[sym] else huffman_eos_len;
        var cur: u16 = 0;
        var bit_pos: u5 = bit_len;
        while (bit_pos > 0) {
            bit_pos -= 1;
            if (nodes[cur].sym != huffman_no_sym) @compileError("HPACK Huffman prefix collision");
            const bit: u1 = @truncate(code >> bit_pos);
            if (nodes[cur].child[bit] == 0) {
                nodes[cur].child[bit] = next_id;
                next_id += 1;
            }
            cur = nodes[cur].child[bit];
        }
        if (nodes[cur].sym != huffman_no_sym) @compileError("HPACK Huffman duplicate code");
        nodes[cur].sym = @intCast(sym);
    }
    if (next_id != nodes.len) @compileError("HPACK Huffman tree is not complete");
    for (nodes) |n| {
        if (n.sym == huffman_no_sym) {
            if (n.child[0] == 0 or n.child[1] == 0) @compileError("HPACK Huffman internal node missing child");
        }
    }
    return nodes;
}

/// Reports whether `name` is a valid HTTP/2 header name: either one of the
/// standard pseudo-headers or a non-empty lowercase RFC 9110 token.
pub fn validHeaderName(name: []const u8) bool {
    if (name.len == 0) return false;
    if (name[0] == ':') {
        return std.mem.eql(u8, name, ":authority") or
            std.mem.eql(u8, name, ":method") or
            std.mem.eql(u8, name, ":path") or
            std.mem.eql(u8, name, ":scheme") or
            std.mem.eql(u8, name, ":status");
    }
    for (name) |ch| {
        const ok = (ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or switch (ch) {
            '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~' => true,
            else => false,
        };
        if (!ok) return false;
    }
    return true;
}

/// Reports whether `value` is a valid HTTP/2 header value (no CR, LF or NUL).
pub fn validHeaderValue(value: []const u8) bool {
    return std.mem.indexOfAny(u8, value, "\r\n\x00") == null;
}

/// Reports whether a header carries credentials and should be encoded as
/// literal never-indexed.
pub fn isSensitive(name: []const u8) bool {
    return std.mem.eql(u8, name, "authorization") or
        std.mem.eql(u8, name, "proxy-authorization") or
        std.mem.eql(u8, name, "cookie");
}

/// Encodes an HPACK integer (RFC 7541 Section 5.1) with `prefix_bits` (1..8).
pub fn encodeInt(w: *Io.Writer, first_byte_mask: u8, comptime prefix_bits: u4, value: u64) Io.Writer.Error!void {
    const max_prefix: u64 = (@as(u64, 1) << prefix_bits) - 1;
    if (value < max_prefix) {
        try w.writeByte(first_byte_mask | @as(u8, @intCast(value)));
        return;
    }
    try w.writeByte(first_byte_mask | @as(u8, @intCast(max_prefix)));
    var v = value - max_prefix;
    while (v >= 128) : (v >>= 7) {
        try w.writeByte(@as(u8, @intCast(v & 0x7f)) | 0x80);
    }
    try w.writeByte(@intCast(v));
}

/// Decodes an HPACK integer (RFC 7541 Section 5.1) with `prefix_bits` (1..8).
pub fn decodeInt(data: []const u8, pos: *usize, comptime prefix_bits: u4) DecodeError!u64 {
    if (pos.* >= data.len) return error.Truncated;
    const max_prefix: u64 = (@as(u64, 1) << prefix_bits) - 1;
    var value: u64 = data[pos.*] & @as(u8, @intCast(max_prefix));
    pos.* += 1;
    if (value < max_prefix) return value;

    var shift: u7 = 0;
    while (true) {
        if (pos.* >= data.len) return error.Truncated;
        const b = data[pos.*];
        pos.* += 1;
        const low: u64 = b & 0x7f;
        if (shift >= 64) return error.IntegerOverflow;
        const s: u6 = @intCast(shift);
        // Reject if shifting `low` left by `s` drops any set bit.
        if (s > 0 and (low >> @intCast(64 - @as(u7, s))) != 0) return error.IntegerOverflow;
        const addend = low << s;
        value = std.math.add(u64, value, addend) catch return error.IntegerOverflow;
        if ((b & 0x80) == 0) return value;
        shift += 7;
    }
}

/// Encodes `input` with RFC 7541 Appendix B Huffman coding, padding the last
/// byte with 1-bits (prefix of EOS).
pub fn huffmanEncode(gpa: Allocator, input: []const u8) Allocator.Error![]u8 {
    var total_bits: usize = 0;
    for (input) |b| total_bits += huffman_lengths[b];
    const out_len = (total_bits + 7) / 8;
    const out = try gpa.alloc(u8, out_len);
    var out_idx: usize = 0;
    var acc: u64 = 0;
    var bits: u6 = 0;
    for (input) |b| {
        const len = huffman_lengths[b];
        acc = (acc << len) | huffman_codes[b];
        bits += len;
        while (bits >= 8) {
            bits -= 8;
            out[out_idx] = @truncate(acc >> bits);
            out_idx += 1;
        }
    }
    if (bits > 0) {
        const pad: u6 = 8 - bits;
        const last: u8 = @truncate((acc << pad) | ((@as(u64, 1) << pad) - 1));
        out[out_idx] = last;
    }
    return out;
}

/// Decodes an RFC 7541 Appendix B Huffman-encoded byte slice, enforcing a
/// maximum output length `max_len` and strict EOS padding rules.
pub fn huffmanDecode(gpa: Allocator, input: []const u8, max_len: usize) DecodeError![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);

    var node: u16 = 0;
    var bits_in_sym: u8 = 0;
    var all_ones = true;

    for (input) |byte| {
        var bit_idx: u8 = 8;
        while (bit_idx > 0) {
            bit_idx -= 1;
            const shift: u3 = @intCast(bit_idx);
            const bit: u1 = @truncate(byte >> shift);
            if (bit == 0) all_ones = false;
            bits_in_sym += 1;
            node = huffman_trie[node].child[bit];
            const sym = huffman_trie[node].sym;
            if (sym != huffman_no_sym) {
                if (sym == huffman_eos_sym) return error.InvalidHuffman;
                if (out.items.len >= max_len) return error.HeaderListTooLarge;
                try out.append(gpa, @intCast(sym));
                node = 0;
                bits_in_sym = 0;
                all_ones = true;
            }
        }
    }
    if (bits_in_sym > 0) {
        if (bits_in_sym > 7 or !all_ones) return error.InvalidHuffman;
    }
    return out.toOwnedSlice(gpa);
}

/// Looks up `(name, value)` in the static table. Returns 1-based index and
/// whether both name and value matched.
fn findStatic(name: []const u8, value: []const u8) struct { index: u8, exact: bool } {
    var name_match: u8 = 0;
    for (static_table, 1..) |entry, idx| {
        if (std.mem.eql(u8, entry.name, name)) {
            if (std.mem.eql(u8, entry.value, value)) {
                return .{ .index = @intCast(idx), .exact = true };
            }
            if (name_match == 0) name_match = @intCast(idx);
        }
    }
    return .{ .index = name_match, .exact = false };
}

fn encodeString(w: *Io.Writer, gpa: ?Allocator, text: []const u8, use_huffman: bool) EncodeError!void {
    if (use_huffman) {
        if (gpa) |a| {
            const encoded = try huffmanEncode(a, text);
            defer a.free(encoded);
            try encodeInt(w, 0x80, 7, encoded.len);
            try w.writeAll(encoded);
            return;
        }
    }
    try encodeInt(w, 0x00, 7, text.len);
    try w.writeAll(text);
}

/// Encodes one header field into `w`. Validates HTTP/2 header name and value
/// hygiene. When `options.huffman` is true, pass a non-null allocator in
/// `scratch_gpa`.
pub fn encodeHeader(
    w: *Io.Writer,
    header: Header,
    options: EncodeOptions,
    scratch_gpa: ?Allocator,
) EncodeError!void {
    if (!validHeaderName(header.name) or !validHeaderValue(header.value)) {
        return error.InvalidHeader;
    }
    const sensitive = isSensitive(header.name);
    const match = findStatic(header.name, header.value);

    switch (options.indexing) {
        .auto => {
            if (!sensitive and match.exact) {
                try encodeInt(w, 0x80, 7, match.index);
                return;
            }
            const mask: u8 = if (sensitive) 0x10 else 0x00;
            try encodeInt(w, mask, 4, match.index);
            if (match.index == 0) {
                try encodeString(w, scratch_gpa, header.name, options.huffman);
            }
            try encodeString(w, scratch_gpa, header.value, options.huffman);
        },
        .without => {
            const mask: u8 = if (sensitive) 0x10 else 0x00;
            try encodeInt(w, mask, 4, match.index);
            if (match.index == 0) {
                try encodeString(w, scratch_gpa, header.name, options.huffman);
            }
            try encodeString(w, scratch_gpa, header.value, options.huffman);
        },
        .never => {
            try encodeInt(w, 0x10, 4, match.index);
            if (match.index == 0) {
                try encodeString(w, scratch_gpa, header.name, options.huffman);
            }
            try encodeString(w, scratch_gpa, header.value, options.huffman);
        },
        .incremental => {
            try encodeInt(w, 0x40, 6, match.index);
            if (match.index == 0) {
                try encodeString(w, scratch_gpa, header.name, options.huffman);
            }
            try encodeString(w, scratch_gpa, header.value, options.huffman);
        },
    }
}

/// Encodes a slice of headers into `w` using default literal/static encoding.
pub fn encodeHeaders(w: *Io.Writer, headers: []const Header) EncodeError!void {
    for (headers) |h| try encodeHeader(w, h, .{}, null);
}

/// Frees a header slice returned by `Decoder.decode`.
pub fn freeHeaders(gpa: Allocator, headers: []Header) void {
    for (headers) |h| {
        gpa.free(h.name);
        gpa.free(h.value);
    }
    gpa.free(headers);
}

/// An owned entry stored in the HPACK dynamic table.
const DynamicEntry = struct {
    name: []u8,
    value: []u8,

    fn byteSize(e: DynamicEntry) usize {
        return e.name.len + e.value.len + entry_overhead;
    }
};

/// RFC 7541 HPACK decoder with a persistent dynamic table across header blocks
/// on one HTTP/2 connection.
pub const Decoder = struct {
    gpa: Allocator,
    /// Dynamic table entries, oldest at index 0, newest at the end.
    entries: std.ArrayList(DynamicEntry) = .empty,
    /// Current dynamic table size in RFC 7541 octets.
    table_size: usize = 0,
    /// Current active dynamic table size limit (<= `hard_max_size`).
    max_table_size: usize,
    /// Upper bound from local `SETTINGS_HEADER_TABLE_SIZE`.
    hard_max_size: usize,
    /// Upper bound on total decoded header bytes per block (with 32-byte overhead).
    max_header_list_size: usize,

    pub fn init(gpa: Allocator, max_table_size: usize, max_header_list_size: usize) Decoder {
        return .{
            .gpa = gpa,
            .max_table_size = max_table_size,
            .hard_max_size = max_table_size,
            .max_header_list_size = max_header_list_size,
        };
    }

    pub fn deinit(d: *Decoder) void {
        d.clearTable();
        d.entries.deinit(d.gpa);
        d.* = undefined;
    }

    /// Updates the maximum allowed table size (from `SETTINGS_HEADER_TABLE_SIZE`).
    pub fn setHardMaxSize(d: *Decoder, new_max: usize) void {
        d.hard_max_size = new_max;
        if (d.max_table_size > new_max) {
            d.max_table_size = new_max;
            d.evictToFit();
        }
    }

    /// Returns the number of entries currently in the dynamic table.
    pub fn dynamicCount(d: *const Decoder) usize {
        return d.entries.items.len;
    }

    /// Returns the current dynamic table size in octets.
    pub fn dynamicSize(d: *const Decoder) usize {
        return d.table_size;
    }

    /// Decodes a complete HPACK header block. Caller owns the returned slice
    /// and its strings; free them with `freeHeaders(out_gpa, headers)`.
    pub fn decode(d: *Decoder, block: []const u8, out_gpa: Allocator) DecodeError![]Header {
        var out: std.ArrayList(Header) = .empty;
        errdefer {
            for (out.items) |h| {
                out_gpa.free(h.name);
                out_gpa.free(h.value);
            }
            out.deinit(out_gpa);
        }

        var pos: usize = 0;
        var total_list_size: usize = 0;
        var seen_header = false;

        while (pos < block.len) {
            const b = block[pos];
            if ((b & 0x80) != 0) {
                // Indexed Header Field (RFC 7541 Section 6.1)
                seen_header = true;
                const idx = try decodeInt(block, &pos, 7);
                const entry = try d.lookup(idx);
                try d.appendDecoded(out_gpa, &out, &total_list_size, entry.name, entry.value);
            } else if ((b & 0xc0) == 0x40) {
                // Literal Header Field with Incremental Indexing (Section 6.2.1)
                seen_header = true;
                const name_idx = try decodeInt(block, &pos, 6);
                try d.decodeLiteral(block, &pos, name_idx, true, out_gpa, &out, &total_list_size);
            } else if ((b & 0xe0) == 0x20) {
                // Dynamic Table Size Update (Section 6.3)
                if (seen_header) return error.InvalidTableSizeUpdate;
                const new_size_u64 = try decodeInt(block, &pos, 5);
                if (new_size_u64 > d.hard_max_size) return error.InvalidTableSizeUpdate;
                d.max_table_size = @intCast(new_size_u64);
                d.evictToFit();
            } else {
                // Literal Without Indexing (0000xxxx) or Never Indexed (0001xxxx)
                seen_header = true;
                const name_idx = try decodeInt(block, &pos, 4);
                try d.decodeLiteral(block, &pos, name_idx, false, out_gpa, &out, &total_list_size);
            }
        }
        return out.toOwnedSlice(out_gpa);
    }

    fn decodeLiteral(
        d: *Decoder,
        block: []const u8,
        pos: *usize,
        name_idx: u64,
        incremental: bool,
        out_gpa: Allocator,
        out: *std.ArrayList(Header),
        total_list_size: *usize,
    ) DecodeError!void {
        const remaining_budget = if (total_list_size.* + entry_overhead <= d.max_header_list_size)
            d.max_header_list_size - total_list_size.* - entry_overhead
        else
            return error.HeaderListTooLarge;

        const name: []u8 = if (name_idx == 0)
            try decodeString(block, pos, out_gpa, remaining_budget)
        else blk: {
            const entry = try d.lookup(name_idx);
            if (entry.name.len > remaining_budget) return error.HeaderListTooLarge;
            break :blk try out_gpa.dupe(u8, entry.name);
        };
        errdefer out_gpa.free(name);

        const value_budget = remaining_budget - name.len;
        const value = try decodeString(block, pos, out_gpa, value_budget);
        errdefer out_gpa.free(value);

        total_list_size.* += name.len + value.len + entry_overhead;
        try out.append(out_gpa, .{ .name = name, .value = value });

        if (incremental) {
            try d.insertDynamic(name, value);
        }
    }

    fn appendDecoded(
        d: *Decoder,
        out_gpa: Allocator,
        out: *std.ArrayList(Header),
        total_list_size: *usize,
        name: []const u8,
        value: []const u8,
    ) DecodeError!void {
        const field_size = name.len + value.len + entry_overhead;
        if (total_list_size.* + field_size > d.max_header_list_size) {
            return error.HeaderListTooLarge;
        }
        const n = try out_gpa.dupe(u8, name);
        errdefer out_gpa.free(n);
        const v = try out_gpa.dupe(u8, value);
        errdefer out_gpa.free(v);
        try out.append(out_gpa, .{ .name = n, .value = v });
        total_list_size.* += field_size;
    }

    fn lookup(d: *const Decoder, idx: u64) DecodeError!Header {
        if (idx == 0) return error.InvalidIndex;
        if (idx <= static_table.len) {
            return static_table[@intCast(idx - 1)];
        }
        const dyn_idx = idx - static_table.len - 1;
        if (dyn_idx >= d.entries.items.len) return error.InvalidIndex;
        const rev = d.entries.items.len - 1 - @as(usize, @intCast(dyn_idx));
        const e = d.entries.items[rev];
        return .{ .name = e.name, .value = e.value };
    }

    fn insertDynamic(d: *Decoder, name: []const u8, value: []const u8) Allocator.Error!void {
        const needed = name.len + value.len + entry_overhead;
        if (needed > d.max_table_size) {
            // RFC 7541 Section 4.4: entry larger than max size clears the table.
            d.clearTable();
            return;
        }
        while (d.table_size + needed > d.max_table_size and d.entries.items.len > 0) {
            d.evictOne();
        }
        const owned_name = try d.gpa.dupe(u8, name);
        errdefer d.gpa.free(owned_name);
        const owned_value = try d.gpa.dupe(u8, value);
        errdefer d.gpa.free(owned_value);
        try d.entries.append(d.gpa, .{ .name = owned_name, .value = owned_value });
        d.table_size += needed;
    }

    fn evictToFit(d: *Decoder) void {
        while (d.table_size > d.max_table_size and d.entries.items.len > 0) {
            d.evictOne();
        }
    }

    fn evictOne(d: *Decoder) void {
        const oldest = d.entries.orderedRemove(0);
        d.table_size -= oldest.byteSize();
        d.gpa.free(oldest.name);
        d.gpa.free(oldest.value);
    }

    fn clearTable(d: *Decoder) void {
        for (d.entries.items) |e| {
            d.gpa.free(e.name);
            d.gpa.free(e.value);
        }
        d.entries.clearRetainingCapacity();
        d.table_size = 0;
    }
};

fn decodeString(block: []const u8, pos: *usize, gpa: Allocator, max_len: usize) DecodeError![]u8 {
    if (pos.* >= block.len) return error.Truncated;
    const huffman = (block[pos.*] & 0x80) != 0;
    const len_u64 = try decodeInt(block, pos, 7);
    if (len_u64 > block.len - pos.*) return error.Truncated;
    const len: usize = @intCast(len_u64);
    const raw = block[pos.* .. pos.* + len];
    pos.* += len;
    if (huffman) {
        return huffmanDecode(gpa, raw, max_len);
    }
    if (len > max_len) return error.HeaderListTooLarge;
    return try gpa.dupe(u8, raw);
}

test {
    _ = @import("hpack_test.zig");
}
