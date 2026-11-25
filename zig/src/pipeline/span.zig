//! Spans. The full implementation lands with the tracer.

const ids = @import("ids.zig");

/// A span.
pub const Span = struct {
    span_context: ids.SpanContext = .invalid,

    /// Returns the span's span context.
    pub fn spanContext(span: *const Span) ids.SpanContext {
        return span.span_context;
    }
};
