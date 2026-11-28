//! `libo11y` CLI for C consumers: `libo11y registry check FILE...`,
//! matching Go's `go/cmd/libo11y` and TypeScript's `@libo11y/spec` bin
//! output format and exit codes (0 = valid, 1 = policy violations,
//! 2 = usage / read / parse error).

const std = @import("std");
const Io = std.Io;
const o11y = @import("o11y");

const usage = "usage: libo11y registry check FILE...\n";

pub fn main(init: std.process.Init) u8 {
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

    var args_it = init.minimal.args.iterateAllocator(gpa) catch |err| {
        stderr_w.interface.print("libo11y: {s}\n", .{@errorName(err)}) catch {};
        return 2;
    };
    defer args_it.deinit();

    var args: std.ArrayList([]const u8) = .empty;
    defer args.deinit(gpa);
    while (args_it.next()) |a| {
        args.append(gpa, a) catch |err| {
            stderr_w.interface.print("libo11y: {s}\n", .{@errorName(err)}) catch {};
            return 2;
        };
    }

    const cli_args = if (args.items.len > 1) args.items[1..] else &[_][]const u8{};
    if (cli_args.len == 1 and
        (std.mem.eql(u8, cli_args[0], "-h") or
            std.mem.eql(u8, cli_args[0], "--help") or
            std.mem.eql(u8, cli_args[0], "help")))
    {
        stdout_w.interface.writeAll(usage) catch {};
        return 0;
    }

    if (cli_args.len < 3 or
        !std.mem.eql(u8, cli_args[0], "registry") or
        !std.mem.eql(u8, cli_args[1], "check"))
    {
        stderr_w.interface.writeAll(usage) catch {};
        return 2;
    }

    var status: u8 = 0;
    for (cli_args[2..]) |path| {
        const raw = Io.Dir.cwd().readFileAlloc(io, path, gpa, .unlimited) catch |err| {
            writeReadError(&stderr_w.interface, path, err);
            status = @max(status, 2);
            continue;
        };
        defer gpa.free(raw);

        var res = o11y.appregistry.check(gpa, raw, .{}) catch |err| {
            stderr_w.interface.print("{s}: {s}\n", .{ path, @errorName(err) }) catch {};
            status = @max(status, 2);
            continue;
        };
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
                        stdout_w.interface.print("{s}: {s}: {s}\n", .{ path, v.rule_id, v.detail }) catch {};
                    } else {
                        stdout_w.interface.print("{s}: {s}: attribute {s}: {s}\n", .{ path, v.rule_id, v.attribute, v.detail }) catch {};
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

fn writeReadError(w: *Io.Writer, path: []const u8, err: anyerror) void {
    switch (err) {
        error.FileNotFound => w.print("open {s}: no such file or directory\n", .{path}) catch {},
        error.AccessDenied => w.print("open {s}: permission denied\n", .{path}) catch {},
        error.IsDir => w.print("read {s}: is a directory\n", .{path}) catch {},
        else => w.print("open {s}: {s}\n", .{ path, @errorName(err) }) catch {},
    }
}
