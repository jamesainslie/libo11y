//! Default semantic-convention process metrics for Zig programs:
//! - `process.cpu.time` (s, ObservableCounter(f64), `cpu.mode` = `user` / `system`)
//! - `process.memory.usage` (By, ObservableUpDownCounter(i64))
//! - `process.memory.virtual` (By, ObservableUpDownCounter(i64))
//! - `process.thread.count` ({thread}, ObservableUpDownCounter(i64))
//! - `process.unix.file_descriptor.count` ({file_descriptor}, ObservableUpDownCounter(i64))
//!
//! Implemented for both Linux (`/proc/self/status`, `/proc/self/fd`,
//! `getrusage`) and macOS (`getrusage`, `task_info`, `task_threads`,
//! `proc_pidinfo`). Disabled when `Options.runtime_metrics == false`.

const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const policy_runtime = @import("policy_runtime.zig");
const attribute = @import("pipeline/attribute.zig");
const metric_meter = @import("pipeline/metric/meter.zig");
const metric_reader = @import("pipeline/metric/reader.zig");

/// One point-in-time snapshot of process resource usage. Fields that cannot
/// be read on the current OS are null and skipped during observation.
pub const Snapshot = struct {
    cpu_user_seconds: ?f64 = null,
    cpu_system_seconds: ?f64 = null,
    memory_rss_bytes: ?i64 = null,
    memory_virtual_bytes: ?i64 = null,
    thread_count: ?i64 = null,
    fd_count: ?i64 = null,
};

/// Active registration of the process metrics callback on a `MeterProvider`.
pub const ProcessMetrics = struct {
    gpa: std.mem.Allocator,
    io: Io,
    cpu_time: metric_meter.ObservableCounter(f64),
    memory_usage: metric_meter.ObservableUpDownCounter(i64),
    memory_virtual: metric_meter.ObservableUpDownCounter(i64),
    thread_count: metric_meter.ObservableUpDownCounter(i64),
    fd_count: metric_meter.ObservableUpDownCounter(i64),
    registration: metric_meter.Registration = .{},

    /// Registers all five process instruments on `mp`. Caller owns the
    /// returned pointer (allocated in `gpa`) and calls `destroy(gpa)` before
    /// destroying `mp`.
    pub fn create(gpa: std.mem.Allocator, io: Io, mp: *metric_meter.MeterProvider, scope: []const u8) std.mem.Allocator.Error!*ProcessMetrics {
        const self = try gpa.create(ProcessMetrics);
        const m = mp.meter(.{ .name = scope });
        self.* = .{
            .gpa = gpa,
            .io = io,
            .cpu_time = m.observableCounter(f64, "process.cpu.time", .{
                .unit = "s",
                .description = "Total CPU seconds broken down by different states.",
            }),
            .memory_usage = m.observableUpDownCounter(i64, "process.memory.usage", .{
                .unit = "By",
                .description = "The amount of physical memory in use.",
            }),
            .memory_virtual = m.observableUpDownCounter(i64, "process.memory.virtual", .{
                .unit = "By",
                .description = "The amount of committed virtual memory.",
            }),
            .thread_count = m.observableUpDownCounter(i64, "process.thread.count", .{
                .unit = "{thread}",
                .description = "Process threads count.",
            }),
            .fd_count = m.observableUpDownCounter(i64, "process.unix.file_descriptor.count", .{
                .unit = "{file_descriptor}",
                .description = "Number of file descriptors in use by the process.",
            }),
        };
        const observables = [_]?metric_meter.Observable{
            self.cpu_time.observable(),
            self.memory_usage.observable(),
            self.memory_virtual.observable(),
            self.thread_count.observable(),
            self.fd_count.observable(),
        };
        self.registration = m.registerCallback(.{ .ptr = self, .func = observe }, &observables);
        return self;
    }

    pub fn destroy(self: *ProcessMetrics, gpa: std.mem.Allocator) void {
        self.registration.unregister();
        gpa.destroy(self);
    }

    fn observe(ptr: ?*anyopaque, observer: metric_meter.Observer) void {
        const p = ptr orelse return;
        const self: *ProcessMetrics = @ptrCast(@alignCast(p));
        const snap = sampleWithAllocator(self.gpa, self.io);

        if (snap.cpu_user_seconds) |u| {
            observer.observe(self.cpu_time, u, &.{attribute.kv("cpu.mode", "user")});
        }
        if (snap.cpu_system_seconds) |s| {
            observer.observe(self.cpu_time, s, &.{attribute.kv("cpu.mode", "system")});
        }
        if (snap.memory_rss_bytes) |rss| {
            observer.observe(self.memory_usage, rss, &.{});
        }
        if (snap.memory_virtual_bytes) |vsz| {
            observer.observe(self.memory_virtual, vsz, &.{});
        }
        if (snap.thread_count) |tc| {
            observer.observe(self.thread_count, tc, &.{});
        }
        if (snap.fd_count) |fds| {
            observer.observe(self.fd_count, fds, &.{});
        }
    }
};

