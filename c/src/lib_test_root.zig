//! Root compilation unit for `libo11ytest`: exports both the core `o11y_*`
//! C11 ABI and the `o11y_test_*` hermetic test harness & OTLP receivers in a
//! single self-contained archive so test binaries share one runtime and guard.

const std = @import("std");

/// Do not allocate a 256 KiB per-thread TLS signal stack or call `sigaltstack`
/// on library worker threads. A C/C++ library must leave host and sanitizer
/// alternate signal stacks untouched.
pub const std_options: std.Options = .{
    .signal_stack_size = null,
};

comptime {
    _ = @import("abi.zig");
    _ = @import("test_abi.zig");
}
