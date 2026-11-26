//! The hook that applies the sensitivity policy to span, event and link
//! attributes when a span ends, and to log record attributes when a
//! record is emitted. The pipeline calls it; the core plugs the real
//! policy in. Until then the no-op policy keeps every attribute.

const std = @import("std");
const attribute = @import("attribute.zig");
const log_record = @import("log_record.zig");

/// Which attribute set a policy call covers.
pub const Target = enum { span, event, link };

/// A policy over attribute lists.
pub const AttributePolicy = struct {
    ptr: ?*anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        /// Returns the attributes to keep for `target`. It may return
        /// `attrs` itself, a prefix of it, or a new slice allocated in
        /// `arena`, and may rewrite values in place. It must not fail:
        /// when it cannot allocate it drops the attributes it cannot
        /// keep safely.
        apply: *const fn (ptr: ?*anyopaque, target: Target, attrs: []attribute.KeyValue, arena: std.mem.Allocator) []attribute.KeyValue,
        /// The same for a log record's attributes, whose values nest.
        /// Null keeps every attribute.
        applyLog: ?*const fn (ptr: ?*anyopaque, attrs: []log_record.KeyValue, arena: std.mem.Allocator) []log_record.KeyValue = null,
    };

    /// Keeps every attribute.
    pub const noop: AttributePolicy = .{ .ptr = null, .vtable = &.{ .apply = keepAll } };

    /// Applies the policy to one attribute list.
    pub fn apply(p: AttributePolicy, target: Target, attrs: []attribute.KeyValue, arena: std.mem.Allocator) []attribute.KeyValue {
        return p.vtable.apply(p.ptr, target, attrs, arena);
    }

    /// Applies the policy to a log record's attributes.
    pub fn applyLog(p: AttributePolicy, attrs: []log_record.KeyValue, arena: std.mem.Allocator) []log_record.KeyValue {
        const f = p.vtable.applyLog orelse return attrs;
        return f(p.ptr, attrs, arena);
    }

    fn keepAll(_: ?*anyopaque, _: Target, attrs: []attribute.KeyValue, _: std.mem.Allocator) []attribute.KeyValue {
        return attrs;
    }
};

test "the no-op policy keeps every attribute" {
    var attrs = [_]attribute.KeyValue{ attribute.kv("a", 1), attribute.kv("b", "x") };
    const kept = AttributePolicy.noop.apply(.span, &attrs, std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), kept.len);
}

test "the no-op policy keeps every log attribute" {
    var attrs = [_]log_record.KeyValue{ log_record.kv("a", 1), log_record.kv("b", "x") };
    const kept = AttributePolicy.noop.applyLog(&attrs, std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 2), kept.len);
}
