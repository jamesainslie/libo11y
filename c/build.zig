//! Build script for the libo11y C11 library (`c/`).
//!
//! `zig build` installs:
//!   - `lib/libo11y.a`             the static SDK library
//!   - `lib/libo11y.so`/`.dylib`   the shared SDK library, versioned
//!   - `lib/libo11ytest.a`         the test harness and OTLP receivers
//!   - `bin/libo11y`               the application registry validator
//!   - `include/o11y/*.h`          the public headers (spec.h, o11y.h, test.h)
//!   - `lib/pkgconfig/libo11y.pc` and `libo11ytest.pc`
//!   - `lib/cmake/libo11y/libo11yConfig.cmake` and `libo11yConfigVersion.cmake`
//!
//! `zig build test` compiles and runs the C11 unit, conformance, wire and
//! example suites with `-std=c11 -Wall -Wextra -Werror -Wpedantic`, and the
//! ABI layout test, which compares `src/c_types.zig` with the headers.
//!
//! The version comes from `build.zig.zon` alone. The library reports it
//! through `o11y_version()`, and the pkg-config and CMake files carry it.

const std = @import("std");

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const manifest = @import("build.zig.zon");
    const version_text: []const u8 = manifest.version;
    const version = try std.SemanticVersion.parse(version_text);

    const build_options = b.addOptions();
    // The option name differs from the engine's own `version` option on purpose:
    // identical generated files would be one file in two modules.
    build_options.addOption([]const u8, "c_version", version_text);
    const build_options_mod = build_options.createModule();

    const zig_dep = b.dependency("libo11y", .{
        .target = target,
        .optimize = optimize,
    });
    const o11y_mod = zig_dep.module("o11y");
    const o11ytest_mod = zig_dep.module("o11ytest");

    // The libraries hold no C code, so they need no UBSan runtime of their
    // own, and leaving it out keeps `__ubsan_*` out of their symbols. A
    // consumer built with -fsanitize=undefined links its own runtime.

    // Static C11 library: libo11y.a
    const core_static_mod = b.createModule(.{
        .root_source_file = b.path("src/abi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
            .{ .name = "c_build_options", .module = build_options_mod },
        },
    });
    const libo11y_static = b.addLibrary(.{
        .name = "o11y",
        .linkage = .static,
        .root_module = core_static_mod,
    });
    libo11y_static.bundle_compiler_rt = true;
    libo11y_static.bundle_ubsan_rt = false;
    b.installArtifact(libo11y_static);

    // Shared C11 library: libo11y.so.X.Y.Z or libo11y.X.Y.Z.dylib, with the
    // unversioned name as a link.
    const core_shared_mod = b.createModule(.{
        .root_source_file = b.path("src/abi.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y", .module = o11y_mod },
            .{ .name = "c_build_options", .module = build_options_mod },
        },
    });
    const libo11y_shared = b.addLibrary(.{
        .name = "o11y",
        .linkage = .dynamic,
        .root_module = core_shared_mod,
        .version = version,
    });
    libo11y_shared.bundle_ubsan_rt = false;
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
            .{ .name = "c_build_options", .module = build_options_mod },
        },
    });
    const libo11ytest = b.addLibrary(.{
        .name = "o11ytest",
        .linkage = .static,
        .root_module = test_lib_mod,
    });
    libo11ytest.bundle_compiler_rt = true;
    libo11ytest.bundle_ubsan_rt = false;
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

    // Public headers.
    b.installDirectory(.{
        .source_dir = b.path("include"),
        .install_dir = .header,
        .install_subdir = "",
    });

    // pkg-config and CMake metadata, generated with the manifest version.
    const system_libs: []const u8 = if (target.result.os.tag == .linux) "-lpthread -lm" else "";
    const metadata = b.addWriteFiles();
    const core_pc = metadata.add("libo11y.pc", pkgConfig(b, .{
        .name = "libo11y",
        .description = "OpenTelemetry traces, metrics and logs for C11",
        .version = version_text,
        .lib = "o11y",
        .system_libs = system_libs,
        // A shared libo11y brings its own dependencies. A static link needs them.
        .static_only_system_libs = true,
    }));
    const test_pc = metadata.add("libo11ytest.pc", pkgConfig(b, .{
        .name = "libo11ytest",
        .description = "libo11y test harness and in-process OTLP receivers for C11",
        .version = version_text,
        .lib = "o11ytest",
        .system_libs = system_libs,
        .static_only_system_libs = false,
    }));
    const cmake_version = metadata.add("libo11yConfigVersion.cmake", b.fmt(
        \\# Version file for find_package(libo11y). Before 1.0 a minor release may
        \\# change the API, so a request matches only the same major and minor.
        \\set(PACKAGE_VERSION "{s}")
        \\if("${{PACKAGE_FIND_VERSION}}" STREQUAL "")
        \\    set(PACKAGE_VERSION_COMPATIBLE TRUE)
        \\elseif(PACKAGE_VERSION VERSION_LESS PACKAGE_FIND_VERSION)
        \\    set(PACKAGE_VERSION_COMPATIBLE FALSE)
        \\elseif("${{PACKAGE_FIND_VERSION_MAJOR}}" STREQUAL "{d}" AND "${{PACKAGE_FIND_VERSION_MINOR}}" STREQUAL "{d}")
        \\    set(PACKAGE_VERSION_COMPATIBLE TRUE)
        \\    if(PACKAGE_FIND_VERSION VERSION_EQUAL PACKAGE_VERSION)
        \\        set(PACKAGE_VERSION_EXACT TRUE)
        \\    endif()
        \\else()
        \\    set(PACKAGE_VERSION_COMPATIBLE FALSE)
        \\endif()
        \\
    , .{ version_text, version.major, version.minor }));
    b.getInstallStep().dependOn(&b.addInstallFile(core_pc, "lib/pkgconfig/libo11y.pc").step);
    b.getInstallStep().dependOn(&b.addInstallFile(test_pc, "lib/pkgconfig/libo11ytest.pc").step);
    b.getInstallStep().dependOn(&b.addInstallFile(cmake_version, "lib/cmake/libo11y/libo11yConfigVersion.cmake").step);
    b.installFile("cmake/libo11yConfig.cmake", "lib/cmake/libo11y/libo11yConfig.cmake");

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
    const test_step = b.step("test", "Build and run all C11 tests (unit, conformance, wire, example, ABI layout)");
    test_step.dependOn(&b.addRunArtifact(example_exe).step);

    // ABI layout test: translate the public headers and compare every struct
    // and enum with its hand-written mirror in src/c_types.zig.
    const headers = b.addTranslateC(.{
        .root_source_file = b.path("include/o11y/test.h"),
        .target = target,
        .optimize = optimize,
    });
    headers.addIncludePath(b.path("include"));
    const layout_mod = b.createModule(.{
        .root_source_file = b.path("src/abi_layout_test.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .imports = &.{
            .{ .name = "o11y_h", .module = headers.createModule() },
            .{ .name = "c_build_options", .module = build_options_mod },
        },
    });
    const layout_tests = b.addTest(.{ .name = "abi-layout", .root_module = layout_mod });
    test_step.dependOn(&b.addRunArtifact(layout_tests).step);

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

const PkgConfig = struct {
    name: []const u8,
    description: []const u8,
    version: []const u8,
    lib: []const u8,
    system_libs: []const u8,
    static_only_system_libs: bool,
};

/// Renders a pkg-config file. `prefix` is relative to the file itself, so an
/// install tree works wherever it is unpacked.
fn pkgConfig(b: *std.Build, pc: PkgConfig) []const u8 {
    return b.fmt(
        \\prefix=${{pcfiledir}}/../..
        \\exec_prefix=${{prefix}}
        \\libdir=${{exec_prefix}}/lib
        \\includedir=${{prefix}}/include
        \\
        \\Name: {s}
        \\Description: {s}
        \\Version: {s}
        \\URL: https://github.com/jamesainslie/libo11y
        \\Libs: -L${{libdir}} -l{s}{s}
        \\Cflags: -I${{includedir}}
        \\
    , .{
        pc.name,
        pc.description,
        pc.version,
        pc.lib,
        if (pc.system_libs.len == 0)
            ""
        else if (pc.static_only_system_libs)
            b.fmt("\nLibs.private: {s}", .{pc.system_libs})
        else
            b.fmt(" {s}", .{pc.system_libs}),
    });
}
