//! W3C baggage, ported from go.opentelemetry.io/otel/baggage v1.47.0
//! (baggage.go).

const std = @import("std");
const Allocator = std.mem.Allocator;

/// An immutable set of baggage members. It borrows every string it holds.
pub const Baggage = struct {
    /// The members in order, each key at most once.
    members: []const Member = &.{},

    /// The baggage with no members.
    pub const empty: Baggage = .{};

    /// The most members a baggage holds (W3C limit).
    pub const max_members = 64;

    /// The most bytes a baggage header holds (W3C limit).
    pub const max_bytes = 8192;

    /// The error `parse` returns.
    pub const ParseError = error{ BaggageTooLarge, OutOfMemory };

    /// The error `fromMembers` returns.
    pub const FromMembersError = error{ InvalidMember, OutOfMemory };

    /// A baggage member: a key, its decoded value and its properties.
    pub const Member = struct {
        /// The key. Any non-empty UTF-8 text is valid, but `encode` writes
        /// only members whose key is a W3C token.
        key: []const u8,
        /// The decoded value, which is UTF-8.
        value: []const u8,
        /// The properties of a member built in code. Leave it empty when
        /// `metadata` is set.
        properties: []const Property = &.{},
        /// The properties as they arrived on the wire, without the leading
        /// semicolon and with empty properties removed. `parse` sets this
        /// instead of `properties`, as Go does, so a header with many
        /// properties costs no allocation per property, and `encode` writes
        /// it back unchanged. `decodedProperties` decodes it.
        metadata: []const u8 = "",

        /// Returns the member's properties with their values decoded: the
        /// `properties` field, or the parsed `metadata` allocated in
        /// `arena`. Malformed metadata gives no properties, as in Go.
        pub fn decodedProperties(m: Member, arena: Allocator) error{OutOfMemory}![]const Property {
            if (m.metadata.len == 0) return m.properties;
            var count: usize = 0;
            var it = std.mem.splitScalar(u8, m.metadata, ';');
            while (it.next()) |raw| {
                if (raw.len == 0) continue;
                if (propertyFields(raw) == null) return &.{};
                count += 1;
            }
            const out = try arena.alloc(Property, count);
            var i: usize = 0;
            it.reset();
            while (it.next()) |raw| {
                const fields = propertyFields(raw) orelse continue;
                const value = if (fields.raw_value) |v| try decodeValue(arena, v) else null;
                out[i] = .{ .key = fields.key, .value = value };
                i += 1;
            }
            return out;
        }
    };

    /// A member property: a key with an optional value.
    pub const Property = struct {
        /// The key. `encode` writes only properties whose key is a W3C token.
        key: []const u8,
        /// The decoded value, or null for a property without one.
        value: ?[]const u8 = null,
    };

    /// Parses a `baggage` header as Go's `baggage.Parse` does. Invalid
    /// members are skipped. Parsing stops at the 65th member or at the
    /// first member that would make the encoded baggage longer than 8192
    /// bytes, and keeps what came before. A duplicate key keeps its first
    /// position and takes the last value. A header longer than 8192 bytes
    /// gives `error.BaggageTooLarge`. Everything the result holds, the
    /// percent-decoded values included, is allocated in `arena`, so the
    /// result does not borrow `header`.
    pub fn parse(arena: Allocator, header: []const u8) ParseError!Baggage {
        if (header.len == 0) return .empty;
        if (header.len > max_bytes) return error.BaggageTooLarge;
        const text = try arena.dupe(u8, header);
        var list: [max_members]Member = undefined;
        var sizes: [max_members]usize = undefined;
        var n: usize = 0;
        var sum: usize = 0;
        var it = std.mem.splitScalar(u8, text, ',');
        while (it.next()) |item| {
            if (n >= max_members) break;
            const m = try parseMember(arena, item) orelse continue;
            const size = memberLen(m);
            const found = indexOfKey(list[0..n], m.key);
            const new_n = if (found == null) n + 1 else n;
            const new_sum = if (found) |i| sum - sizes[i] + size else sum + size;
            if (new_sum + new_n - 1 > max_bytes) break;
            const slot = found orelse n;
            list[slot] = m;
            sizes[slot] = size;
            n = new_n;
            sum = new_sum;
        }
        if (n == 0) return .empty;
        return .{ .members = try arena.dupe(Member, list[0..n]) };
    }

    /// Builds a baggage from members, as Go's `baggage.New` does with
    /// members from `NewMemberRaw`. Every member must have a non-empty
    /// UTF-8 key and a UTF-8 value, and so must its properties; a member
    /// with both `metadata` and `properties`, or with malformed `metadata`,
    /// is invalid. A duplicate key keeps its first position and takes the
    /// last value. Only the first 64 distinct keys are kept, and members
    /// that would make the encoded baggage longer than 8192 bytes are
    /// dropped. The member list is allocated in `arena`; the strings are
    /// borrowed from `members`.
    pub fn fromMembers(arena: Allocator, members: []const Member) FromMembersError!Baggage {
        for (members) |m| {
            if (!validMember(m)) return error.InvalidMember;
        }
        var list: [max_members]Member = undefined;
        var n: usize = 0;
        for (members) |m| {
            if (indexOfKey(list[0..n], m.key)) |i| {
                list[i] = m;
            } else if (n < max_members) {
                list[n] = m;
                n += 1;
            }
        }
        var kept: usize = 0;
        var total: usize = 0;
        for (list[0..n]) |m| {
            const size = memberLen(m);
            if (size > 0) {
                const add = size + @intFromBool(total > 0);
                if (total + add > max_bytes) continue;
                total += add;
            }
            list[kept] = m;
            kept += 1;
        }
        if (kept == 0) return .empty;
        return .{ .members = try arena.dupe(Member, list[0..kept]) };
    }

    /// Returns the member for `key`, or null.
    pub fn member(b: Baggage, key: []const u8) ?Member {
        const i = indexOfKey(b.members, key) orelse return null;
        return b.members[i];
    }

    /// Returns the number of members.
    pub fn len(b: Baggage) usize {
        return b.members.len;
    }

    /// Writes the W3C header form, as Go's `Baggage.String` does: members
    /// joined by commas, values percent-encoded, properties after
    /// semicolons. Members and properties whose key is not a W3C token are
    /// left out.
    pub fn encode(b: Baggage, w: *std.Io.Writer) std.Io.Writer.Error!void {
        var first = true;
        for (b.members) |m| {
            if (!validKey(m.key)) continue;
            if (!first) try w.writeByte(',');
            first = false;
            try w.writeAll(m.key);
            try w.writeByte('=');
            try writeEscaped(w, m.value);
            if (m.metadata.len > 0) {
                try w.writeByte(';');
                try w.writeAll(m.metadata);
            } else if (m.properties.len > 0) {
                try w.writeByte(';');
                var first_prop = true;
                for (m.properties) |p| {
                    if (!validKey(p.key)) continue;
                    if (!first_prop) try w.writeByte(';');
                    first_prop = false;
                    try w.writeAll(p.key);
                    if (p.value) |v| {
                        try w.writeByte('=');
                        try writeEscaped(w, v);
                    }
                }
            }
        }
    }
};

