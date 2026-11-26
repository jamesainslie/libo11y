//! Tests for log records: copying, the nested body, and the log record
//! limits as the OTel Go SDK applies them.

const std = @import("std");
const testing = std.testing;
const log_record = @import("log_record.zig");
const LogData = log_record.LogData;
const Value = log_record.Value;
const KeyValue = log_record.KeyValue;
const kv = log_record.kv;
const resource = @import("resource.zig");

const res: resource.Resource = .empty;
const scope: resource.InstrumentationScope = .{ .name = "test" };

fn create(record: log_record.Record, limits: log_record.Limits) !*LogData {
    return LogData.create(testing.allocator, record, &res, &scope, limits) orelse error.OutOfMemory;
}

test "Value.from converts scalars and strings" {
    try testing.expect(Value.from("x").eql(.{ .string = "x" }));
    try testing.expect(Value.from(true).eql(.{ .bool = true }));
    try testing.expect(Value.from(@as(u64, std.math.maxInt(u64))).eql(.{ .int = std.math.maxInt(i64) }));
    try testing.expect(Value.from(2.5).eql(.{ .double = 2.5 }));
    const v: Value = .{ .bytes = "\x00\x01" };
    try testing.expect(Value.from(v).eql(v));
    try testing.expect(!Value.from(1).eql(.{ .double = 1 }));
}

test "a nested body is copied deeply and survives the caller's buffers" {
    var name_buf = "widget".*;
    var key_buf = "items".*;
    const inner = [_]KeyValue{ kv("sku", "A-1"), kv("qty", 3) };
    const items = [_]Value{ .{ .map = &inner }, .{ .string = &name_buf }, .{ .bytes = "\x00\xff" }, .empty };
    const body_pairs = [_]KeyValue{
        .{ .key = &key_buf, .value = .{ .array = &items } },
        kv("ok", true),
        kv("ratio", 0.25),
    };
    const body: Value = .{ .map = &body_pairs };

    const data = try create(.{ .body = body }, .{});
    defer data.release();
    name_buf[0] = 'X';
    key_buf[0] = 'X';

    const want_inner = [_]KeyValue{ kv("sku", "A-1"), kv("qty", 3) };
    const want_items = [_]Value{ .{ .map = &want_inner }, .{ .string = "widget" }, .{ .bytes = "\x00\xff" }, .empty };
    const want_pairs = [_]KeyValue{
        .{ .key = "items", .value = .{ .array = &want_items } },
        kv("ok", true),
        kv("ratio", 0.25),
    };
    try testing.expect(data.body.eql(.{ .map = &want_pairs }));
}

test "the body is deduplicated but never cut" {
    const deep_leaf = [_]KeyValue{kv("leaf", "abcdefgh")};
    const deep = [_]KeyValue{.{ .key = "deep", .value = .{ .map = &deep_leaf } }};
    const pairs = [_]KeyValue{ kv("a", 1), .{ .key = "n", .value = .{ .map = &deep } }, kv("a", 2) };
    const data = try create(.{ .body = .{ .map = &pairs } }, .{ .attribute_value_length = 2, .attribute_value_depth = 1 });
    defer data.release();
    const want = [_]KeyValue{ kv("a", 2), .{ .key = "n", .value = .{ .map = &deep } } };
    try testing.expect(data.body.eql(.{ .map = &want }));
}

test "the defaults are the OTel Go log record limits" {
    const limits: log_record.Limits = .{};
    try testing.expectEqual(@as(?u32, 128), limits.attribute_count);
    try testing.expectEqual(@as(?usize, null), limits.attribute_value_length);
    try testing.expectEqual(@as(?u32, 64), limits.attribute_value_depth);
}

test "attributes are deduplicated with the last value winning, and empty keys are ignored" {
    const attrs = [_]KeyValue{ kv("a", 1), kv("", "x"), kv("b", 2), kv("a", 3) };
    const data = try create(.{ .attributes = &attrs }, .{});
    defer data.release();
    try testing.expectEqual(@as(usize, 2), data.attributes.len);
    try testing.expectEqualStrings("a", data.attributes[0].key);
    try testing.expectEqual(@as(i64, 3), data.attributes[0].value.int);
    try testing.expectEqualStrings("b", data.attributes[1].key);
    try testing.expectEqual(@as(u32, 0), data.dropped_attributes_count);
}

test "attributes past the count limit are dropped and counted" {
    var attrs: [130]KeyValue = undefined;
    var keys: [130][8]u8 = undefined;
    for (&attrs, &keys, 0..) |*a, *k, i| {
        const key = try std.fmt.bufPrint(k, "k{d}", .{i});
        a.* = kv(key, @as(i64, @intCast(i)));
    }
    const data = try create(.{ .attributes = &attrs }, .{});
    defer data.release();
    try testing.expectEqual(@as(usize, 128), data.attributes.len);
    try testing.expectEqual(@as(u32, 2), data.dropped_attributes_count);
    try testing.expectEqualStrings("k127", data.attributes[127].key);

    const none = try create(.{ .attributes = attrs[0..3] }, .{ .attribute_count = 0 });
    defer none.release();
    try testing.expectEqual(@as(usize, 0), none.attributes.len);
    try testing.expectEqual(@as(u32, 3), none.dropped_attributes_count);
}

