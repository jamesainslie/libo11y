//! Signal-driven graceful shutdown (`shutdownOnSignals`).
//!
//! Installs POSIX signal handlers (defaulting to SIGINT and SIGTERM) backed by
//! a self-pipe so the handler itself performs only an async-signal-safe write.
//! Once a signal arrives, default signal handling (`SIG.DFL`) is immediately
//! restored so a second signal terminates the process without waiting on
//! flush, then an optional `before_shutdown` callback and `telemetry.shutdown`
//! run under one shared deadline.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const deadline_mod = @import("pipeline/deadline.zig");
const Deadline = deadline_mod.Deadline;

/// Default shared shutdown deadline (5 seconds, matching Go).
pub const default_shutdown_timeout: Io.Duration = .fromSeconds(5);

/// Optional callback executed after signal receipt and before flushing
/// telemetry, sharing the same shutdown deadline.
pub const BeforeShutdown = struct {
    ptr: ?*anyopaque = null,
    func: *const fn (ptr: ?*anyopaque, deadline: Deadline) void,
};

/// Options for `shutdownOnSignals`.
pub const Options = struct {
    /// Total budget shared by `before_shutdown` and `telemetry.shutdown`.
    /// Defaults to 5 seconds.
    timeout: Io.Duration = default_shutdown_timeout,
    /// Optional hook to drain servers/workers before telemetry flushes.
    before_shutdown: ?BeforeShutdown = null,
    /// Signals to wait on. Defaults to SIGINT and SIGTERM.
    signals: []const std.posix.SIG = &.{ .INT, .TERM },
    /// Optional event set once every POSIX signal handler is installed, so
    /// callers and tests can synchronize without sleeping. Before it is set
    /// a signal still has its previous action.
    ready_event: ?*Io.Event = null,
};

// State the async-signal-safe handler uses. It is process-wide, because a
// signal handler takes no context argument, so one `shutdownOnSignals` call
// may be active at a time.
var signal_pipe_write_fd: std.atomic.Value(i32) = .init(-1);
var signal_seen: std.atomic.Value(bool) = .init(false);

/// How often the wait checks for a signal when no pipe could be opened.
const poll_interval: Io.Duration = .fromMilliseconds(20);

fn posixSignalHandler(_: std.posix.SIG) callconv(.c) void {
    const preserve_errno = builtin.link_libc or builtin.os.tag == .macos;
    const saved_errno: c_int = if (preserve_errno) std.c._errno().* else 0;
    defer if (preserve_errno) {
        std.c._errno().* = saved_errno;
    };

    signal_seen.store(true, .release);
    const fd = signal_pipe_write_fd.load(.acquire);
    if (fd < 0) return;
    const byte = [1]u8{1};
    // The write end does not block. A full pipe already holds a byte, so
    // a failed write loses nothing.
    _ = std.posix.system.write(@intCast(fd), &byte, 1);
}

const Pipe = struct {
    read: std.posix.fd_t,
    write: std.posix.fd_t,

    /// Opens the self-pipe, or returns null when the process has no file
    /// descriptors left. Both ends are close-on-exec, so a child process
    /// does not inherit them. The write end does not block, so the handler
    /// cannot block on a full pipe.
    fn open() ?Pipe {
        const system = std.posix.system;
        var fds: [2]std.posix.fd_t = .{ -1, -1 };
        if (std.posix.errno(system.pipe(&fds)) != .SUCCESS) return null;
        for (fds) |fd| {
            _ = system.fcntl(fd, std.posix.F.SETFD, @as(usize, std.posix.FD_CLOEXEC));
        }
        const flags = system.fcntl(fds[1], std.posix.F.GETFL, @as(usize, 0));
        if (std.posix.errno(flags) == .SUCCESS) {
            const nonblock: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
            _ = system.fcntl(fds[1], std.posix.F.SETFL, @as(usize, @intCast(flags)) | nonblock);
        }
        return .{ .read = fds[0], .write = fds[1] };
    }

    fn close(p: Pipe) void {
        _ = std.posix.system.close(p.read);
        _ = std.posix.system.close(p.write);
    }
};

/// Sets the action of `sig`. False when the system refuses, which it does
/// for a signal that cannot be caught, such as SIGKILL, and for a number
/// that is not a signal.
fn setAction(sig: std.posix.SIG, act: *const std.posix.Sigaction) bool {
    // The Linux wrapper asserts on these two instead of returning EINVAL.
    if (sig == .KILL or sig == .STOP) return false;
    return std.posix.errno(std.posix.system.sigaction(sig, act, null)) == .SUCCESS;
}

