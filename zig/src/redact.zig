//! Capture-time protection for sensitive values: `Secret(T)`, `Masked(T)`,
//! and `Struct(T)`.
//!
//! Every wrapper guards `std.fmt` (`format`), `std.json` (`jsonStringify`),
//! and the libo11y logger's attribute walk so protected forms render
//! identically across every surface. Unknown comptime tags on `Struct(T)` are
//! a `@compileError`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const log_record = @import("pipeline/log_record.zig");

/// The literal string that replaces redacted values.
pub const redacted_literal = "REDACTED";

/// Maximum recursion depth for `Struct` protection; deeper graphs fail closed
/// to `"REDACTED"`.
pub const max_depth: usize = 32;

/// Protection levels, ordered from weakest to strictest. Strictest wins
/// through nesting.
pub const Protection = enum(u8) {
    passthrough = 0,
    mask = 1,
    redact = 2,
    omit = 3,

    /// Maps a tag string or enum literal to a protection level at comptime.
    /// Recognizes `mask`, `redact`, `omit`, and the spec synonyms
    /// `confidential` (mask) and `secret` (redact). Any other tag is a
    /// compile error.
    pub fn fromComptimeTag(comptime tag: anytype) Protection {
        const T = @TypeOf(tag);
        if (T == Protection) return tag;
        const name: []const u8 = switch (@typeInfo(T)) {
            .enum_literal => @tagName(tag),
            .pointer => |p| blk: {
                if (p.size == .slice and p.child == u8) break :blk tag;
                if (p.size == .one) {
                    const child = @typeInfo(p.child);
                    if (child == .array and child.array.child == u8) break :blk tag[0..];
                }
                @compileError("o11y.redact: tag must be a string or enum literal, got " ++ @typeName(T));
            },
            else => @compileError("o11y.redact: tag must be a string or enum literal, got " ++ @typeName(T)),
        };
        if (std.mem.eql(u8, name, "") or std.mem.eql(u8, name, "passthrough")) return .passthrough;
        if (std.mem.eql(u8, name, "mask") or std.mem.eql(u8, name, "confidential")) return .mask;
        if (std.mem.eql(u8, name, "redact") or std.mem.eql(u8, name, "secret")) return .redact;
        if (std.mem.eql(u8, name, "omit")) return .omit;
        @compileError("o11y.redact: unknown protection tag '" ++ name ++ "' (expected mask, confidential, redact, secret, or omit)");
    }

    pub fn strictest(a: Protection, b: Protection) Protection {
        return if (@backingInt(a) >= @backingInt(b)) a else b;
    }
};

/// Wraps a value of type `T` that must never appear in telemetry. Renders as
/// `"REDACTED"` in `std.fmt`, `std.json`, and libo11y logs. Retrieve the
/// wrapped value explicitly via `reveal()`.
pub fn Secret(comptime T: type) type {
    return struct {
        const Self = @This();
        pub const o11y_redact_kind = .secret;
        pub const Inner = T;

        _value: T,

        pub fn init(value: T) Self {
            return .{ ._value = value };
        }

        /// Returns the wrapped value. The deliberate name makes retrieval easy
        /// to audit.
        pub fn reveal(self: Self) T {
            return self._value;
        }

        pub fn format(_: Self, w: *Io.Writer) Io.Writer.Error!void {
            try w.writeAll(redacted_literal);
        }

        pub fn jsonStringify(_: Self, jw: anytype) !void {
            try jw.write(redacted_literal);
        }
    };
}

/// Convenience constructor for `Secret(T)`.
pub fn secret(value: anytype) Secret(@TypeOf(value)) {
    return .init(value);
}

/// Wraps a value of type `T` and renders it as a run of `'X'` matching the
/// UTF-8 code point count of its text form, preserving shape without leaking
/// content.
pub fn Masked(comptime T: type) type {
    return struct {
        const Self = @This();
        pub const o11y_redact_kind = .masked;
        pub const Inner = T;

        _value: T,

        pub fn init(value: T) Self {
            return .{ ._value = value };
        }

        pub fn reveal(self: Self) T {
            return self._value;
        }

        pub fn format(self: Self, w: *Io.Writer) Io.Writer.Error!void {
            const count = maskedRuneCount(T, self._value);
            try writeXs(w, count);
        }

        pub fn jsonStringify(self: Self, jw: anytype) !void {
            const count = maskedRuneCount(T, self._value);
            var buf: [256]u8 = @splat('X');
            if (count <= buf.len) {
                try jw.write(buf[0..count]);
                return;
            }
            // Write directly as a JSON string for long masked values without allocating.
            try jw.beginWriteRaw();
            try jw.writer.writeByte('"');
            try writeXs(jw.writer, count);
            try jw.writer.writeByte('"');
            jw.endWriteRaw();
        }
    };
}