test "the value length limit counts characters and applies at every depth" {
    const nested = [_]KeyValue{kv("s", "héllo")};
    const list = [_]Value{ .{ .string = "abcdef" }, .{ .bytes = "\x01\x02\x03\x04" } };
    const attrs = [_]KeyValue{
        kv("s", "héllo"),
        .{ .key = "m", .value = .{ .map = &nested } },
        .{ .key = "l", .value = .{ .array = &list } },
        kv("short", "ab"),
    };
    const data = try create(.{ .attributes = &attrs }, .{ .attribute_value_length = 3 });
    defer data.release();
    try testing.expectEqualStrings("hél", data.attributes[0].value.string);
    try testing.expectEqualStrings("hél", data.attributes[1].value.map[0].value.string);
    try testing.expectEqualStrings("abc", data.attributes[2].value.array[0].string);
    try testing.expectEqualSlices(u8, "\x01\x02\x03", data.attributes[2].value.array[1].bytes);
    try testing.expectEqualStrings("ab", data.attributes[3].value.string);
}

test "cutting a string with invalid UTF-8 removes the invalid bytes, as Go does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // Within the byte limit nothing changes, even invalid bytes.
    try testing.expectEqualStrings("a\xffb", try log_record.truncateChars(a, "a\xffb", 3));
    try testing.expectEqualStrings("a\xffb", try log_record.truncateChars(a, "a\xffb", null));
    try testing.expectEqualStrings("ab", try log_record.truncateChars(a, "a\xffbcd", 2));
    try testing.expectEqualStrings("abc", try log_record.truncateChars(a, "a\xff\xfebcd", 3));
    try testing.expectEqualStrings("", try log_record.truncateChars(a, "\xffabc", 0));
    try testing.expectEqualStrings("", try log_record.truncateChars(a, "abc", 0));
    // A valid U+FFFD counts as one character.
    try testing.expectEqualStrings("\u{fffd}a", try log_record.truncateChars(a, "\u{fffd}abc", 2));
}

test "arrays and maps past the depth limit become empty values" {
    const level3 = [_]KeyValue{kv("x", 1)};
    const level2 = [_]KeyValue{ .{ .key = "m", .value = .{ .map = &level3 } }, kv("s", "kept") };
    const list = [_]Value{ .{ .map = &level3 }, .{ .int = 7 } };
    const attrs = [_]KeyValue{
        .{ .key = "top", .value = .{ .map = &level2 } },
        .{ .key = "list", .value = .{ .array = &list } },
        kv("scalar", 1),
    };
    const data = try create(.{ .attributes = &attrs }, .{ .attribute_value_depth = 1 });
    defer data.release();
    const top = data.attributes[0].value.map;
    try testing.expect(top[0].value == .empty);
    try testing.expectEqualStrings("kept", top[1].value.string);
    try testing.expect(data.attributes[1].value.array[0] == .empty);
    try testing.expectEqual(@as(i64, 7), data.attributes[1].value.array[1].int);
    try testing.expectEqual(@as(i64, 1), data.attributes[2].value.int);

    const flat = try create(.{ .attributes = &attrs }, .{ .attribute_value_depth = 0 });
    defer flat.release();
    try testing.expect(flat.attributes[0].value == .empty);
    try testing.expectEqual(@as(i64, 1), flat.attributes[2].value.int);

    const unlimited = try create(.{ .attributes = &attrs }, .{ .attribute_value_depth = null });
    defer unlimited.release();
    try testing.expectEqual(@as(i64, 1), unlimited.attributes[0].value.map[0].value.map[0].value.int);
}

test "maps inside attributes are deduplicated" {
    const pairs = [_]KeyValue{ kv("k", 1), kv("j", 2), kv("k", 3) };
    const attrs = [_]KeyValue{.{ .key = "m", .value = .{ .map = &pairs } }};
    const data = try create(.{ .attributes = &attrs }, .{});
    defer data.release();
    const want = [_]KeyValue{ kv("k", 3), kv("j", 2) };
    try testing.expect(data.attributes[0].value.eql(.{ .map = &want }));
}

test "retain keeps the record alive until the last release" {
    const data = try create(.{ .severity_text = "INFO", .event_name = "order.placed" }, .{});
    data.retain();
    data.release();
    try testing.expectEqualStrings("INFO", data.severity_text);
    try testing.expectEqualStrings("order.placed", data.event_name);
    data.release();
}

test "an allocation failure returns null without leaking" {
    const attrs = [_]KeyValue{ kv("a", "x"), kv("b", "y") };
    var i: usize = 0;
    while (i < 32) : (i += 1) {
        var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = i });
        const data = LogData.create(failing.allocator(), .{ .attributes = &attrs, .severity_text = "WARN" }, &res, &scope, .{}) orelse continue;
        data.release();
        break;
    }
    try testing.expect(i > 0);
}
