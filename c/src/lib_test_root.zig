//! Root compilation unit for `libo11ytest`: exports both the core `o11y_*`
//! C11 ABI and the `o11y_test_*` hermetic test harness & OTLP receivers in a
//! single self-contained archive so test binaries share one runtime and guard.

comptime {
    _ = @import("abi.zig");
    _ = @import("test_abi.zig");
}