const BaggageMember = Baggage.Member;

fn indexOfKey(members: []const BaggageMember, key: []const u8) ?usize {
    for (members, 0..) |m, i| {
        if (std.mem.eql(u8, m.key, key)) return i;
    }
    return null;
}

/// Returns the length of what `encode` writes for `m`, without a comma.
fn memberLen(m: BaggageMember) usize {
    if (!validKey(m.key)) return 0;
    var n = m.key.len + 1 + escapedLen(m.value);
    if (m.metadata.len > 0) {
        n += 1 + m.metadata.len;
    } else if (m.properties.len > 0) {
        n += 1;
        var first = true;
        for (m.properties) |p| {
            if (!validKey(p.key)) continue;
            if (!first) n += 1;
            first = false;
            n += p.key.len;
            if (p.value) |v| n += 1 + escapedLen(v);
        }
    }
    return n;
}

fn validMember(m: BaggageMember) bool {
    if (m.key.len == 0 or !std.unicode.utf8ValidateSlice(m.key)) return false;
    if (!std.unicode.utf8ValidateSlice(m.value)) return false;
    for (m.properties) |p| {
        if (p.key.len == 0 or !std.unicode.utf8ValidateSlice(p.key)) return false;
        if (p.value) |v| if (!std.unicode.utf8ValidateSlice(v)) return false;
    }
    if (m.metadata.len > 0) {
        if (m.properties.len > 0) return false;
        if (!validMetadata(m.metadata)) return false;
    }
    return true;
}

