//! `libo11y` CLI for C consumers: `libo11y registry check FILE...`,
//! matching Go's `go/cmd/libo11y` and TypeScript's `@libo11y/spec` bin
//! output format and exit codes (0 = valid, 1 = policy violations,
//! 2 = usage / read / parse error).

const std = @import("std");
const Io = std.Io;
const o11y = @import("o11y");

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.gpa;
    const io = init.io;

    var stdout_buf: [4096]u8 = undefined;
    var stderr_buf: [4096]u8 = undefined;
    var stdout_w = Io.File.stdout().writerStreaming(io, &stdout_buf);
    var stderr_w = Io.File.stderr().writerStreaming(io, &stderr_buf);
    defer {
        stdout_w.interface.flush() catch {};
        stderr_w.interface.flush() catch {};
    }

    var args_it = try init.minimal.args.iterateAllocator(gpa);
    defer args_it.deinit();

    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    while (args_it.next()) |a| {
        try args.append(gpa, a);
    }

    if (args.items.len < 4 or
        !std.mem.eql(u8, args.items[1], "registry") or
        !std.mem.eql(u8, args.items[2], "check"))
    {
        stderr_w.interface.writeAll("usage: libo11y registry check FILE...\n") catch {};
        return 2;
    }

    var status: u8 = 0;
    for (args.items[3..]) |path| {
        const raw = Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(4 * 1024 * 1024)) catch |err| {
            stderr_w.interface.print("{s}: reading application registry: {s}\n", .{ path, @errorName(err) }) catch {};
            status = @max(status, 2);
            continue;
        };
        defer gpa.free(raw);

        var res = try o11y.appregistry.check(gpa, raw, .{});
        defer res.deinit();

        switch (res.outcome) {
            .valid => |reg| {
                const word: []const u8 = if (reg.attributes.len == 1) "attribute" else "attributes";
                stdout_w.interface.print("{s}: ok ({d} {s} in namespace {s})\n", .{
                    path,
                    reg.attributes.len,
                    word,
                    reg.namespace,
                }) catch {};
            },
            .invalid => |vs| {
                for (vs) |v| {
                    if (v.attribute.len == 0) {
                        stderr_w.interface.print("{s}: {s}: {s}\n", .{ path, v.rule_id, v.detail }) catch {};
                    } else {
                        stderr_w.interface.print("{s}: {s}: attribute {s}: {s}\n", .{ path, v.rule_id, v.attribute, v.detail }) catch {};
                    }
                }
                status = @max(status, 1);
            },
            .parse_error => |e| {
                stderr_w.interface.print("{s}: parsing application registry: {s}\n", .{ path, e.message }) catch {};
                status = @max(status, 2);
            },
        }
    }

    return status;
}
