//! Unit tests and fuzz target for HPACK (RFC 7541).

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const hpack = @import("hpack.zig");

fn fromHex(comptime hex: []const u8) [hex.len / 2]u8 {
    return comptime blk: {
        var out: [hex.len / 2]u8 = undefined;
        for (0..out.len) |i| {
            const hi = hexDigit(hex[i * 2]);
            const lo = hexDigit(hex[i * 2 + 1]);
            out[i] = (hi << 4) | lo;
        }
        break :blk out;
    };
}

fn hexDigit(comptime ch: u8) u8 {
    return switch (ch) {
        '0'...'9' => ch - '0',
        'a'...'f' => ch - 'a' + 10,
        'A'...'F' => ch - 'A' + 10,
        else => @compileError("invalid hex digit"),
    };
}

fn expectHeaders(got: []const hpack.Header, want: []const hpack.Header) !void {
    try testing.expectEqual(want.len, got.len);
    for (want, got) |w, g| {
        try testing.expectEqualStrings(w.name, g.name);
        try testing.expectEqualStrings(w.value, g.value);
    }
}

test "RFC 7541 Appendix C.1 integer encoding and decoding" {
    // C.1.1: 10 with 5-bit prefix -> 0x0a
    {
        var buf: [16]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        try hpack.encodeInt(&w, 0x00, 5, 10);
        try testing.expectEqualSlices(u8, &.{0x0a}, w.buffered());
        var pos: usize = 0;
        try testing.expectEqual(@as(u64, 10), try hpack.decodeInt(w.buffered(), &pos, 5));
        try testing.expectEqual(@as(usize, 1), pos);
    }
    // C.1.2: 1337 with 5-bit prefix -> 1f 9a 0a
    {
        var buf: [16]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        try hpack.encodeInt(&w, 0x00, 5, 1337);
        try testing.expectEqualSlices(u8, &.{ 0x1f, 0x9a, 0x0a }, w.buffered());
        var pos: usize = 0;
        try testing.expectEqual(@as(u64, 1337), try hpack.decodeInt(w.buffered(), &pos, 5));
        try testing.expectEqual(@as(usize, 3), pos);
    }
    // C.1.3: 42 with 8-bit prefix -> 0x2a
    {
        var buf: [16]u8 = undefined;
        var w: Io.Writer = .fixed(&buf);
        try hpack.encodeInt(&w, 0x00, 8, 42);
        try testing.expectEqualSlices(u8, &.{0x2a}, w.buffered());
        var pos: usize = 0;
        try testing.expectEqual(@as(u64, 42), try hpack.decodeInt(w.buffered(), &pos, 8));
    }
    // Integer overflow and truncation
    {
        const overflow = [_]u8{ 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02 };
        var pos: usize = 0;
        try testing.expectError(error.IntegerOverflow, hpack.decodeInt(&overflow, &pos, 5));
    }
    {
        const trunc = [_]u8{ 0x1f, 0x80 };
        var pos: usize = 0;
        try testing.expectError(error.Truncated, hpack.decodeInt(&trunc, &pos, 5));
    }
}

test "RFC 7541 Appendix C.2 literal header field examples" {
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 65536);
    defer dec.deinit();

    // C.2.1: Literal Header Field with Indexing
    const c21 = fromHex("400a637573746f6d2d6b65790d637573746f6d2d686561646572");
    const h21 = try dec.decode(&c21, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h21);
    try expectHeaders(h21, &.{.{ .name = "custom-key", .value = "custom-header" }});
    try testing.expectEqual(@as(usize, 1), dec.dynamicCount());
    try testing.expectEqual(@as(usize, 55), dec.dynamicSize());

    // C.2.2: Literal Header Field without Indexing
    const c22 = fromHex("040c2f73616d706c652f70617468");
    const h22 = try dec.decode(&c22, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h22);
    try expectHeaders(h22, &.{.{ .name = ":path", .value = "/sample/path" }});
    try testing.expectEqual(@as(usize, 1), dec.dynamicCount());

    // C.2.3: Literal Header Field Never Indexed
    const c23 = fromHex("100870617373776f726406736563726574");
    const h23 = try dec.decode(&c23, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h23);
    try expectHeaders(h23, &.{.{ .name = "password", .value = "secret" }});
    try testing.expectEqual(@as(usize, 1), dec.dynamicCount());

    // C.2.4: Indexed Header Field
    const c24 = fromHex("82");
    const h24 = try dec.decode(&c24, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h24);
    try expectHeaders(h24, &.{.{ .name = ":method", .value = "GET" }});
}

