//! The root shim for the libo11y Zig package in zig/. It re-exports every
//! module zig/build.zig adds, under the same names, and forwards the test
//! step. See build.zig.zon for why the shim exists.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    const libo11y = b.dependency("libo11y", .{
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
    });

    var modules = libo11y.builder.modules.iterator();
    while (modules.next()) |entry| {
        try b.modules.put(b.graph.arena, entry.key_ptr.*, entry.value_ptr.*);
    }

    const package_tests = libo11y.builder.top_level_steps.get("test") orelse return error.MissingTestStep;
    const test_step = b.step("test", "Run the libo11y Zig tests");
    test_step.dependOn(&package_tests.step);
}
