//! Unit tests and fuzz target for the HTTP/2 frame codec and helpers.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const net = Io.net;
const http = @import("http.zig");
const hpack = @import("hpack.zig");
const h2 = @import("h2.zig");

test "FrameHeader encode and parse round-trip" {
    const hdr: h2.FrameHeader = .{
        .length = 0x123456,
        .frame_type = @backingInt(h2.FrameType.headers),
        .flags = h2.Flags.end_headers | h2.Flags.end_stream,
        .stream_id = 0x1234567,
    };
    const wire = hdr.encode();
    try testing.expectEqualSlices(u8, &.{ 0x12, 0x34, 0x56, 0x01, 0x05, 0x01, 0x23, 0x45, 0x67 }, &wire);
    try testing.expectEqual(hdr, h2.FrameHeader.parse(wire));

    // Reserved high bit of stream_id is ignored on parse.
    var with_reserved = wire;
    with_reserved[5] |= 0x80;
    try testing.expectEqual(hdr.stream_id, h2.FrameHeader.parse(with_reserved).stream_id);
}

test "parseFrame handles DATA and HEADERS with PADDED and PRIORITY flags" {
    // Padded DATA frame: pad_len=3, payload="hi", 3 pad bytes.
    const padded_data = [_]u8{ 3, 'h', 'i', 0, 0, 0 };
    const f_data = try h2.parseFrame(.{
        .length = padded_data.len,
        .frame_type = @backingInt(h2.FrameType.data),
        .flags = h2.Flags.padded | h2.Flags.end_stream,
        .stream_id = 1,
    }, &padded_data);
    try testing.expectEqualStrings("hi", f_data.data.payload);
    try testing.expect(f_data.data.end_stream);
    try testing.expectEqual(@as(u24, 6), f_data.data.wire_len);

    // Invalid pad_len exceeding payload.
    try testing.expectError(error.ProtocolError, h2.parseFrame(.{
        .length = 2,
        .frame_type = @backingInt(h2.FrameType.data),
        .flags = h2.Flags.padded,
        .stream_id = 1,
    }, &.{ 2, 0 }));

    // Padded + Priority HEADERS frame.
    const padded_prio_hdr = [_]u8{
        2, // pad_len
        0, 0, 0, 0, // dep = 0
        15, // weight
        0x88, // :status 200
        0, 0, // padding
    };
    const f_hdr = try h2.parseFrame(.{
        .length = padded_prio_hdr.len,
        .frame_type = @backingInt(h2.FrameType.headers),
        .flags = h2.Flags.padded | h2.Flags.priority | h2.Flags.end_headers,
        .stream_id = 3,
    }, &padded_prio_hdr);
    try testing.expectEqualSlices(u8, &.{0x88}, f_hdr.headers.fragment);
    try testing.expect(f_hdr.headers.end_headers);
    try testing.expect(!f_hdr.headers.end_stream);

    // Self-dependency in PRIORITY is PROTOCOL_ERROR.
    const self_dep = [_]u8{ 0, 0, 0, 3, 15, 0x88 };
    try testing.expectError(error.ProtocolError, h2.parseFrame(.{
        .length = self_dep.len,
        .frame_type = @backingInt(h2.FrameType.headers),
        .flags = h2.Flags.priority,
        .stream_id = 3,
    }, &self_dep));
}

