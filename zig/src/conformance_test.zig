//! The cross-language conformance suite: every case and vector in the
//! repository's conformance/ directory, read at run time from the directory
//! the build passes in (-Dconformance-dir, by default the repository's).
//! The published package holds neither this suite's data nor a path to it.

const std = @import("std");
const conformance = @import("conformance");
const appregistry = @import("appregistry/appregistry.zig");
const identity = @import("identity.zig");
const endpoint = @import("endpoint.zig");
const pii = @import("pii.zig");

const testing = std.testing;
const Io = std.Io;

const max_file = 16 * 1024 * 1024;

fn openSubdir(sub: []const u8, iterate: bool) !Io.Dir {
    var root = Io.Dir.cwd().openDir(testing.io, conformance.dir, .{}) catch |err| {
        std.debug.print("conformance directory {s}: {t}\n", .{ conformance.dir, err });
        return err;
    };
    defer root.close(testing.io);
    return root.openDir(testing.io, sub, .{ .iterate = iterate });
}

fn readFile(dir: Io.Dir, gpa: std.mem.Allocator, name: []const u8) ![]u8 {
    return dir.readFileAlloc(testing.io, name, gpa, .limited(max_file));
}

fn lessThan(_: void, a: []const u8, b: []const u8) bool {
    return std.mem.lessThan(u8, a, b);
}

/// The names in dir that end in suffix, without it, sorted.
fn listCases(arena: std.mem.Allocator, dir: Io.Dir, suffix: []const u8) ![]const []const u8 {
    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (try it.next(testing.io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, suffix)) continue;
        try names.append(arena, try arena.dupe(u8, entry.name[0 .. entry.name.len - suffix.len]));
    }
    std.mem.sort([]const u8, names.items, {}, lessThan);
    return names.items;
}

test "every application registry case" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var dir = try openSubdir("appregistry", true);
    defer dir.close(testing.io);
    const cases = try listCases(arena, dir, ".yaml");
    try testing.expect(cases.len >= 20);

    var failures: usize = 0;
    for (cases) |name| {
        const raw = try readFile(dir, arena, try std.fmt.allocPrint(arena, "{s}.yaml", .{name}));
        const want_file = try readFile(dir, arena, try std.fmt.allocPrint(arena, "{s}.want", .{name}));
        const want = std.mem.trimEnd(u8, want_file, "\n");
        var result = try appregistry.check(testing.allocator, raw, .{});
        defer result.deinit();
        var got: Io.Writer.Allocating = .init(arena);
        try result.writeWant(&got.writer);
        if (!std.mem.eql(u8, got.written(), want)) {
            failures += 1;
            std.debug.print("{s}:\n got: {s}\nwant: {s}\n", .{ name, got.written(), want });
        }
    }
    try testing.expectEqual(@as(usize, 0), failures);
}

test "every .want file has its .yaml case" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var dir = try openSubdir("appregistry", true);
    defer dir.close(testing.io);
    for (try listCases(arena, dir, ".want")) |name| {
        dir.access(testing.io, try std.fmt.allocPrint(arena, "{s}.yaml", .{name}), .{}) catch |err| {
            std.debug.print("{s}.want has no matching .yaml case\n", .{name});
            return err;
        };
    }
}

fn readVectors(arena: std.mem.Allocator, name: []const u8) ![]u8 {
    var dir = try openSubdir("vectors", false);
    defer dir.close(testing.io);
    return readFile(dir, arena, name);
}

test "the service.instance.id vectors" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const Case = struct {
        name: []const u8,
        k8s_pod_uid: []const u8,
        k8s_pod_name: []const u8,
        k8s_namespace_name: []const u8,
        want: []const u8,
    };
    const cases = try std.json.parseFromSliceLeaky([]const Case, arena, try readVectors(arena, "instance-id.json"), .{});
    try testing.expect(cases.len > 0);
    for (cases) |c| {
        var buf: [identity.uuid_text_len]u8 = undefined;
        const got = identity.instanceId(&buf, c.k8s_pod_uid, c.k8s_pod_name, c.k8s_namespace_name) orelse {
            std.debug.print("{s}: no instance id\n", .{c.name});
            return error.TestUnexpectedResult;
        };
        testing.expectEqualStrings(c.want, got) catch |err| {
            std.debug.print("case {s}\n", .{c.name});
            return err;
        };
    }
}

