//! OTLP/JSON encoding and decoding for the vendored OTLP protobuf messages.
//!
//! zig-protobuf's own JSON support writes proto3 canonical JSON, which is
//! not OTLP/JSON. This file follows the OTLP specification's "JSON Protobuf
//! Encoding" and the proto3 JSON mapping it builds on:
//!
//! - Field names are the lowerCamelCase form of the proto field names. The
//!   decoder also accepts the original snake_case names.
//! - `trace_id`, `span_id` and `parent_span_id` are lowercase hex strings.
//!   Every other `bytes` field is standard base64 with padding. The decoder
//!   accepts hex in either case and base64 in the standard or URL-safe
//!   alphabet, with or without padding.
//! - Enums are integers. The decoder also accepts the value names.
//! - 64-bit integers are decimal strings and 32-bit integers are numbers.
//!   The decoder accepts either form for both.
//! - Doubles are numbers, and NaN and the infinities are the strings
//!   "NaN", "Infinity" and "-Infinity".
//! - Oneof members appear directly in the enclosing object.
//! - Fields holding their default value are omitted. Optional scalars
//!   (`?T`) and set submessages are written even when they hold zero.
//! - The decoder ignores unknown fields and treats `null` as the default.
//!
//! Both directions are driven at comptime by each message's generated
//! `_desc_table`, so the same code serves traces, metrics and logs.

const std = @import("std");

const Allocator = std.mem.Allocator;
const Writer = std.Io.Writer;
const Value = std.json.Value;
const ObjectMap = std.json.ObjectMap;

/// The deepest nesting of messages `decode` accepts, counting the
/// top-level message as one. OTLP's own messages nest about eight deep, so
/// the limit leaves room for nested attribute values (array and kvlist
/// values) while bounding the decoder's recursion.
pub const max_depth = 64;

/// The errors `decode` returns.
pub const DecodeError = error{
    /// The input is not well-formed JSON, or an object repeats a key.
    InvalidJson,
    /// A field has the wrong JSON type, or its value is malformed or out
    /// of range for the field.
    InvalidField,
    /// Messages are nested deeper than `max_depth`.
    NestingTooDeep,
    /// The allocator failed.
    OutOfMemory,
};

/// Writes `message`, a generated OTLP message such as
/// `collector_trace_v1.ExportTraceServiceRequest`, to `w` as compact
/// OTLP/JSON. Fields appear in declaration order, so the output is
/// deterministic. Invalid UTF-8 in a string field is written as U+FFFD.
pub fn encode(comptime T: type, message: T, w: *Writer) Writer.Error!void {
    return encodeMessage(T, message, w);
}

/// Parses OTLP/JSON into a message of type `T`. Every allocation, including
/// the decoded strings and lists, goes to `arena`, and the result does not
/// refer to `bytes`. The caller frees the result by freeing the arena.
pub fn decode(comptime T: type, arena: Allocator, bytes: []const u8) DecodeError!T {
    const root = std.json.parseFromSliceLeaky(Value, arena, bytes, .{
        .parse_numbers = false,
        .duplicate_field_behavior = .@"error",
        .allocate = .alloc_always,
    }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.InvalidJson,
    };
    return decodeMessage(T, arena, root, 1);
}

/// How one field value is written and read.
const Codec = enum { string, bytes, trace_id, span_id, int, float, boolean, enumeration, message };

/// The codec for a field `name` whose (element) type is `ftype`, a
/// `protobuf.FieldType` or a `protobuf.FieldType.Repeated`.
fn codecOf(comptime name: []const u8, comptime ftype: anytype) Codec {
    const tag = @tagName(std.meta.activeTag(ftype));
    if (std.mem.eql(u8, tag, "enum")) return .enumeration;
    if (std.mem.eql(u8, tag, "submessage")) return .message;
    if (!std.mem.eql(u8, tag, "scalar")) @compileError("unsupported field type for " ++ name);
    return switch (ftype.scalar) {
        .string => .string,
        .bytes => if (std.mem.eql(u8, name, "trace_id"))
            .trace_id
        else if (std.mem.eql(u8, name, "span_id") or std.mem.eql(u8, name, "parent_span_id"))
            .span_id
        else
            .bytes,
        .bool => .boolean,
        .float, .double => .float,
        else => .int,
    };
}

/// The lowerCamelCase JSON name of the proto field `snake`.
fn jsonName(comptime snake: []const u8) []const u8 {
    comptime {
        var out: [snake.len]u8 = undefined;
        var n: usize = 0;
        var upper = false;
        for (snake) |c| {
            if (c == '_') {
                upper = true;
                continue;
            }
            out[n] = if (upper) std.ascii.toUpper(c) else c;
            upper = false;
            n += 1;
        }
        const final = out[0..n].*;
        return &final;
    }
}