/// Convenience constructor for `Masked(T)`.
pub fn masked(value: anytype) Masked(@TypeOf(value)) {
    return .init(value);
}

/// Wraps a struct `T` and applies comptime protections declared in
/// `T.o11y_tags` (a comptime struct literal mapping field names to `.mask`,
/// `.confidential`, `.redact`, `.secret`, or `.omit` / string equivalents).
///
/// Validation happens at compile time: an unknown field name or an unknown tag
/// value triggers `@compileError`. Strictest protection wins through nested
/// structs, optionals, slices, and arrays.
pub fn Struct(comptime T: type) type {
    comptime validateStructType(T, 0);
    return struct {
        const Self = @This();
        pub const o11y_redact_kind = .@"struct";
        pub const Inner = T;

        value: T,

        pub fn init(value: T) Self {
            return .{ .value = value };
        }

        pub fn format(self: Self, w: *Io.Writer) Io.Writer.Error!void {
            try formatProtected(T, self.value, .passthrough, 0, w);
        }

        pub fn jsonStringify(self: Self, jw: anytype) !void {
            try stringifyProtected(T, self.value, .passthrough, 0, jw);
        }
    };
}

/// Convenience constructor for `Struct(T)`.
pub fn wrapStruct(value: anytype) Struct(@TypeOf(value)) {
    return .init(value);
}

/// Converts any value (including `Secret`, `Masked`, `Struct`, and plain
/// Zig scalars/structs/slices) into a `log_record.Value` allocated in `arena`,
/// applying capture-time redaction rules.
pub fn toLogValue(arena: Allocator, value: anytype) Allocator.Error!log_record.Value {
    return toLogValueProtected(@TypeOf(value), value, .passthrough, 0, arena);
}

fn validateStructType(comptime T: type, comptime depth: usize) void {
    if (depth > max_depth) return;
    const info = @typeInfo(T);
    if (info != .@"struct") return;
    if (@hasDecl(T, "o11y_redact_kind")) return;
    if (@hasDecl(T, "o11y_tags")) {
        const tags = T.o11y_tags;
        const tags_info = @typeInfo(@TypeOf(tags));
        if (tags_info != .@"struct") {
            @compileError("o11y.redact: " ++ @typeName(T) ++ ".o11y_tags must be a struct");
        }
        inline for (tags_info.@"struct".field_names) |tf_name| {
            if (!@hasField(T, tf_name)) {
                @compileError("o11y.redact: tag for unknown field '" ++ tf_name ++ "' on " ++ @typeName(T));
            }
            _ = Protection.fromComptimeTag(@field(tags, tf_name));
        }
    }
    inline for (info.@"struct".field_types) |ft| {
        validateFieldType(ft, depth + 1);
    }
}

fn validateFieldType(comptime F: type, comptime depth: usize) void {
    if (depth > max_depth) return;
    switch (@typeInfo(F)) {
        .@"struct" => validateStructType(F, depth),
        .optional => |opt| validateFieldType(opt.child, depth + 1),
        .pointer => |ptr| validateFieldType(ptr.child, depth + 1),
        .array => |arr| validateFieldType(arr.child, depth + 1),
        else => {},
    }
}

fn fieldProtection(comptime S: type, comptime field_name: []const u8) Protection {
    if (!@hasDecl(S, "o11y_tags")) return .passthrough;
    const tags = S.o11y_tags;
    if (!@hasField(@TypeOf(tags), field_name)) return .passthrough;
    return comptime Protection.fromComptimeTag(@field(tags, field_name));
}

fn isStringType(comptime T: type) bool {
    return switch (@typeInfo(T)) {
        .pointer => |p| switch (p.size) {
            .slice => p.child == u8,
            .one => switch (@typeInfo(p.child)) {
                .array => |a| a.child == u8,
                else => false,
            },
            else => false,
        },
        else => false,
    };
}