/// Parses one list member, or returns null when it is invalid.
fn parseMember(arena: Allocator, item: []const u8) error{OutOfMemory}!?BaggageMember {
    var key_value = item;
    var raw_metadata: ?[]const u8 = null;
    if (std.mem.cutScalar(u8, item, ';')) |parts| {
        key_value = parts[0];
        if (!validMetadata(parts[1])) return null;
        raw_metadata = parts[1];
    }
    const raw_key, const raw_value = std.mem.cutScalar(u8, key_value, '=') orelse return null;
    const key = trimSpace(raw_key);
    if (!validKey(key)) return null;
    const raw = trimSpace(raw_value);
    for (raw) |c| {
        if (!valueChar(c)) return null;
    }
    if (!validPercentEncoding(raw)) return null;
    const metadata = if (raw_metadata) |md| try normalizeMetadata(arena, md) else "";
    return .{ .key = key, .value = try decodeValue(arena, raw), .metadata = metadata };
}

fn validMetadata(raw: []const u8) bool {
    var it = std.mem.splitScalar(u8, raw, ';');
    while (it.next()) |p| {
        if (p.len > 0 and propertyFields(p) == null) return false;
    }
    return true;
}

/// Removes empty properties and keeps the others as they are.
fn normalizeMetadata(arena: Allocator, raw: []const u8) error{OutOfMemory}![]const u8 {
    if (raw.len == 0 or (raw[0] != ';' and raw[raw.len - 1] != ';' and
        std.mem.find(u8, raw, ";;") == null)) return raw;
    var n: usize = 0;
    var it = std.mem.splitScalar(u8, raw, ';');
    while (it.next()) |p| {
        if (p.len == 0) continue;
        if (n > 0) n += 1;
        n += p.len;
    }
    const out = try arena.alloc(u8, n);
    var i: usize = 0;
    it.reset();
    while (it.next()) |p| {
        if (p.len == 0) continue;
        if (i > 0) {
            out[i] = ';';
            i += 1;
        }
        @memcpy(out[i..][0..p.len], p);
        i += p.len;
    }
    return out;
}

const PropertyFields = struct {
    key: []const u8,
    raw_value: ?[]const u8,
};

/// Validates a property, `key` or `key=value` with optional spaces and
/// tabs around each part, and locates its fields without decoding.
fn propertyFields(s: []const u8) ?PropertyFields {
    var i = skipSpace(s, 0);
    const key_start = i;
    while (i < s.len and keyChar(s[i])) i += 1;
    if (i == key_start) return null;
    const key = s[key_start..i];
    i = skipSpace(s, i);
    if (i == s.len) return .{ .key = key, .raw_value = null };
    if (s[i] != '=') return null;
    i = skipSpace(s, i + 1);
    const value_start = i;
    while (i < s.len and valueChar(s[i])) i += 1;
    const raw = s[value_start..i];
    if (skipSpace(s, i) != s.len) return null;
    if (!validPercentEncoding(raw)) return null;
    return .{ .key = key, .raw_value = raw };
}

fn skipSpace(s: []const u8, start: usize) usize {
    var i = start;
    while (i < s.len and (s[i] == ' ' or s[i] == '\t')) i += 1;
    return i;
}

fn validPercentEncoding(s: []const u8) bool {
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] != '%') continue;
        if (i + 2 >= s.len or !isHex(s[i + 1]) or !isHex(s[i + 2])) return false;
        i += 2;
    }
    return true;
}

fn isHex(c: u8) bool {
    return std.ascii.isHex(c);
}

fn hexValue(c: u8) u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => c - 'A' + 10,
    };
}

