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

var hermetic_io_mutex: Mutex = .{};
var hermetic_io_refcount: usize = 0;
var hermetic_io_threaded: Io.Threaded = undefined;

const have_sigaction = builtin.os.tag != .windows and std.posix.Sigaction != void;
const have_sig_io = have_sigaction and @hasField(std.posix.SIG, "IO");
const have_sig_pipe = have_sigaction and builtin.os.tag != .linux and @hasField(std.posix.SIG, "PIPE");

var installed_sig_io: bool = false;
var old_sig_io: if (have_sig_io) std.posix.Sigaction else void = undefined;
var installed_sig_pipe: bool = false;
var old_sig_pipe: if (have_sig_pipe) std.posix.Sigaction else void = undefined;

fn noOpSigHandler(_: std.posix.SIG) callconv(.c) void {}

fn isDefaultHandler(act: std.posix.Sigaction) bool {
    return (act.flags & std.posix.SA.SIGINFO) == 0 and act.handler.handler == std.posix.SIG.DFL;
}

fn isOurHandler(act: std.posix.Sigaction) bool {
    return (act.flags & std.posix.SA.SIGINFO) == 0 and
        act.handler.handler == @as(?std.posix.Sigaction.handler_fn, noOpSigHandler);
}

fn initNoSignalThreaded() Io.Threaded {
    var t: Io.Threaded = .init_single_threaded;
    const cpu_count = std.Thread.getCpuCount();
    t.allocator = gpa;
    t.async_limit = if (cpu_count) |n| (if (n > 1) .limited(n - 1) else .nothing) else |_| .nothing;
    t.concurrent_limit = .unlimited;
    t.cpu_count_error = if (cpu_count) |_| null else |e| e;
    return t;
}

/// Returns a global synchronous `std.Io` handle backed by OS futex/pthread locks
/// with no worker threads and no signal mutations.
pub fn syncIo() Io {
    return Io.Threaded.global_single_threaded.io();
}

/// Acquires a reference to the signal-free hermetic `std.Io` runtime used by
/// `O11Y_ENV_HERMETIC` SDKs and the hermetic test recorder. Never touches POSIX
/// signal handlers.
pub fn acquireHermeticIo() Io {
    hermetic_io_mutex.lock();
    defer hermetic_io_mutex.unlock();
    if (hermetic_io_refcount == 0) {
        hermetic_io_threaded = initNoSignalThreaded();
    }
    hermetic_io_refcount += 1;
    return hermetic_io_threaded.io();
}

/// Releases a reference to the hermetic `std.Io` runtime. When the last
/// hermetic handle is destroyed, waits for internal worker threads to finish.
pub fn releaseHermeticIo() void {
    hermetic_io_mutex.lock();
    defer hermetic_io_mutex.unlock();
    if (hermetic_io_refcount == 0) return;
    hermetic_io_refcount -= 1;
    if (hermetic_io_refcount == 0) {
        hermetic_io_threaded.deinit();
    }
}

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

/// Acquires a reference to the shared networked `std.Io` runtime, initializing
/// it on the first live handle. Every `acquireIo` must be paired with `releaseIo`.
///
/// Only touches POSIX signal dispositions when `SIG_DFL` is currently installed
/// (`SIGIO` on POSIX for syscall cancellation, and `SIGPIPE` on non-Linux
/// POSIX targets). On Linux `std.Io.Threaded` uses `MSG_NOSIGNAL`, so `SIGPIPE`
/// is left untouched.
pub fn acquireIo() Io {
    io_mutex.lock();
    defer io_mutex.unlock();
    if (io_refcount == 0) {
        io_threaded = initNoSignalThreaded();
        if (have_sig_io or have_sig_pipe) {
            const act: std.posix.Sigaction = .{
                .handler = .{ .handler = noOpSigHandler },
                .mask = std.posix.sigemptyset(),
                .flags = 0,
            };
            if (have_sig_io) {
                std.posix.sigaction(.IO, null, &old_sig_io);
                if (isDefaultHandler(old_sig_io)) {
                    std.posix.sigaction(.IO, &act, null);
                    installed_sig_io = true;
                }
            }
            if (have_sig_pipe) {
                std.posix.sigaction(.PIPE, null, &old_sig_pipe);
                if (isDefaultHandler(old_sig_pipe)) {
                    std.posix.sigaction(.PIPE, &act, null);
                    installed_sig_pipe = true;
                }
            }
        }
    }
    io_refcount += 1;
    return io_threaded.io();
}

/// Releases a reference to the shared networked `std.Io` runtime. When the
/// last handle is destroyed, waits for internal worker threads to finish and
/// restores only handlers installed by `acquireIo` that remain unchanged.
pub fn releaseIo() void {
    io_mutex.lock();
    defer io_mutex.unlock();
    if (io_refcount == 0) return;
    io_refcount -= 1;
    if (io_refcount == 0) {
        io_threaded.deinit();
        if (have_sig_io) {
            if (installed_sig_io) {
                var cur: std.posix.Sigaction = undefined;
                std.posix.sigaction(.IO, null, &cur);
                if (isOurHandler(cur)) {
                    std.posix.sigaction(.IO, &old_sig_io, null);
                }
                installed_sig_io = false;
            }
        }
        if (have_sig_pipe) {
            if (installed_sig_pipe) {
                var cur: std.posix.Sigaction = undefined;
                std.posix.sigaction(.PIPE, null, &cur);
                if (isOurHandler(cur)) {
                    std.posix.sigaction(.PIPE, &old_sig_pipe, null);
                }
                installed_sig_pipe = false;
            }
        }
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