fn asStringSlice(comptime T: type, value: T) []const u8 {
    return switch (@typeInfo(T)) {
        .pointer => |p| switch (p.size) {
            .slice => value,
            .one => value[0..],
            else => "",
        },
        else => "",
    };
}

/// Counts UTF-8 code points in `s` as Go's `utf8.RuneCountInString` does:
/// each valid UTF-8 sequence counts as 1, and each invalid byte counts as 1.
pub fn utf8RuneCount(s: []const u8) usize {
    var count: usize = 0;
    var i: usize = 0;
    while (i < s.len) {
        const seq_len = std.unicode.utf8ByteSequenceLength(s[i]) catch {
            count += 1;
            i += 1;
            continue;
        };
        if (i + seq_len > s.len) {
            count += 1;
            i += 1;
            continue;
        }
        _ = std.unicode.utf8Decode(s[i .. i + seq_len]) catch {
            count += 1;
            i += 1;
            continue;
        };
        count += 1;
        i += seq_len;
    }
    return count;
}

fn maskedRuneCount(comptime T: type, value: T) usize {
    if (comptime isStringType(T)) {
        return utf8RuneCount(asStringSlice(T, value));
    }
    var buf: [256]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    formatScalar(T, value, &w) catch {};
    return utf8RuneCount(w.buffered());
}

fn writeXs(w: *Io.Writer, count: usize) Io.Writer.Error!void {
    const chunk: [64]u8 = @splat('X');
    var rem = count;
    while (rem >= chunk.len) {
        try w.writeAll(&chunk);
        rem -= chunk.len;
    }
    if (rem > 0) try w.writeAll(chunk[0..rem]);
}

fn allocXs(arena: Allocator, count: usize) Allocator.Error![]const u8 {
    const out = try arena.alloc(u8, count);
    @memset(out, 'X');
    return out;
}

fn formatScalar(comptime T: type, value: T, w: *Io.Writer) Io.Writer.Error!void {
    if (comptime isStringType(T)) {
        try w.writeAll(asStringSlice(T, value));
        return;
    }
    switch (@typeInfo(T)) {
        .bool => try w.writeAll(if (value) "true" else "false"),
        .int, .comptime_int => try w.print("{d}", .{value}),
        .float, .comptime_float => try w.print("{d}", .{value}),
        .@"enum" => {
            if (@hasDecl(T, "asStr")) {
                try w.writeAll(value.asStr());
            } else {
                try w.writeAll(@tagName(value));
            }
        },
        .enum_literal => try w.writeAll(@tagName(value)),
        .error_set => try w.writeAll(@errorName(value)),
        else => try w.print("{any}", .{value}),
    }
}

fn formatProtected(comptime T: type, value: T, comptime floor: Protection, comptime depth: usize, w: *Io.Writer) Io.Writer.Error!void {
    if (comptime floor == .redact or floor == .omit or depth > max_depth) {
        try w.writeAll(redacted_literal);
        return;
    }
    if (comptime @typeInfo(T) == .@"struct" and @hasDecl(T, "o11y_redact_kind")) {
        switch (comptime T.o11y_redact_kind) {
            .secret => {
                try w.writeAll(redacted_literal);
                return;
            },
            .masked => {
                try value.format(w);
                return;
            },
            .@"struct" => {
                try formatProtected(T.Inner, value.value, floor, depth, w);
                return;
            },
            else => {},
        }
    }
    if (comptime isStringType(T)) {
        const s = asStringSlice(T, value);
        if (comptime floor == .mask) {
            try writeXs(w, utf8RuneCount(s));
        } else {
            try w.writeAll(s);
        }
        return;
    }
    switch (@typeInfo(T)) {
        .optional => |opt| {
            if (value) |inner| {
                try formatProtected(opt.child, inner, floor, depth + 1, w);
            } else {
                try w.writeAll("null");
            }
        },
        .pointer => |ptr| switch (ptr.size) {
            .one => try formatProtected(ptr.child, value.*, floor, depth + 1, w),
            .slice => {
                try w.writeByte('[');
                for (value, 0..) |item, i| {
                    if (i > 0) try w.writeByte(' ');
                    try formatProtected(ptr.child, item, floor, depth + 1, w);
                }
                try w.writeByte(']');
            },
            else => try w.writeAll(redacted_literal),
        },
        .array => |arr| {
            try w.writeByte('[');
            for (value, 0..) |item, i| {
                if (i > 0) try w.writeByte(' ');
                try formatProtected(arr.child, item, floor, depth + 1, w);
            }
            try w.writeByte(']');
        },
        .@"struct" => |s| {
            try w.writeByte('{');
            var first = true;
            inline for (s.field_names, s.field_types) |fname, ftype| {
                const eff = comptime Protection.strictest(floor, fieldProtection(T, fname));
                if (comptime eff != .omit) {
                    if (!first) try w.writeByte(' ');
                    first = false;
                    try w.writeAll(fname);
                    try w.writeByte(':');
                    try formatProtected(ftype, @field(value, fname), eff, depth + 1, w);
                }
            }
            try w.writeByte('}');
        },
        else => {
            if (comptime floor == .mask) {
                try writeXs(w, maskedRuneCount(T, value));
            } else {
                try formatScalar(T, value, w);
            }
        },
    }
}

