//! Build script for the libo11y C11 library (`c/`).
//!
//! Artifacts installed by `zig build`:
//!   - `lib/libo11y.a`        static C11 core SDK library
//!   - `lib/libo11y.so/.dylib` shared C11 core SDK library
//!   - `lib/libo11ytest.a`    self-contained C11 test harness + OTLP receivers
//!   - `bin/libo11y`          application attribute registry validator CLI
//!   - `include/o11y/*.h`     ISO C11 public headers (spec.h, o11y.h, test.h)
//!   - `lib/pkgconfig/libo11y.pc`
//!   - `lib/cmake/libo11y/libo11yConfig.cmake`
//!
//! Run `zig build test` to compile and execute the full C11 unit, conformance,
//! wire, and example test suites with `-std=c11 -Wall -Wextra -Werror -Wpedantic`.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const zig_dep = b.dependency("libo11y", .{
        .target = target,
        .optimize = optimize,
    });
    const o11y_mod = zig_dep.module("o11y");
    const o11ytest_mod = zig_dep.module("o11ytest");

    // Static C11 library: libo11y.a
    const core_static_mod = b.createModule(.{
        .root_source_file = b.path("src/abi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
        },
    });
    const libo11y_static = b.addLibrary(.{
        .name = "o11y",
        .linkage = .static,
        .root_module = core_static_mod,
    });
    libo11y_static.bundle_compiler_rt = true;
    b.installArtifact(libo11y_static);

    // Shared C11 library: libo11y.so / libo11y.dylib
    const core_shared_mod = b.createModule(.{
        .root_source_file = b.path("src/abi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
        },
    });
    const libo11y_shared = b.addLibrary(.{
        .name = "o11y",
        .linkage = .dynamic,
        .root_module = core_shared_mod,
    });
    b.installArtifact(libo11y_shared);

    // Self-contained test harness library: libo11ytest.a
    const test_lib_mod = b.createModule(.{
        .root_source_file = b.path("src/lib_test_root.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
            .{ .name = "o11ytest", .module = o11ytest_mod },
        },
    });
    const libo11ytest = b.addLibrary(.{
        .name = "o11ytest",
        .linkage = .static,
        .root_module = test_lib_mod,
    });
    libo11ytest.bundle_compiler_rt = true;
    b.installArtifact(libo11ytest);

    // CLI binary: `libo11y registry check FILE...`
    const cli_mod = b.createModule(.{
        .root_source_file = b.path("src/cli_main.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
        },
    });
    const cli = b.addExecutable(.{
        .name = "libo11y",
        .root_module = cli_mod,
    });
    b.installArtifact(cli);

    // Install C11 public headers, pkg-config, and CMake metadata.
    b.installDirectory(.{
        .source_dir = b.path("include"),
        .install_dir = .header,
        .install_subdir = "",
    });
    b.installFile("cmake/libo11y.pc.in", "lib/pkgconfig/libo11y.pc");
    b.installFile("cmake/libo11yConfig.cmake.in", "lib/cmake/libo11y/libo11yConfig.cmake");

    // Quickstart C11 example executable.
    const c_flags = &[_][]const u8{
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wpedantic",
    };

    const example_mod = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    example_mod.addIncludePath(b.path("include"));
    example_mod.addCSourceFile(.{
        .file = b.path("examples/quickstart.c"),
        .flags = c_flags,
    });
    example_mod.linkLibrary(libo11y_static);
    const example_exe = b.addExecutable(.{
        .name = "o11y-quickstart",
        .root_module = example_mod,
    });
    const example_step = b.step("example", "Build and run the C11 quickstart example");
    example_step.dependOn(&b.addRunArtifact(example_exe).step);

    // C11 test suites.
    const test_step = b.step("test", "Build and run all C11 tests (unit, conformance, wire, example)");
    test_step.dependOn(&b.addRunArtifact(example_exe).step);

    const conformance_dir = b.option(
        []const u8,
        "conformance-dir",
        "Path to shared conformance/ directory (default: ../conformance)",
    ) orelse "../conformance";

    const test_suites = [_]struct {
        name: []const u8,
        src: []const u8,
        needs_conformance_dir: bool = false,
    }{
        .{ .name = "test-core", .src = "tests/test_core.c" },
        .{ .name = "test-tracing", .src = "tests/test_tracing.c" },
        .{ .name = "test-metrics", .src = "tests/test_metrics.c" },
        .{ .name = "test-logging", .src = "tests/test_logging.c" },
        .{ .name = "test-sensitivity", .src = "tests/test_sensitivity.c" },
        .{ .name = "test-propagation", .src = "tests/test_propagation.c" },
        .{ .name = "test-conformance", .src = "tests/test_conformance.c", .needs_conformance_dir = true },
        .{ .name = "test-wire", .src = "tests/test_wire.c" },
    };

    for (test_suites) |suite| {
        const mod = b.createModule(.{
            .target = target,
            .optimize = optimize,
            .link_libc = true,
        });
        mod.addIncludePath(b.path("include"));
        mod.addIncludePath(b.path("tests"));
        mod.addCSourceFile(.{
            .file = b.path(suite.src),
            .flags = c_flags,
        });
        mod.linkLibrary(libo11ytest);
        const exe = b.addExecutable(.{
            .name = suite.name,
            .root_module = mod,
        });
        const run = b.addRunArtifact(exe);
        if (suite.needs_conformance_dir) {
            run.addArg(conformance_dir);
            run.has_side_effects = true;
        }
        test_step.dependOn(&run.step);
    }
}
