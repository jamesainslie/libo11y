//! The W3C trace state, ported from go.opentelemetry.io/otel/trace
//! v1.47.0 (tracestate.go).

const std = @import("std");
const Allocator = std.mem.Allocator;

/// A W3C `tracestate` value in canonical form: list members joined by
/// commas, without optional whitespace or empty members. It borrows its
/// text.
///
/// The functions that build a trace state either return `empty`, borrow
/// text the caller passed in, or allocate the new text in the allocator
/// they take. Pass an arena, which frees all of it at once.
pub const TraceState = struct {
    /// The canonical header text.
    header: []const u8 = "",

    /// The trace state with no members.
    pub const empty: TraceState = .{};

    /// The most list members a trace state holds.
    pub const max_members = 32;

    /// The error `parse` returns.
    pub const ParseError = error{ InvalidTraceState, OutOfMemory };

    /// The error `insert` returns.
    pub const InsertError = error{ InvalidKey, InvalidValue, OutOfMemory };

    /// One list member. Both strings borrow the trace state's text.
    pub const Member = struct {
        key: []const u8,
        value: []const u8,
    };

    /// Iterates over the members in order.
    pub const Iterator = struct {
        rest: []const u8,

        /// Returns the next member, or null at the end.
        pub fn next(it: *Iterator) ?Member {
            while (it.rest.len > 0) {
                const item, it.rest = cutComma(it.rest);
                if (item.len == 0) continue;
                const key, const value = std.mem.cutScalar(u8, item, '=') orelse return null;
                return .{ .key = key, .value = value };
            }
            return null;
        }
    };

    /// Parses a `tracestate` header as Go's `trace.ParseTraceState` does.
    /// Empty list members are skipped, spaces and tabs before a key and
    /// after a value are trimmed, and a malformed member, a duplicate key
    /// or more than 32 members makes the whole header invalid. When `text`
    /// is already canonical the result borrows it; otherwise the canonical
    /// text is allocated in `gpa`.
    pub fn parse(gpa: Allocator, text: []const u8) ParseError!TraceState {
        var members: [max_members]Member = undefined;
        var n: usize = 0;
        var canonical_len: usize = 0;
        var rest = text;
        while (rest.len > 0) {
            const item, rest = cutComma(rest);
            if (item.len == 0) continue;
            const m = parseMember(item) orelse return error.InvalidTraceState;
            for (members[0..n]) |prev| {
                if (std.mem.eql(u8, prev.key, m.key)) return error.InvalidTraceState;
            }
            if (n == max_members) return error.InvalidTraceState;
            members[n] = m;
            n += 1;
            canonical_len += m.key.len + 1 + m.value.len;
        }
        if (n == 0) return .empty;
        canonical_len += n - 1;
        // The canonical form only removes bytes, so equal lengths mean the
        // text is already canonical.
        if (canonical_len == text.len) return .{ .header = text };
        return .{ .header = try join(gpa, members[0..n], canonical_len) };
    }

    /// Returns the value for `key`, or null when there is no such member.
    pub fn get(ts: TraceState, key: []const u8) ?[]const u8 {
        var it = ts.iterator();
        while (it.next()) |m| {
            if (std.mem.eql(u8, m.key, key)) return m.value;
        }
        return null;
    }

    /// Returns the number of members.
    pub fn len(ts: TraceState) usize {
        var n: usize = 0;
        var it = ts.iterator();
        while (it.next()) |_| n += 1;
        return n;
    }

    /// Reports whether the trace state has no members.
    pub fn isEmpty(ts: TraceState) bool {
        return ts.header.len == 0;
    }

    /// Returns an iterator over the members in order.
    pub fn iterator(ts: TraceState) Iterator {
        return .{ .rest = ts.header };
    }

    /// Returns a trace state with `key` set to `value` as its first member,
    /// as Go's `TraceState.Insert` does. An existing member with the same
    /// key is removed. When the result would have more than 32 members, the
    /// right-most one is dropped. The new text is allocated in `gpa`, and
    /// `ts` is unchanged.
    pub fn insert(ts: TraceState, gpa: Allocator, key: []const u8, value: []const u8) InsertError!TraceState {
        if (!validKey(key)) return error.InvalidKey;
        if (!validValue(value)) return error.InvalidValue;
        var members: [max_members]Member = undefined;
        members[0] = .{ .key = key, .value = value };
        var n: usize = 1;
        var total: usize = key.len + 1 + value.len;
        var it = ts.iterator();
        while (it.next()) |m| {
            if (n == max_members) break;
            if (std.mem.eql(u8, m.key, key)) continue;
            members[n] = m;
            n += 1;
            total += 1 + m.key.len + 1 + m.value.len;
        }
        return .{ .header = try join(gpa, members[0..n], total) };
    }

    /// Returns a trace state without the member for `key`. When there is no
    /// such member the result is `ts` itself; otherwise the new text is
    /// allocated in `gpa`.
    pub fn delete(ts: TraceState, gpa: Allocator, key: []const u8) error{OutOfMemory}!TraceState {
        var members: [max_members]Member = undefined;
        var n: usize = 0;
        var total: usize = 0;
        var found = false;
        var it = ts.iterator();
        while (it.next()) |m| {
            if (!found and std.mem.eql(u8, m.key, key)) {
                found = true;
                continue;
            }
            if (n == max_members) break;
            members[n] = m;
            n += 1;
            total += m.key.len + 1 + m.value.len;
        }
        if (!found) return ts;
        if (n == 0) return .empty;
        return .{ .header = try join(gpa, members[0..n], total + n - 1) };
    }

    /// Reports whether `key` is a valid W3C list-member key: a simple key
    /// of a lowercase letter and up to 255 more characters, or a
    /// multi-tenant key `tenant@system`.
    pub fn validKey(key: []const u8) bool {
        const tenant, const system = std.mem.cutScalar(u8, key, '@') orelse
            return validKeyPart(key, 255);
        return validTenant(tenant) and validKeyPart(system, 13);
    }

    /// Reports whether `value` is a valid W3C list-member value: 1 to 256
    /// printable ASCII characters other than `,` and `=`, not ending in a
    /// space.
    pub fn validValue(value: []const u8) bool {
        if (value.len == 0 or value.len > 256) return false;
        for (value[0 .. value.len - 1]) |c| {
            if (!valueChar(c)) return false;
        }
        const last = value[value.len - 1];
        return last != ' ' and valueChar(last);
    }
};