/// Collects a snapshot of the current process's CPU, memory, thread, and file
/// descriptor metrics.
pub fn sample(io: Io) Snapshot {
    return sampleWithAllocator(null, io);
}

fn sampleWithAllocator(gpa: ?std.mem.Allocator, io: Io) Snapshot {
    return switch (builtin.os.tag) {
        .linux => sampleLinux(io),
        .macos => sampleMacos(gpa),
        else => .{},
    };
}

fn timevalSeconds(tv: anytype) f64 {
    const sec: f64 = @floatFromInt(tv.sec);
    const usec: f64 = @floatFromInt(tv.usec);
    return sec + usec / 1_000_000.0;
}

fn sampleLinux(io: Io) Snapshot {
    var snap: Snapshot = .{};

    // CPU time via getrusage(RUSAGE_SELF).
    const ru = std.posix.getrusage(std.posix.rusage.SELF);
    snap.cpu_user_seconds = timevalSeconds(ru.utime);
    snap.cpu_system_seconds = timevalSeconds(ru.stime);

    // Memory (VmRSS, VmSize) and thread count (Threads) from /proc/self/status.
    if (Io.Dir.cwd().openFile(io, "/proc/self/status", .{})) |file| {
        defer file.close(io);
        var buf: [8192]u8 = undefined;
        var total: usize = 0;
        while (total < buf.len) {
            const n = file.readStreaming(io, &.{buf[total..]}) catch break;
            if (n == 0) break;
            total += n;
        }
        parseProcSelfStatus(buf[0..total], &snap);
    } else |_| {}

    // Open file descriptors from /proc/self/fd (subtract 1 for the dir handle).
    if (Io.Dir.cwd().openDir(io, "/proc/self/fd", .{ .iterate = true })) |dir_const| {
        var dir = dir_const;
        defer dir.close(io);
        var count: i64 = 0;
        var it = dir.iterate();
        while (it.next(io) catch null) |_| {
            count += 1;
        }
        snap.fd_count = @max(0, count - 1);
    } else |_| {}

    return snap;
}

/// Parses `VmRSS:`, `VmSize:`, and `Threads:` lines from `/proc/self/status`.
pub fn parseProcSelfStatus(content: []const u8, snap: *Snapshot) void {
    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "VmRSS:")) {
            if (parseProcNumber(line["VmRSS:".len..])) |kib| snap.memory_rss_bytes = kib *| 1024;
        } else if (std.mem.startsWith(u8, line, "VmSize:")) {
            if (parseProcNumber(line["VmSize:".len..])) |kib| snap.memory_virtual_bytes = kib *| 1024;
        } else if (std.mem.startsWith(u8, line, "Threads:")) {
            if (parseProcNumber(line["Threads:".len..])) |n| snap.thread_count = n;
        }
    }
}

fn parseProcNumber(rest: []const u8) ?i64 {
    const trimmed = std.mem.trimStart(u8, rest, " \t");
    var end: usize = 0;
    while (end < trimmed.len and std.ascii.isDigit(trimmed[end])) end += 1;
    if (end == 0) return null;
    return std.fmt.parseInt(i64, trimmed[0..end], 10) catch null;
}

// Darwin libproc declaration (lives in libSystem on macOS).
const PROC_PIDLISTFDS: c_int = 1;
const PROC_FDINFO_SIZE: c_int = 8; // struct proc_fdinfo { int32_t proc_fd; uint32_t proc_fdtype; }

const darwin_ext = if (builtin.os.tag == .macos) struct {
    extern "c" fn proc_pidinfo(pid: c_int, flavor: c_int, arg: u64, buffer: ?*anyopaque, buffersize: c_int) c_int;
} else struct {};

