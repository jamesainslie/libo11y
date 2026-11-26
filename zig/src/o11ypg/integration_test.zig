//! Unit and live PostgreSQL integration tests for `o11ypg`.
//!
//! Unit tests always run (no external DB needed, no unguarded `pg.Pool.init`
//! failure logs). Live PostgreSQL tests read `O11YPG_TEST_DSN` from the process
//! environment and return `error.SkipZigTest` cleanly when unset.

const std = @import("std");
const testing = std.testing;
const pg = @import("pg");
const o11y = @import("o11y");
const o11ypg = @import("o11ypg");
const o11ytest = @import("o11ytest");

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

fn testDsn(allocator: std.mem.Allocator) !?[]u8 {
    var env_map = try testing.environ.createMap(allocator);
    defer env_map.deinit();
    const raw = env_map.get("O11YPG_TEST_DSN") orelse return null;
    const trimmed = std.mem.trim(u8, raw, " \t\r\n");
    if (trimmed.len == 0) return null;
    return try allocator.dupe(u8, trimmed);
}

test "o11ypg unit: pool metrics callback reports idle, used, and max connections" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const meter = rec.telemetry().meter(o11ypg.scope_name);
    const count_inst = meter.observableUpDownCounter(i64, "db.client.connection.count", .{
        .unit = "{connection}",
    });
    const max_inst = meter.observableUpDownCounter(i64, "db.client.connection.max", .{
        .unit = "{connection}",
    });

    const Ctx = struct {
        count_inst: o11y.ObservableUpDownCounter(i64),
        max_inst: o11y.ObservableUpDownCounter(i64),
        stats: pg.Pool.Stats,

        fn cb(ptr: ?*anyopaque, observer: o11y.Observer) void {
            const self: *@This() = @ptrCast(@alignCast(ptr orelse return));
            o11ypg.observePoolStats(observer, self.count_inst, self.max_inst, "primary", self.stats);
        }
    };
    var cb_ctx: Ctx = .{
        .count_inst = count_inst,
        .max_inst = max_inst,
        .stats = .{ .size = 10, .available = 7, .missing = 1, .in_use = 2 },
    };

    var reg = meter.registerCallback(
        .{ .ptr = &cb_ctx, .func = Ctx.cb },
        &.{ count_inst.observable(), max_inst.observable() },
    );
    defer reg.unregister();

    const count_m = try rec.expectMetric("db.client.connection.count");
    try testing.expectEqualStrings("{connection}", count_m.unit);
    var saw_idle = false;
    var saw_used = false;
    for (count_m.data.sum.data_points) |dp| {
        const state = findAttr(dp.attributes, "db.client.connection.state").?.string;
        try testing.expectEqualStrings("primary", findAttr(dp.attributes, "db.client.connection.pool.name").?.string);
        if (std.mem.eql(u8, state, "idle")) {
            try testing.expectEqual(@as(i64, 7), dp.value.int);
            saw_idle = true;
        } else if (std.mem.eql(u8, state, "used")) {
            try testing.expectEqual(@as(i64, 2), dp.value.int);
            saw_used = true;
        }
    }
    try testing.expect(saw_idle and saw_used);

    const max_m = try rec.expectMetric("db.client.connection.max");
    try testing.expectEqual(@as(usize, 1), max_m.data.sum.data_points.len);
    try testing.expectEqual(@as(i64, 10), max_m.data.sum.data_points[0].value.int);
    try testing.expectEqualStrings("primary", findAttr(max_m.data.sum.data_points[0].attributes, "db.client.connection.pool.name").?.string);
}

