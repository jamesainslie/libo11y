//! libo11y for Zig: the core module.
//!
//! The implementation is in progress. Later steps of the program in
//! docs/design/2026-11-25-libo11y-zig-design.md add setup, the three
//! signals and the rest of the API here.

const std = @import("std");
const build_options = @import("build_options");

/// The libo11y package version, from zig/build.zig.zon.
pub const version: []const u8 = build_options.version;

test "version is the package version and a semantic version" {
    const parsed = try std.SemanticVersion.parse(version);
    try std.testing.expectFmt(version, "{f}", .{parsed});
}

test {
    _ = @import("proto_roundtrip_test.zig");
}