test "parseFrame validates SETTINGS, PING, GOAWAY, RST_STREAM, WINDOW_UPDATE and unknown frames" {
    // SETTINGS
    var buf: [64]u8 = undefined;
    var w: Io.Writer = .fixed(&buf);
    try h2.writeSettings(&w, &.{
        .{ .id = @backingInt(h2.SettingId.max_frame_size), .value = 32768 },
        .{ .id = @backingInt(h2.SettingId.initial_window_size), .value = 131072 },
    });
    const raw = w.buffered();
    const shdr = h2.FrameHeader.parse(raw[0..9].*);
    const sf = try h2.parseFrame(shdr, raw[9..]);
    try testing.expect(!sf.settings.ack);
    var it: h2.SettingIterator = .{ .payload = sf.settings.payload };
    const s1 = it.next().?;
    try testing.expectEqual(@backingInt(h2.SettingId.max_frame_size), s1.id);
    try testing.expectEqual(@as(u32, 32768), s1.value);
    const s2 = it.next().?;
    try testing.expectEqual(@backingInt(h2.SettingId.initial_window_size), s2.id);
    try testing.expectEqual(@as(u32, 131072), s2.value);
    try testing.expectEqual(@as(?h2.Setting, null), it.next());

    // SETTINGS ACK with non-empty payload -> FrameSizeError
    try testing.expectError(error.FrameSizeError, h2.parseFrame(.{
        .length = 1,
        .frame_type = @backingInt(h2.FrameType.settings),
        .flags = h2.Flags.ack,
        .stream_id = 0,
    }, &.{0}));

    // PING with wrong length -> FrameSizeError
    try testing.expectError(error.FrameSizeError, h2.parseFrame(.{
        .length = 7,
        .frame_type = @backingInt(h2.FrameType.ping),
        .flags = 0,
        .stream_id = 0,
    }, "1234567"));

    // GOAWAY
    w = .fixed(&buf);
    try h2.writeGoAway(&w, 5, .enhance_your_calm, "slow down");
    const gw_raw = w.buffered();
    const gf = try h2.parseFrame(h2.FrameHeader.parse(gw_raw[0..9].*), gw_raw[9..]);
    try testing.expectEqual(@as(u31, 5), gf.goaway.last_stream_id);
    try testing.expectEqual(@backingInt(h2.ErrorCode.enhance_your_calm), gf.goaway.error_code);
    try testing.expectEqualStrings("slow down", gf.goaway.debug_data);

    // RST_STREAM on stream 0 -> ProtocolError
    try testing.expectError(error.ProtocolError, h2.parseFrame(.{
        .length = 4,
        .frame_type = @backingInt(h2.FrameType.rst_stream),
        .flags = 0,
        .stream_id = 0,
    }, &.{ 0, 0, 0, 0 }));

    // WINDOW_UPDATE with increment 0 -> ProtocolError
    try testing.expectError(error.ProtocolError, h2.parseFrame(.{
        .length = 4,
        .frame_type = @backingInt(h2.FrameType.window_update),
        .flags = 0,
        .stream_id = 0,
    }, &.{ 0, 0, 0, 0 }));

    // PUSH_PROMISE is rejected by client
    try testing.expectError(error.ProtocolError, h2.parseFrame(.{
        .length = 4,
        .frame_type = @backingInt(h2.FrameType.push_promise),
        .flags = 0,
        .stream_id = 1,
    }, &.{ 0, 0, 0, 2 }));

    // Unknown frame type is ignored cleanly
    const unk = try h2.parseFrame(.{
        .length = 3,
        .frame_type = 0xfe,
        .flags = 0,
        .stream_id = 0,
    }, "abc");
    try testing.expectEqual(@as(u8, 0xfe), unk.unknown.frame_type);
}

test "writeHeaderBlock splits oversized headers into HEADERS plus CONTINUATION" {
    var out: Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();

    const big_block = try testing.allocator.alloc(u8, h2.default_max_frame_size + 100);
    defer testing.allocator.free(big_block);
    @memset(big_block, 0x82);

    try h2.writeHeaderBlock(&out.writer, 1, big_block, h2.default_max_frame_size, true);
    const bytes = out.written();

    const h1 = h2.FrameHeader.parse(bytes[0..9].*);
    try testing.expectEqual(@backingInt(h2.FrameType.headers), h1.frame_type);
    try testing.expectEqual(@as(u24, h2.default_max_frame_size), h1.length);
    try testing.expectEqual(h2.Flags.end_stream, h1.flags);
    try testing.expectEqual(@as(u31, 1), h1.stream_id);

    const off = 9 + h2.default_max_frame_size;
    const h2_hdr = h2.FrameHeader.parse(bytes[off .. off + 9].*);
    try testing.expectEqual(@backingInt(h2.FrameType.continuation), h2_hdr.frame_type);
    try testing.expectEqual(@as(u24, 100), h2_hdr.length);
    try testing.expectEqual(h2.Flags.end_headers, h2_hdr.flags);
    try testing.expectEqual(@as(u31, 1), h2_hdr.stream_id);
}