/// Percent-decodes `raw`, which `validPercentEncoding` accepted, into
/// `arena`, and replaces each byte that does not start a valid UTF-8
/// sequence with U+FFFD, as Go does.
fn decodeValue(arena: Allocator, raw: []const u8) error{OutOfMemory}![]const u8 {
    if (std.mem.findScalar(u8, raw, '%') == null) return raw;
    const decoded = try arena.alloc(u8, raw.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < raw.len) : (n += 1) {
        if (raw[i] == '%') {
            decoded[n] = hexValue(raw[i + 1]) << 4 | hexValue(raw[i + 2]);
            i += 3;
        } else {
            decoded[n] = raw[i];
            i += 1;
        }
    }
    const text = decoded[0..n];
    if (std.unicode.utf8ValidateSlice(text)) return text;
    return replaceInvalidUtf8(arena, text);
}

const replacement = "\u{FFFD}";

fn replaceInvalidUtf8(arena: Allocator, s: []const u8) error{OutOfMemory}![]const u8 {
    var total: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        if (validRuneLen(s, i)) |n| {
            total += n;
            i += n;
        } else {
            total += replacement.len;
            i += 1;
        }
    }
    const out = try arena.alloc(u8, total);
    var o: usize = 0;
    i = 0;
    while (i < s.len) {
        if (validRuneLen(s, i)) |n| {
            @memcpy(out[o..][0..n], s[i..][0..n]);
            o += n;
            i += n;
        } else {
            @memcpy(out[o..][0..replacement.len], replacement);
            o += replacement.len;
            i += 1;
        }
    }
    return out;
}

/// Returns the length of the valid UTF-8 sequence at `s[i]`, or null.
fn validRuneLen(s: []const u8, i: usize) ?usize {
    const n = std.unicode.utf8ByteSequenceLength(s[i]) catch return null;
    if (i + n > s.len) return null;
    const ok = switch (n) {
        1 => true,
        2 => if (std.unicode.utf8Decode2(s[i..][0..2].*)) |_| true else |_| false,
        3 => if (std.unicode.utf8Decode3(s[i..][0..3].*)) |_| true else |_| false,
        4 => if (std.unicode.utf8Decode4(s[i..][0..4].*)) |_| true else |_| false,
        else => false,
    };
    return if (ok) n else null;
}

/// Trims leading and trailing white space as Go's `strings.TrimSpace`
/// does, Unicode white space included.
fn trimSpace(s: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = s.len;
    while (start < end) {
        const n = spacePrefixLen(s[start..end]);
        if (n == 0) break;
        start += n;
    }
    while (end > start) {
        const n = spaceSuffixLen(s[start..end]);
        if (n == 0) break;
        end -= n;
    }
    return s[start..end];
}

/// The UTF-8 encodings of the non-ASCII characters Go's `unicode.IsSpace`
/// accepts.
const unicode_spaces = [_][]const u8{
    "\u{85}",   "\u{a0}",   "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}",
    "\u{2003}", "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}",
    "\u{2009}", "\u{200a}", "\u{2028}", "\u{2029}", "\u{202f}", "\u{205f}",
    "\u{3000}",
};

fn asciiSpace(c: u8) bool {
    return switch (c) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ' => true,
        else => false,
    };
}

fn spacePrefixLen(s: []const u8) usize {
    if (asciiSpace(s[0])) return 1;
    for (unicode_spaces) |sp| {
        if (std.mem.startsWith(u8, s, sp)) return sp.len;
    }
    return 0;
}

fn spaceSuffixLen(s: []const u8) usize {
    if (asciiSpace(s[s.len - 1])) return 1;
    for (unicode_spaces) |sp| {
        if (std.mem.endsWith(u8, s, sp)) return sp.len;
    }
    return 0;
}

/// Reports whether `s` is a W3C baggage key: a non-empty RFC 7230 token.
fn validKey(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |c| {
        if (!keyChar(c)) return false;
    }
    return true;
}

fn keyChar(c: u8) bool {
    return switch (c) {
        '!', '#'...'\'', '*', '+', '-', '.', '0'...'9', 'A'...'Z', '^'...'z', '|', '~' => true,
        else => false,
    };
}

/// The W3C baggage-octet set: %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E.
fn valueChar(c: u8) bool {
    return switch (c) {
        0x21, 0x23...0x2b, 0x2d...0x3a, 0x3c...0x5b, 0x5d...0x7e => true,
        else => false,
    };
}

fn shouldEscape(c: u8) bool {
    return c == '%' or !valueChar(c);
}

