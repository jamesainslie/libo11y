//! Process-wide runtime support for the libo11y C ABI: lazily-initialized
//! `std.Io.Threaded`, libc allocator, and C string/environment helpers.

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;

/// The library version, from `build.zig.zon` through the build script.
pub const c_version: [:0]const u8 = @import("c_build_options").c_version ++ "";

/// Allocator backed by libc malloc/realloc/free (thread-safe).
pub const gpa: Allocator = std.heap.c_allocator;

var io_state: std.atomic.Value(u8) = .init(0);
var io_threaded: Io.Threaded = undefined;

/// Returns the shared `std.Io` instance, initializing it once on first call.
pub fn globalIo() Io {
    if (io_state.load(.acquire) == 2) return io_threaded.io();
    while (true) {
        const prev = io_state.cmpxchgWeak(0, 1, .acq_rel, .acquire);
        if (prev == null) {
            io_threaded = .init(gpa, .{});
            io_state.store(2, .release);
            return io_threaded.io();
        }
        if (prev.? == 2) return io_threaded.io();
        std.atomic.spinLoopHint();
    }
}

pub fn cStrOpt(p: ?[*:0]const u8) ?[]const u8 {
    const ptr = p orelse return null;
    return std.mem.span(ptr);
}

pub fn cStrOrEmpty(p: ?[*:0]const u8) []const u8 {
    return cStrOpt(p) orelse "";
}

/// Allocates a NUL-terminated copy with libc `malloc`, freed by `o11y_string_free`.
pub fn allocCString(slice: []const u8) ?[*:0]u8 {
    const raw = std.c.malloc(slice.len + 1) orelse return null;
    const dst: [*]u8 = @ptrCast(raw);
    if (slice.len > 0) @memcpy(dst[0..slice.len], slice);
    dst[slice.len] = 0;
    return @ptrCast(dst);
}

pub fn freeCString(ptr: ?[*:0]u8) void {
    if (ptr) |p| std.c.free(p);
}

/// Duplicates `slice` with a trailing NUL sentinel in `allocator`.
pub fn dupeZ(allocator: Allocator, slice: []const u8) Allocator.Error![:0]u8 {
    const buf = try allocator.alloc(u8, slice.len + 1);
    if (slice.len > 0) @memcpy(buf[0..slice.len], slice);
    buf[slice.len] = 0;
    return buf[0..slice.len :0];
}

/// Frees a sentinel-terminated string allocated with `dupeZ`.
pub fn freeZ(allocator: Allocator, z: [*:0]u8) void {
    const s = std.mem.span(z);
    allocator.free(s.ptr[0 .. s.len + 1]);
}

// POSIX global process environment pointer.
extern "c" var environ: ?[*:null]?[*:0]u8;

/// Snapshots the current process environment into `arena` as `[2][]const u8` pairs.
pub fn readProcessEnvPairs(arena: Allocator) Allocator.Error![][2][]const u8 {
    if (builtin.os.tag == .windows) return &.{};
    const envp = environ orelse return &.{};
    var list: std.ArrayList([2][]const u8) = .empty;
    var i: usize = 0;
    while (envp[i]) |entry_z| : (i += 1) {
        const entry = std.mem.span(entry_z);
        const eq = std.mem.indexOfScalar(u8, entry, '=') orelse continue;
        const k = try arena.dupe(u8, entry[0..eq]);
        const v = try arena.dupe(u8, entry[eq + 1 ..]);
        try list.append(arena, .{ k, v });
    }
    return list.items;
}
