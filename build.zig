//! The root shim for the libo11y Zig package in zig/. It re-exports every
//! module zig/build.zig adds, under the same names, and forwards the test
//! step. See build.zig.zon for why the shim exists.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    // The package's conformance suite reads the repository's conformance/
    // directory by default. The option is forwarded so it can be pointed
    // elsewhere from the repository root too.
    const conformance_dir = b.option(
        []const u8,
        "conformance-dir",
        "The directory of shared conformance cases (default: the repository's conformance/)",
    );
    const libo11y = b.dependency("libo11y", .{
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
        .@"conformance-dir" = conformance_dir,
    });

    var modules = libo11y.builder.modules.iterator();
    while (modules.next()) |entry| {
        try b.modules.put(b.graph.arena, entry.key_ptr.*, entry.value_ptr.*);
    }

    const package_tests = libo11y.builder.top_level_steps.get("test") orelse return error.MissingTestStep;
    const test_step = b.step("test", "Run the libo11y Zig tests");
    test_step.dependOn(&package_tests.step);
}