fn escapedLen(s: []const u8) usize {
    var n: usize = s.len;
    for (s) |c| {
        if (shouldEscape(c)) n += 2;
    }
    return n;
}

fn writeEscaped(w: *std.Io.Writer, s: []const u8) std.Io.Writer.Error!void {
    const upper = "0123456789ABCDEF";
    var start: usize = 0;
    for (s, 0..) |c, i| {
        if (!shouldEscape(c)) continue;
        try w.writeAll(s[start..i]);
        try w.writeAll(&.{ '%', upper[c >> 4], upper[c & 15] });
        start = i + 1;
    }
    try w.writeAll(s[start..]);
}

const testing = std.testing;

const Want = struct { key: []const u8, value: []const u8, metadata: []const u8 = "" };

fn expectMembers(want: []const Want, got: Baggage) !void {
    try testing.expectEqual(want.len, got.len());
    for (want, got.members) |w, m| {
        try testing.expectEqualStrings(w.key, m.key);
        try testing.expectEqualStrings(w.value, m.value);
        try testing.expectEqualStrings(w.metadata, m.metadata);
    }
}

fn sameBaggage(x: Baggage, y: Baggage) bool {
    if (x.members.len != y.members.len) return false;
    for (x.members, y.members) |m, n| {
        if (!std.mem.eql(u8, m.key, n.key) or !std.mem.eql(u8, m.value, n.value) or
            !std.mem.eql(u8, m.metadata, n.metadata) or m.properties.len != n.properties.len) return false;
    }
    return true;
}

fn encodeAlloc(gpa: std.mem.Allocator, b: Baggage) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(gpa);
    errdefer out.deinit();
    try b.encode(&out.writer);
    return out.toOwnedSlice();
}

test "parse decodes the Go valid cases" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { in: []const u8, want: []const Want }{
        .{ .in = "", .want = &.{} },
        .{ .in = "foo=", .want = &.{.{ .key = "foo", .value = "" }} },
        .{ .in = "foo=1", .want = &.{.{ .key = "foo", .value = "1" }} },
        .{ .in = "foo=1+1", .want = &.{.{ .key = "foo", .value = "1+1" }} },
        .{ .in = "foo=1%2B1", .want = &.{.{ .key = "foo", .value = "1+1" }} },
        .{ .in = "foo=1/1", .want = &.{.{ .key = "foo", .value = "1/1" }} },
        .{ .in = "foo=1%2F1", .want = &.{.{ .key = "foo", .value = "1/1" }} },
        .{ .in = "foo=1=1", .want = &.{.{ .key = "foo", .value = "1=1" }} },
        .{ .in = "foo=1%3D1", .want = &.{.{ .key = "foo", .value = "1=1" }} },
        .{ .in = " foo \t= 1\t\t ", .want = &.{.{ .key = "foo", .value = "1" }} },
        .{ .in = "foo=;state=on;red", .want = &.{.{ .key = "foo", .value = "", .metadata = "state=on;red" }} },
        .{ .in = "foo=1;state=on;red", .want = &.{.{ .key = "foo", .value = "1", .metadata = "state=on;red" }} },
        .{ .in = "k=v;a;;b;", .want = &.{.{ .key = "k", .value = "v", .metadata = "a;b" }} },
        .{ .in = "foo=0=0=0", .want = &.{.{ .key = "foo", .value = "0=0=0" }} },
        .{ .in = "foo=1;state=on;red,bar=2;yellow", .want = &.{
            .{ .key = "foo", .value = "1", .metadata = "state=on;red" },
            .{ .key = "bar", .value = "2", .metadata = "yellow" },
        } },
        .{ .in = "foo=1;state=on;red,foo=2", .want = &.{.{ .key = "foo", .value = "2" }} },
        .{ .in = "key==", .want = &.{.{ .key = "key", .value = "=" }} },
        .{ .in = "key1=val%252%2C", .want = &.{.{ .key = "key1", .value = "val%2," }} },
        .{ .in = "key1=;bar=val%252%2C", .want = &.{.{ .key = "key1", .value = "", .metadata = "bar=val%252%2C" }} },
        .{ .in = "foo=%C4%85%C5%9B%C4%87", .want = &.{.{ .key = "foo", .value = "ąść" }} },
        .{ .in = "a=b,%C4%85%C5%9B%C4%87=%C4%85%C5%9B%C4%87", .want = &.{
            .{ .key = "a", .value = "b" },
            .{ .key = "%C4%85%C5%9B%C4%87", .value = "ąść" },
        } },
        .{ .in = "foo=,,bar=", .want = &.{
            .{ .key = "foo", .value = "" },
            .{ .key = "bar", .value = "" },
        } },
        .{ .in = "key1=val1,key2=val2,a,val3", .want = &.{
            .{ .key = "key1", .value = "val1" },
            .{ .key = "key2", .value = "val2" },
        } },
        .{ .in = "key1 =   val1,  key2 =val2   ", .want = &.{
            .{ .key = "key1", .value = "val1" },
            .{ .key = "key2", .value = "val2" },
        } },
        .{ .in = "k=aa%ffcc;p=d%fff", .want = &.{.{ .key = "k", .value = "aa\u{FFFD}cc", .metadata = "p=d%fff" }} },
        .{ .in = "k=aa%ffcc%fedd%fa", .want = &.{.{ .key = "k", .value = "aa\u{FFFD}cc\u{FFFD}dd\u{FFFD}" }} },
        .{ .in = "k=aa%26cc", .want = &.{.{ .key = "k", .value = "aa&cc" }} },
        // Go's strings.TrimSpace also trims Unicode spaces such as U+00A0.
        .{ .in = "k\u{a0}=v\u{3000}", .want = &.{.{ .key = "k", .value = "v" }} },
    };
    for (cases) |c| {
        try expectMembers(c.want, try Baggage.parse(a, c.in));
    }
}

