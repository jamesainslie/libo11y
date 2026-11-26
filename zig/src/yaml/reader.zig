//! Input decoding for libo11y's strict registry parser, as gopkg.in/yaml.v3's
//! reader does it: UTF-8, or UTF-16 after a byte order mark, with a leading
//! byte order mark dropped. The characters yaml.v3 refuses are refused here
//! too: control characters other than tab, line feed and carriage return,
//! surrogates, U+FFFE and U+FFFF.
//!
//! yaml.v3 decodes its input in chunks as the scanner needs it, so it can
//! accept a file whose bad character sits past the point where decoding
//! stopped. This reader checks the whole input first. A bad character
//! anywhere is a syntax error.

const std = @import("std");
const Allocator = std.mem.Allocator;
const scanner = @import("scanner.zig");

pub const Diagnostic = scanner.Diagnostic;

/// Returns the input as UTF-8 without a leading byte order mark. The result
/// is raw itself, a slice of it, or text allocated in arena.
pub fn decode(arena: Allocator, raw: []const u8, diag: *Diagnostic) scanner.Error![]const u8 {
    if (raw.len >= 2 and raw[0] == 0xFF and raw[1] == 0xFE) return fromUtf16(arena, raw[2..], .little, diag);
    if (raw.len >= 2 and raw[0] == 0xFE and raw[1] == 0xFF) return fromUtf16(arena, raw[2..], .big, diag);
    const text = if (std.mem.startsWith(u8, raw, "\xEF\xBB\xBF")) raw[3..] else raw;
    var i: usize = 0;
    while (i < text.len) {
        const first = text[i];
        const w: usize = if (first & 0x80 == 0)
            1
        else if (first & 0xE0 == 0xC0)
            2
        else if (first & 0xF0 == 0xE0)
            3
        else if (first & 0xF8 == 0xF0)
            4
        else
            return fail(diag, i, "invalid leading UTF-8 octet");
        if (i + w > text.len) return fail(diag, i, "incomplete UTF-8 octet sequence");
        var value: u32 = switch (w) {
            1 => first & 0x7F,
            2 => first & 0x1F,
            3 => first & 0x0F,
            else => first & 0x07,
        };
        for (text[i + 1 .. i + w]) |b| {
            if (b & 0xC0 != 0x80) return fail(diag, i, "invalid trailing UTF-8 octet");
            value = (value << 6) + (b & 0x3F);
        }
        const shortest = switch (w) {
            1 => true,
            2 => value >= 0x80,
            3 => value >= 0x800,
            else => value >= 0x10000,
        };
        if (!shortest) return fail(diag, i, "invalid length of a UTF-8 sequence");
        if ((value >= 0xD800 and value <= 0xDFFF) or value > 0x10FFFF) return fail(diag, i, "invalid Unicode character");
        if (!allowed(value)) return fail(diag, i, "control characters are not allowed");
        i += w;
    }
    return text;
}

fn allowed(c: u32) bool {
    return switch (c) {
        0x09, 0x0A, 0x0D, 0x20...0x7E, 0x85, 0xA0...0xD7FF, 0xE000...0xFFFD, 0x10000...0x10FFFF => true,
        else => false,
    };
}

fn fail(diag: *Diagnostic, offset: usize, message: []const u8) scanner.Error {
    diag.* = .{ .message = message, .mark = .{ .index = offset } };
    return error.Syntax;
}

fn fromUtf16(arena: Allocator, raw: []const u8, endian: std.lang.Endian, diag: *Diagnostic) scanner.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < raw.len) {
        if (i + 2 > raw.len) return fail(diag, i, "incomplete UTF-16 character");
        var value: u32 = std.mem.readInt(u16, raw[i..][0..2], endian);
        i += 2;
        if (value & 0xFC00 == 0xDC00) return fail(diag, i, "unexpected low surrogate area");
        if (value & 0xFC00 == 0xD800) {
            if (i + 2 > raw.len) return fail(diag, i, "incomplete UTF-16 surrogate pair");
            const low: u32 = std.mem.readInt(u16, raw[i..][0..2], endian);
            if (low & 0xFC00 != 0xDC00) return fail(diag, i, "expected low surrogate area");
            i += 2;
            value = 0x10000 + ((value & 0x3FF) << 10) + (low & 0x3FF);
        }
        if (!allowed(value)) return fail(diag, i, "control characters are not allowed");
        var buf: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(@intCast(value), &buf) catch return fail(diag, i, "invalid Unicode character");
        try out.appendSlice(arena, buf[0..n]);
    }
    return out.items;
}

fn expectDecoded(raw: []const u8, want: ?[]const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var diag: Diagnostic = .{};
    const got = decode(arena.allocator(), raw, &diag) catch |err| switch (err) {
        error.Syntax => {
            try std.testing.expect(want == null);
            return;
        },
        else => |e| return e,
    };
    try std.testing.expectEqualStrings(want orelse return error.TestUnexpectedResult, got);
}

test "UTF-8 input passes through without its byte order mark" {
    try expectDecoded("a: b\n", "a: b\n");
    try expectDecoded("\xEF\xBB\xBFa: caf\xC3\xA9", "a: caf\u{e9}");
    try expectDecoded("\u{FEFF}\u{FEFF}a", "\u{FEFF}a");
}

test "characters yaml.v3 refuses" {
    try expectDecoded("a\x00b", null);
    try expectDecoded("a\x07", null);
    try expectDecoded("a\x7F", null);
    try expectDecoded("caf\xE9", null);
    try expectDecoded("\xC0\xAF", null);
    try expectDecoded("\xED\xA0\x80", null);
    try expectDecoded("\xEF\xBF\xBE", null);
    try expectDecoded("\xC2\x85\xC2\xA0", "\u{85}\u{A0}");
    try expectDecoded("\xC2\x80", null);
}

test "UTF-16 input with a byte order mark" {
    try expectDecoded("\xFF\xFEa\x00:\x00 \x00\x3D\xD8\x00\xDE", "a: \u{1F600}");
    try expectDecoded("\xFE\xFF\x00a\x00\xE9", "a\u{e9}");
    try expectDecoded("\xFF\xFE\x00\xDC", null);
    try expectDecoded("\xFF\xFEa", null);
}
