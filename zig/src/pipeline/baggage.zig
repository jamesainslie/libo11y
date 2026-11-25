//! W3C baggage.

/// An immutable set of baggage members. It borrows every string it holds.
pub const Baggage = struct {
    members: []const Member = &.{},

    pub const empty: Baggage = .{};

    /// A baggage member: a key, its decoded value and its properties.
    pub const Member = struct {
        key: []const u8,
        value: []const u8,
        properties: []const Property = &.{},
    };

    /// A member property: a key with an optional value.
    pub const Property = struct {
        key: []const u8,
        value: ?[]const u8 = null,
    };
};