test "parse skips the Go invalid members" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_][]const u8{
        "=foo",
        "foo",
        "\\=value",
        "foo=\\",
        "key1=val%",
        "key1=val%4",
        "key1=val%zz",
        "foo=1;=v",
        "foo=1;key\\=v",
        "foo=1;key=\\",
        "foo=1;valid;key=val%",
        "foo=1; \t",
        "foo=1;key = a b",
        "fo o=1",
        "foo=a b",
        "k\xff=v",
    };
    for (cases) |in| {
        const b = try Baggage.parse(a, in);
        try testing.expectEqual(@as(usize, 0), b.len());
    }
}

test "parse enforces the size and member limits" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const too_large = try a.alloc(u8, Baggage.max_bytes + 1);
    @memset(too_large, 'k');
    try testing.expectError(error.BaggageTooLarge, Baggage.parse(a, too_large));

    var many: std.ArrayList(u8) = .empty;
    for (0..Baggage.max_members + 1) |i| {
        if (i > 0) try many.append(a, ',');
        try many.print(a, "a{d}=", .{i});
    }
    const b = try Baggage.parse(a, many.items);
    try testing.expectEqual(@as(usize, Baggage.max_members), b.len());
    try testing.expectEqualStrings("a63", b.members[63].key);

    // Three members of 2730 bytes and two commas are exactly 8192 bytes.
    const v: [2727]u8 = @splat('v');
    const at_max = try std.mem.concat(a, u8, &.{ "k0=", &v, ",k1=", &v, ",k2=", &v });
    try testing.expectEqual(@as(usize, Baggage.max_bytes), at_max.len);
    try testing.expectEqual(@as(usize, 3), (try Baggage.parse(a, at_max)).len());

    // A member whose escaped form would push the total past the limit stops
    // parsing; the members before it are kept.
    var wide: std.ArrayList(u8) = .empty;
    try wide.appendSlice(a, "a=");
    try wide.appendNTimes(a, 'v', 4000);
    try wide.appendSlice(a, ",b=");
    for (0..1000) |_| try wide.appendSlice(a, "%ff");
    const cut = try Baggage.parse(a, wide.items);
    try testing.expectEqual(@as(usize, 1), cut.len());
    try testing.expectEqualStrings("a", cut.members[0].key);
}

test "parse copies what it keeps into the arena" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    var header = "key=val;p=1".*;
    const b = try Baggage.parse(arena.allocator(), &header);
    @memset(&header, 'x');
    try expectMembers(&.{.{ .key = "key", .value = "val", .metadata = "p=1" }}, b);
}

