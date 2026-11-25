//! Trace and span identifiers, trace flags and the span context.

const std = @import("std");
const TraceState = @import("tracestate.zig").TraceState;

/// A 16-byte W3C trace id. The all-zero id is invalid.
pub const TraceId = struct {
    bytes: [16]u8,

    pub const invalid: TraceId = .{ .bytes = @splat(0) };

    /// Reports whether the id is not all zeros.
    pub fn isValid(id: TraceId) bool {
        return !std.mem.allEqual(u8, &id.bytes, 0);
    }

    /// Parses 32 lowercase hex characters. It returns null for any other
    /// input, including uppercase hex, and accepts the all-zero id, which
    /// `isValid` rejects.
    pub fn parseHex(text: []const u8) ?TraceId {
        var id: TraceId = undefined;
        if (!parseLowerHex(&id.bytes, text)) return null;
        return id;
    }

    /// Returns the id as 32 lowercase hex characters.
    pub fn hex(id: TraceId) [32]u8 {
        return std.fmt.bytesToHex(id.bytes, .lower);
    }

    /// Writes the id as lowercase hex, for `{f}`.
    pub fn format(id: TraceId, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll(&id.hex());
    }
};

/// An 8-byte W3C span id. The all-zero id is invalid.
pub const SpanId = struct {
    bytes: [8]u8,

    pub const invalid: SpanId = .{ .bytes = @splat(0) };

    /// Reports whether the id is not all zeros.
    pub fn isValid(id: SpanId) bool {
        return !std.mem.allEqual(u8, &id.bytes, 0);
    }

    /// Parses 16 lowercase hex characters, as `TraceId.parseHex` does.
    pub fn parseHex(text: []const u8) ?SpanId {
        var id: SpanId = undefined;
        if (!parseLowerHex(&id.bytes, text)) return null;
        return id;
    }

    /// Returns the id as 16 lowercase hex characters.
    pub fn hex(id: SpanId) [16]u8 {
        return std.fmt.bytesToHex(id.bytes, .lower);
    }

    /// Writes the id as lowercase hex, for `{f}`.
    pub fn format(id: SpanId, w: *std.Io.Writer) std.Io.Writer.Error!void {
        try w.writeAll(&id.hex());
    }
};

fn parseLowerHex(out: []u8, text: []const u8) bool {
    if (text.len != out.len * 2) return false;
    for (out, 0..) |*byte, i| {
        const hi = lowerHexDigit(text[2 * i]) orelse return false;
        const lo = lowerHexDigit(text[2 * i + 1]) orelse return false;
        byte.* = hi << 4 | lo;
    }
    return true;
}

/// Returns the value of a lowercase hex digit, or null.
pub fn lowerHexDigit(c: u8) ?u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        else => null,
    };
}

/// The W3C trace flags byte. Only the sampled bit has a meaning here.
pub const TraceFlags = packed struct(u8) {
    sampled: bool = false,
    rest: u7 = 0,

    pub const sampled_flag: TraceFlags = .{ .sampled = true };

    /// Returns the flags as the byte W3C tracecontext carries.
    pub fn toByte(flags: TraceFlags) u8 {
        return @bitCast(flags);
    }

    /// Returns the flags for a W3C tracecontext byte.
    pub fn fromByte(byte: u8) TraceFlags {
        return @bitCast(byte);
    }
};

/// The identity of a span that crosses process boundaries: its trace id,
/// span id, flags and trace state, and whether it came from another
/// process. It borrows the trace state text.
pub const SpanContext = struct {
    trace_id: TraceId = .invalid,
    span_id: SpanId = .invalid,
    flags: TraceFlags = .{},
    trace_state: TraceState = .empty,
    remote: bool = false,

    pub const invalid: SpanContext = .{};

    /// Reports whether both ids are valid.
    pub fn isValid(sc: SpanContext) bool {
        return sc.trace_id.isValid() and sc.span_id.isValid();
    }

    /// Reports whether the sampled flag is set.
    pub fn isSampled(sc: SpanContext) bool {
        return sc.flags.sampled;
    }

    /// Reports whether two span contexts have the same ids, flags, trace
    /// state text and remote flag.
    pub fn eql(a: SpanContext, b: SpanContext) bool {
        return std.mem.eql(u8, &a.trace_id.bytes, &b.trace_id.bytes) and
            std.mem.eql(u8, &a.span_id.bytes, &b.span_id.bytes) and
            a.flags == b.flags and a.remote == b.remote and
            std.mem.eql(u8, a.trace_state.header, b.trace_state.header);
    }
};

/// Generates random trace and span ids from the `std.Io` random source.
pub const IdGenerator = struct {
    io: std.Io,

    /// Returns a random, valid trace id.
    pub fn traceId(g: IdGenerator) TraceId {
        var id: TraceId = .invalid;
        while (!id.isValid()) g.io.random(&id.bytes);
        return id;
    }

    /// Returns a random, valid span id.
    pub fn spanId(g: IdGenerator) SpanId {
        var id: SpanId = .invalid;
        while (!id.isValid()) g.io.random(&id.bytes);
        return id;
    }
};

const testing = std.testing;

test "ids parse and print lowercase hex" {
    const t = TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?;
    try testing.expect(t.isValid());
    try testing.expectEqualStrings("4bf92f3577b34da6a3ce929d0e0e4736", &t.hex());
    try testing.expectFmt("4bf92f3577b34da6a3ce929d0e0e4736", "{f}", .{t});
    const s = SpanId.parseHex("00f067aa0ba902b7").?;
    try testing.expectFmt("00f067aa0ba902b7", "{f}", .{s});
    try testing.expectEqual(null, TraceId.parseHex("4BF92F3577B34DA6A3CE929D0E0E4736"));
    try testing.expectEqual(null, SpanId.parseHex("00f067aa0ba902b"));
    try testing.expectEqual(null, SpanId.parseHex("00f067aa0ba902bg"));
    try testing.expect(!TraceId.parseHex("00000000000000000000000000000000").?.isValid());
}

test "IdGenerator returns valid, distinct ids" {
    const g: IdGenerator = .{ .io = testing.io };
    const a = g.traceId();
    const b = g.traceId();
    try testing.expect(a.isValid() and b.isValid());
    try testing.expect(!std.mem.eql(u8, &a.bytes, &b.bytes));
    try testing.expect(g.spanId().isValid());
}

test "SpanContext validity and flags" {
    try testing.expect(!SpanContext.invalid.isValid());
    const sc: SpanContext = .{
        .trace_id = TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
    };
    try testing.expect(sc.isValid() and sc.isSampled());
    try testing.expectEqual(@as(u8, 1), sc.flags.toByte());
    try testing.expect(TraceFlags.fromByte(0x03).sampled);
    try testing.expect(sc.eql(sc));
    var other = sc;
    other.remote = true;
    try testing.expect(!sc.eql(other));
}
