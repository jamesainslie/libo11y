//! Default rate-limited error handler for internal pipeline failures.
//!
//! Writes directly to stderr (or an injected byte sink in tests) and never
//! routes through `std.log`, so a failing exporter cannot recurse into the
//! log pipeline. Uses a token bucket matching Go's `errhandler.go`: burst of
//! 5 reports, refilling one token every 30 seconds.

const std = @import("std");
const Io = std.Io;
const processor = @import("pipeline/processor.zig");

/// Maximum burst of error reports before suppression kicks in.
pub const default_burst: f64 = 5.0;

/// Refill interval per token (30 seconds).
pub const default_refill_ns: i64 = 30 * std.time.ns_per_s;

/// Where the default error handler writes formatted lines.
pub const Sink = union(enum) {
    stderr,
    custom: Custom,

    pub const Custom = struct {
        ptr: *anyopaque,
        writeFn: *const fn (ptr: *anyopaque, bytes: []const u8) void,
    };

    fn write(s: Sink, io: Io, bytes: []const u8) void {
        switch (s) {
            .stderr => {
                Io.File.stderr().writeStreamingAll(io, bytes) catch {};
            },
            .custom => |c| c.writeFn(c.ptr, bytes),
        }
    }
};

/// Rate-limited internal error handler. Safe for concurrent use.
pub const DefaultErrorHandler = struct {
    io: Io,
    sink: Sink = .stderr,
    burst: f64 = default_burst,
    refill_ns: i64 = default_refill_ns,
    mutex: Io.Mutex = .init,
    tokens: f64 = default_burst,
    last_ns: ?i96 = null,
    suppressed: u64 = 0,

    pub fn init(io: Io, sink: Sink) DefaultErrorHandler {
        return .{ .io = io, .sink = sink };
    }

    /// Returns the internal pipeline `ErrorHandler` interface.
    pub fn handler(self: *DefaultErrorHandler) processor.ErrorHandler {
        return .{ .ptr = self, .report = reportErased };
    }

    /// Reports a pipeline error if the token bucket allows it.
    pub fn report(self: *DefaultErrorHandler, component: []const u8, err: processor.ExportError, detail: []const u8) void {
        const suppressed_count = self.take() orelse return;
        var buf: [1024]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        if (suppressed_count > 0) {
            w.print(
                "level=WARN msg=\"o11y: telemetry error\" component=\"{s}\" error=\"{s}\" detail=\"{s}\" suppressed={d}\n",
                .{ component, @errorName(err), detail, suppressed_count },
            ) catch {};
        } else {
            w.print(
                "level=WARN msg=\"o11y: telemetry error\" component=\"{s}\" error=\"{s}\" detail=\"{s}\"\n",
                .{ component, @errorName(err), detail },
            ) catch {};
        }
        self.sink.write(self.io, w.buffered());
    }

    /// Reports a free-form warning message (such as an invalid env var value).
    pub fn reportWarning(self: *DefaultErrorHandler, msg: []const u8) void {
        const suppressed_count = self.take() orelse return;
        var buf: [1024]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        if (suppressed_count > 0) {
            w.print("level=WARN msg=\"o11y: telemetry error\" error=\"{s}\" suppressed={d}\n", .{ msg, suppressed_count }) catch {};
        } else {
            w.print("level=WARN msg=\"o11y: telemetry error\" error=\"{s}\"\n", .{msg}) catch {};
        }
        self.sink.write(self.io, w.buffered());
    }

    /// Attempts to consume one token. Returns null when suppressed, or the
    /// number of previously suppressed reports when permitted.
    fn take(self: *DefaultErrorHandler) ?u64 {
        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);

        const now_ns = Io.Clock.awake.now(self.io).nanoseconds;
        if (self.last_ns) |prev| {
            const elapsed = now_ns - prev;
            if (elapsed > 0 and self.refill_ns > 0) {
                const elapsed_f: f64 = @floatFromInt(elapsed);
                const refill_f: f64 = @floatFromInt(self.refill_ns);
                self.tokens = @min(self.burst, self.tokens + elapsed_f / refill_f);
            }
        }
        self.last_ns = now_ns;

        if (self.tokens < 1.0) {
            self.suppressed += 1;
            return null;
        }
        self.tokens -= 1.0;
        const count = self.suppressed;
        self.suppressed = 0;
        return count;
    }

    fn reportErased(ptr: ?*anyopaque, component: []const u8, err: processor.ExportError, detail: []const u8) void {
        const p = ptr orelse return;
        const self: *DefaultErrorHandler = @ptrCast(@alignCast(p));
        self.report(component, err, detail);
    }
};

const testing = std.testing;

const CaptureSink = struct {
    gpa: std.mem.Allocator,
    lines: std.ArrayList([]u8) = .empty,

    fn deinit(c: *CaptureSink) void {
        for (c.lines.items) |l| c.gpa.free(l);
        c.lines.deinit(c.gpa);
    }

    fn sink(c: *CaptureSink) Sink {
        return .{ .custom = .{ .ptr = c, .writeFn = writeFn } };
    }

    fn writeFn(ptr: *anyopaque, bytes: []const u8) void {
        const c: *CaptureSink = @ptrCast(@alignCast(ptr));
        const copy = c.gpa.dupe(u8, bytes) catch return;
        c.lines.append(c.gpa, copy) catch {
            c.gpa.free(copy);
        };
    }
};

test "rate-limited error handler allows burst then suppresses and reports suppressed count after refill" {
    var cap: CaptureSink = .{ .gpa = testing.allocator };
    defer cap.deinit();

    var eh = DefaultErrorHandler.init(testing.io, cap.sink());
    // Use a huge refill so the first 5 succeed and the next 3 are suppressed.
    eh.refill_ns = 3600 * std.time.ns_per_s;
    const h = eh.handler();

    for (0..8) |_| {
        h.handle("test", error.ExportFailed, "boom");
    }
    try testing.expectEqual(@as(usize, 5), cap.lines.items.len);
    try testing.expect(std.mem.indexOf(u8, cap.lines.items[0], "o11y: telemetry error") != null);
    try testing.expect(std.mem.indexOf(u8, cap.lines.items[0], "suppressed=") == null);

    // Simulate time passing by rewinding last_ns so 1 token refills.
    eh.last_ns = eh.last_ns.? - eh.refill_ns;
    h.handle("test", error.Timeout, "slow");
    try testing.expectEqual(@as(usize, 6), cap.lines.items.len);
    try testing.expect(std.mem.indexOf(u8, cap.lines.items[5], "suppressed=3") != null);
}