test "member finds a member by key" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const b = try Baggage.parse(arena.allocator(), "a=1,b=2");
    try testing.expectEqualStrings("2", b.member("b").?.value);
    try testing.expectEqual(null, b.member("c"));
    try testing.expectEqual(null, Baggage.empty.member("a"));
}

test "decodedProperties decodes the metadata or returns the properties" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const b = try Baggage.parse(a, "k=v;state=on;red; x = a%20b ;e=;bad=%ff");
    const props = try b.members[0].decodedProperties(a);
    try testing.expectEqual(@as(usize, 5), props.len);
    try testing.expectEqualStrings("state", props[0].key);
    try testing.expectEqualStrings("on", props[0].value.?);
    try testing.expectEqualStrings("red", props[1].key);
    try testing.expectEqual(null, props[1].value);
    try testing.expectEqualStrings("x", props[2].key);
    try testing.expectEqualStrings("a b", props[2].value.?);
    try testing.expectEqualStrings("e", props[3].key);
    try testing.expectEqualStrings("", props[3].value.?);
    try testing.expectEqualStrings("\u{FFFD}", props[4].value.?);

    const m: Baggage.Member = .{ .key = "k", .value = "v", .properties = &.{.{ .key = "p" }} };
    try testing.expectEqual(m.properties.ptr, (try m.decodedProperties(a)).ptr);
}

test "encode writes the Go header form" {
    const gpa = testing.allocator;
    var all: [128]u8 = undefined;
    for (&all, 0..) |*c, i| c.* = @intCast(i);
    const cases = [_]struct { out: []const u8, members: []const Baggage.Member }{
        .{ .out = "", .members = &.{} },
        .{ .out = "foo=", .members = &.{.{ .key = "foo", .value = "" }} },
        .{ .out = "foo=1", .members = &.{.{ .key = "foo", .value = "1" }} },
        .{
            .out = "foo=%00%01%02%03%04%05%06%07%08%09%0A%0B%0C%0D%0E%0F%10%11%12%13%14%15%16%17%18%19%1A%1B%1C%1D%1E%1F%20!%22#$%25&'()*+%2C-./0123456789:%3B<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[%5C]^_`abcdefghijklmnopqrstuvwxyz{|}~%7F",
            .members = &.{.{ .key = "foo", .value = &all }},
        },
        .{ .out = "foo=%C4%85%C5%9B%C4%87", .members = &.{.{ .key = "foo", .value = "ąść" }} },
        .{ .out = "foo=;bar=%20", .members = &.{.{ .key = "foo", .value = "", .properties = &.{.{ .key = "bar", .value = " " }} }} },
        .{ .out = "foo=1+1", .members = &.{.{ .key = "foo", .value = "1+1" }} },
        .{ .out = "foo=1=1", .members = &.{.{ .key = "foo", .value = "1=1" }} },
        .{ .out = "foo=1;state=on;red;z=z=z", .members = &.{.{ .key = "foo", .value = "1", .properties = &.{
            .{ .key = "state", .value = "on" },
            .{ .key = "red" },
            .{ .key = "z", .value = "z=z" },
        } }} },
        .{ .out = "bar=2;yellow,foo=1;red", .members = &.{
            .{ .key = "bar", .value = "2", .properties = &.{.{ .key = "yellow" }} },
            .{ .key = "foo", .value = "1", .properties = &.{.{ .key = "red" }} },
        } },
        // W3C does not allow non-token keys, so those members and
        // properties are left out.
        .{ .out = "foo=B%25%20%F0%9F%92%BC-2;foo-1=B%25%20%F0%9F%92%BC-4;foo-2", .members = &.{
            .{ .key = "ąść", .value = "B% 💼", .properties = &.{ .{ .key = "ąść-1", .value = "B% 💼-1" }, .{ .key = "ąść-2" } } },
            .{ .key = "foo", .value = "B% 💼-2", .properties = &.{
                .{ .key = "ąść", .value = "B% 💼-3" },
                .{ .key = "foo-1", .value = "B% 💼-4" },
                .{ .key = "foo-2" },
            } },
        } },
        .{ .out = "k=v; raw = x%41", .members = &.{.{ .key = "k", .value = "v", .metadata = " raw = x%41" }} },
    };
    for (cases) |c| {
        const text = try encodeAlloc(gpa, .{ .members = c.members });
        defer gpa.free(text);
        try testing.expectEqualStrings(c.out, text);
    }
}

