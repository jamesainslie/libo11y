//! gRPC 5-byte length-prefixed message framing (plain and gzip).

const std = @import("std");
const Allocator = std.mem.Allocator;
const http = @import("http.zig");

/// Request/response body compression.
pub const Compression = enum { none, gzip };

/// Errors from gRPC 5-byte message framing/unframing.
pub const FrameError = error{
    InvalidFrame,
    ResponseTooLarge,
    UnsupportedEncoding,
    OutOfMemory,
};

/// Wraps `payload` in a 5-byte gRPC length-prefixed message frame, gzip-
/// compressing it first when `compression == .gzip`.
pub fn frameEncode(gpa: Allocator, payload: []const u8, compression: Compression) error{ OutOfMemory, PayloadTooLarge }![]u8 {
    const body: []const u8, const owned_zip: ?[]u8 = if (compression == .gzip) blk: {
        const z = try http.gzip(gpa, payload);
        break :blk .{ z, z };
    } else .{ payload, null };
    defer if (owned_zip) |z| gpa.free(z);

    if (body.len > std.math.maxInt(u32)) return error.PayloadTooLarge;
    const out = try gpa.alloc(u8, 5 + body.len);
    out[0] = if (compression == .gzip) 1 else 0;
    std.mem.writeInt(u32, out[1..5], @intCast(body.len), .big);
    @memcpy(out[5..], body);
    return out;
}

/// Decodes a single unary gRPC length-prefixed message from `raw`, gunzipping
/// when the compressed flag is 1 and enforcing `max_size`.
pub fn frameDecode(gpa: Allocator, raw: []const u8, encoding: ?[]const u8, max_size: usize) FrameError![]u8 {
    if (raw.len == 0) return try gpa.alloc(u8, 0);
    if (raw.len < 5) return error.InvalidFrame;
    const compressed = raw[0];
    if (compressed != 0 and compressed != 1) return error.InvalidFrame;
    const msg_len: usize = std.mem.readInt(u32, raw[1..5], .big);
    if (msg_len != raw.len - 5) return error.InvalidFrame;
    const msg = raw[5..];

    if (compressed == 0) {
        if (msg.len > max_size) return error.ResponseTooLarge;
        return try gpa.dupe(u8, msg);
    }

    const enc = encoding orelse return error.UnsupportedEncoding;
    if (!std.ascii.eqlIgnoreCase(enc, "gzip")) return error.UnsupportedEncoding;
    return http.gunzip(gpa, msg, max_size) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.InvalidData => error.InvalidFrame,
    };
}
