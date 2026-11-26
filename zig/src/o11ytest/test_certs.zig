//! Self-signed test TLS certificate fixtures for loopback TLS and mTLS tests.
//!
//! These certificates are strictly for local loopback testing (localhost /
//! 127.0.0.1) and are never used in production.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;

/// The CA that signs `server` and `client`.
pub const ca = @embedFile("certs/ca.pem");
/// An unrelated CA, for wrong-CA negative tests.
pub const other_ca = @embedFile("certs/other-ca.pem");
/// The server certificate (valid for localhost and 127.0.0.1).
pub const server = @embedFile("certs/server.pem");
/// The server private key.
pub const server_key = @embedFile("certs/server-key.pem");
/// The client certificate signed by `ca`.
pub const client = @embedFile("certs/client.pem");
/// The client private key.
pub const client_key = @embedFile("certs/client-key.pem");

/// File names written by `writeAll`.
pub const names = [_][]const u8{
    "ca.pem",
    "other-ca.pem",
    "server.pem",
    "server-key.pem",
    "client.pem",
    "client-key.pem",
};

const contents = [_][]const u8{
    ca,
    other_ca,
    server,
    server_key,
    client,
    client_key,
};

/// Writes every PEM fixture into `dir`.
pub fn writeAll(io: Io, dir: Io.Dir) !void {
    for (names, contents) |name, data| {
        try dir.writeFile(io, .{ .sub_path = name, .data = data });
    }
}

/// Returns the cwd-relative path of `name` inside a `std.testing.TmpDir`.
pub fn path(gpa: Allocator, tmp: *const std.testing.TmpDir, name: []const u8) Allocator.Error![]u8 {
    return std.fmt.allocPrint(gpa, ".zig-cache/tmp/{s}/{s}", .{ tmp.sub_path, name });
}