test "fromMembers validates, keeps the last value of a key and enforces the limits" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    const b = try Baggage.fromMembers(a, &.{
        .{ .key = "a", .value = "1" },
        .{ .key = "b", .value = "2" },
        .{ .key = "a", .value = "3" },
    });
    try expectMembers(&.{ .{ .key = "a", .value = "3" }, .{ .key = "b", .value = "2" } }, b);
    try testing.expectEqual(@as(usize, 0), (try Baggage.fromMembers(a, &.{})).len());

    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "", .value = "1" }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "\xff", .value = "1" }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "k", .value = "\xff" }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "k", .value = "v", .properties = &.{.{ .key = "" }} }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "k", .value = "v", .properties = &.{.{ .key = "p", .value = "\xff" }} }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "k", .value = "v", .metadata = "=x" }}));
    try testing.expectError(error.InvalidMember, Baggage.fromMembers(a, &.{.{ .key = "k", .value = "v", .metadata = "p", .properties = &.{.{ .key = "p" }} }}));
    // A UTF-8 key is a valid OpenTelemetry key even though encode leaves it out.
    try testing.expectEqual(@as(usize, 1), (try Baggage.fromMembers(a, &.{.{ .key = "ąść", .value = "1" }})).len());

    var many: [Baggage.max_members + 1]Baggage.Member = undefined;
    var keys: [Baggage.max_members + 1][4]u8 = undefined;
    for (&many, &keys, 0..) |*m, *k, i| {
        const key = try std.fmt.bufPrint(k, "k{d}", .{i});
        m.* = .{ .key = key, .value = "" };
    }
    const capped = try Baggage.fromMembers(a, &many);
    try testing.expectEqual(@as(usize, Baggage.max_members), capped.len());

    // Members that would push the encoded form past 8192 bytes are dropped.
    const big: [5000]u8 = @splat('v');
    const sized = try Baggage.fromMembers(a, &.{
        .{ .key = "a", .value = &big },
        .{ .key = "b", .value = &big },
        .{ .key = "c", .value = "1" },
    });
    try expectMembers(&.{ .{ .key = "a", .value = &big }, .{ .key = "c", .value = "1" } }, sized);
}

test "parse, encode and parse again gives the same baggage" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const b = try Baggage.parse(a, " k = a%20b%ff ;p= x ;;q, j=%2C%3B ");
    const text = try encodeAlloc(a, b);
    try testing.expectEqualStrings("k=a%20b%EF%BF%BD;p= x ;q,j=%2C%3B", text);
    const again = try Baggage.parse(a, text);
    try testing.expect(sameBaggage(b, again));
}

fn fuzzParse(_: void, smith: *testing.Smith) anyerror!void {
    var buf: [Baggage.max_bytes + 16]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const b = Baggage.parse(a, input) catch |err| switch (err) {
        error.BaggageTooLarge => return testing.expect(input.len > Baggage.max_bytes),
        error.OutOfMemory => return err,
    };
    try testing.expect(b.len() <= Baggage.max_members);
    for (b.members) |m| {
        try testing.expect(std.unicode.utf8ValidateSlice(m.value));
        _ = try m.decodedProperties(a);
    }
    // The encoded form fits the limit and parses back to the same members.
    const text = try encodeAlloc(a, b);
    try testing.expect(text.len <= Baggage.max_bytes);
    const again = try Baggage.parse(a, text);
    try testing.expect(sameBaggage(b, again));
    try testing.expectEqualStrings(text, try encodeAlloc(a, again));
}

test "fuzz the baggage parser" {
    try testing.fuzz({}, fuzzParse, .{ .corpus = &.{
        "key1=val1,key2=val2",
        " foo \t= 1\t\t ",
        "foo=1;state=on;red,bar=2;yellow",
        "k=v;a;;b;",
        "k=aa%ffcc;p=d%fff",
        "a=b,%C4%85%C5%9B%C4%87=%C4%85%C5%9B%C4%87",
        "foo=,,bar=",
        "key1=val%",
        "foo=1; \t",
        "k\u{a0}=v\u{3000}",
        "a=1,a=2,b=3",
    } });
}