fn Child(comptime F: type) type {
    return switch (@typeInfo(F)) {
        .optional => |o| o.child,
        else => F,
    };
}

fn ListElem(comptime F: type) type {
    return @typeInfo(@FieldType(F, "items")).pointer.child;
}

// Encoding.

fn writeKey(w: *Writer, first: *bool, comptime name: []const u8) Writer.Error!void {
    if (!first.*) try w.writeByte(',');
    first.* = false;
    try w.writeAll("\"" ++ comptime jsonName(name) ++ "\":");
}

fn encodeMessage(comptime T: type, message: T, w: *Writer) Writer.Error!void {
    const info = @typeInfo(T).@"struct";
    try w.writeByte('{');
    var first = true;
    inline for (info.field_names, info.field_types) |name, F| {
        const desc = @field(T._desc_table, name);
        const value = @field(message, name);
        switch (desc.ftype) {
            .oneof => |U| if (value) |member| switch (member) {
                inline else => |inner, tag| {
                    const tag_name = @tagName(tag);
                    const codec = comptime codecOf(tag_name, @field(U._desc_table, tag_name).ftype);
                    try writeKey(w, &first, tag_name);
                    try encodeValue(@TypeOf(inner), codec, inner, w);
                },
            },
            .repeated, .packed_repeated => |elem| if (value.items.len > 0) {
                const codec = comptime codecOf(name, elem);
                try writeKey(w, &first, name);
                try w.writeByte('[');
                for (value.items, 0..) |item, i| {
                    if (i > 0) try w.writeByte(',');
                    try encodeValue(ListElem(F), codec, item, w);
                }
                try w.writeByte(']');
            },
            else => {
                const codec = comptime codecOf(name, desc.ftype);
                if (@typeInfo(F) == .optional) {
                    if (value) |inner| {
                        try writeKey(w, &first, name);
                        try encodeValue(Child(F), codec, inner, w);
                    }
                } else if (!isDefault(F, codec, value)) {
                    try writeKey(w, &first, name);
                    try encodeValue(F, codec, value, w);
                }
            },
        }
    }
    try w.writeByte('}');
}

fn isDefault(comptime V: type, comptime codec: Codec, value: V) bool {
    return switch (codec) {
        .string, .bytes, .trace_id, .span_id => value.len == 0,
        .int => value == 0,
        .float => @as(@Int(.unsigned, @bitSizeOf(V)), @bitCast(value)) == 0,
        .boolean => !value,
        .enumeration => @backingInt(value) == 0,
        .message => false,
    };
}

fn encodeValue(comptime V: type, comptime codec: Codec, value: V, w: *Writer) Writer.Error!void {
    switch (codec) {
        .string => try writeString(w, value),
        .bytes => {
            try w.writeByte('"');
            try std.base64.standard.Encoder.encodeWriter(w, value);
            try w.writeByte('"');
        },
        .trace_id, .span_id => {
            try w.writeByte('"');
            try w.printHex(value, .lower);
            try w.writeByte('"');
        },
        .int => if (@bitSizeOf(V) > 32) try w.print("\"{d}\"", .{value}) else try w.print("{d}", .{value}),
        .float => try writeFloat(w, value),
        .boolean => try w.writeAll(if (value) "true" else "false"),
        .enumeration => try w.print("{d}", .{@backingInt(value)}),
        .message => try encodeMessage(V, value, w),
    }
}

/// Writes a double as the shortest decimal that reads back to the same
/// value, in plain notation for magnitudes from 1e-6 up to 1e21 and in
/// exponent notation outside that range, as JavaScript does.
fn writeFloat(w: *Writer, value: f64) Writer.Error!void {
    if (std.math.isNan(value)) return w.writeAll("\"NaN\"");
    if (std.math.isInf(value)) return w.writeAll(if (value > 0) "\"Infinity\"" else "\"-Infinity\"");
    const magnitude = @abs(value);
    if (magnitude == 0 or (magnitude >= 1e-6 and magnitude < 1e21)) {
        try w.print("{d}", .{value});
    } else {
        try w.print("{e}", .{value});
    }
}