test "validateResponseHeaders and validateTrailers enforce RFC 9113 header rules" {
    // Valid response headers.
    try testing.expectEqual(@as(?u16, 200), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = "content-type", .value = "application/grpc" },
    }));
    // Pseudo-header after regular header is rejected.
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = "content-type", .value = "application/grpc" },
        .{ .name = ":status", .value = "200" },
    }));
    // Request pseudo-header or unknown pseudo-header in response is rejected.
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = ":path", .value = "/" },
    }));
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = ":bogus", .value = "1" },
    }));
    // Duplicate :status or missing :status is rejected.
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = ":status", .value = "200" },
    }));
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = "content-type", .value = "application/grpc" },
    }));
    // Uppercase name or CR/LF/NUL in value is rejected.
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = "Content-Type", .value = "application/grpc" },
    }));
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = "x-bad", .value = "a\r\nb" },
    }));
    try testing.expectEqual(@as(?u16, null), h2.validateResponseHeaders(&.{
        .{ .name = ":status", .value = "200" },
        .{ .name = "x-bad", .value = "a\x00b" },
    }));

    // Valid trailers vs pseudo-header / uppercase / invalid value in trailers.
    try testing.expect(h2.validateTrailers(&.{
        .{ .name = "grpc-status", .value = "0" },
        .{ .name = "grpc-message", .value = "ok" },
    }));
    try testing.expect(!h2.validateTrailers(&.{
        .{ .name = ":status", .value = "200" },
    }));
    try testing.expect(!h2.validateTrailers(&.{
        .{ .name = "Grpc-Status", .value = "0" },
    }));
    try testing.expect(!h2.validateTrailers(&.{
        .{ .name = "grpc-message", .value = "line1\nline2" },
    }));
}

test "foreign HEADERS and unsolicited CONTINUATION fail with ProtocolError and mark connection broken" {
    const io = testing.io;
    const Mode = enum { foreign_headers, unsolicited_continuation, foreign_continuation };
    inline for (.{ Mode.foreign_headers, Mode.unsolicited_continuation, Mode.foreign_continuation }) |mode| {
        const address = try net.IpAddress.parse("127.0.0.1", 0);
        var listener = try address.listen(io, .{ .reuse_address = true });
        defer listener.deinit(io);
        const port = listener.socket.address.getPort();

        const Server = struct {
            fn run(l: *net.Server, m: Mode) void {
                const s = l.accept(io) catch return;
                defer s.close(io);
                var rbuf: [4096]u8 = undefined;
                var wbuf: [4096]u8 = undefined;
                var r = s.reader(io, &rbuf);
                var w = s.writer(io, &wbuf);
                var pref: [h2.client_preface.len]u8 = undefined;
                r.interface.readSliceAll(&pref) catch return;
                switch (m) {
                    .foreign_headers => {
                        h2.writeFrame(&w.interface, .headers, h2.Flags.end_headers, 99, &.{0x88}) catch return;
                    },
                    .unsolicited_continuation => {
                        h2.writeFrame(&w.interface, .continuation, h2.Flags.end_headers, 1, &.{0x88}) catch return;
                    },
                    .foreign_continuation => {
                        h2.writeFrame(&w.interface, .continuation, h2.Flags.end_headers, 99, &.{0x88}) catch return;
                    },
                }
                w.interface.flush() catch return;
                s.shutdown(io, .send) catch {};
                var drain: [256]u8 = undefined;
                while (true) {
                    const n = r.interface.readSliceShort(&drain) catch break;
                    if (n == 0) break;
                }
            }
        };
        var srv = try io.concurrent(Server.run, .{ &listener, mode });
        defer srv.await(io);

        const url = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}", .{port});
        defer testing.allocator.free(url);
        const ep = try http.Endpoint.parse(url);
        var failure: http.Failure = undefined;
        var conn = try h2.Connection.open(testing.allocator, io, &ep, null, &failure);
        defer conn.close(testing.allocator, false);

        const req_hdrs = [_]hpack.Header{
            .{ .name = ":method", .value = "POST" },
            .{ .name = ":scheme", .value = "http" },
            .{ .name = ":path", .value = "/test" },
            .{ .name = ":authority", .value = ep.authority },
        };
        try testing.expectError(error.ProtocolError, conn.roundTrip(testing.allocator, &req_hdrs, "", 4096));
        try testing.expect(conn.broken);
        try testing.expect(!conn.usable());
    }
}

