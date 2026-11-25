//! Build script for the libo11y Zig package.
//!
//! It exports the `o11y` module. The repository root's build.zig re-exports
//! every module this script adds with `b.addModule`, so consumers that fetch
//! the repository get the same names.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const protobuf = b.dependency("protobuf", .{
        .target = target,
        .optimize = optimize,
    }).module("protobuf");

    // Only the generated OTLP bindings are used from the upstream SDK. The
    // module is built here from upstream's sources rather than taken from
    // its build script, so the bindings and libo11y share the one pinned
    // zig-protobuf instead of each carrying their own copy. No options are
    // passed, because only upstream's source tree is used. Its build script
    // still runs, so its own dependencies are fetched too.
    const upstream = b.dependency("opentelemetry", .{});
    const proto = b.createModule(.{
        .root_source_file = upstream.path("opentelemetry-proto/src/root.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "protobuf", .module = protobuf },
        },
    });

    const manifest = @import("build.zig.zon");
    const options = b.addOptions();
    options.addOption([]const u8, "version", manifest.version);

    const o11y = b.addModule("o11y", .{
        .root_source_file = b.path("src/o11y.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "opentelemetry-proto", .module = proto },
            .{ .name = "protobuf", .module = protobuf },
            .{ .name = "build_options", .module = options.createModule() },
        },
    });

    const tests = b.addTest(.{ .root_module = o11y });
    const test_step = b.step("test", "Run the libo11y tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
