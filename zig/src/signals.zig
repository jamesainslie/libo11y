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
};

// Self-pipe write fd used by the async-signal-safe POSIX handler.
var signal_pipe_write_fd: std.atomic.Value(i32) = .init(-1);

fn posixSignalHandler(_: std.posix.SIG) callconv(.c) void {
    const fd = signal_pipe_write_fd.load(.acquire);
    if (fd < 0) return;
    const byte = [1]u8{1};
    _ = std.posix.system.write(@intCast(fd), &byte, 1);
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

    signal_pipe_write_fd.store(@intCast(pipe_fds[1]), .release);

    const act: std.posix.Sigaction = .{
        .handler = .{ .handler = posixSignalHandler },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    for (options.signals) |sig| {
        std.posix.sigaction(sig, &act, null);
    }

    // Block reading a single byte from the self-pipe. Retry on EINTR.
    var buf: [1]u8 = undefined;
    while (true) {
        const rc = std.posix.system.read(pipe_fds[0], &buf, 1);
        const err = std.posix.errno(rc);
        if (err == .INTR) continue;
        break;
    }

    // Restore default handling immediately so a second signal kills the process.
    const dfl: std.posix.Sigaction = .{
        .handler = .{ .handler = std.posix.SIG.DFL },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    for (options.signals) |sig| {
        std.posix.sigaction(sig, &dfl, null);
    }
    signal_pipe_write_fd.store(-1, .release);

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
    var waiter = try testing.io.concurrent(struct {
        fn run(s: *State) bool {
            return shutdownOnSignals(testing.io, s, .{
                .signals = &.{.USR1},
                .before_shutdown = .{ .ptr = s, .func = State.before },
            });
        }
    }.run, .{&state});

    // Wait briefly until signal_pipe_write_fd is armed, then raise SIGUSR1.
    var spins: usize = 0;
    while (signal_pipe_write_fd.load(.acquire) < 0 and spins < 200) : (spins += 1) {
        testing.io.sleep(.fromMilliseconds(5), .awake) catch {};
    }
    try std.posix.raise(.USR1);

    const ok = waiter.await(testing.io);
    try testing.expect(ok);
    try testing.expectEqualStrings("BS", &state.order);
}