/// Writes `s` as a JSON string. Control characters, quotes and
/// backslashes are escaped. Each byte that does not start a valid UTF-8
/// sequence is written as U+FFFD, so the output is always valid JSON.
fn writeString(w: *Writer, s: []const u8) Writer.Error!void {
    try w.writeByte('"');
    var start: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const c = s[i];
        if (c >= 0x20 and c < 0x80 and c != '"' and c != '\\') {
            i += 1;
            continue;
        }
        if (c >= 0x80) {
            if (utf8SequenceLength(s[i..])) |len| {
                i += len;
                continue;
            }
        }
        try w.writeAll(s[start..i]);
        switch (c) {
            '"' => try w.writeAll("\\\""),
            '\\' => try w.writeAll("\\\\"),
            '\n' => try w.writeAll("\\n"),
            '\r' => try w.writeAll("\\r"),
            '\t' => try w.writeAll("\\t"),
            0x08 => try w.writeAll("\\b"),
            0x0c => try w.writeAll("\\f"),
            0x00...0x07, 0x0b, 0x0e...0x1f => try w.print("\\u{x:0>4}", .{c}),
            else => try w.writeAll("\\ufffd"),
        }
        i += 1;
        start = i;
    }
    try w.writeAll(s[start..]);
    try w.writeByte('"');
}

/// The length of the valid UTF-8 sequence at the start of `s`, or null if
/// `s` does not start with one.
fn utf8SequenceLength(s: []const u8) ?usize {
    const len = std.unicode.utf8ByteSequenceLength(s[0]) catch return null;
    if (len > s.len) return null;
    _ = std.unicode.utf8Decode(s[0..len]) catch return null;
    return len;
}

// Decoding.

fn lookup(object: ObjectMap, comptime name: []const u8) ?Value {
    const camel = comptime jsonName(name);
    const found = object.get(camel) orelse if (comptime std.mem.eql(u8, camel, name)) null else object.get(name);
    const value = found orelse return null;
    return if (value == .null) null else value;
}

fn decodeMessage(comptime T: type, arena: Allocator, value: Value, depth: usize) DecodeError!T {
    if (depth > max_depth) return error.NestingTooDeep;
    const object = switch (value) {
        .object => |o| o,
        else => return error.InvalidField,
    };
    const info = @typeInfo(T).@"struct";
    var message: T = .{};
    inline for (info.field_names, info.field_types) |name, F| {
        const desc = @field(T._desc_table, name);
        switch (desc.ftype) {
            .oneof => |U| @field(message, name) = try decodeOneof(U, arena, object, depth),
            .repeated, .packed_repeated => |elem| if (lookup(object, name)) |found| {
                const items = switch (found) {
                    .array => |a| a.items,
                    else => return error.InvalidField,
                };
                const codec = comptime codecOf(name, elem);
                const Elem = ListElem(F);
                var out: std.ArrayList(Elem) = .empty;
                try out.ensureTotalCapacityPrecise(arena, items.len);
                for (items) |item| {
                    if (item == .null) return error.InvalidField;
                    out.appendAssumeCapacity(try decodeValue(Elem, codec, arena, item, depth));
                }
                @field(message, name) = out;
            },
            else => if (lookup(object, name)) |found| {
                const codec = comptime codecOf(name, desc.ftype);
                @field(message, name) = try decodeValue(Child(F), codec, arena, found, depth);
            },
        }
    }
    return message;
}

fn decodeOneof(comptime U: type, arena: Allocator, object: ObjectMap, depth: usize) DecodeError!?U {
    const info = @typeInfo(U).@"union";
    var result: ?U = null;
    inline for (info.field_names, info.field_types) |name, F| {
        const camel = comptime jsonName(name);
        const keys: []const []const u8 = comptime if (std.mem.eql(u8, camel, name)) &.{name} else &.{ camel, name };
        inline for (keys) |key| {
            const found: Value = object.get(key) orelse .null;
            if (found != .null) {
                if (result != null) return error.InvalidField;
                const codec = comptime codecOf(name, @field(U._desc_table, name).ftype);
                result = @unionInit(U, name, try decodeValue(F, codec, arena, found, depth));
            }
        }
    }
    return result;
}

fn decodeValue(comptime V: type, comptime codec: Codec, arena: Allocator, value: Value, depth: usize) DecodeError!V {
    switch (codec) {
        .string => return switch (value) {
            .string => |s| s,
            else => error.InvalidField,
        },
        .bytes => return decodeBase64(arena, try expectString(value)),
        .trace_id => return decodeHex(arena, try expectString(value), 16),
        .span_id => return decodeHex(arena, try expectString(value), 8),
        .int => return decodeInt(V, value),
        .float => return decodeFloat(value),
        .boolean => return switch (value) {
            .bool => |b| b,
            else => error.InvalidField,
        },
        .enumeration => return decodeEnum(V, value),
        .message => return decodeMessage(V, arena, value, depth + 1),
    }
}

fn expectString(value: Value) DecodeError![]const u8 {
    return switch (value) {
        .string => |s| s,
        else => error.InvalidField,
    };
}