test "o11ypg live: queries, transactions, error SQLSTATE, parent-span gating, and pool metrics" {
    const dsn = (try testDsn(testing.allocator)) orelse return error.SkipZigTest;
    defer testing.allocator.free(dsn);

    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const uri = try std.Uri.parse(dsn);
    var pool = try o11ypg.Pool.initUri(testing.allocator, testing.io, uri, .{
        .size = 4,
        .connect_on_init_count = 2,
    }, .{
        .telemetry = rec.telemetry(),
        .pool_name = "test-pg-pool",
    });
    defer pool.deinit();

    // 1. Rootless query: NO span emitted, duration metric IS recorded.
    {
        var qr = (try pool.row(.background, "SELECT 1 AS one", .{})) orelse return error.TestUnexpectedResult;
        defer qr.deinit() catch {};
        try testing.expectEqual(@as(i32, 1), try qr.get(i32, 0));
        try testing.expectEqual(@as(usize, 0), rec.spans().len);
        const hist = try rec.expectMetric("db.client.operation.duration");
        try testing.expectEqual(@as(u64, 1), hist.data.histogram.data_points[0].count);
    }

    // 2. Parented CREATE, INSERT, SELECT, and error query on an acquired Conn
    //    (using a TEMP table so parallel or repeated runs stay isolated).
    rec.reset();
    var parent = rec.tracer("handler").start(.background, "POST /widgets", .{});
    defer parent.end();
    const pctx = o11y.Context.background.withSpan(&parent);

    var conn = try pool.acquire();
    defer conn.release();

    try conn.begin(pctx);
    _ = try conn.exec(pctx, "CREATE TEMP TABLE o11ypg_widgets (id INTEGER PRIMARY KEY, secret_email TEXT NOT NULL)", .{});
    _ = try conn.exec(pctx, "INSERT INTO o11ypg_widgets (id, secret_email) VALUES (1, 'alice@secret.example')", .{});

    {
        var qr = (try conn.row(pctx, "SELECT secret_email FROM o11ypg_widgets WHERE id = $1", .{@as(i32, 1)})) orelse return error.TestUnexpectedResult;
        defer qr.deinit() catch {};
        try testing.expectEqualStrings("alice@secret.example", try qr.get([]u8, 0));
    }

    // Intentional PG error (undefined_table = 42P01) inside a rolled-back savepoint / transaction.
    try testing.expectError(error.PG, conn.exec(pctx, "SELECT * FROM o11ypg_does_not_exist_xyz WHERE x = 'leak'", .{}));
    try conn.rollback(pctx);

    parent.end();

    // Assert spans and sanitized db.query.text (no literal PII anywhere!).
    const create_sp = try rec.expectSpan("CREATE o11ypg_widgets");
    try testing.expectEqual(o11y.SpanKind.client, create_sp.kind);
    try testing.expectEqualStrings("postgresql", findAttr(create_sp.attributes.items, "db.system.name").?.string);

    const insert_sp = try rec.expectSpan("INSERT o11ypg_widgets");
    const insert_qt = findAttr(insert_sp.attributes.items, "db.query.text").?.string;
    try testing.expect(std.mem.indexOf(u8, insert_qt, "alice@secret.example") == null);
    try testing.expectEqualStrings(
        "INSERT INTO o11ypg_widgets (id, secret_email) VALUES (?, ?)",
        insert_qt,
    );

    const select_sp = try rec.expectSpan("SELECT o11ypg_widgets");
    try testing.expectEqualStrings("SELECT", findAttr(select_sp.attributes.items, "db.operation.name").?.string);
    try testing.expectEqualStrings("o11ypg_widgets", findAttr(select_sp.attributes.items, "db.collection.name").?.string);

    const err_sp = try rec.expectSpan("SELECT o11ypg_does_not_exist_xyz");
    try testing.expectEqual(o11y.StatusCode.@"error", err_sp.status.code);
    try testing.expectEqualStrings("", err_sp.status.description);
    try testing.expectEqualStrings("PG", findAttr(err_sp.attributes.items, "error.type").?.string);
    try testing.expectEqualStrings("42P01", findAttr(err_sp.attributes.items, "db.response.status_code").?.string);
    const err_qt = findAttr(err_sp.attributes.items, "db.query.text").?.string;
    try testing.expect(std.mem.indexOf(u8, err_qt, "leak") == null);

    _ = try rec.expectSpan("BEGIN");
    _ = try rec.expectSpan("ROLLBACK");

    // Assert duration exemplar and pool metrics.
    _ = try rec.expectExemplar("db.client.operation.duration", select_sp.span_context.trace_id);

    const pool_count = try rec.expectMetric("db.client.connection.count");
    try testing.expect(pool_count.data.sum.data_points.len >= 2);
    const pool_max = try rec.expectMetric("db.client.connection.max");
    try testing.expectEqual(@as(i64, 4), pool_max.data.sum.data_points[0].value.int);
    try testing.expectEqualStrings("test-pg-pool", findAttr(pool_max.data.sum.data_points[0].attributes, "db.client.connection.pool.name").?.string);

    try rec.expectConforms();
}
