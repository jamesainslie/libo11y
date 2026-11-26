//! Tag resolution as gopkg.in/yaml.v3 does it (resolve.go): what a plain
//! scalar's text means, and whether an explicit tag fits the text. yaml.v3
//! resolves with YAML 1.2's core schema plus a few YAML 1.1 forms, such as
//! integers with underscores and sexagesimal-free timestamps. Only the kind
//! of each value matters to the registry decoder, so no value is built,
//! except that a float's range is checked as Go's strconv.ParseFloat does.

const std = @import("std");

pub const str = "!!str";
pub const null_tag = "!!null";
pub const bool_tag = "!!bool";
pub const int_tag = "!!int";
pub const float_tag = "!!float";
pub const timestamp_tag = "!!timestamp";
pub const seq_tag = "!!seq";
pub const map_tag = "!!map";
pub const binary_tag = "!!binary";
pub const merge_tag = "!!merge";

const long_prefix = "tag:yaml.org,2002:";

/// What a resolved value is. string covers every value a Go interface{}
/// would hold as a string: !!str, !!merge, !!binary and unknown tags.
pub const Kind = enum { null, bool, int, uint, float, timestamp, string };

pub const Resolved = struct {
    /// The resolved tag in short form, such as "!!int".
    tag: []const u8,
    kind: Kind,
};

/// yaml.v3's shortTag: tag:yaml.org,2002:x becomes !!x.
pub fn shortTag(tag: []const u8) []const u8 {
    if (!std.mem.startsWith(u8, tag, long_prefix)) return tag;
    return shortForms.get(tag[long_prefix.len..]) orelse tag;
}

/// The long tags yaml.v3 shortens. A long tag outside this list keeps its
/// long form, which yaml.v3 renders as !!x only in messages.
const shortForms: std.StaticStringMap([]const u8) = .initComptime(.{
    .{ "null", null_tag },     .{ "bool", bool_tag },
    .{ "str", str },           .{ "int", int_tag },
    .{ "float", float_tag },   .{ "timestamp", timestamp_tag },
    .{ "seq", seq_tag },       .{ "map", map_tag },
    .{ "binary", binary_tag }, .{ "merge", merge_tag },
});

fn resolvable(tag: []const u8) bool {
    const tags = [_][]const u8{ "", str, bool_tag, int_tag, float_tag, null_tag, timestamp_tag };
    for (tags) |t| if (std.mem.eql(u8, tag, t)) return true;
    return false;
}