fn stringifyProtected(comptime T: type, value: T, comptime floor: Protection, comptime depth: usize, jw: anytype) !void {
    if (comptime floor == .redact or floor == .omit or depth > max_depth) {
        try jw.write(redacted_literal);
        return;
    }
    if (comptime @typeInfo(T) == .@"struct" and @hasDecl(T, "o11y_redact_kind")) {
        switch (comptime T.o11y_redact_kind) {
            .secret => {
                try jw.write(redacted_literal);
                return;
            },
            .masked => {
                try value.jsonStringify(jw);
                return;
            },
            .@"struct" => {
                try stringifyProtected(T.Inner, value.value, floor, depth, jw);
                return;
            },
            else => {},
        }
    }
    if (comptime isStringType(T)) {
        const s = asStringSlice(T, value);
        if (comptime floor == .mask) {
            try Masked([]const u8).init(s).jsonStringify(jw);
        } else {
            try jw.write(s);
        }
        return;
    }
    switch (@typeInfo(T)) {
        .optional => |opt| {
            if (value) |inner| {
                try stringifyProtected(opt.child, inner, floor, depth + 1, jw);
            } else {
                try jw.write(null);
            }
        },
        .pointer => |ptr| switch (ptr.size) {
            .one => try stringifyProtected(ptr.child, value.*, floor, depth + 1, jw),
            .slice => {
                try jw.beginArray();
                for (value) |item| {
                    try stringifyProtected(ptr.child, item, floor, depth + 1, jw);
                }
                try jw.endArray();
            },
            else => try jw.write(redacted_literal),
        },
        .array => |arr| {
            try jw.beginArray();
            for (value) |item| {
                try stringifyProtected(arr.child, item, floor, depth + 1, jw);
            }
            try jw.endArray();
        },
        .@"struct" => |s| {
            try jw.beginObject();
            inline for (s.field_names, s.field_types) |fname, ftype| {
                const eff = comptime Protection.strictest(floor, fieldProtection(T, fname));
                if (comptime eff != .omit) {
                    try jw.objectField(fname);
                    try stringifyProtected(ftype, @field(value, fname), eff, depth + 1, jw);
                }
            }
            try jw.endObject();
        },
        .bool, .int, .comptime_int, .float, .comptime_float => {
            if (comptime floor == .mask) {
                try Masked(T).init(value).jsonStringify(jw);
            } else {
                try jw.write(value);
            }
        },
        .@"enum" => {
            const text = if (@hasDecl(T, "asStr")) value.asStr() else @tagName(value);
            if (comptime floor == .mask) {
                try Masked([]const u8).init(text).jsonStringify(jw);
            } else {
                try jw.write(text);
            }
        },
        .enum_literal => {
            const text = @tagName(value);
            if (comptime floor == .mask) {
                try Masked([]const u8).init(text).jsonStringify(jw);
            } else {
                try jw.write(text);
            }
        },
        .error_set => {
            const text = @errorName(value);
            if (comptime floor == .mask) {
                try Masked([]const u8).init(text).jsonStringify(jw);
            } else {
                try jw.write(text);
            }
        },
        else => try jw.write(redacted_literal),
    }
}