test "early END_STREAM response during blocked upload resets half-open stream cleanly" {
    const io = testing.io;
    const address = try net.IpAddress.parse("127.0.0.1", 0);
    var listener = try address.listen(io, .{ .reuse_address = true });
    defer listener.deinit(io);
    const port = listener.socket.address.getPort();

    const Result = struct { saw_rst: bool = false };
    const Server = struct {
        fn run(l: *net.Server, res: *Result) void {
            const s = l.accept(io) catch return;
            defer s.close(io);
            var rbuf: [32 * 1024]u8 = undefined;
            var wbuf: [4096]u8 = undefined;
            var r = s.reader(io, &rbuf);
            var w = s.writer(io, &wbuf);
            var pref: [h2.client_preface.len]u8 = undefined;
            r.interface.readSliceAll(&pref) catch return;
            // Read client frames until first DATA frame on stream 1, then send
            // an early trailers-only response with END_STREAM without sending
            // WINDOW_UPDATE so the client is blocked mid-upload.
            var frame_buf: [h2.default_max_frame_size]u8 = undefined;
            var replied = false;
            while (true) {
                var raw_hdr: [h2.frame_header_len]u8 = undefined;
                r.interface.readSliceAll(&raw_hdr) catch return;
                const hdr = h2.FrameHeader.parse(raw_hdr);
                if (hdr.length > frame_buf.len) return;
                const payload = frame_buf[0..hdr.length];
                if (payload.len > 0) r.interface.readSliceAll(payload) catch return;
                const f = h2.parseFrame(hdr, payload) catch return;
                switch (f) {
                    .data => |d| {
                        if (!replied and d.stream_id == 1) {
                            replied = true;
                            h2.writeFrame(&w.interface, .headers, h2.Flags.end_headers | h2.Flags.end_stream, 1, &.{0x88}) catch return;
                            w.interface.flush() catch return;
                        }
                    },
                    .rst_stream => |rst| {
                        if (rst.stream_id == 1 and rst.error_code == @backingInt(h2.ErrorCode.no_error)) {
                            res.saw_rst = true;
                            return;
                        }
                    },
                    else => {},
                }
            }
        }
    };
    var res: Result = .{};
    var srv = try io.concurrent(Server.run, .{ &listener, &res });
    defer srv.await(io);

    const url = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}", .{port});
    defer testing.allocator.free(url);
    const ep = try http.Endpoint.parse(url);
    var failure: http.Failure = undefined;
    var conn = try h2.Connection.open(testing.allocator, io, &ep, null, &failure);
    defer conn.close(testing.allocator, true);

    const big_body = try testing.allocator.alloc(u8, 96 * 1024);
    defer testing.allocator.free(big_body);
    @memset(big_body, 'a');

    const req_hdrs = [_]hpack.Header{
        .{ .name = ":method", .value = "POST" },
        .{ .name = ":scheme", .value = "http" },
        .{ .name = ":path", .value = "/test" },
        .{ .name = ":authority", .value = ep.authority },
    };
    var resp = try conn.roundTrip(testing.allocator, &req_hdrs, big_body, 4096);
    defer resp.deinit(testing.allocator);
    try testing.expectEqual(@as(u16, 200), resp.status);
    try testing.expect(resp.trailers_only);
    srv.await(io);
    try testing.expect(res.saw_rst);
}

fn fuzzParseFrame(_: void, smith: *testing.Smith) anyerror!void {
    var buf: [4096]u8 = undefined;
    const input = smith.in orelse buf[0..smith.slice(&buf)];
    if (input.len < h2.frame_header_len) return;
    const hdr = h2.FrameHeader.parse(input[0..h2.frame_header_len].*);
    const payload = input[h2.frame_header_len..];
    if (hdr.length > payload.len) return;
    const frame = h2.parseFrame(hdr, payload[0..hdr.length]) catch return;
    switch (frame) {
        .settings => |s| {
            var it: h2.SettingIterator = .{ .payload = s.payload };
            while (it.next()) |_| {}
        },
        else => {},
    }
}

test "fuzz HTTP/2 frame decoder" {
    try testing.fuzz({}, fuzzParseFrame, .{
        .corpus = &.{
            "",
            &.{ 0, 0, 0, 4, 1, 0, 0, 0, 0 }, // SETTINGS ACK
            &.{ 0, 0, 8, 6, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8 }, // PING
            &.{ 0, 0, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 1 }, // WINDOW_UPDATE
            &.{ 0, 0, 4, 3, 0, 0, 0, 0, 1, 0, 0, 0, 8 }, // RST_STREAM
            &.{ 0, 0, 8, 7, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0 }, // GOAWAY
            &.{ 0, 0, 6, 0, 9, 0, 0, 0, 1, 3, 'a', 'b', 0, 0, 0 }, // Padded DATA
            &.{ 0, 0, 7, 1, 0x2c, 0, 0, 0, 1, 0, 0, 0, 0, 0, 15, 0x88 }, // Padded+Priority HEADERS
            &.{ 0, 0, 3, 0xff, 0, 0, 0, 0, 0, 1, 2, 3 }, // Unknown frame
        },
    });
}