const map_entries: std.StaticStringMap(Resolved) = .initComptime(.{
    .{ "true", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "True", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "TRUE", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "false", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "False", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "FALSE", Resolved{ .tag = bool_tag, .kind = .bool } },
    .{ "", Resolved{ .tag = null_tag, .kind = .null } },
    .{ "~", Resolved{ .tag = null_tag, .kind = .null } },
    .{ "null", Resolved{ .tag = null_tag, .kind = .null } },
    .{ "Null", Resolved{ .tag = null_tag, .kind = .null } },
    .{ "NULL", Resolved{ .tag = null_tag, .kind = .null } },
    .{ ".nan", Resolved{ .tag = float_tag, .kind = .float } },
    .{ ".NaN", Resolved{ .tag = float_tag, .kind = .float } },
    .{ ".NAN", Resolved{ .tag = float_tag, .kind = .float } },
    .{ ".inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ ".Inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ ".INF", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "+.inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "+.Inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "+.INF", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "-.inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "-.Inf", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "-.INF", Resolved{ .tag = float_tag, .kind = .float } },
    .{ "<<", Resolved{ .tag = merge_tag, .kind = .string } },
});

pub const Error = error{ Mismatch, OutOfMemory };

/// Resolves text under tag, which may be empty. error.Mismatch is yaml.v3's
/// "cannot decode X as a Y", for an explicit tag the text does not fit.
/// scratch holds the copies the number parsers need.
pub fn resolve(scratch: std.mem.Allocator, tag_in: []const u8, in: []const u8) Error!Resolved {
    const tag = shortTag(tag_in);
    if (!resolvable(tag)) return .{ .tag = tag, .kind = .string };
    var r = try classify(scratch, tag, in);
    if (tag.len == 0 or std.mem.eql(u8, tag, r.tag) or std.mem.eql(u8, tag, str)) return r;
    // !!float accepts a signed integer, which it reads as a float.
    if (std.mem.eql(u8, tag, float_tag) and r.kind == .int) {
        r = .{ .tag = float_tag, .kind = .float };
        return r;
    }
    return error.Mismatch;
}

fn classify(scratch: std.mem.Allocator, tag: []const u8, in: []const u8) error{OutOfMemory}!Resolved {
    const plain_str: Resolved = .{ .tag = str, .kind = .string };
    const hint: u8 = if (in.len == 0) 'N' else switch (in[0]) {
        '+', '-' => 'S',
        '0'...'9' => 'D',
        'y', 'Y', 'n', 'N', 't', 'T', 'f', 'F', 'o', 'O', '~' => 'M',
        '.' => '.',
        else => 0,
    };
    if (hint == 0 or std.mem.eql(u8, tag, str)) return plain_str;
    if (map_entries.get(in)) |r| return r;
    switch (hint) {
        '.' => if (try parseFloatOk(scratch, in)) return .{ .tag = float_tag, .kind = .float },
        'D', 'S' => {
            if ((tag.len == 0 or std.mem.eql(u8, tag, timestamp_tag)) and parseTimestamp(in)) {
                return .{ .tag = timestamp_tag, .kind = .timestamp };
            }
            const plain = try withoutUnderscores(scratch, in);
            if (parseInt(plain, 0) != null) return .{ .tag = int_tag, .kind = .int };
            if (parseUint(plain, 0) != null) return .{ .tag = int_tag, .kind = .uint };
            if (yamlStyleFloat(plain) and try parseFloatOk(scratch, plain)) return .{ .tag = float_tag, .kind = .float };
            if (std.mem.startsWith(u8, plain, "0b")) {
                if (parseInt(plain[2..], 2) != null) return .{ .tag = int_tag, .kind = .int };
                if (parseUint(plain[2..], 2) != null) return .{ .tag = int_tag, .kind = .uint };
            } else if (std.mem.startsWith(u8, plain, "-0b")) {
                if (try negativeInt(scratch, plain[3..], 2)) return .{ .tag = int_tag, .kind = .int };
            }
            if (std.mem.startsWith(u8, plain, "0o")) {
                if (parseInt(plain[2..], 8) != null) return .{ .tag = int_tag, .kind = .int };
                if (parseUint(plain[2..], 8) != null) return .{ .tag = int_tag, .kind = .uint };
            } else if (std.mem.startsWith(u8, plain, "-0o")) {
                if (try negativeInt(scratch, plain[3..], 8)) return .{ .tag = int_tag, .kind = .int };
            }
        },
        else => {},
    }
    return plain_str;
}

/// in without its underscores, as yaml.v3 removes them before it parses a
/// number.
fn withoutUnderscores(scratch: std.mem.Allocator, in: []const u8) error{OutOfMemory}![]const u8 {
    if (std.mem.findScalar(u8, in, '_') == null) return in;
    var out: std.ArrayList(u8) = try .initCapacity(scratch, in.len);
    for (in) |c| {
        if (c != '_') out.appendAssumeCapacity(c);
    }
    return out.items;
}

/// Whether "-" ++ digits parses as a base-base int64.
fn negativeInt(scratch: std.mem.Allocator, digits: []const u8, base: u8) error{OutOfMemory}!bool {
    const text = try std.mem.concat(scratch, u8, &.{ "-", digits });
    return parseInt(text, base) != null;
}

/// Go's strconv.ParseUint(s, base, 64) for text without underscores. Base 0
/// reads a 0b, 0o or 0x prefix, or a leading 0 as octal.
pub fn parseUint(s_in: []const u8, base_in: u8) ?u64 {
    if (s_in.len == 0) return null;
    var s = s_in;
    var base: u8 = base_in;
    if (base == 0) {
        base = 10;
        if (s[0] == '0') {
            if (s.len >= 3 and std.ascii.toLower(s[1]) == 'b') {
                base = 2;
                s = s[2..];
            } else if (s.len >= 3 and std.ascii.toLower(s[1]) == 'o') {
                base = 8;
                s = s[2..];
            } else if (s.len >= 3 and std.ascii.toLower(s[1]) == 'x') {
                base = 16;
                s = s[2..];
            } else {
                base = 8;
                s = s[1..];
            }
        }
    }
    var n: u64 = 0;
    for (s) |c| {
        const d: u8 = switch (c) {
            '0'...'9' => c - '0',
            'a'...'z' => c - 'a' + 10,
            'A'...'Z' => c - 'A' + 10,
            else => return null,
        };
        if (d >= base) return null;
        n = std.math.mul(u64, n, base) catch return null;
        n = std.math.add(u64, n, d) catch return null;
    }
    return n;
}

/// Go's strconv.ParseInt(s, base, 64) for text without underscores.
pub fn parseInt(s: []const u8, base: u8) ?i64 {
    if (s.len == 0) return null;
    var body = s;
    var negative = false;
    if (s[0] == '+' or s[0] == '-') {
        negative = s[0] == '-';
        body = s[1..];
    }
    const un = parseUint(body, base) orelse return null;
    const limit: u64 = 1 << 63;
    if (!negative and un >= limit) return null;
    if (negative and un > limit) return null;
    if (negative) return if (un == limit) std.math.minInt(i64) else -@as(i64, @intCast(un));
    return @intCast(un);
}

/// yaml.v3's yamlStyleFloat: ^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$
fn yamlStyleFloat(s: []const u8) bool {
    var i: usize = 0;
    if (i < s.len and (s[i] == '-' or s[i] == '+')) i += 1;
    if (i < s.len and s[i] == '.') {
        i += 1;
        const digits = i;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        if (i == digits) return false;
    } else {
        const digits = i;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        if (i == digits) return false;
        if (i < s.len and s[i] == '.') {
            i += 1;
            while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        }
    }
    if (i < s.len and (s[i] == 'e' or s[i] == 'E')) {
        i += 1;
        if (i < s.len and (s[i] == '-' or s[i] == '+')) i += 1;
        const digits = i;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
        if (i == digits) return false;
    }
    return i == s.len;
}

/// Whether Go's strconv.ParseFloat(s, 64) succeeds for a decimal s: the
/// syntax of its readFloat, with underscores between digits, and a finite
/// result. Hexadecimal floats and the inf and nan words never reach here,
/// because yaml.v3 tries ParseFloat only on text starting with '.' or
/// matching yamlStyleFloat.
fn parseFloatOk(scratch: std.mem.Allocator, s: []const u8) error{OutOfMemory}!bool {
    var i: usize = 0;
    if (i < s.len and (s[i] == '+' or s[i] == '-')) i += 1;
    var saw_dot = false;
    var saw_digits = false;
    var underscores = false;
    while (i < s.len) : (i += 1) {
        switch (s[i]) {
            '_' => underscores = true,
            '.' => {
                if (saw_dot) break;
                saw_dot = true;
            },
            '0'...'9' => saw_digits = true,
            else => break,
        }
    }
    if (!saw_digits) return false;
    if (i < s.len and (s[i] == 'e' or s[i] == 'E')) {
        i += 1;
        if (i >= s.len) return false;
        if (s[i] == '+' or s[i] == '-') i += 1;
        if (i >= s.len or !std.ascii.isDigit(s[i])) return false;
        while (i < s.len and (std.ascii.isDigit(s[i]) or s[i] == '_')) : (i += 1) {
            if (s[i] == '_') underscores = true;
        }
    }
    if (i != s.len) return false;
    if (underscores and !underscoreOk(s)) return false;
    const plain = try withoutUnderscores(scratch, s);
    const f = std.fmt.parseFloat(f64, plain) catch return false;
    return !std.math.isInf(f);
}

/// Go's underscoreOK for a decimal number: each underscore sits between
/// digits.
fn underscoreOk(s_in: []const u8) bool {
    var s = s_in;
    if (s.len >= 1 and (s[0] == '-' or s[0] == '+')) s = s[1..];
    var saw: u8 = '^';
    for (s) |c| {
        if (std.ascii.isDigit(c)) {
            saw = '0';
            continue;
        }
        if (c == '_') {
            if (saw != '0') return false;
            saw = '_';
            continue;
        }
        if (saw == '_') return false;
        saw = '!';
    }
    return saw != '_';
}

/// yaml.v3's parseTimestamp: four digits and a '-', then one of Go's
/// time.Parse layouts 2006-1-2T15:4:5.999999999Z07:00 (with T or t),
/// 2006-1-2 15:4:5.999999999 and 2006-1-2, with Go's range checks.
pub fn parseTimestamp(s: []const u8) bool {
    var i: usize = 0;
    while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
    if (i != 4 or i == s.len or s[i] != '-') return false;
    if (matchLayout(s, .{ .sep = 'T', .zone = true })) return true;
    if (matchLayout(s, .{ .sep = 't', .zone = true })) return true;
    if (matchLayout(s, .{ .sep = ' ', .zone = false })) return true;
    const date = matchDate(s) orelse return false;
    return date.len == s.len;
}

const Layout = struct { sep: u8, zone: bool };

const Date = struct { len: usize, year: u32, month: u32, day: u32 };

/// Go's getnum(s, false): one or two digits.
fn getnum(s: []const u8, i: *usize) ?u32 {
    if (i.* >= s.len or !std.ascii.isDigit(s[i.*])) return null;
    var v: u32 = s[i.*] - '0';
    i.* += 1;
    if (i.* < s.len and std.ascii.isDigit(s[i.*])) {
        v = v * 10 + (s[i.*] - '0');
        i.* += 1;
    }
    return v;
}

/// Matches the 2006-1-2 part at the start of s and checks the month. The
/// day is checked once the whole layout matched, as Go does.
fn matchDate(s: []const u8) ?Date {
    if (s.len < 4) return null;
    const year = std.fmt.parseInt(u32, s[0..4], 10) catch return null;
    var i: usize = 4;
    if (i >= s.len or s[i] != '-') return null;
    i += 1;
    const month = getnum(s, &i) orelse return null;
    if (month < 1 or month > 12) return null;
    if (i >= s.len or s[i] != '-') return null;
    i += 1;
    const day = getnum(s, &i) orelse return null;
    if (day < 1 or day > daysIn(month, year)) return null;
    return .{ .len = i, .year = year, .month = month, .day = day };
}

fn daysIn(month: u32, year: u32) u32 {
    return switch (month) {
        2 => if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) 29 else 28,
        4, 6, 9, 11 => 30,
        else => 31,
    };
}

