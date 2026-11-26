//! The resource and instrumentation scope that telemetry carries.

const attribute = @import("attribute.zig");

/// The entity that produces telemetry: a set of attributes and the schema
/// URL they follow. It borrows its strings.
pub const Resource = struct {
    attributes: []const attribute.KeyValue = &.{},
    schema_url: []const u8 = "",

    pub const empty: Resource = .{};
};

/// The instrumentation scope a tracer, meter or logger belongs to. It
/// borrows its strings.
pub const InstrumentationScope = struct {
    name: []const u8,
    version: []const u8 = "",
    schema_url: []const u8 = "",
    attributes: []const attribute.KeyValue = &.{},
};