fn sampleMacos(gpa: ?std.mem.Allocator) Snapshot {
    if (builtin.os.tag != .macos) return .{};
    var snap: Snapshot = .{};

    // CPU time via getrusage(RUSAGE_SELF).
    const ru = std.posix.getrusage(std.c.rusage.SELF);
    snap.cpu_user_seconds = timevalSeconds(ru.utime);
    snap.cpu_system_seconds = timevalSeconds(ru.stime);

    // Memory via Mach task_info(MACH_TASK_BASIC_INFO).
    const task = std.c.mach_task_self();
    var info: std.c.mach_task_basic_info = std.mem.zeroes(std.c.mach_task_basic_info);
    var count: std.c.mach_msg_type_number_t = std.c.MACH.TASK.BASIC.INFO_COUNT;
    if (std.c.task_info(task, std.c.MACH.TASK.BASIC.INFO, @ptrCast(&info), &count) == 0) {
        snap.memory_rss_bytes = std.math.cast(i64, info.resident_size);
        snap.memory_virtual_bytes = std.math.cast(i64, info.virtual_size);
    }

    // Thread count via Mach task_threads.
    var threads: std.c.mach_port_array_t = undefined;
    var thread_count: std.c.mach_msg_type_number_t = 0;
    if (std.c.task_threads(task, &threads, &thread_count) == 0) {
        snap.thread_count = @intCast(thread_count);
        for (0..thread_count) |i| {
            _ = std.c.mach_port_deallocate(task, threads[i]);
        }
        const byte_len: usize = @as(usize, thread_count) * @sizeOf(std.c.mach_port_t);
        if (byte_len > 0) {
            _ = std.c.vm_deallocate(task, @intFromPtr(threads), byte_len);
        }
    }

    // Open FDs via two-pass proc_pidinfo(PROC_PIDLISTFDS): the null-buffer
    // probe returns XNU's capacity estimate, so populate a real buffer to get
    // the exact count of open descriptors.
    const pid = std.c.getpid();
    const est_bytes = darwin_ext.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, null, 0);
    if (est_bytes == 0) {
        snap.fd_count = 0;
    } else if (est_bytes > 0) {
        const max_fd_buf: usize = 16 * 1024 * 1024;
        const needed: usize = @min(@as(usize, @intCast(est_bytes)), max_fd_buf);
        var stack_buf: [4096]u8 align(4) = undefined;
        if (needed <= stack_buf.len) {
            const actual = darwin_ext.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &stack_buf, @intCast(stack_buf.len));
            if (actual >= 0) {
                snap.fd_count = @divTrunc(@as(i64, actual), PROC_FDINFO_SIZE);
            }
        } else if (gpa) |alloc| {
            if (alloc.alloc(u8, needed)) |heap_buf| {
                defer alloc.free(heap_buf);
                const actual = darwin_ext.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, heap_buf.ptr, @intCast(heap_buf.len));
                if (actual >= 0) {
                    snap.fd_count = @divTrunc(@as(i64, actual), PROC_FDINFO_SIZE);
                }
            } else |_| {}
        }
    }

    return snap;
}

const testing = std.testing;

test "parseProcSelfStatus extracts VmRSS, VmSize, and Threads" {
    var snap: Snapshot = .{};
    parseProcSelfStatus("Name:\tmybin\nVmSize:\t   123456 kB\nVmRSS:\t    4096 kB\nThreads:\t4\n", &snap);
    try testing.expectEqual(@as(?i64, 4096 * 1024), snap.memory_rss_bytes);
    try testing.expectEqual(@as(?i64, 123456 * 1024), snap.memory_virtual_bytes);
    try testing.expectEqual(@as(?i64, 4), snap.thread_count);
}

test "ProcessMetrics callback produces positive readings on current OS" {
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    const mp = try metric_meter.MeterProvider.create(testing.allocator, testing.io, .{
        .readers = &.{reader.reader()},
    });
    defer mp.destroy();

    const pm = try ProcessMetrics.create(testing.allocator, testing.io, mp, policy_runtime.scope_name);
    defer pm.destroy(testing.allocator);

    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();

    var saw_cpu = false;
    var saw_rss = false;
    var saw_vsz = false;
    var saw_threads = false;
    var saw_fds = false;
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            if (std.mem.eql(u8, m.name, "process.cpu.time")) {
                saw_cpu = m.data.sum.data_points.len == 2;
            } else if (std.mem.eql(u8, m.name, "process.memory.usage")) {
                saw_rss = m.data.sum.data_points.len == 1 and m.data.sum.data_points[0].value.int > 0;
            } else if (std.mem.eql(u8, m.name, "process.memory.virtual")) {
                saw_vsz = m.data.sum.data_points.len == 1 and m.data.sum.data_points[0].value.int > 0;
            } else if (std.mem.eql(u8, m.name, "process.thread.count")) {
                saw_threads = m.data.sum.data_points.len == 1 and m.data.sum.data_points[0].value.int >= 1;
            } else if (std.mem.eql(u8, m.name, "process.unix.file_descriptor.count")) {
                saw_fds = m.data.sum.data_points.len == 1 and m.data.sum.data_points[0].value.int >= 0;
            }
        }
    }
    if (builtin.os.tag == .linux or builtin.os.tag == .macos) {
        try testing.expect(saw_cpu);
        try testing.expect(saw_rss);
        try testing.expect(saw_vsz);
        try testing.expect(saw_threads);
        try testing.expect(saw_fds);
    }
}