fn matchLayout(s: []const u8, layout: Layout) bool {
    const date = matchDate(s) orelse return false;
    var i = date.len;
    if (layout.sep == ' ') {
        // A space in a Go layout matches one or more spaces.
        if (i < s.len and s[i] != ' ') return false;
        while (i < s.len and s[i] == ' ') i += 1;
    } else {
        if (i >= s.len or s[i] != layout.sep) return false;
        i += 1;
    }
    const hour = getnum(s, &i) orelse return false;
    if (hour >= 24) return false;
    if (i >= s.len or s[i] != ':') return false;
    i += 1;
    const minute = getnum(s, &i) orelse return false;
    if (minute >= 60) return false;
    if (i >= s.len or s[i] != ':') return false;
    i += 1;
    const second = getnum(s, &i) orelse return false;
    if (second >= 60) return false;
    // An optional fraction: a '.' or ',' and at least one digit.
    if (i + 1 < s.len and (s[i] == '.' or s[i] == ',') and std.ascii.isDigit(s[i + 1])) {
        i += 1;
        while (i < s.len and std.ascii.isDigit(s[i])) i += 1;
    }
    if (layout.zone) {
        if (i < s.len and s[i] == 'Z') {
            i += 1;
        } else {
            if (s.len - i < 6 or s[i + 3] != ':') return false;
            if (s[i] != '+' and s[i] != '-') return false;
            for ([_]usize{ 1, 2, 4, 5 }) |k| if (!std.ascii.isDigit(s[i + k])) return false;
            const zh = (s[i + 1] - '0') * 10 + (s[i + 2] - '0');
            const zm = (s[i + 4] - '0') * 10 + (s[i + 5] - '0');
            if (zh > 24 or zm > 60) return false;
            i += 6;
        }
    }
    return i == s.len;
}

