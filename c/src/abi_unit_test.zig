//! Zig-level unit tests for internal C ABI trampolines (such as OOM paths
//! that require an injected failing allocator).

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const c = @import("c_types.zig");
const abi = @import("abi_common.zig");

const SinkState = struct {
    calls: usize = 0,
};

fn testSinkEmit(
    userdata: ?*anyopaque,
    _: u64,
    _: c.Level,
    _: [*:0]const u8,
    _: c.SpanContext,
    _: ?[*]const c.LogAttr,
    _: usize,
) callconv(.c) c.Err {
    const state: *SinkState = @ptrCast(@alignCast(userdata.?));
    state.calls += 1;
    return .ok;
}

test "LogSinkTrampoline.emit returns error.SinkRejected on allocation failure" {
    var state: SinkState = .{};
    var tr: abi.LogSinkTrampoline = .{
        .sink = .{
            .userdata = &state,
            .enabled = null,
            .emit = testSinkEmit,
        },
        .allocator = testing.failing_allocator,
    };
    const rec: o11y.SinkRecord = .{
        .time_unix_nano = 123,
        .level = .info,
        .message = "canary",
        .span_context = .invalid,
        .attributes = &.{},
    };
    try testing.expectError(error.SinkRejected, abi.LogSinkTrampoline.vtable.emit(&tr, .background, rec));
    try testing.expectEqual(@as(usize, 0), state.calls);
}
