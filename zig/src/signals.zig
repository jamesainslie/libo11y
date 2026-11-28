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

// Self-pipe write fd used by the async-signal-safe POSIX handler.
var signal_pipe_write_fd: std.atomic.Value(i32) = .init(-1);

fn posixSignalHandler(_: std.posix.SIG) callconv(.c) void {
    const preserve_errno = builtin.link_libc or builtin.os.tag == .macos;
    const saved_errno: c_int = if (preserve_errno) std.c._errno().* else 0;
    defer if (preserve_errno) {
        std.c._errno().* = saved_errno;
    };

    const fd = signal_pipe_write_fd.load(.acquire);
    if (fd < 0) return;
    const byte = [1]u8{1};
    _ = std.posix.system.write(@intCast(fd), &byte, 1);
}

/// Publishes `write_fd`, then installs the handler for each of `signals`.
/// The pipe comes first, so a signal delivered the instant its handler is
/// installed is written to it. In the other order the handler would find no
/// pipe, drop the signal, and leave the caller waiting on an empty pipe.
///
/// `installed`, when set, runs right after each handler is installed. Tests
/// use it to deliver a signal at that moment.
fn arm(write_fd: std.posix.fd_t, signals: []const std.posix.SIG, installed: ?*const fn (sig: std.posix.SIG) void) void {
    signal_pipe_write_fd.store(@intCast(write_fd), .release);
    const act: std.posix.Sigaction = .{
        .handler = .{ .handler = posixSignalHandler },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    for (signals) |sig| {
        std.posix.sigaction(sig, &act, null);
        if (installed) |f| f(sig);
    }
}

/// Restores default handling for `signals`, then retires the pipe.
fn disarm(signals: []const std.posix.SIG) void {
    const dfl: std.posix.Sigaction = .{
        .handler = .{ .handler = std.posix.SIG.DFL },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    for (signals) |sig| {
        std.posix.sigaction(sig, &dfl, null);
    }
    signal_pipe_write_fd.store(-1, .release);
}

/// Installs signal handlers for `options.signals`, waits until one arrives,
/// restores default signal handling (`SIG.DFL`), runs `options.before_shutdown`
/// (if set), and shuts down `telemetry` under one shared deadline.
pub fn shutdownOnSignals(io: Io, telemetry: anytype, options: Options) @TypeOf(telemetry.shutdownBy(undefined)) {
    if (builtin.os.tag == .windows) {
        const dl = deadline_mod.after(io, options.timeout);
        if (options.before_shutdown) |cb| cb.func(cb.ptr, dl);
        return telemetry.shutdownBy(dl);
    }

    var pipe_fds: [2]std.posix.fd_t = .{ -1, -1 };
    const pipe_ok = std.posix.errno(std.posix.system.pipe(&pipe_fds)) == .SUCCESS;
    if (!pipe_ok) {
        const dl = deadline_mod.after(io, options.timeout);
        if (options.before_shutdown) |cb| cb.func(cb.ptr, dl);
        return telemetry.shutdownBy(dl);
    }
    defer {
        signal_pipe_write_fd.store(-1, .release);
        _ = std.posix.system.close(pipe_fds[0]);
        _ = std.posix.system.close(pipe_fds[1]);
    }

    arm(pipe_fds[1], options.signals, null);
    if (options.ready_event) |ev| ev.set(io);

    // Block reading a single byte from the self-pipe. Retry on EINTR.
    var buf: [1]u8 = undefined;
    while (true) {
        const rc = std.posix.system.read(pipe_fds[0], &buf, 1);
        const err = std.posix.errno(rc);
        if (err == .INTR) continue;
        break;
    }

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
    arm(pipe_fds[1], &.{.USR1}, struct {
        fn raise(sig: std.posix.SIG) void {
            std.posix.raise(sig) catch {};
        }
    }.raise);
    defer disarm(&.{.USR1});

    var poll_fds = [_]std.posix.pollfd{.{ .fd = pipe_fds[0], .events = std.posix.POLL.IN, .revents = 0 }};
    try testing.expectEqual(@as(usize, 1), try std.posix.poll(&poll_fds, 0));
}