fn toLogValueProtected(comptime T: type, value: T, comptime floor: Protection, comptime depth: usize, arena: Allocator) Allocator.Error!log_record.Value {
    if (comptime floor == .redact or floor == .omit or depth > max_depth) {
        return .{ .string = redacted_literal };
    }
    if (T == log_record.Value) {
        var walk: LogValueWalk = .{};
        if (comptime floor == .mask) return maskLogValue(arena, value, depth, &walk);
        return cloneLogValue(arena, value, depth, &walk);
    }
    if (comptime @typeInfo(T) == .@"struct" and @hasDecl(T, "o11y_redact_kind")) {
        switch (comptime T.o11y_redact_kind) {
            .secret => return .{ .string = redacted_literal },
            .masked => return .{ .string = try allocXs(arena, maskedRuneCount(T.Inner, value._value)) },
            .@"struct" => return toLogValueProtected(T.Inner, value.value, floor, depth, arena),
            else => {},
        }
    }
    if (comptime isStringType(T)) {
        const s = asStringSlice(T, value);
        if (comptime floor == .mask) return .{ .string = try allocXs(arena, utf8RuneCount(s)) };
        return .{ .string = try arena.dupe(u8, s) };
    }
    switch (@typeInfo(T)) {
        .optional => |opt| {
            if (value) |inner| return toLogValueProtected(opt.child, inner, floor, depth + 1, arena);
            return .empty;
        },
        .pointer => |ptr| switch (ptr.size) {
            .one => return toLogValueProtected(ptr.child, value.*, floor, depth + 1, arena),
            .slice => {
                const items = try arena.alloc(log_record.Value, value.len);
                for (items, value) |*dst, item| {
                    dst.* = try toLogValueProtected(ptr.child, item, floor, depth + 1, arena);
                }
                return .{ .array = items };
            },
            else => return .{ .string = redacted_literal },
        },
        .array => |arr| {
            const items = try arena.alloc(log_record.Value, value.len);
            for (items, value) |*dst, item| {
                dst.* = try toLogValueProtected(arr.child, item, floor, depth + 1, arena);
            }
            return .{ .array = items };
        },
        .@"struct" => |s| {
            comptime validateStructType(T, depth);
            var kept_count: usize = 0;
            inline for (s.field_names) |fname| {
                const eff = comptime Protection.strictest(floor, fieldProtection(T, fname));
                if (comptime eff != .omit) kept_count += 1;
            }
            const pairs = try arena.alloc(log_record.KeyValue, kept_count);
            var idx: usize = 0;
            inline for (s.field_names, s.field_types) |fname, ftype| {
                const eff = comptime Protection.strictest(floor, fieldProtection(T, fname));
                if (comptime eff != .omit) {
                    pairs[idx] = .{
                        .key = fname,
                        .value = try toLogValueProtected(ftype, @field(value, fname), eff, depth + 1, arena),
                    };
                    idx += 1;
                }
            }
            return .{ .map = pairs };
        },
        .bool => {
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, maskedRuneCount(T, value)) };
            return .{ .bool = value };
        },
        .int => {
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, maskedRuneCount(T, value)) };
            const clamped: i64 = std.math.cast(i64, value) orelse if (value < 0) std.math.minInt(i64) else std.math.maxInt(i64);
            return .{ .int = clamped };
        },
        .comptime_int => {
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, maskedRuneCount(T, value)) };
            return .{ .int = value };
        },
        .float, .comptime_float => {
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, maskedRuneCount(T, value)) };
            return .{ .double = value };
        },
        .@"enum" => {
            const text = if (@hasDecl(T, "asStr")) value.asStr() else @tagName(value);
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, utf8RuneCount(text)) };
            return .{ .string = try arena.dupe(u8, text) };
        },
        .enum_literal => {
            const text = @tagName(value);
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, utf8RuneCount(text)) };
            return .{ .string = try arena.dupe(u8, text) };
        },
        .error_set => {
            const text = @errorName(value);
            if (comptime floor == .mask) return .{ .string = try allocXs(arena, utf8RuneCount(text)) };
            return .{ .string = try arena.dupe(u8, text) };
        },
        else => return .{ .string = redacted_literal },
    }
}

const log_value_budget: usize = 2048;

const LogValueAncestor = struct {
    is_map: bool,
    addr: usize,
};

