//! The W3C trace state.

/// A W3C `tracestate` value in canonical form: list members joined by
/// commas, without optional whitespace or empty members. It borrows its
/// text.
pub const TraceState = struct {
    header: []const u8 = "",

    pub const empty: TraceState = .{};
};