test "RFC 7541 Appendix C.3 request examples without Huffman" {
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 65536);
    defer dec.deinit();

    // C.3.1 First Request
    const r1 = fromHex("828684410f7777772e6578616d706c652e636f6d");
    const h1 = try dec.decode(&r1, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h1);
    try expectHeaders(h1, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = "/" },
        .{ .name = ":authority", .value = "www.example.com" },
    });
    try testing.expectEqual(@as(usize, 57), dec.dynamicSize());

    // C.3.2 Second Request
    const r2 = fromHex("828684be58086e6f2d6361636865");
    const h2 = try dec.decode(&r2, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h2);
    try expectHeaders(h2, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = "/" },
        .{ .name = ":authority", .value = "www.example.com" },
        .{ .name = "cache-control", .value = "no-cache" },
    });
    try testing.expectEqual(@as(usize, 110), dec.dynamicSize());

    // C.3.3 Third Request
    const r3 = fromHex("828785bf400a637573746f6d2d6b65790c637573746f6d2d76616c7565");
    const h3 = try dec.decode(&r3, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h3);
    try expectHeaders(h3, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":path", .value = "/index.html" },
        .{ .name = ":authority", .value = "www.example.com" },
        .{ .name = "custom-key", .value = "custom-value" },
    });
    try testing.expectEqual(@as(usize, 164), dec.dynamicSize());
}

test "RFC 7541 Appendix C.4 request examples with Huffman" {
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 65536);
    defer dec.deinit();

    // C.4.1 First Request
    const r1 = fromHex("828684418cf1e3c2e5f23a6ba0ab90f4ff");
    const h1 = try dec.decode(&r1, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h1);
    try expectHeaders(h1, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = "/" },
        .{ .name = ":authority", .value = "www.example.com" },
    });

    // C.4.2 Second Request
    const r2 = fromHex("828684be5886a8eb10649cbf");
    const h2 = try dec.decode(&r2, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h2);
    try expectHeaders(h2, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = "/" },
        .{ .name = ":authority", .value = "www.example.com" },
        .{ .name = "cache-control", .value = "no-cache" },
    });

    // C.4.3 Third Request
    const r3 = fromHex("828785bf408825a849e95ba97d7f8925a849e95bb8e8b4bf");
    const h3 = try dec.decode(&r3, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h3);
    try expectHeaders(h3, &.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":path", .value = "/index.html" },
        .{ .name = ":authority", .value = "www.example.com" },
        .{ .name = "custom-key", .value = "custom-value" },
    });
}

test "RFC 7541 Appendix C.6 response examples with Huffman and eviction" {
    var dec: hpack.Decoder = .init(testing.allocator, 256, 65536);
    defer dec.deinit();

    // C.6.1 First Response
    const r1 = fromHex(
        "488264025885aec3771a4b6196d07abe941054d444a8200595040b8166e082a6" ++
            "2d1bff6e919d29ad171863c78f0b97c8e9ae82ae43d3",
    );
    const h1 = try dec.decode(&r1, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h1);
    try expectHeaders(h1, &.{
        .{ .name = ":status", .value = "302" },
        .{ .name = "cache-control", .value = "private" },
        .{ .name = "date", .value = "Mon, 21 Oct 2013 20:13:21 GMT" },
        .{ .name = "location", .value = "https://www.example.com" },
    });
    try testing.expectEqual(@as(usize, 222), dec.dynamicSize());

    // C.6.2 Second Response (evicts oldest entry)
    const r2 = fromHex("4883640effc1c0bf");
    const h2 = try dec.decode(&r2, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h2);
    try expectHeaders(h2, &.{
        .{ .name = ":status", .value = "307" },
        .{ .name = "cache-control", .value = "private" },
        .{ .name = "date", .value = "Mon, 21 Oct 2013 20:13:21 GMT" },
        .{ .name = "location", .value = "https://www.example.com" },
    });
    try testing.expectEqual(@as(usize, 222), dec.dynamicSize());

    // C.6.3 Third Response (multiple evictions)
    const r3 = fromHex(
        "88c16196d07abe941054d444a8200595040b8166e084a62d1bffc05a839bd9ab" ++
            "77ad94e7821dd7f2e6c7b335dfdfcd5b3960d5af27087f3672c1ab270fb5291f" ++
            "9587316065c003ed4ee5b1063d5007",
    );
    const h3 = try dec.decode(&r3, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, h3);
    try expectHeaders(h3, &.{
        .{ .name = ":status", .value = "200" },
        .{ .name = "cache-control", .value = "private" },
        .{ .name = "date", .value = "Mon, 21 Oct 2013 20:13:22 GMT" },
        .{ .name = "location", .value = "https://www.example.com" },
        .{ .name = "content-encoding", .value = "gzip" },
        .{ .name = "set-cookie", .value = "foo=ASDJKHQKBZXOQWEOPIUAXQWEOIU; max-age=3600; version=1" },
    });
    try testing.expectEqual(@as(usize, 215), dec.dynamicSize());
}

