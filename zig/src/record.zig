//! Wide-event `Record` accumulator for canonical log lines (matching Go's
//! `record.go`).
//!
//! Accumulates attributes over the lifetime of a request (or unit of work)
//! under a mutex, then flushes them as a single contract-bearing event via
//! `emitEvent`. Safe for concurrent use across tasks.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const log_record = @import("pipeline/log_record.zig");
const redact = @import("redact.zig");
const spec = @import("spec.zig");

/// Accumulates attributes over the life of a request into one wide event.
/// Safe for concurrent use.
pub const Record = struct {
    gpa: Allocator,
    io: Io,
    mutex: Io.Mutex = .init,
    arena: std.heap.ArenaAllocator,
    entries: std.ArrayList(log_record.KeyValue) = .empty,

    pub fn init(gpa: Allocator, io: Io) Record {
        return .{
            .gpa = gpa,
            .io = io,
            .arena = .init(gpa),
        };
    }

    pub fn deinit(r: *Record) void {
        r.entries.deinit(r.gpa);
        r.arena.deinit();
    }

    /// Sets or overwrites one attribute, keeping first-insertion key order.
    /// Hot-path call: never fails the host.
    pub fn set(r: *Record, key: []const u8, value: anytype) void {
        if (key.len == 0) return;
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const arena = r.arena.allocator();
        const lv = redact.toLogValue(arena, value) catch return;
        r.setLocked(arena, key, lv);
    }

    /// Sets every field of an anonymous struct (or slice of `log_record.KeyValue`).
    pub fn setAttrs(r: *Record, attrs: anytype) void {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const arena = r.arena.allocator();
        const T = @TypeOf(attrs);
        if (T == []const log_record.KeyValue or T == []log_record.KeyValue) {
            for (attrs) |kv| {
                if (kv.key.len == 0) continue;
                const val = copyLogValue(arena, kv.value) catch continue;
                r.setLocked(arena, kv.key, val);
            }
            return;
        }
        const info = @typeInfo(T);
        if (info == .@"struct") {
            inline for (info.@"struct".field_names) |fname| {
                const lv = redact.toLogValue(arena, @field(attrs, fname)) catch continue;
                r.setLocked(arena, fname, lv);
            }
            return;
        }
        @compileError("Record.setAttrs expects a struct or []const log_record.KeyValue, got " ++ @typeName(T));
    }

    /// Increments an integer counter on the wide event, creating it at `delta`
    /// if absent. If the key currently holds another kind, replaces it with
    /// `delta`.
    pub fn add(r: *Record, key: []const u8, delta: i64) void {
        if (key.len == 0) return;
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const arena = r.arena.allocator();
        if (r.findIndexLocked(key)) |idx| {
            const current: i64 = switch (r.entries.items[idx].value) {
                .int => |v| v,
                else => 0,
            };
            r.entries.items[idx].value = .{ .int = current +| delta };
            return;
        }
        r.setLocked(arena, key, .{ .int = delta });
    }

    /// Records the larger of the existing and new `f64` value for `key`. If
    /// the key holds another kind, replaces it with `v`.
    pub fn max(r: *Record, key: []const u8, v: f64) void {
        if (key.len == 0) return;
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const arena = r.arena.allocator();
        if (r.findIndexLocked(key)) |idx| {
            switch (r.entries.items[idx].value) {
                .double => |existing| {
                    if (existing >= v) return;
                },
                else => {},
            }
            r.entries.items[idx].value = .{ .double = v };
            return;
        }
        r.setLocked(arena, key, .{ .double = v });
    }

    /// Records an error on the wide event (`error.type` and `o11y.outcome = failure`).
    pub fn setError(r: *Record, err: anyerror) void {
        r.set("error.type", @errorName(err));
        r.set(spec.Outcome.key, spec.Outcome.failure.asStr());
    }

    /// Returns a snapshot of accumulated attributes in insertion order,
    /// allocated in `arena`.
    pub fn snapshot(r: *Record, arena: Allocator) Allocator.Error![]log_record.KeyValue {
        r.mutex.lockUncancelable(r.io);
        defer r.mutex.unlock(r.io);
        const out = try arena.alloc(log_record.KeyValue, r.entries.items.len);
        for (out, r.entries.items) |*dst, src| {
            dst.* = .{
                .key = try arena.dupe(u8, src.key),
                .value = try copyLogValue(arena, src.value),
            };
        }
        return out;
    }

    /// Emits the accumulated wide event through `telemetry` under `name`.
    /// Any `extra_attrs` override accumulated attributes with the same key.
    pub fn emitEvent(r: *Record, ctx: anytype, telemetry: anytype, name: []const u8, extra_attrs: anytype) void {
        var arena_state: std.heap.ArenaAllocator = .init(r.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const snap = r.snapshot(arena) catch return;
        const extra = attrsFromAny(arena, extra_attrs) catch return;
        const combined = arena.alloc(log_record.KeyValue, snap.len + extra.len) catch return;
        @memcpy(combined[0..snap.len], snap);
        @memcpy(combined[snap.len..], extra);
        telemetry.event(ctx, name, @as([]const log_record.KeyValue, combined));
    }

    fn findIndexLocked(r: *const Record, key: []const u8) ?usize {
        for (r.entries.items, 0..) |e, i| {
            if (std.mem.eql(u8, e.key, key)) return i;
        }
        return null;
    }

    fn setLocked(r: *Record, arena: Allocator, key: []const u8, val: log_record.Value) void {
        if (r.findIndexLocked(key)) |idx| {
            r.entries.items[idx].value = val;
            return;
        }
        const key_copy = arena.dupe(u8, key) catch return;
        r.entries.append(r.gpa, .{ .key = key_copy, .value = val }) catch return;
    }
};

/// Non-nil handle returned by `o11y.recordFromContext(ctx)`. Every method is
/// a silent no-op when no record is attached to the context, so call sites
/// never need null checks.
pub const RecordHandle = struct {
    ptr: ?*Record = null,

    pub fn set(h: RecordHandle, key: []const u8, value: anytype) void {
        if (h.ptr) |r| r.set(key, value);
    }

    pub fn setAttrs(h: RecordHandle, attrs: anytype) void {
        if (h.ptr) |r| r.setAttrs(attrs);
    }

    pub fn add(h: RecordHandle, key: []const u8, delta: i64) void {
        if (h.ptr) |r| r.add(key, delta);
    }

    pub fn max(h: RecordHandle, key: []const u8, v: f64) void {
        if (h.ptr) |r| r.max(key, v);
    }

    pub fn setError(h: RecordHandle, err: anyerror) void {
        if (h.ptr) |r| r.setError(err);
    }

    pub fn emitEvent(h: RecordHandle, ctx: anytype, telemetry: anytype, name: []const u8, extra_attrs: anytype) void {
        if (h.ptr) |r| {
            r.emitEvent(ctx, telemetry, name, extra_attrs);
        } else {
            telemetry.event(ctx, name, extra_attrs);
        }
    }
};

fn attrsFromAny(arena: Allocator, attrs: anytype) Allocator.Error![]const log_record.KeyValue {
    const T = @TypeOf(attrs);
    if (T == []const log_record.KeyValue or T == []log_record.KeyValue) return attrs;
    const info = @typeInfo(T);
    if (info == .pointer and info.pointer.size == .one) {
        const child = @typeInfo(info.pointer.child);
        if (child == .array and child.array.child == log_record.KeyValue) return attrs[0..];
    }
    if (info == .@"struct") {
        const field_names = info.@"struct".field_names;
        if (field_names.len == 0) return &.{};
        const out = try arena.alloc(log_record.KeyValue, field_names.len);
        inline for (field_names, 0..) |fname, i| {
            out[i] = .{
                .key = fname,
                .value = try redact.toLogValue(arena, @field(attrs, fname)),
            };
        }
        return out;
    }
    @compileError("expected struct or []const log_record.KeyValue, got " ++ @typeName(T));
}

fn copyLogValue(arena: Allocator, v: log_record.Value) Allocator.Error!log_record.Value {
    return switch (v) {
        .empty, .bool, .int, .double => v,
        .string => |s| .{ .string = try arena.dupe(u8, s) },
        .bytes => |b| .{ .bytes = try arena.dupe(u8, b) },
        .array => |items| blk: {
            const out = try arena.alloc(log_record.Value, items.len);
            for (out, items) |*dst, item| dst.* = try copyLogValue(arena, item);
            break :blk .{ .array = out };
        },
        .map => |pairs| blk: {
            const out = try arena.alloc(log_record.KeyValue, pairs.len);
            for (out, pairs) |*dst, p| dst.* = .{
                .key = try arena.dupe(u8, p.key),
                .value = try copyLogValue(arena, p.value),
            };
            break :blk .{ .map = out };
        },
    };
}

const testing = std.testing;

test "Record accumulates set, add, max, setError in insertion order" {
    var rec = Record.init(testing.allocator, testing.io);
    defer rec.deinit();

    rec.set("user.id", "u1");
    rec.add("db.queries", 2);
    rec.add("db.queries", 3);
    rec.max("downstream.max_ms", 12.5);
    rec.max("downstream.max_ms", 8.0);
    rec.max("downstream.max_ms", 25.0);
    rec.set("user.id", "u2"); // overwrite keeps first-insertion order
    rec.setError(error.Timeout);

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const snap = try rec.snapshot(arena.allocator());
    try testing.expectEqual(@as(usize, 5), snap.len);
    try testing.expectEqualStrings("user.id", snap[0].key);
    try testing.expectEqualStrings("u2", snap[0].value.string);
    try testing.expectEqualStrings("db.queries", snap[1].key);
    try testing.expectEqual(@as(i64, 5), snap[1].value.int);
    try testing.expectEqualStrings("downstream.max_ms", snap[2].key);
    try testing.expectEqual(@as(f64, 25.0), snap[2].value.double);
    try testing.expectEqualStrings("error.type", snap[3].key);
    try testing.expectEqualStrings("Timeout", snap[3].value.string);
    try testing.expectEqualStrings("o11y.outcome", snap[4].key);
    try testing.expectEqualStrings("failure", snap[4].value.string);

    // Kind replacement on add/max matches Go.
    rec.set("k", "text");
    rec.add("k", 7);
    rec.set("m", "text");
    rec.max("m", 3.5);
    const snap2 = try rec.snapshot(arena.allocator());
    try testing.expectEqual(@as(i64, 7), log_record.find(snap2, "k").?.int);
    try testing.expectEqual(@as(f64, 3.5), log_record.find(snap2, "m").?.double);
}

test "RecordHandle with null ptr is a silent no-op" {
    const h: RecordHandle = .{};
    h.set("a", 1);
    h.add("b", 2);
    h.max("c", 3.0);
    h.setError(error.Boom);
}