test "the endpoint sanitizing vectors" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const Case = struct { in: []const u8, want: []const u8 };
    const cases = try std.json.parseFromSliceLeaky([]const Case, arena, try readVectors(arena, "endpoint-sanitize.json"), .{});
    try testing.expect(cases.len > 0);
    for (cases) |c| {
        const got = try endpoint.sanitize(testing.allocator, c.in);
        defer testing.allocator.free(got);
        testing.expectEqualStrings(c.want, got) catch |err| {
            std.debug.print("input {s}\n", .{c.in});
            return err;
        };
    }
}

/// A JSON value as the attribute value Go's vector generator gave, by its
/// JSON type: an integer is an int and any other number a float.
fn fromJson(arena: std.mem.Allocator, v: std.json.Value) !pii.Value {
    return switch (v) {
        .string => |s| .{ .string = s },
        .integer => |i| .{ .int = i },
        .float => |f| .{ .float = f },
        .bool => |b| .{ .bool = b },
        .array => |a| a: {
            const items = try arena.alloc(pii.Value, a.items.len);
            for (a.items, items) |item, *out| out.* = try fromJson(arena, item);
            break :a .{ .array = items };
        },
        .object => |o| o: {
            const members = try arena.alloc(pii.Member, o.count());
            var it = o.iterator();
            var i: usize = 0;
            while (it.next()) |e| : (i += 1) {
                members[i] = .{ .key = e.key_ptr.*, .value = try fromJson(arena, e.value_ptr.*) };
            }
            break :o .{ .map = members };
        },
        .null, .number_string => error.UnsupportedVector,
    };
}

/// A vector's input value, read by the case's kind.
fn vectorValue(arena: std.mem.Allocator, kind: []const u8, v: std.json.Value) !pii.Value {
    if (std.mem.eql(u8, kind, "float")) {
        return switch (v) {
            .float => |f| .{ .float = f },
            .integer => |i| .{ .float = @floatFromInt(i) },
            else => error.UnsupportedVector,
        };
    }
    if (std.mem.eql(u8, kind, "float_array")) {
        const items = try arena.alloc(pii.Value, v.array.items.len);
        for (v.array.items, items) |item, *out| out.* = try vectorValue(arena, "float", item);
        return .{ .array = items };
    }
    if (std.mem.eql(u8, kind, "bytes")) {
        const decoder = std.base64.standard.Decoder;
        const out = try arena.alloc(u8, try decoder.calcSizeForSlice(v.string));
        try decoder.decode(out, v.string);
        return .{ .bytes = out };
    }
    return fromJson(arena, v);
}

test "the PII token vectors" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const Case = struct {
        name: []const u8,
        kind: []const u8,
        value: std.json.Value,
        canonical: []const u8,
        token: []const u8,
    };
    const Vectors = struct { key_hex: []const u8, cases: []const Case };
    const vectors = try std.json.parseFromSliceLeaky(Vectors, arena, try readVectors(arena, "pii-hash.json"), .{});
    var key: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&key, vectors.key_hex);
    try testing.expect(vectors.cases.len > 0);
    for (vectors.cases) |c| {
        const value = try vectorValue(arena, c.kind, c.value);
        const canonical = try pii.canonical(testing.allocator, value);
        defer testing.allocator.free(canonical);
        testing.expectEqualStrings(c.canonical, canonical) catch |err| {
            std.debug.print("case {s}\n", .{c.name});
            return err;
        };
        var buf: [pii.token_len]u8 = undefined;
        testing.expectEqualStrings(c.token, pii.token(&buf, &key, canonical)) catch |err| {
            std.debug.print("case {s}\n", .{c.name});
            return err;
        };
    }
}
