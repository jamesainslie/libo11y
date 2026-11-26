//! The root shim for the libo11y Zig package in zig/. It re-exports every
//! module zig/build.zig adds, under the same names, and forwards the test
//! step. See build.zig.zon for why the shim exists.

const std = @import("std");
const zig_build = @import("libo11y");

/// Options for `addBuildInfo`, re-exported from `zig/build.zig`.
pub const BuildInfoOptions = zig_build.BuildInfoOptions;

/// Records build-time identity into a build-options module on `compile`,
/// re-exported from `zig/build.zig`.
pub const addBuildInfo = zig_build.addBuildInfo;

pub fn build(b: *std.Build) !void {
    // The package's conformance suite reads the repository's conformance/
    // directory by default. The option is forwarded so it can be pointed
    // elsewhere from the repository root too.
    const conformance_dir = b.option(
        []const u8,
        "conformance-dir",
        "The directory of shared conformance cases (default: the repository's conformance/)",
    );
    const httpz_enabled = b.option(
        bool,
        "httpz",
        "Enable the o11yhttpz module (fetches http.zig)",
    ) orelse false;
    const pg_enabled = b.option(
        bool,
        "pg",
        "Enable the o11ypg module (fetches pg.zig)",
    ) orelse false;
    const sqlite_enabled = b.option(
        bool,
        "sqlite",
        "Enable the o11ysqlite module (fetches zig-sqlite)",
    ) orelse false;
    const libo11y = b.dependency("libo11y", .{
        .target = b.standardTargetOptions(.{}),
        .optimize = b.standardOptimizeOption(.{}),
        .@"conformance-dir" = conformance_dir,
        .httpz = httpz_enabled,
        .pg = pg_enabled,
        .sqlite = sqlite_enabled,
    });

    var modules = libo11y.builder.modules.iterator();
    while (modules.next()) |entry| {
        try b.modules.put(b.graph.arena, entry.key_ptr.*, entry.value_ptr.*);
    }

    const package_tests = libo11y.builder.top_level_steps.get("test") orelse return error.MissingTestStep;
    const test_step = b.step("test", "Run the libo11y Zig tests");
    test_step.dependOn(&package_tests.step);
}
