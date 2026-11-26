//! Build-time binary identity (`service.version`, `vcs.ref.head.revision`,
//! `o11y.build.time`, `o11y.build.modified`).
//!
//! Applications wire this in `build.zig` via `libo11y.addBuildInfo(b, exe, .{})`
//! and pass `o11y.buildInfo(@import("o11y_build_info"))` in `Options.build_info`,
//! or publish `pub const o11y_build_info = @import("o11y_build_info");` on
//! their root module. Applications that omit it still build and run cleanly.

const std = @import("std");
const attribute = @import("pipeline/attribute.zig");
const spec = @import("spec.zig");

/// Build metadata recorded at compile time.
pub const BuildInfo = struct {
    version: []const u8 = "",
    revision: []const u8 = "",
    time: []const u8 = "",
    modified: ?bool = null,

    pub const empty: BuildInfo = .{};

    /// Converts an `o11y_build_info` options module produced by
    /// `libo11y.addBuildInfo` into a `BuildInfo` value.
    pub fn fromModule(comptime mod: type) BuildInfo {
        return .{
            .version = if (@hasDecl(mod, "version")) mod.version else "",
            .revision = if (@hasDecl(mod, "revision")) mod.revision else "",
            .time = if (@hasDecl(mod, "time")) mod.time else "",
            .modified = if (@hasDecl(mod, "modified")) mod.modified else null,
        };
    }

    /// Reads `pub const o11y_build_info` from the root module when present,
    /// returning `.empty` otherwise.
    pub fn fromRoot() BuildInfo {
        const root = @import("root");
        if (@hasDecl(root, "o11y_build_info")) {
            const decl = root.o11y_build_info;
            if (@TypeOf(decl) == type) return fromModule(decl);
            if (@TypeOf(decl) == BuildInfo) return decl;
        }
        return .empty;
    }

    /// Appends non-empty build info resource attributes to `out`, copying
    /// string slices into `arena` and skipping empty strings and Go's
    /// `(devel)` sentinel for `service.version`.
    pub fn appendAttributes(info: BuildInfo, arena: std.mem.Allocator, out: *std.ArrayList(attribute.KeyValue)) std.mem.Allocator.Error!void {
        if (info.version.len > 0 and !std.mem.eql(u8, info.version, "(devel)")) {
            try out.append(arena, attribute.kv("service.version", try arena.dupe(u8, info.version)));
        }
        if (info.revision.len > 0) {
            try out.append(arena, attribute.kv(spec.attr.vcs_ref_head_revision, try arena.dupe(u8, info.revision)));
        }
        if (info.time.len > 0) {
            try out.append(arena, attribute.kv(spec.attr.build_time, try arena.dupe(u8, info.time)));
        }
        if (info.modified) |m| {
            try out.append(arena, attribute.kv(spec.attr.build_modified, m));
        }
    }
};

const testing = std.testing;

test "BuildInfo appends non-empty attributes, dupes into arena, and skips (devel)" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    var list: std.ArrayList(attribute.KeyValue) = .empty;

    const rev_buf = try testing.allocator.dupe(u8, "abc1234");
    const time_buf = try testing.allocator.dupe(u8, "2026-11-26T12:00:00Z");
    const info: BuildInfo = .{
        .version = "(devel)",
        .revision = rev_buf,
        .time = time_buf,
        .modified = true,
    };
    try info.appendAttributes(arena, &list);
    // Mutate and free caller-owned buffers immediately to verify copies live in arena.
    @memset(rev_buf, 'X');
    @memset(time_buf, 'Y');
    testing.allocator.free(rev_buf);
    testing.allocator.free(time_buf);

    try testing.expectEqual(@as(usize, 3), list.items.len);
    try testing.expectEqual(null, attribute.find(list.items, "service.version"));
    try testing.expectEqualStrings("abc1234", attribute.find(list.items, spec.attr.vcs_ref_head_revision).?.string);
    try testing.expectEqualStrings("2026-11-26T12:00:00Z", attribute.find(list.items, spec.attr.build_time).?.string);
    try testing.expectEqual(true, attribute.find(list.items, spec.attr.build_modified).?.bool);

    list.clearRetainingCapacity();
    const ver_buf = try testing.allocator.dupe(u8, "1.2.3");
    const release: BuildInfo = .{ .version = ver_buf };
    try release.appendAttributes(arena, &list);
    @memset(ver_buf, 'Z');
    testing.allocator.free(ver_buf);
    try testing.expectEqual(@as(usize, 1), list.items.len);
    try testing.expectEqualStrings("1.2.3", attribute.find(list.items, "service.version").?.string);
}

test "BuildInfo.fromModule reads options module fields" {
    const FakeMod = struct {
        pub const version: []const u8 = "2.0.0";
        pub const revision: []const u8 = "deadbeef";
        pub const time: []const u8 = "2026-01-01T00:00:00Z";
        pub const modified: ?bool = false;
    };
    const info = BuildInfo.fromModule(FakeMod);
    try testing.expectEqualStrings("2.0.0", info.version);
    try testing.expectEqualStrings("deadbeef", info.revision);
    try testing.expectEqualStrings("2026-01-01T00:00:00Z", info.time);
    try testing.expectEqual(@as(?bool, false), info.modified);
}
