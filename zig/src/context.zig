//! The explicit context that every libo11y call takes.

const std = @import("std");
const ids = @import("pipeline/ids.zig");
const Baggage = @import("pipeline/baggage.zig").Baggage;
const Span = @import("pipeline/span.zig").Span;

/// The accumulator for a wide event. Its API arrives with the core in a
/// later step; until then a context only carries the pointer.
pub const Record = opaque {};

/// A small immutable value, passed by value and never allocated, that
/// carries the current span context, the live span, the baggage, the
/// force-emit flag and the current wide-event record.
///
/// A context borrows what it points to. The owner of a span, of extracted
/// baggage or of the trace state text must keep it alive for as long as
/// any context derived from it is in use. For a local span that means
/// until the span ends, because the trace state text in `span_context`
/// lives in the span's record, and `span` points to the caller's span
/// handle. Start children before the parent ends; work that outlives it
/// starts from a serialized carrier instead.
pub const Context = struct {
    /// The span context of the current span, or of the remote parent
    /// that a propagator extracted.
    span_context: ids.SpanContext = .invalid,
    /// The live span that `span_context` belongs to, when it is local.
    span: ?*Span = null,
    /// The current baggage, when there is any.
    baggage: ?*const Baggage = null,
    /// Whether records emitted in this context bypass level gates.
    force_emit: bool = false,
    /// The wide-event record this context accumulates into.
    record: ?*Record = null,

    /// The empty context: no span, no baggage, no record.
    pub const background: Context = .{};

    /// Returns a copy whose current span is `span`, a live local span.
    pub fn withSpan(ctx: Context, span: *Span) Context {
        var out = ctx;
        out.span = span;
        out.span_context = span.spanContext();
        return out;
    }

    /// Returns a copy whose current span context is `sc` and which has no
    /// live span. Propagators use it for a remote parent.
    pub fn withSpanContext(ctx: Context, sc: ids.SpanContext) Context {
        var out = ctx;
        out.span = null;
        out.span_context = sc;
        return out;
    }

    /// Returns a copy that carries `baggage`, or no baggage when it is null.
    pub fn withBaggage(ctx: Context, baggage: ?*const Baggage) Context {
        var out = ctx;
        out.baggage = baggage;
        return out;
    }

    /// Returns a copy whose records bypass level gates.
    pub fn withForceEmit(ctx: Context) Context {
        var out = ctx;
        out.force_emit = true;
        return out;
    }

    /// Returns a copy that accumulates into `record`.
    pub fn withRecord(ctx: Context, record: ?*Record) Context {
        var out = ctx;
        out.record = record;
        return out;
    }

    /// Returns the current span context, which is invalid when there is
    /// no current span.
    pub fn spanContext(ctx: Context) ids.SpanContext {
        return ctx.span_context;
    }
};

const testing = std.testing;

test "the with helpers return new values and leave the original alone" {
    const base: Context = .background;
    const sc: ids.SpanContext = .{
        .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
        .remote = true,
    };
    const remote = base.withSpanContext(sc);
    try testing.expect(remote.spanContext().eql(sc));
    try testing.expect(!base.spanContext().isValid());

    var span: Span = .{ .span_context = .{ .trace_id = sc.trace_id, .span_id = ids.SpanId.parseHex("53995c3f42cd8ad8").? } };
    const local = remote.withSpan(&span);
    try testing.expectEqual(&span, local.span.?);
    try testing.expect(local.spanContext().eql(span.span_context));
    try testing.expectEqual(null, remote.withSpanContext(sc).span);
    try testing.expectEqual(null, local.withSpanContext(sc).span);

    const bag: Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    const with_bag = local.withBaggage(&bag);
    try testing.expectEqual(&bag, with_bag.baggage.?);
    try testing.expectEqual(null, local.baggage);
    try testing.expect(with_bag.withForceEmit().force_emit);
    try testing.expect(!with_bag.force_emit);
    try testing.expectEqual(null, with_bag.withRecord(null).record);
}