test "Huffman encode and decode round-trip all 256 byte values" {
    var all: [256]u8 = undefined;
    for (0..256) |i| all[i] = @intCast(i);
    const encoded = try hpack.huffmanEncode(testing.allocator, &all);
    defer testing.allocator.free(encoded);
    const decoded = try hpack.huffmanDecode(testing.allocator, encoded, 1024);
    defer testing.allocator.free(decoded);
    try testing.expectEqualSlices(u8, &all, decoded);
}

test "Huffman rejects invalid padding, >7-bit padding and EOS in stream" {
    // Non-1 padding: '0' is 00000 (5 bits), padded with 000 instead of 111.
    try testing.expectError(error.InvalidHuffman, hpack.huffmanDecode(testing.allocator, &.{0x00}, 64));
    // >7 bits of 1-padding (full 0xff byte).
    try testing.expectError(error.InvalidHuffman, hpack.huffmanDecode(testing.allocator, &.{0xff}, 64));
    // '0' (00000) + 11 bits of 1s (0x07, 0xff) -> >7 bits of padding.
    try testing.expectError(error.InvalidHuffman, hpack.huffmanDecode(testing.allocator, &.{ 0x07, 0xff }, 64));
    // EOS symbol (30 ones) embedded in stream.
    try testing.expectError(error.InvalidHuffman, hpack.huffmanDecode(testing.allocator, &.{ 0xff, 0xff, 0xff, 0xff }, 64));
    // Valid '0' (00000) + 111 padding = 0x07.
    const ok = try hpack.huffmanDecode(testing.allocator, &.{0x07}, 64);
    defer testing.allocator.free(ok);
    try testing.expectEqualStrings("0", ok);
}

test "dynamic table size updates and validation" {
    var dec: hpack.Decoder = .init(testing.allocator, 256, 65536);
    defer dec.deinit();

    // Table size update at start of block to 0, then 128, followed by :method GET.
    const valid = [_]u8{ 0x20, 0x3f, 0x61, 0x82 };
    const headers = try dec.decode(&valid, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, headers);
    try expectHeaders(headers, &.{.{ .name = ":method", .value = "GET" }});
    try testing.expectEqual(@as(usize, 128), dec.max_table_size);

    // Table size update exceeding hard_max_size (256) is rejected.
    const too_big = [_]u8{ 0x3f, 0xe2, 0x01 }; // 31 + 226 = 257
    try testing.expectError(error.InvalidTableSizeUpdate, dec.decode(&too_big, testing.allocator));

    // Table size update after a header field is rejected (RFC 7541 Section 4.2).
    const after_header = [_]u8{ 0x82, 0x20 };
    try testing.expectError(error.InvalidTableSizeUpdate, dec.decode(&after_header, testing.allocator));

    // Index 0 and out-of-range index are rejected.
    try testing.expectError(error.InvalidIndex, dec.decode(&.{0x80}, testing.allocator));
    try testing.expectError(error.InvalidIndex, dec.decode(&.{0xbe}, testing.allocator));
}

test "header list size limit rejects oversized blocks cleanly" {
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 64);
    defer dec.deinit();
    // Literal without indexing, name="a" (1), value=40 'x' -> 1 + 40 + 32 = 73 > 64.
    var block: [44]u8 = undefined;
    block[0] = 0x00;
    block[1] = 1;
    block[2] = 'a';
    block[3] = 40;
    @memset(block[4..44], 'x');
    try testing.expectError(error.HeaderListTooLarge, dec.decode(&block, testing.allocator));
}