const testing = std.testing;

fn expectResolved(tag: []const u8, in: []const u8, want_tag: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const r = try resolve(arena.allocator(), tag, in);
    try testing.expectEqualStrings(want_tag, r.tag);
}

fn expectMismatch(tag: []const u8, in: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    try testing.expectError(error.Mismatch, resolve(arena.allocator(), tag, in));
}

test "plain scalars resolve with yaml.v3's rules" {
    try expectResolved("", "studio", str);
    try expectResolved("", "1", int_tag);
    try expectResolved("", "1_000", int_tag);
    try expectResolved("", "0x1F", int_tag);
    try expectResolved("", "0o17", int_tag);
    try expectResolved("", "0b-101", int_tag);
    try expectResolved("", "-0b101", int_tag);
    try expectResolved("", "017", int_tag);
    try expectResolved("", "09", float_tag);
    try expectResolved("", "18446744073709551615", int_tag);
    try expectResolved("", "1.0", float_tag);
    try expectResolved("", ".5", float_tag);
    try expectResolved("", ".5_5", float_tag);
    try expectResolved("", ".5e999", str);
    try expectResolved("", "1e999", str);
    try expectResolved("", "1e5", float_tag);
    try expectResolved("", ".inf", float_tag);
    try expectResolved("", ".Nan", str);
    try expectResolved("", "true", bool_tag);
    try expectResolved("", "yes", str);
    try expectResolved("", "~", null_tag);
    try expectResolved("", "", null_tag);
    // The map entry for << is never reached, because < gives no hint. The
    // merge tag comes from the composer instead.
    try expectResolved("", "<<", str);
    try expectResolved("", "2001-12-14", timestamp_tag);
    try expectResolved("", "2001-12-14t21:59:43.10-05:00", timestamp_tag);
    try expectResolved("", "2001-12-14 21:59:43.10", timestamp_tag);
    try expectResolved("", "2001-12-14  1:2:3", timestamp_tag);
    try expectResolved("", "2001-02-29", str);
    try expectResolved("", "2001-13-01", str);
    try expectResolved("", "2001-1-1T24:00:00Z", str);
    try expectResolved("", "+.5", float_tag);
    try expectResolved("", "-1.e5", float_tag);
    try expectResolved("", "0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001", int_tag);
}

test "explicit tags must fit the text" {
    try expectResolved("!!str", "1", str);
    try expectResolved("tag:yaml.org,2002:int", "1", int_tag);
    try expectResolved("!!float", "1", float_tag);
    try expectResolved("!!null", "~", null_tag);
    try expectResolved("!!binary", "aGVsbG8=", binary_tag);
    try expectResolved("!custom", "x", "!custom");
    try expectMismatch("!!int", "client");
    try expectMismatch("!!float", "client");
    try expectMismatch("!!null", "client");
    try expectMismatch("!!bool", "yes");
    try expectMismatch("!!float", "18446744073709551615");
    try expectMismatch("!!timestamp", "2001-02-30");
}

test "Go's integer parsers" {
    try testing.expectEqual(@as(?i64, std.math.minInt(i64)), parseInt("-9223372036854775808", 0));
    try testing.expectEqual(@as(?i64, null), parseInt("9223372036854775808", 0));
    try testing.expectEqual(@as(?i64, 0), parseInt("0", 0));
    try testing.expectEqual(@as(?i64, null), parseInt("0x", 0));
    try testing.expectEqual(@as(?i64, null), parseInt("+", 0));
    try testing.expectEqual(@as(?u64, 255), parseUint("0xff", 0));
}