/// Splits `s` at its first comma.
fn cutComma(s: []const u8) struct { []const u8, []const u8 } {
    return std.mem.cutScalar(u8, s, ',') orelse .{ s, "" };
}

fn parseMember(item: []const u8) ?TraceState.Member {
    const raw_key, const raw_value = std.mem.cutScalar(u8, item, '=') orelse return null;
    const key = std.mem.trimStart(u8, raw_key, " \t");
    const value = std.mem.trimEnd(u8, raw_value, " \t");
    if (!TraceState.validKey(key) or !TraceState.validValue(value)) return null;
    return .{ .key = key, .value = value };
}

fn join(gpa: Allocator, members: []const TraceState.Member, total: usize) error{OutOfMemory}![]const u8 {
    const out = try gpa.alloc(u8, total);
    var i: usize = 0;
    for (members, 0..) |m, idx| {
        if (idx > 0) {
            out[i] = ',';
            i += 1;
        }
        @memcpy(out[i..][0..m.key.len], m.key);
        i += m.key.len;
        out[i] = '=';
        i += 1;
        @memcpy(out[i..][0..m.value.len], m.value);
        i += m.value.len;
    }
    return out;
}

fn valueChar(c: u8) bool {
    return c >= 0x20 and c <= 0x7e and c != ',' and c != '=';
}

fn keyRestChar(c: u8) bool {
    return switch (c) {
        'a'...'z', '0'...'9', '_', '-', '*', '/' => true,
        else => false,
    };
}

fn validKeyRest(rest: []const u8, max: usize) bool {
    if (rest.len > max) return false;
    for (rest) |c| {
        if (!keyRestChar(c)) return false;
    }
    return true;
}

fn validKeyPart(key: []const u8, max_rest: usize) bool {
    if (key.len == 0) return false;
    return key[0] >= 'a' and key[0] <= 'z' and validKeyRest(key[1..], max_rest);
}

fn validTenant(tenant: []const u8) bool {
    if (tenant.len == 0) return false;
    const first = tenant[0];
    const ok = (first >= 'a' and first <= 'z') or (first >= '0' and first <= '9');
    return ok and validKeyRest(tenant[1..], 240);
}

const testing = std.testing;

const max32 = "bar01=01,bar02=02,bar03=03,bar04=04,bar05=05,bar06=06,bar07=07,bar08=08," ++
    "bar09=09,bar10=10,bar11=11,bar12=12,bar13=13,bar14=14,bar15=15,bar16=16," ++
    "bar17=17,bar18=18,bar19=19,bar20=20,bar21=21,bar22=22,bar23=23,bar24=24," ++
    "bar25=25,bar26=26,bar27=27,bar28=28,bar29=29,bar30=30,bar31=31,bar32=32";

const all_value_chars = " !\"#$%&'()*+-./0123456789:;<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