test "encoder enforces hygiene, static lookups and never-indexed sensitive headers" {
    var out: Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();

    const headers = [_]hpack.Header{
        .{ .name = ":method", .value = "POST" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":path", .value = "/opentelemetry.proto.collector.trace.v1.TraceService/Export" },
        .{ .name = ":authority", .value = "localhost:4317" },
        .{ .name = "content-type", .value = "application/grpc" },
        .{ .name = "authorization", .value = "Bearer secret-token" },
        .{ .name = "x-tenant", .value = "acme" },
    };
    try hpack.encodeHeaders(&out.writer, &headers);

    const bytes = out.written();
    // :method POST is static index 3 -> 0x83, :scheme https is static index 7 -> 0x87.
    try testing.expectEqual(@as(u8, 0x83), bytes[0]);
    try testing.expectEqual(@as(u8, 0x87), bytes[1]);
    // Verify authorization was encoded as never-indexed (0x1f 0x08 -> mask 0x10, 4-bit prefix, index 23 = 15 + 8).
    try testing.expect(std.mem.indexOf(u8, bytes, &.{ 0x1f, 0x08 }) != null);

    // Round-trip through the decoder.
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 65536);
    defer dec.deinit();
    const decoded = try dec.decode(bytes, testing.allocator);
    defer hpack.freeHeaders(testing.allocator, decoded);
    try expectHeaders(decoded, &headers);
    try testing.expectEqual(@as(usize, 0), dec.dynamicCount());

    // Hygiene rejections: uppercase, spaces, unknown pseudo-header, CR/LF in value.
    var scratch: [128]u8 = undefined;
    var w: Io.Writer = .fixed(&scratch);
    try testing.expectError(error.InvalidHeader, hpack.encodeHeader(&w, .{ .name = "Content-Type", .value = "x" }, .{}, null));
    try testing.expectError(error.InvalidHeader, hpack.encodeHeader(&w, .{ .name = ":unknown", .value = "x" }, .{}, null));
    try testing.expectError(error.InvalidHeader, hpack.encodeHeader(&w, .{ .name = "bad name", .value = "x" }, .{}, null));
    try testing.expectError(error.InvalidHeader, hpack.encodeHeader(&w, .{ .name = "x-ok", .value = "a\r\nb" }, .{}, null));
    try testing.expectError(error.InvalidHeader, hpack.encodeHeader(&w, .{ .name = "x-ok", .value = "a\x00b" }, .{}, null));
}

fn fuzzDecode(_: void, smith: *testing.Smith) anyerror!void {
    var buf: [4096]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];
    var dec: hpack.Decoder = .init(testing.allocator, 4096, 16 * 1024);
    defer dec.deinit();
    const headers = dec.decode(input, testing.allocator) catch return;
    hpack.freeHeaders(testing.allocator, headers);
}

test "Decoder handles OOM cleanly without double-free or leak" {
    const Runner = struct {
        fn run(alloc: std.mem.Allocator) !void {
            var dec: hpack.Decoder = .init(alloc, 256, 65536);
            defer dec.deinit();
            const r1 = fromHex(
                "488264025885aec3771a4b6196d07abe941054d444a8200595040b8166e082a6" ++
                    "2d1bff6e919d29ad171863c78f0b97c8e9ae82ae43d3",
            );
            const h1 = try dec.decode(&r1, alloc);
            defer hpack.freeHeaders(alloc, h1);
            const r2 = fromHex("4883640effc1c0bf");
            const h2 = try dec.decode(&r2, alloc);
            defer hpack.freeHeaders(alloc, h2);
        }
    };
    try testing.checkAllAllocationFailures(testing.allocator, Runner.run, .{});
}

test "fuzz HPACK decoder" {
    const c1 = fromHex("828684418cf1e3c2e5f23a6ba0ab90f4ff");
    const c2 = fromHex("488264025885aec3771a4b");
    const c3 = fromHex("20400a637573746f6d2d6b65790d637573746f6d2d686561646572");
    try testing.fuzz({}, fuzzDecode, .{ .corpus = &.{
        "",
        &c1,
        &c2,
        &c3,
        &.{0x80},
        &.{ 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff },
        &.{ 0x40, 0x81, 0xff, 0x00 },
        &.{ 0x00, 0x84, 0xff, 0xff, 0xff, 0xff, 0x00 },
    } });
}
