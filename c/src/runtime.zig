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

var io_mutex: Mutex = .{};
var io_refcount: usize = 0;
var io_threaded: Io.Threaded = undefined;

/// Thread-safe mutex usable before `acquireIo` initializes `std.Io.Threaded`.
pub const Mutex = struct {
    inner: if (builtin.os.tag == .windows)
        std.atomic.Value(u8)
    else
        std.c.pthread_mutex_t = if (builtin.os.tag == .windows)
        .init(0)
    else
        std.c.PTHREAD_MUTEX_INITIALIZER,

    pub fn lock(m: *Mutex) void {
        if (builtin.os.tag == .windows) {
            while (m.inner.cmpxchgWeak(0, 1, .acquire, .monotonic) != null) {
                std.atomic.spinLoopHint();
            }
        } else {
            _ = std.c.pthread_mutex_lock(&m.inner);
        }
    }

    pub fn unlock(m: *Mutex) void {
        if (builtin.os.tag == .windows) {
            m.inner.store(0, .release);
        } else {
            _ = std.c.pthread_mutex_unlock(&m.inner);
        }
    }
};

/// Acquires a reference to the shared `std.Io` runtime, initializing it on
/// the first live handle. Every `acquireIo` must be paired with `releaseIo`.
pub fn acquireIo() Io {
    io_mutex.lock();
    defer io_mutex.unlock();
    if (io_refcount == 0) {
        io_threaded = .init(gpa, .{});
    }
    io_refcount += 1;
    return io_threaded.io();
}

/// Releases a reference to the shared `std.Io` runtime. When the last handle
/// is destroyed, worker threads are joined and prior POSIX signal handlers
/// installed by `Io.Threaded.init` are restored.
pub fn releaseIo() void {
    io_mutex.lock();
    defer io_mutex.unlock();
    if (io_refcount == 0) return;
    io_refcount -= 1;
    if (io_refcount == 0) {
        io_threaded.deinit();
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

const darwin_env = if (builtin.os.tag.isDarwin()) struct {
    extern "c" fn _NSGetEnviron() *?[*:null]?[*:0]u8;
} else struct {
    extern "c" var environ: ?[*:null]?[*:0]u8;
};

fn processEnviron() ?[*:null]?[*:0]u8 {
    if (builtin.os.tag == .windows) return null;
    if (builtin.os.tag.isDarwin()) return darwin_env._NSGetEnviron().*;
    return darwin_env.environ;
}

/// Snapshots only `OTEL_*` variables from the process environment into `arena`
/// as `[2][]const u8` pairs. Unrelated host environment entries are never read
/// or retained.
pub fn readProcessEnvPairs(arena: Allocator) Allocator.Error![][2][]const u8 {
    const envp = processEnviron() orelse return &.{};
    var list: std.ArrayList([2][]const u8) = .empty;
    var i: usize = 0;
    while (envp[i]) |entry_z| : (i += 1) {
        const entry = std.mem.span(entry_z);
        if (!std.mem.startsWith(u8, entry, "OTEL_")) continue;
        const eq = std.mem.indexOfScalar(u8, entry, '=') orelse continue;
        const k = try arena.dupe(u8, entry[0..eq]);
        const v = try arena.dupe(u8, entry[eq + 1 ..]);
        try list.append(arena, .{ k, v });
    }
    return list.items;
}
