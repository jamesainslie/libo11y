//! Private internal OTLP wire framing module shared by `o11y` and `o11ytest`.
//!
//! Created with `b.createModule` in `zig/build.zig`, never exported as a public
//! module and never re-exported on `o11y`.

pub const http = @import("http.zig");
pub const hpack = @import("hpack.zig");
pub const h2 = @import("h2.zig");
pub const grpc_frame = @import("grpc_frame.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