test "parse accepts the W3C valid cases and returns the canonical form" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cases = [_]struct { in: []const u8, out: []const u8 }{
        .{ .in = "", .out = "" },
        .{ .in = "foo=1", .out = "foo=1" },
        .{ .in = "foo=1,", .out = "foo=1" },
        .{ .in = ",,", .out = "" },
        .{ .in = "foo=1,bar=2", .out = "foo=1,bar=2" },
        .{ .in = "foo=1,bar=2,rojo=1,congo=2,baz=3", .out = "foo=1,bar=2,rojo=1,congo=2,baz=3" },
        .{ .in = "foo=1 \t , \t bar=2, \t baz=3", .out = "foo=1,bar=2,baz=3" },
        .{ .in = "foo=1\t \t,\t \tbar=2,\t \tbaz=3", .out = "foo=1,bar=2,baz=3" },
        .{ .in = "foo=1 ", .out = "foo=1" },
        .{ .in = "foo=1\t", .out = "foo=1" },
        .{ .in = "foo=1 \t", .out = "foo=1" },
        .{ .in = "abcdefghijklmnopqrstuvwxyz0123456789_-*/=" ++ all_value_chars, .out = "abcdefghijklmnopqrstuvwxyz0123456789_-*/=" ++ all_value_chars },
        .{ .in = "abcdefghijklmnopqrstuvwxyz0123456789_-*/@a-z0-9_-*/=" ++ all_value_chars, .out = "abcdefghijklmnopqrstuvwxyz0123456789_-*/@a-z0-9_-*/=" ++ all_value_chars },
        .{ .in = max32, .out = max32 },
        .{ .in = "a= b", .out = "a= b" },
    };
    for (cases) |c| {
        const ts = try TraceState.parse(a, c.in);
        try testing.expectEqualStrings(c.out, ts.header);
    }
    // Canonical input is borrowed, not copied.
    const canonical = "foo=1,bar=2";
    try testing.expectEqual(canonical.ptr, (try TraceState.parse(a, canonical)).header.ptr);
}

test "parse accepts keys and values at their maximum lengths" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const simple: [256]u8 = @splat('z');
    const in = try std.mem.concat(a, u8, &.{ "foo=1,", &simple, "=1" });
    try testing.expectEqualStrings(in, (try TraceState.parse(a, in)).header);

    const tenant: [241]u8 = @splat('t');
    const system: [14]u8 = @splat('v');
    const in2 = try std.mem.concat(a, u8, &.{ "foo=1,", &tenant, "@", &system, "=1" });
    try testing.expectEqualStrings(in2, (try TraceState.parse(a, in2)).header);

    const value: [256]u8 = @splat('v');
    const in3 = try std.mem.concat(a, u8, &.{ "k=", &value });
    try testing.expectEqualStrings(in3, (try TraceState.parse(a, in3)).header);
}

test "parse rejects the W3C invalid cases" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const too_long_simple: [257]u8 = @splat('z');
    const too_long_tenant: [242]u8 = @splat('t');
    const too_long_value: [257]u8 = @splat('v');
    const cases = [_][]const u8{
        "foo=1,foo=1",
        "foo=1,foo=2",
        "foo =1",
        "FOO=1",
        "foo.bar=1",
        "foo@=1,bar=2",
        "@foo=1,bar=2",
        "foo@@bar=1,bar=2",
        "foo@bar@baz=1,bar=2",
        "foo=1,t@vvvvvvvvvvvvvvv=1",
        "foo=bar=baz",
        "foo=,bar=3",
        max32 ++ ",bar33=33",
        "foo",
        "foo=1, ,bar=2",
        "foo=1\x7f",
        "foo=a,b",
        "1foo=1",
        try std.mem.concat(a, u8, &.{ &too_long_simple, "=1" }),
        try std.mem.concat(a, u8, &.{ &too_long_tenant, "@v=1" }),
        try std.mem.concat(a, u8, &.{ "k=", &too_long_value }),
    };
    for (cases) |in| {
        try testing.expectError(error.InvalidTraceState, TraceState.parse(a, in));
    }
}

test "get, len, isEmpty and the iterator read the members" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const ts = try TraceState.parse(arena.allocator(), max32);
    try testing.expectEqual(@as(usize, 32), ts.len());
    try testing.expectEqualStrings("16", ts.get("bar16").?);
    try testing.expectEqual(null, ts.get("keyxx"));
    try testing.expectEqual(null, ts.get("key!"));
    try testing.expect(!ts.isEmpty());
    try testing.expect(TraceState.empty.isEmpty());
    try testing.expectEqual(@as(usize, 0), TraceState.empty.len());

    var it = (try TraceState.parse(arena.allocator(), "key1=val1,key2=val2")).iterator();
    const first = it.next().?;
    try testing.expectEqualStrings("key1", first.key);
    try testing.expectEqualStrings("val1", first.value);
    const second = it.next().?;
    try testing.expectEqualStrings("key2", second.key);
    try testing.expectEqualStrings("val2", second.value);
    try testing.expectEqual(null, it.next());
}