const LogValueWalk = struct {
    budget: usize = log_value_budget,
    ancestors: [max_depth]LogValueAncestor = undefined,
    ancestor_len: usize = 0,

    fn spend(w: *LogValueWalk) bool {
        if (w.budget == 0) return false;
        w.budget -= 1;
        return true;
    }

    fn enter(w: *LogValueWalk, is_map: bool, addr: usize) bool {
        for (w.ancestors[0..w.ancestor_len]) |a| {
            if (a.is_map == is_map and a.addr == addr) return false;
        }
        if (w.ancestor_len >= w.ancestors.len) return false;
        w.ancestors[w.ancestor_len] = .{ .is_map = is_map, .addr = addr };
        w.ancestor_len += 1;
        return true;
    }

    fn leave(w: *LogValueWalk) void {
        w.ancestor_len -= 1;
    }
};

fn cloneLogValue(arena: Allocator, v: log_record.Value, depth: usize, w: *LogValueWalk) Allocator.Error!log_record.Value {
    if (depth > max_depth or !w.spend()) return .empty;
    return switch (v) {
        .empty, .bool, .int, .double => v,
        .string => |s| .{ .string = try arena.dupe(u8, s) },
        .bytes => |b| .{ .bytes = try arena.dupe(u8, b) },
        .array => |items| blk: {
            if (items.len == 0) break :blk .{ .array = &.{} };
            if (!w.enter(false, @intFromPtr(items.ptr))) break :blk .empty;
            defer w.leave();
            const cap = @min(items.len, w.budget);
            const out = try arena.alloc(log_record.Value, cap);
            var n: usize = 0;
            for (items[0..cap]) |item| {
                if (w.budget == 0) break;
                out[n] = try cloneLogValue(arena, item, depth + 1, w);
                n += 1;
            }
            break :blk .{ .array = out[0..n] };
        },
        .map => |pairs| blk: {
            if (pairs.len == 0) break :blk .{ .map = &.{} };
            if (!w.enter(true, @intFromPtr(pairs.ptr))) break :blk .empty;
            defer w.leave();
            const cap = @min(pairs.len, w.budget);
            const out = try arena.alloc(log_record.KeyValue, cap);
            var n: usize = 0;
            for (pairs[0..cap]) |p| {
                if (w.budget == 0) break;
                out[n] = .{
                    .key = try arena.dupe(u8, p.key),
                    .value = try cloneLogValue(arena, p.value, depth + 1, w),
                };
                n += 1;
            }
            break :blk .{ .map = out[0..n] };
        },
    };
}

fn maskLogValue(arena: Allocator, v: log_record.Value, depth: usize, w: *LogValueWalk) Allocator.Error!log_record.Value {
    if (depth > max_depth or !w.spend()) return .{ .string = redacted_literal };
    return switch (v) {
        .empty => .empty,
        .string => |s| if (std.mem.eql(u8, s, redacted_literal))
            .{ .string = redacted_literal }
        else
            .{ .string = try allocXs(arena, utf8RuneCount(s)) },
        .bool => |b| .{ .string = try allocXs(arena, if (b) 4 else 5) },
        .int => |i| .{ .string = try allocXs(arena, maskedRuneCount(i64, i)) },
        .double => |d| .{ .string = try allocXs(arena, maskedRuneCount(f64, d)) },
        .bytes => |b| .{ .string = try allocXs(arena, b.len) },
        .array => |items| blk: {
            if (items.len == 0) break :blk .{ .array = &.{} };
            if (!w.enter(false, @intFromPtr(items.ptr))) break :blk .{ .string = redacted_literal };
            defer w.leave();
            const cap = @min(items.len, w.budget);
            const out = try arena.alloc(log_record.Value, cap);
            var n: usize = 0;
            for (items[0..cap]) |item| {
                if (w.budget == 0) break;
                out[n] = try maskLogValue(arena, item, depth + 1, w);
                n += 1;
            }
            break :blk .{ .array = out[0..n] };
        },
        .map => |pairs| blk: {
            if (pairs.len == 0) break :blk .{ .map = &.{} };
            if (!w.enter(true, @intFromPtr(pairs.ptr))) break :blk .{ .string = redacted_literal };
            defer w.leave();
            const cap = @min(pairs.len, w.budget);
            const out = try arena.alloc(log_record.KeyValue, cap);
            var n: usize = 0;
            for (pairs[0..cap]) |p| {
                if (w.budget == 0) break;
                out[n] = .{
                    .key = try arena.dupe(u8, p.key),
                    .value = try maskLogValue(arena, p.value, depth + 1, w),
                };
                n += 1;
            }
            break :blk .{ .map = out[0..n] };
        },
    };
}

