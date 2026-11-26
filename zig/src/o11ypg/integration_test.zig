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

test "o11ypg live: Pool.query/row SQLSTATE, release_conn=true safety, and idempotent Pool.deinit" {
    const dsn = (try testDsn(testing.allocator)) orelse return error.SkipZigTest;
    defer testing.allocator.free(dsn);

    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const uri = try std.Uri.parse(dsn);
    var pool = try o11ypg.Pool.initUri(testing.allocator, testing.io, uri, .{
        .size = 2,
        .connect_on_init_count = 1,
    }, .{
        .telemetry = rec.telemetry(),
        .pool_name = "release-conn-pool",
    });
    defer pool.deinit();

    var parent = rec.tracer("handler").start(.background, "GET /pool-checks", .{});
    defer parent.end();
    const pctx = o11y.Context.background.withSpan(&parent);

    // 1. Failing pool.query and pool.row must record SQLSTATE 42P01 and release conn cleanly.
    try testing.expectError(error.PG, pool.query(pctx, "SELECT * FROM o11ypg_missing_pool_q", .{}));
    try testing.expectError(error.PG, pool.row(pctx, "SELECT * FROM o11ypg_missing_pool_r", .{}));

    // 2. pool.row returning null must release conn back to the pool.
    try testing.expectEqual(@as(?pg.QueryRow, null), try pool.row(pctx, "SELECT 1 WHERE false", .{}));

    // 3. pool.execOpts with release_conn=true must NOT double-release (both success and error).
    _ = try pool.execOpts(pctx, "SELECT $1::int", .{@as(i32, 7)}, .{ .release_conn = true });
    try testing.expectError(error.PG, pool.execOpts(pctx, "SELECT * FROM o11ypg_missing_exec_rc", .{}, .{ .release_conn = true }));

    // 4. Conn.*Opts with release_conn=true on success, null row, and error.PG (must record 42P01
    //    before releasing and never UAF or leak a pool slot).
    {
        var c = try pool.acquire();
        var res = try c.queryOpts(pctx, "SELECT 1 AS n", .{}, .{ .release_conn = true });
        defer res.deinit();
        const r = (try res.next()) orelse return error.TestUnexpectedResult;
        try testing.expectEqual(@as(i32, 1), try r.get(i32, 0));
    }
    {
        var c = try pool.acquire();
        try testing.expectError(error.PG, c.queryOpts(pctx, "SELECT * FROM o11ypg_missing_conn_q", .{}, .{ .release_conn = true }));
    }
    {
        var c = try pool.acquire();
        try testing.expectEqual(@as(?pg.QueryRow, null), try c.rowOpts(pctx, "SELECT 1 WHERE false", .{}, .{ .release_conn = true }));
    }
    {
        var c = try pool.acquire();
        try testing.expectError(error.PG, c.rowOpts(pctx, "SELECT * FROM o11ypg_missing_conn_r", .{}, .{ .release_conn = true }));
    }
    {
        var c = try pool.acquire();
        _ = try c.execOpts(pctx, "SELECT 1", .{}, .{ .release_conn = true });
    }
    {
        var c = try pool.acquire();
        try testing.expectError(error.PG, c.execOpts(pctx, "SELECT * FROM o11ypg_missing_conn_e", .{}, .{ .release_conn = true }));
    }

    // All pool slots must be cleanly returned (in_use == 0).
    try testing.expectEqual(@as(usize, 0), pool.stats().in_use);

    parent.end();

    for ([_][]const u8{
        "SELECT o11ypg_missing_pool_q",
        "SELECT o11ypg_missing_pool_r",
        "SELECT o11ypg_missing_exec_rc",
        "SELECT o11ypg_missing_conn_q",
        "SELECT o11ypg_missing_conn_r",
        "SELECT o11ypg_missing_conn_e",
    }) |name| {
        const sp = try rec.expectSpan(name);
        try testing.expectEqual(o11y.StatusCode.@"error", sp.status.code);
        try testing.expectEqualStrings("", sp.status.description);
        try testing.expectEqualStrings("PG", findAttr(sp.attributes.items, "error.type").?.string);
        try testing.expectEqualStrings("42P01", findAttr(sp.attributes.items, "db.response.status_code").?.string);
    }

    // Pool.deinit must be idempotent (defer pool.deinit() runs a second time).
    pool.deinit();
}
