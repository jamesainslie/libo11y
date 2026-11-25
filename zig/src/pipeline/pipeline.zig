//! The internal SDK: ids, propagation, sampling, spans, processors and the
//! OTLP exporters. Nothing here is public API. The core in o11y.zig wraps
//! it, so a mature upstream SDK can replace it later behind the same API.

pub const attribute = @import("attribute.zig");
pub const baggage = @import("baggage.zig");
pub const deadline = @import("deadline.zig");
pub const ids = @import("ids.zig");
pub const propagation = @import("propagation.zig");
pub const resource = @import("resource.zig");
pub const tracestate = @import("tracestate.zig");
pub const span = @import("span.zig");

pub const otlp = struct {
    pub const json = @import("otlp/json.zig");
    pub const http = @import("otlp/http.zig");
    pub const transport = @import("otlp/transport.zig");
    pub const env = @import("otlp/env.zig");
};

test {
    @import("std").testing.refAllDecls(@This());
    @import("std").testing.refAllDecls(otlp);
}
