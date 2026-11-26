//! The internal SDK: ids, propagation, sampling, spans, metrics,
//! log records, processors and the OTLP exporters. Nothing here is
//! public API. The core in o11y.zig wraps it, so a mature upstream SDK
//! can replace it later behind the same API.

pub const attribute = @import("attribute.zig");
pub const baggage = @import("baggage.zig");
pub const batch = @import("batch.zig");
pub const deadline = @import("deadline.zig");
pub const ids = @import("ids.zig");
pub const propagation = @import("propagation.zig");
pub const resource = @import("resource.zig");
pub const tracestate = @import("tracestate.zig");
pub const log_processor = @import("log_processor.zig");
pub const log_record = @import("log_record.zig");
pub const logger = @import("logger.zig");
pub const memory_exporter = @import("memory_exporter.zig");
pub const metric = @import("metric/metric.zig");
pub const policy = @import("policy.zig");
pub const processor = @import("processor.zig");
pub const sampler = @import("sampler.zig");
pub const span = @import("span.zig");
pub const tracer = @import("tracer.zig");

pub const otlp = struct {
    pub const json = @import("otlp/json.zig");
    pub const http = @import("otlp/http.zig");
    pub const transport = @import("otlp/transport.zig");
    pub const env = @import("otlp/env.zig");
    pub const encode = @import("otlp/encode.zig");
    pub const metric_exporter = @import("otlp/metric_exporter.zig");
    pub const trace_exporter = @import("otlp/trace_exporter.zig");
    pub const log_encode = @import("otlp/log_encode.zig");
    pub const log_exporter = @import("otlp/log_exporter.zig");
};

test {
    @import("std").testing.refAllDecls(@This());
    @import("std").testing.refAllDecls(otlp);
}
