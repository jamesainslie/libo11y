//! Go's %q quoting of a string (strconv.Quote) and Go's strings.TrimSpace,
//! so messages that quote a value match the Go implementation byte for
//! byte. "Printable" is Go's unicode.IsPrint, from the table specgen
//! generates, so it follows the Unicode version of the Go toolchain rather
//! than Zig's.

const std = @import("std");
const spec = @import("spec.zig");

/// One decoded rune and its width, as Go's utf8.DecodeRuneInString returns
/// them: an invalid byte decodes as U+FFFD with width 1.
const Rune = struct { cp: u21, width: usize, valid: bool };

fn decodeRune(s: []const u8) Rune {
    const bad: Rune = .{ .cp = 0xFFFD, .width = 1, .valid = false };
    const b0 = s[0];
    if (b0 < 0x80) return .{ .cp = b0, .width = 1, .valid = true };
    const n: usize, const lo: u8, const hi: u8 = switch (b0) {
        0xC2...0xDF => .{ 2, 0x80, 0xBF },
        0xE0 => .{ 3, 0xA0, 0xBF },
        0xE1...0xEC, 0xEE, 0xEF => .{ 3, 0x80, 0xBF },
        0xED => .{ 3, 0x80, 0x9F },
        0xF0 => .{ 4, 0x90, 0xBF },
        0xF1...0xF3 => .{ 4, 0x80, 0xBF },
        0xF4 => .{ 4, 0x80, 0x8F },
        else => return bad,
    };
    if (s.len < n) return bad;
    if (s[1] < lo or s[1] > hi) return bad;
    for (s[2..n]) |b| if (b < 0x80 or b > 0xBF) return bad;
    var cp: u21 = b0 & (@as(u8, 0x7F) >> @intCast(n));
    for (s[1..n]) |b| cp = (cp << 6) | (b & 0x3F);
    return .{ .cp = cp, .width = n, .valid = true };
}

/// Writes s quoted as Go's fmt %q verb quotes a string.
pub fn writeQuoted(w: *std.Io.Writer, s: []const u8) std.Io.Writer.Error!void {
    const hex = "0123456789abcdef";
    try w.writeByte('"');
    var i: usize = 0;
    while (i < s.len) {
        const r = decodeRune(s[i..]);
        defer i += r.width;
        if (!r.valid) {
            try w.writeAll("\\x");
            try w.writeByte(hex[s[i] >> 4]);
            try w.writeByte(hex[s[i] & 0xF]);
            continue;
        }
        const c = r.cp;
        if (c == '"' or c == '\\') {
            try w.writeByte('\\');
            try w.writeByte(@intCast(c));
        } else if (spec.isGoPrint(c)) {
            try w.writeAll(s[i..][0..r.width]);
        } else switch (c) {
            0x07 => try w.writeAll("\\a"),
            0x08 => try w.writeAll("\\b"),
            0x0C => try w.writeAll("\\f"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0x0B => try w.writeAll("\\v"),
            else => if (c < ' ' or c == 0x7F) {
                try w.print("\\x{x:0>2}", .{c});
            } else if (c < 0x10000) {
                try w.print("\\u{x:0>4}", .{c});
            } else {
                try w.print("\\U{x:0>8}", .{c});
            },
        }
    }
    try w.writeByte('"');
}

/// Go's unicode.IsSpace: the Unicode White_Space property.
fn isSpace(c: u21) bool {
    return switch (c) {
        '\t', '\n', 0x0B, 0x0C, '\r', ' ', 0x85, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000 => true,
        else => false,
    };
}

/// Go's strings.TrimSpace. An invalid byte is not space.
pub fn trimSpace(s: []const u8) []const u8 {
    var start: usize = 0;
    while (start < s.len) {
        const r = decodeRune(s[start..]);
        if (!r.valid or !isSpace(r.cp)) break;
        start += r.width;
    }
    var end = s.len;
    while (end > start) {
        // Find the start of the last rune, as utf8.DecodeLastRuneInString
        // does: back up over at most three continuation bytes.
        var begin = end - 1;
        const limit = if (end >= 4) end - 4 else 0;
        while (begin > limit and begin > start and s[begin] & 0xC0 == 0x80) begin -= 1;
        var r = decodeRune(s[begin..end]);
        if (begin + r.width != end) r = .{ .cp = 0xFFFD, .width = 1, .valid = false };
        if (!r.valid or !isSpace(r.cp)) break;
        end = begin;
    }
    return s[start..end];
}

fn expectQuoted(s: []const u8, want: []const u8) !void {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeQuoted(&out.writer, s);
    try std.testing.expectEqualStrings(want, out.written());
}

test "quotes as Go's %q does" {
    try expectQuoted("studio", "\"studio\"");
    try expectQuoted("it's \"x\" \\", "\"it's \\\"x\\\" \\\\\"");
    try expectQuoted("caf\u{e9}\t", "\"caf\u{e9}\\t\"");
    try expectQuoted(" \x07", "\" \\a\"");
    try expectQuoted("x\u{85}", "\"x\\u0085\"");
    try expectQuoted("\u{FEFF}y", "\"\\ufeffy\"");
    try expectQuoted("\x00\x1b\x7f", "\"\\x00\\x1b\\x7f\"");
    try expectQuoted("\xff\xc3", "\"\\xff\\xc3\"");
    try expectQuoted("\xed\xa0\x80", "\"\\xed\\xa0\\x80\"");
    try expectQuoted("\u{E000}\u{10FFFF}\u{1F600}", "\"\\ue000\\U0010ffff\u{1F600}\"");
}

test "trims as Go's strings.TrimSpace does" {
    try std.testing.expectEqualStrings("studio", trimSpace(" studio\t\n"));
    try std.testing.expectEqualStrings("x", trimSpace("x\u{85}"));
    try std.testing.expectEqualStrings("\u{FEFF}y", trimSpace("\u{FEFF}y"));
    try std.testing.expectEqualStrings("a", trimSpace("\u{3000}\u{2028}a\u{A0}"));
    try std.testing.expectEqualStrings("\xff", trimSpace(" \xff "));
    try std.testing.expectEqualStrings("", trimSpace(" \u{2009}"));
    try std.testing.expectEqualStrings("a\xc2", trimSpace("a\xc2"));
}