const testing = std.testing;

test "Secret renders REDACTED in fmt, json, and log value, and reveals original" {
    const s = Secret([]const u8).init("super-secret-token");
    try testing.expectEqualStrings("super-secret-token", s.reveal());
    try testing.expectFmt("REDACTED", "{f}", .{s});

    var json_out: Io.Writer.Allocating = .init(testing.allocator);
    defer json_out.deinit();
    try std.json.Stringify.value(s, .{}, &json_out.writer);
    try testing.expectEqualStrings("\"REDACTED\"", json_out.written());

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const lv = try toLogValue(arena.allocator(), s);
    try testing.expectEqualStrings("REDACTED", lv.string);
}

test "Masked renders equal rune count of X across fmt, json, and log value" {
    const m = Masked([]const u8).init("4111");
    try testing.expectEqualStrings("4111", m.reveal());
    try testing.expectFmt("XXXX", "{f}", .{m});

    // Multi-byte UTF-8 counts runes, not bytes.
    const utf8_m = Masked([]const u8).init("café");
    try testing.expectFmt("XXXX", "{f}", .{utf8_m});

    var json_out: Io.Writer.Allocating = .init(testing.allocator);
    defer json_out.deinit();
    try std.json.Stringify.value(utf8_m, .{}, &json_out.writer);
    try testing.expectEqualStrings("\"XXXX\"", json_out.written());

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const lv = try toLogValue(arena.allocator(), utf8_m);
    try testing.expectEqualStrings("XXXX", lv.string);

    // Non-string Masked(i64) masks formatted digits.
    const num = Masked(i64).init(12345);
    try testing.expectFmt("XXXXX", "{f}", .{num});
}

test "Struct applies mask, confidential, redact, secret, and omit across fmt, json, and log walk" {
    const Inner = struct {
        code: []const u8,
        note: []const u8,

        pub const o11y_tags = .{
            .code = .secret,
        };
    };

    const Payment = struct {
        card: []const u8,
        ssn: []const u8,
        cvv: []const u8,
        pin: []const u8,
        merchant: []const u8,
        nested: Inner,

        pub const o11y_tags = .{
            .card = "mask",
            .ssn = "confidential",
            .cvv = "redact",
            .pin = .omit,
            .nested = .mask,
        };
    };

    const wrapped = wrapStruct(Payment{
        .card = "4111",
        .ssn = "123-45",
        .cvv = "999",
        .pin = "0000",
        .merchant = "acme",
        .nested = .{ .code = "secret-code", .note = "hi" },
    });

    // Strictest wins through nesting: nested is masked, nested.code is secret -> REDACTED, nested.note is masked -> XX.
    try testing.expectFmt(
        "{card:XXXX ssn:XXXXXX cvv:REDACTED merchant:acme nested:{code:REDACTED note:XX}}",
        "{f}",
        .{wrapped},
    );

    var json_out: Io.Writer.Allocating = .init(testing.allocator);
    defer json_out.deinit();
    try std.json.Stringify.value(wrapped, .{}, &json_out.writer);
    try testing.expectEqualStrings(
        "{\"card\":\"XXXX\",\"ssn\":\"XXXXXX\",\"cvv\":\"REDACTED\",\"merchant\":\"acme\",\"nested\":{\"code\":\"REDACTED\",\"note\":\"XX\"}}",
        json_out.written(),
    );

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const lv = try toLogValue(arena.allocator(), wrapped);
    try testing.expectEqual(@as(usize, 5), lv.map.len);
    try testing.expectEqualStrings("XXXX", log_record.find(lv.map, "card").?.string);
    try testing.expectEqualStrings("XXXXXX", log_record.find(lv.map, "ssn").?.string);
    try testing.expectEqualStrings("REDACTED", log_record.find(lv.map, "cvv").?.string);
    try testing.expectEqual(null, log_record.find(lv.map, "pin"));
    try testing.expectEqualStrings("acme", log_record.find(lv.map, "merchant").?.string);
    const nested = log_record.find(lv.map, "nested").?.map;
    try testing.expectEqualStrings("REDACTED", log_record.find(nested, "code").?.string);
    try testing.expectEqualStrings("XX", log_record.find(nested, "note").?.string);
}