/// Publishes `write_fd`, then installs the handler for each of `signals`,
/// and returns how many it installed. A signal that cannot be caught is
/// skipped.
///
/// The pipe comes first, so a signal delivered the instant its handler is
/// installed is written to it. In the other order the handler would find no
/// pipe, drop the signal, and leave the caller waiting on an empty pipe.
///
/// `installed`, when set, runs right after each handler is installed. Tests
/// use it to deliver a signal at that moment.
fn arm(write_fd: ?std.posix.fd_t, signals: []const std.posix.SIG, installed: ?*const fn (sig: std.posix.SIG) void) usize {
    signal_seen.store(false, .release);
    signal_pipe_write_fd.store(if (write_fd) |fd| @intCast(fd) else -1, .release);
    const act: std.posix.Sigaction = .{
        .handler = .{ .handler = posixSignalHandler },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    var count: usize = 0;
    for (signals) |sig| {
        if (!setAction(sig, &act)) continue;
        count += 1;
        if (installed) |f| f(sig);
    }
    return count;
}

/// Restores default handling for `signals`, then retires the pipe.
fn disarm(signals: []const std.posix.SIG) void {
    const dfl: std.posix.Sigaction = .{
        .handler = .{ .handler = std.posix.SIG.DFL },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    for (signals) |sig| {
        _ = setAction(sig, &dfl);
    }
    signal_pipe_write_fd.store(-1, .release);
}

/// Returns once the handler has seen a signal. With a pipe it blocks on a
/// read. Without one it polls the flag the handler sets, and also returns
/// when the calling task is canceled.
fn waitForSignal(io: Io, read_fd: ?std.posix.fd_t) void {
    if (read_fd) |fd| {
        var buf: [1]u8 = undefined;
        while (true) {
            const rc = std.posix.system.read(fd, &buf, 1);
            if (std.posix.errno(rc) == .INTR) continue;
            return;
        }
    }
    while (!signal_seen.load(.acquire)) {
        io.sleep(poll_interval, .awake) catch return;
    }
}

/// Installs signal handlers for `options.signals`, waits until one arrives,
/// restores default signal handling (`SIG.DFL`), runs `options.before_shutdown`
/// (if set), and shuts down `telemetry` under one shared deadline.
///
/// POSIX only: calling it for a Windows target is a compile error. One call
/// may be active per process at a time. A signal in `options.signals` that
/// cannot be caught, such as SIGKILL, is skipped. When the process has no
/// file descriptor left for the self-pipe, the wait polls instead, so a
/// signal is still seen within 20 ms.
pub fn shutdownOnSignals(io: Io, telemetry: anytype, options: Options) @TypeOf(telemetry.shutdownBy(undefined)) {
    if (builtin.os.tag == .windows) {
        @compileError("o11y.shutdownOnSignals supports POSIX targets only; on Windows call Telemetry.shutdown from the program's own console control handler");
    }

    const pipe = Pipe.open();
    defer if (pipe) |p| p.close();

    _ = arm(if (pipe) |p| p.write else null, options.signals, null);
    if (options.ready_event) |ev| ev.set(io);

    waitForSignal(io, if (pipe) |p| p.read else null);

    // Restore default handling immediately so a second signal kills the process.
    disarm(options.signals);

    const shared_deadline = deadline_mod.after(io, options.timeout);
    if (options.before_shutdown) |cb| {
        cb.func(cb.ptr, shared_deadline);
    }
    return telemetry.shutdownBy(shared_deadline);
}

/// Testable seam: waits on an `Io.Event`, then runs `before_shutdown` and
/// `telemetry.shutdownBy` under one shared deadline.
pub fn shutdownOnEvent(io: Io, event: *Io.Event, telemetry: anytype, options: Options) @TypeOf(telemetry.shutdownBy(undefined)) {
    event.waitUncancelable(io);
    const shared_deadline = deadline_mod.after(io, options.timeout);
    if (options.before_shutdown) |cb| {
        cb.func(cb.ptr, shared_deadline);
    }
    return telemetry.shutdownBy(shared_deadline);
}

const testing = std.testing;

test "shutdownOnSignals handles a real POSIX signal, restores SIG.DFL, and runs before_shutdown before shutdown" {
    if (builtin.os.tag == .windows) return;

    const State = struct {
        order: [2]u8 = .{ 0, 0 },
        idx: usize = 0,

        fn before(ptr: ?*anyopaque, _: Deadline) void {
            const s: *@This() = @ptrCast(@alignCast(ptr.?));
            s.order[s.idx] = 'B';
            s.idx += 1;
        }

        fn shutdownBy(s: *@This(), _: Deadline) bool {
            s.order[s.idx] = 'S';
            s.idx += 1;
            return true;
        }
    };

    var state: State = .{};
    var ready: Io.Event = .unset;
    var waiter = try testing.io.concurrent(struct {
        fn run(s: *State, ready_ev: *Io.Event) bool {
            return shutdownOnSignals(testing.io, s, .{
                .signals = &.{.USR1},
                .before_shutdown = .{ .ptr = s, .func = State.before },
                .ready_event = ready_ev,
            });
        }
    }.run, .{ &state, &ready });

    // The handler is installed once `ready` is set, so the signal cannot
    // arrive while SIGUSR1 still has its default action.
    ready.waitUncancelable(testing.io);
    try std.posix.raise(.USR1);

    const ok = waiter.await(testing.io);
    try testing.expect(ok);
    try testing.expectEqualStrings("BS", &state.order);
}

test "a signal delivered the instant its handler is installed reaches the pipe" {
    if (builtin.os.tag == .windows) return;

    var pipe_fds: [2]std.posix.fd_t = .{ -1, -1 };
    try testing.expectEqual(std.posix.E.SUCCESS, std.posix.errno(std.posix.system.pipe(&pipe_fds)));
    defer {
        _ = std.posix.system.close(pipe_fds[0]);
        _ = std.posix.system.close(pipe_fds[1]);
    }

    // The handler runs on this thread before `raise` returns. If the pipe
    // were published only after the handlers, it would find no pipe and
    // the signal would be lost.
    const installed = arm(pipe_fds[1], &.{.USR1}, struct {
        fn raise(sig: std.posix.SIG) void {
            std.posix.raise(sig) catch {};
        }
    }.raise);
    defer disarm(&.{.USR1});
    try testing.expectEqual(@as(usize, 1), installed);

    var poll_fds = [_]std.posix.pollfd{.{ .fd = pipe_fds[0], .events = std.posix.POLL.IN, .revents = 0 }};
    try testing.expectEqual(@as(usize, 1), try std.posix.poll(&poll_fds, 0));
}

test "a signal that cannot be caught is skipped and the others are still handled" {
    if (builtin.os.tag == .windows) return;

    const pipe = Pipe.open() orelse return error.SkipZigTest;
    defer pipe.close();

    // SIGKILL cannot have a handler. It is skipped, not a crash, and the
    // handler for SIGUSR1 is still installed.
    try testing.expectEqual(@as(usize, 1), arm(pipe.write, &.{ .KILL, .USR1 }, null));
    defer disarm(&.{ .KILL, .USR1 });
    try std.posix.raise(.USR1);

    var poll_fds = [_]std.posix.pollfd{.{ .fd = pipe.read, .events = std.posix.POLL.IN, .revents = 0 }};
    try testing.expectEqual(@as(usize, 1), try std.posix.poll(&poll_fds, 0));
}

test "the self-pipe is close-on-exec and its write end does not block" {
    if (builtin.os.tag == .windows) return;

    const pipe = Pipe.open() orelse return error.SkipZigTest;
    defer pipe.close();

    const system = std.posix.system;
    for ([_]std.posix.fd_t{ pipe.read, pipe.write }) |fd| {
        const fd_flags: usize = @intCast(system.fcntl(fd, std.posix.F.GETFD, @as(usize, 0)));
        try testing.expect(fd_flags & std.posix.FD_CLOEXEC != 0);
    }
    const nonblock: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
    const write_flags: usize = @intCast(system.fcntl(pipe.write, std.posix.F.GETFL, @as(usize, 0)));
    try testing.expect(write_flags & nonblock != 0);
    const read_flags: usize = @intCast(system.fcntl(pipe.read, std.posix.F.GETFL, @as(usize, 0)));
    try testing.expect(read_flags & nonblock == 0);

    // More signals than the pipe holds do not block the handler.
    _ = arm(pipe.write, &.{.USR1}, null);
    defer disarm(&.{.USR1});
    const byte = [1]u8{1};
    while (std.posix.errno(system.write(pipe.write, &byte, 1)) == .SUCCESS) {}
    try std.posix.raise(.USR1);
    try testing.expect(signal_seen.load(.acquire));
}

test "without a pipe the wait still returns once a signal arrives" {
    if (builtin.os.tag == .windows) return;

    try testing.expectEqual(@as(usize, 1), arm(null, &.{.USR1}, null));
    defer disarm(&.{.USR1});
    try testing.expect(!signal_seen.load(.acquire));
    try std.posix.raise(.USR1);
    waitForSignal(testing.io, null);
    try testing.expect(signal_seen.load(.acquire));
}