test "insert moves the key to the front and drops the right-most member when full" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const base = try TraceState.parse(a, "key1=val1,key2=val2,key3=val3");

    try testing.expectEqualStrings("key4@vendor=val4,key1=val1,key2=val2,key3=val3", (try base.insert(a, "key4@vendor", "val4")).header);
    try testing.expectEqualStrings("key2=valX,key1=val1,key3=val3", (try base.insert(a, "key2", "valX")).header);
    try testing.expectEqualStrings("k=v", (try TraceState.empty.insert(a, "k", "v")).header);
    try testing.expectError(error.InvalidKey, base.insert(a, "key!", "val"));
    try testing.expectError(error.InvalidValue, base.insert(a, "key", "v=l"));
    try testing.expectError(error.InvalidKey, base.insert(a, "key!", "v=l"));
    // The original is unchanged.
    try testing.expectEqualStrings("key1=val1,key2=val2,key3=val3", base.header);

    const full = try TraceState.parse(a, max32);
    const inserted = try full.insert(a, "keyx", "valx");
    try testing.expectEqual(@as(usize, 32), inserted.len());
    try testing.expectEqualStrings("keyx=valx," ++ max32[0 .. max32.len - ",bar32=32".len], inserted.header);
    const replaced = try full.insert(a, "bar32", "xx");
    try testing.expectEqual(@as(usize, 32), replaced.len());
    try testing.expectEqualStrings("bar32=xx," ++ max32[0 .. max32.len - ",bar32=32".len], replaced.header);
}

test "delete removes one member and leaves the original alone" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const base = try TraceState.parse(a, "key1=val1,key2=val2,key3=val3");
    try testing.expectEqualStrings("key1=val1,key3=val3", (try base.delete(a, "key2")).header);
    try testing.expectEqualStrings("key2=val2,key3=val3", (try base.delete(a, "key1")).header);
    try testing.expectEqualStrings("key1=val1,key2=val2", (try base.delete(a, "key3")).header);
    try testing.expectEqualStrings(base.header, (try base.delete(a, "keyx")).header);
    try testing.expectEqualStrings(base.header, (try base.delete(a, "in va lid")).header);
    try testing.expect((try (try TraceState.parse(a, "k=v")).delete(a, "k")).isEmpty());
    try testing.expectEqualStrings("key1=val1,key2=val2,key3=val3", base.header);
}

test "validKey and validValue follow the W3C grammar" {
    try testing.expect(TraceState.validKey("a"));
    try testing.expect(TraceState.validKey("0@a"));
    try testing.expect(!TraceState.validKey(""));
    try testing.expect(!TraceState.validKey("0"));
    try testing.expect(!TraceState.validKey("a@"));
    try testing.expect(!TraceState.validKey("a@0"));
    try testing.expect(TraceState.validValue("x y"));
    try testing.expect(TraceState.validValue(" x"));
    try testing.expect(!TraceState.validValue("x "));
    try testing.expect(!TraceState.validValue(""));
    try testing.expect(!TraceState.validValue("a,b"));
}

fn fuzzParse(_: void, smith: *testing.Smith) anyerror!void {
    var buf: [1024]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];
    const gpa = testing.allocator;
    const ts = TraceState.parse(gpa, input) catch |err| switch (err) {
        error.InvalidTraceState => return,
        error.OutOfMemory => return err,
    };
    const owned = ts.header.len > 0 and ts.header.ptr != input.ptr;
    defer if (owned) gpa.free(ts.header);
    // The canonical form parses to itself, borrowed, with the same members.
    const again = try TraceState.parse(gpa, ts.header);
    try testing.expectEqual(ts.header.ptr, again.header.ptr);
    try testing.expectEqualStrings(ts.header, again.header);
    try testing.expect(ts.len() <= TraceState.max_members);
    var it = ts.iterator();
    while (it.next()) |m| {
        try testing.expect(TraceState.validKey(m.key) and TraceState.validValue(m.value));
        try testing.expectEqualStrings(m.value, ts.get(m.key).?);
    }
}

test "fuzz the tracestate parser" {
    try testing.fuzz({}, fuzzParse, .{ .corpus = &.{
        "foo=1",
        "foo=1 \t , \t bar=2, \t baz=3",
        ",,foo=1,,",
        "abcdefghijklmnopqrstuvwxyz0123456789_-*/@a-z0-9_-*/=" ++ all_value_chars,
        max32,
        max32 ++ ",bar33=33",
        "foo=1,foo=2",
        "foo=bar=baz",
        "FOO=1",
        "foo=1, ,bar=2",
    } });
}