/// Decodes a hex id of exactly `len` bytes. The empty string is the
/// default (absent) id.
fn decodeHex(arena: Allocator, text: []const u8, comptime len: usize) DecodeError![]const u8 {
    if (text.len == 0) return &.{};
    if (text.len != 2 * len) return error.InvalidField;
    const out = try arena.alloc(u8, len);
    for (out, 0..) |*b, i| {
        const hi = std.fmt.charToDigit(text[2 * i], 16) catch return error.InvalidField;
        const lo = std.fmt.charToDigit(text[2 * i + 1], 16) catch return error.InvalidField;
        b.* = hi << 4 | lo;
    }
    return out;
}

/// Decodes base64 in the standard or URL-safe alphabet, with or without
/// padding, as the proto3 JSON mapping requires.
fn decodeBase64(arena: Allocator, text: []const u8) DecodeError![]const u8 {
    var body = text;
    var pad: usize = 0;
    while (pad < 2 and body.len > 0 and body[body.len - 1] == '=') : (pad += 1) body = body[0 .. body.len - 1];
    if (pad > 0 and text.len % 4 != 0) return error.InvalidField;
    const url_safe = std.mem.indexOfAny(u8, body, "-_") != null;
    const decoder = if (url_safe) std.base64.url_safe_no_pad.Decoder else std.base64.standard_no_pad.Decoder;
    const len = decoder.calcSizeForSlice(body) catch return error.InvalidField;
    const out = try arena.alloc(u8, len);
    decoder.decode(out, body) catch return error.InvalidField;
    return out;
}

/// Reports whether `text` follows the JSON number grammar.
fn isJsonNumber(text: []const u8) bool {
    var i: usize = 0;
    if (i < text.len and text[i] == '-') i += 1;
    if (i >= text.len) return false;
    if (text[i] == '0') {
        i += 1;
    } else if (std.ascii.isDigit(text[i])) {
        while (i < text.len and std.ascii.isDigit(text[i])) i += 1;
    } else return false;
    if (i < text.len and text[i] == '.') {
        i += 1;
        const digits = i;
        while (i < text.len and std.ascii.isDigit(text[i])) i += 1;
        if (i == digits) return false;
    }
    if (i < text.len and (text[i] == 'e' or text[i] == 'E')) {
        i += 1;
        if (i < text.len and (text[i] == '+' or text[i] == '-')) i += 1;
        const digits = i;
        while (i < text.len and std.ascii.isDigit(text[i])) i += 1;
        if (i == digits) return false;
    }
    return i == text.len;
}

/// The text of a JSON number, or of a string holding one.
fn numberText(value: Value) DecodeError![]const u8 {
    const text = switch (value) {
        .number_string, .string => |s| s,
        else => return error.InvalidField,
    };
    if (!isJsonNumber(text)) return error.InvalidField;
    return text;
}

/// Decodes an integer from a JSON number or a string holding one. A
/// number with a fraction or an exponent is accepted when its value is a
/// whole number in range, as the proto3 JSON mapping allows.
fn decodeInt(comptime I: type, value: Value) DecodeError!I {
    const text = try numberText(value);
    if (std.mem.indexOfAny(u8, text, ".eE") == null) {
        return std.fmt.parseInt(I, text, 10) catch error.InvalidField;
    }
    const f = std.fmt.parseFloat(f64, text) catch return error.InvalidField;
    const signed = @typeInfo(I).int.signedness == .signed;
    const magnitude_bits = if (signed) @bitSizeOf(I) - 1 else @bitSizeOf(I);
    const high: f64 = std.math.ldexp(@as(f64, 1), magnitude_bits);
    const low: f64 = if (signed) -high else 0;
    if (!(f >= low and f < high) or @floor(f) != f) return error.InvalidField;
    return @intFromFloat(f);
}

fn decodeFloat(value: Value) DecodeError!f64 {
    if (value == .string) {
        const s = value.string;
        if (std.mem.eql(u8, s, "NaN")) return std.math.nan(f64);
        if (std.mem.eql(u8, s, "Infinity")) return std.math.inf(f64);
        if (std.mem.eql(u8, s, "-Infinity")) return -std.math.inf(f64);
    }
    const text = try numberText(value);
    const f = std.fmt.parseFloat(f64, text) catch return error.InvalidField;
    if (std.math.isInf(f)) return error.InvalidField;
    return f;
}

/// Decodes an enum from its integer value or its name. OTLP enums are
/// open, so an integer without a name is kept.
fn decodeEnum(comptime E: type, value: Value) DecodeError!E {
    if (value == .string) {
        if (std.meta.stringToEnum(E, value.string)) |e| return e;
        return error.InvalidField;
    }
    if (value != .number_string) return error.InvalidField;
    const info = @typeInfo(E).@"enum";
    const n = try decodeInt(info.tag_type, value);
    if (info.mode == .nonexhaustive) return @fromBackingInt(n);
    return std.enums.fromInt(E, n) orelse error.InvalidField;
}

test {
    _ = @import("json_test.zig");
}
