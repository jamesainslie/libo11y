//! Tests of a single stream, below the meter provider.

const std = @import("std");
const testing = std.testing;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const kv = attribute.kv;
const aggregate = @import("aggregate.zig");

const io = testing.io;
const gpa = testing.allocator;

test "a stream with cardinality limit 1 sends every series to overflow" {
    const s = try aggregate.Stream(i64).create(gpa, io, .{
        .name = "c",
        .kind = .counter,
        .aggregation = .{ .sum = .{ .monotonic = true } },
        .cardinality_limit = 1,
    }, 100);
    defer s.destroy();

    s.record(.background, 3, &.{kv("k", "a")}, gpa);
    s.record(.background, 4, &.{kv("k", "b")}, gpa);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const m = (try s.collect(arena.allocator(), 200)).?;
    const pts = m.data.sum.data_points;
    try testing.expectEqual(@as(usize, 1), pts.len);
    try testing.expectEqual(@as(i64, 7), pts[0].value.int);
    try testing.expect(attribute.find(pts[0].attributes, "otel.metric.overflow").?.bool);
}

test "a stream with cardinality limit 0 keeps every series without overflow" {
    const s = try aggregate.Stream(i64).create(gpa, io, .{
        .name = "c",
        .kind = .counter,
        .aggregation = .{ .sum = .{ .monotonic = true } },
        .cardinality_limit = 0,
    }, 100);
    defer s.destroy();

    var buf: [16]u8 = undefined;
    for (0..32) |i| {
        const val = try std.fmt.bufPrint(&buf, "v{d}", .{i});
        s.record(.background, 1, &.{kv("k", val)}, gpa);
    }

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const m = (try s.collect(arena.allocator(), 200)).?;
    try testing.expectEqual(@as(usize, 32), m.data.sum.data_points.len);
}

test "histogram with record_min_max=false omits min and max" {
    const s = try aggregate.Stream(f64).create(gpa, io, .{
        .name = "h",
        .kind = .histogram,
        .aggregation = .{ .histogram = .{ .bounds = &.{ 1, 10 }, .record_min_max = false, .record_sum = true } },
    }, 100);
    defer s.destroy();

    s.record(.background, 0.5, &.{}, gpa);
    s.record(.background, 5.0, &.{}, gpa);

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    const m = (try s.collect(arena.allocator(), 200)).?;
    const p = m.data.histogram.data_points[0];
    try testing.expectEqual(@as(u64, 2), p.count);
    try testing.expectEqual(@as(f64, 5.5), p.sum.?.double);
    try testing.expectEqual(null, p.min);
    try testing.expectEqual(null, p.max);
    try testing.expectEqualSlices(u64, &.{ 1, 1, 0 }, p.bucket_counts);
}

test "precomputed delta sum forgets unobserved series across a gap cycle" {
    const s = try aggregate.Stream(i64).create(gpa, io, .{
        .name = "obs",
        .kind = .observable_counter,
        .aggregation = .{ .sum = .{ .monotonic = true } },
        .temporality = .delta,
    }, 100);
    defer s.destroy();

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();

    // Cycle 1: observe 10 -> delta 10, reported = 10.
    s.record(.background, 10, &.{kv("k", "a")}, gpa);
    const m1 = (try s.collect(arena.allocator(), 200)).?;
    try testing.expectEqual(@as(i64, 10), m1.data.sum.data_points[0].value.int);

    // Cycle 2: nothing observed -> null, series forgotten.
    try testing.expectEqual(null, try s.collect(arena.allocator(), 300));

    // Cycle 3: observe 15 -> reported was forgotten, so delta is 15.
    s.record(.background, 15, &.{kv("k", "a")}, gpa);
    const m3 = (try s.collect(arena.allocator(), 400)).?;
    try testing.expectEqual(@as(i64, 15), m3.data.sum.data_points[0].value.int);
    try testing.expectEqual(@as(u64, 300), m3.data.sum.data_points[0].start_time_unix_nano);
}

test "cumulative histogram on an observable instrument accumulates across collections" {
    const s = try aggregate.Stream(f64).create(gpa, io, .{
        .name = "obs.hist",
        .kind = .observable_gauge,
        .aggregation = .{ .histogram = .{ .bounds = &.{ 10, 50 }, .record_min_max = true, .record_sum = false } },
        .temporality = .cumulative,
    }, 100);
    defer s.destroy();

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();

    s.record(.background, 5, &.{kv("pool", "a")}, gpa);
    const m1 = (try s.collect(arena.allocator(), 200)).?;
    const p1 = m1.data.histogram.data_points[0];
    try testing.expectEqual(@as(u64, 100), p1.start_time_unix_nano);
    try testing.expectEqual(@as(u64, 1), p1.count);
    try testing.expectEqual(null, p1.sum);
    try testing.expectEqual(@as(f64, 5), p1.min.?.double);
    try testing.expectEqual(@as(f64, 5), p1.max.?.double);
    try testing.expectEqualSlices(u64, &.{ 1, 0, 0 }, p1.bucket_counts);

    s.record(.background, 25, &.{kv("pool", "a")}, gpa);
    const m2 = (try s.collect(arena.allocator(), 300)).?;
    const p2 = m2.data.histogram.data_points[0];
    try testing.expectEqual(@as(u64, 100), p2.start_time_unix_nano);
    try testing.expectEqual(@as(u64, 2), p2.count);
    try testing.expectEqual(@as(f64, 5), p2.min.?.double);
    try testing.expectEqual(@as(f64, 25), p2.max.?.double);
    try testing.expectEqualSlices(u64, &.{ 1, 1, 0 }, p2.bucket_counts);
}

test "delta histogram on an observable instrument resets each collection" {
    const s = try aggregate.Stream(f64).create(gpa, io, .{
        .name = "obs.hist.delta",
        .kind = .observable_counter,
        .aggregation = .{ .histogram = .{ .bounds = &.{10}, .record_min_max = true, .record_sum = true } },
        .temporality = .delta,
    }, 100);
    defer s.destroy();

    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();

    s.record(.background, 5, &.{}, gpa);
    const m1 = (try s.collect(arena.allocator(), 200)).?;
    try testing.expectEqual(@as(u64, 1), m1.data.histogram.data_points[0].count);

    s.record(.background, 20, &.{}, gpa);
    const m2 = (try s.collect(arena.allocator(), 300)).?;
    const p2 = m2.data.histogram.data_points[0];
    try testing.expectEqual(@as(u64, 200), p2.start_time_unix_nano);
    try testing.expectEqual(@as(u64, 1), p2.count);
    try testing.expectEqual(@as(f64, 20), p2.sum.?.double);
    try testing.expectEqualSlices(u64, &.{ 0, 1 }, p2.bucket_counts);
}
