//! service.instance.id from Kubernetes pod identity, as Go's instanceIDFor
//! derives it (go/resource.go): a UUIDv5 of the pod UID, else a UUIDv5 of
//! "<namespace>/<pod name>", else a random UUIDv4. Every libo11y
//! implementation derives the same ID from the same identity
//! (conformance/vectors/instance-id.json).

const std = @import("std");

/// The semconv-sanctioned UUIDv5 namespace for service.instance.id,
/// 4d63009a-8d0f-11ee-aad7-4c796ed8e320.
pub const instance_id_namespace: [16]u8 = .{
    0x4d, 0x63, 0x00, 0x9a, 0x8d, 0x0f, 0x11, 0xee,
    0xaa, 0xd7, 0x4c, 0x79, 0x6e, 0xd8, 0xe3, 0x20,
};

/// The length of a UUID in its hyphenated text form.
pub const uuid_text_len = 36;

/// Writes the service.instance.id derived from pod identity into buf and
/// returns it, lowercase and hyphenated. The pod UID wins when it is not
/// empty. Otherwise a pod name gives the UUIDv5 of "<namespace>/<pod name>",
/// so a pod name without a namespace hashes "/<pod name>". With neither, there
/// is no pod identity and the result is null: the caller then uses a random
/// UUIDv4, for example from randomV4.
pub fn instanceId(buf: *[uuid_text_len]u8, pod_uid: []const u8, pod_name: []const u8, namespace: []const u8) ?[]const u8 {
    if (pod_uid.len != 0) return uuidV5(buf, instance_id_namespace, &.{pod_uid});
    if (pod_name.len != 0) return uuidV5(buf, instance_id_namespace, &.{ namespace, "/", pod_name });
    return null;
}

/// Writes the RFC 9562 version 5 UUID of a name under namespace into buf and
/// returns it. The name is the concatenation of name_parts, so a composite
/// name needs no allocation.
pub fn uuidV5(buf: *[uuid_text_len]u8, namespace: [16]u8, name_parts: []const []const u8) []const u8 {
    var sha1 = std.crypto.hash.Sha1.init(.{});
    sha1.update(&namespace);
    for (name_parts) |part| sha1.update(part);
    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    sha1.final(&digest);
    var bytes: [16]u8 = digest[0..16].*;
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return format(buf, bytes);
}

/// Writes a random RFC 9562 version 4 UUID drawn from random into buf and
/// returns it.
pub fn randomV4(buf: *[uuid_text_len]u8, random: std.Random) []const u8 {
    var bytes: [16]u8 = undefined;
    random.bytes(&bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return format(buf, bytes);
}

/// Formats 16 UUID bytes as lowercase hyphenated text, 8-4-4-4-12.
fn format(buf: *[uuid_text_len]u8, bytes: [16]u8) []const u8 {
    const hex = "0123456789abcdef";
    var out: usize = 0;
    for (bytes, 0..) |b, i| {
        if (i == 4 or i == 6 or i == 8 or i == 10) {
            buf[out] = '-';
            out += 1;
        }
        buf[out] = hex[b >> 4];
        buf[out + 1] = hex[b & 0x0f];
        out += 2;
    }
    return buf[0..out];
}

const testing = std.testing;

test "instanceId matches every case of conformance/vectors/instance-id.json" {
    const cases = [_]struct { name: []const u8, pod_uid: []const u8, pod_name: []const u8, namespace: []const u8, want: []const u8 }{
        .{ .name = "pod uid", .pod_uid = "0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42", .pod_name = "", .namespace = "", .want = "fceeac15-05b1-5132-b02a-910f70fb6aac" },
        .{ .name = "pod uid wins over the name", .pod_uid = "0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42", .pod_name = "lor-portal-0", .namespace = "lor-portal", .want = "fceeac15-05b1-5132-b02a-910f70fb6aac" },
        .{ .name = "namespace and pod name", .pod_uid = "", .pod_name = "lor-site-7d9f8-abcde", .namespace = "lor-site", .want = "620f09d7-0486-5b08-8412-83628da94a0f" },
        .{ .name = "pod name without a namespace", .pod_uid = "", .pod_name = "lor-site-7d9f8-abcde", .namespace = "", .want = "64d2bcdf-3549-5e2e-b0ff-ab2d444fb136" },
    };
    for (cases) |c| {
        var buf: [uuid_text_len]u8 = undefined;
        const got = instanceId(&buf, c.pod_uid, c.pod_name, c.namespace) orelse return error.TestUnexpectedResult;
        testing.expectEqualStrings(c.want, got) catch |err| {
            std.debug.print("case {s}\n", .{c.name});
            return err;
        };
    }
}

test "instanceId is null without pod identity, even with a namespace" {
    var buf: [uuid_text_len]u8 = undefined;
    try testing.expectEqual(null, instanceId(&buf, "", "", ""));
    try testing.expectEqual(null, instanceId(&buf, "", "", "lor-site"));
}

test "a pod name without a namespace hashes the name with a leading slash" {
    var a: [uuid_text_len]u8 = undefined;
    var b: [uuid_text_len]u8 = undefined;
    const got = instanceId(&a, "", "lor-site-7d9f8-abcde", "").?;
    try testing.expectEqualStrings(uuidV5(&b, instance_id_namespace, &.{"/lor-site-7d9f8-abcde"}), got);
}

test "uuidV5 matches the RFC 9562 example for the DNS namespace" {
    // RFC 9562 appendix A.4: www.example.com under the DNS namespace.
    const dns: [16]u8 = .{ 0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8 };
    var buf: [uuid_text_len]u8 = undefined;
    try testing.expectEqualStrings("2ed6657d-e927-568b-95e1-2665a8aea6a2", uuidV5(&buf, dns, &.{"www.example.com"}));
}

test "randomV4 sets the version and variant" {
    var prng: std.Random.DefaultPrng = .init(1);
    for (0..64) |_| {
        var buf: [uuid_text_len]u8 = undefined;
        const id = randomV4(&buf, prng.random());
        try testing.expectEqual(uuid_text_len, id.len);
        try testing.expectEqual('4', id[14]);
        try testing.expect(std.mem.indexOfScalar(u8, "89ab", id[19]) != null);
        for (id, 0..) |c, i| {
            if (i == 8 or i == 13 or i == 18 or i == 23) {
                try testing.expectEqual('-', c);
            } else {
                try testing.expect(std.ascii.isDigit(c) or (c >= 'a' and c <= 'f'));
            }
        }
    }
}
