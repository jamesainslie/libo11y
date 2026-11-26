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

    // Tests that read fixtures under test/, which the published package
    // leaves out. They build only when the test step runs.
    const fixture_tests = b.addTest(.{ .root_module = b.createModule(.{
        .root_source_file = b.path("test/otlp_fixtures_test.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "opentelemetry-proto", .module = proto },
        },
    }) });
    test_step.dependOn(&b.addRunArtifact(fixture_tests).step);

    // The conformance suite reads the shared cases and vectors at run time.
    // The published package does not hold them, so the default is the
    // repository's conformance/ directory beside zig/. The path is only
    // resolved when the test step runs, so a consumer's build never needs
    // it.
    const conformance_dir: std.Build.LazyPath = if (b.option(
        []const u8,
        "conformance-dir",
        "The directory of shared conformance cases (default: the repository's conformance/)",
    )) |dir| b.graph.cwdRelativePath(dir) else b.path("../conformance");
    const conformance = b.addOptions();
    conformance.addOptionPathDirectory("dir", conformance_dir);
    const conformance_tests = b.addTest(.{
        // Only the suite itself. The unit tests of the files it imports run
        // in the o11y module's tests.
        .filters = &.{"conformance_test."},
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/conformance_test.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "conformance", .module = conformance.createModule() },
            },
        }),
    });
    const conformance_run = b.addRunArtifact(conformance_tests);
    // The build cannot see the files the suite reads, so it runs every time
    // rather than reporting a cached result for changed cases.
    conformance_run.has_side_effects = true;
    test_step.dependOn(&conformance_run.step);
}
