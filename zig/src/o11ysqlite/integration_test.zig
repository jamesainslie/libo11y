//! Real in-memory SQLite integration tests for `o11ysqlite` using zig-sqlite's
//! bundled SQLite amalgamation and `o11ytest.Recorder`.

const std = @import("std");
const testing = std.testing;
const sqlite = @import("sqlite");
const o11y = @import("o11y");
const o11ysqlite = @import("o11ysqlite");
const o11ytest = @import("o11ytest");

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

test "o11ysqlite live: CREATE, INSERT, SELECT, prepared statements, sanitization, parent-span gating, and exemplars" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var db = try o11ysqlite.Db.init(.{
        .mode = .Memory,
        .open_flags = .{ .write = true, .create = true },
    }, .{
        .telemetry = rec.telemetry(),
        .database = "test-mem",
    });
    defer db.deinit();

    // 1. Rootless query: NO span emitted, duration metric IS recorded.
    try db.exec(.background, "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, age INTEGER)", .{}, .{});
    try testing.expectEqual(@as(usize, 0), rec.spans().len);
    {
        const hist = try rec.expectMetric("db.client.operation.duration");
        try testing.expectEqualStrings("s", hist.unit);
        try testing.expectEqualSlices(f64, &o11ysqlite.duration_buckets, hist.data.histogram.data_points[0].bounds);
        try testing.expectEqual(@as(u64, 1), hist.data.histogram.data_points[0].count);
        try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(hist.data.histogram.data_points[0].attributes, "db.query.text"));
    }

    // 2. Parented queries: INSERT (literal PII + bound params), SELECT oneAlloc/all,
    //    prepared statement reuse, and SQLite error handling.
    rec.reset();
    var parent = rec.tracer("handler").start(.background, "GET /users", .{});
    defer parent.end();
    const pctx = o11y.Context.background.withSpan(&parent);

    // Literal strings & numbers + SQL comment must be sanitized in db.query.text.
    try db.exec(pctx, "INSERT INTO users (id, email, age) VALUES (1, 'alice@pii.example', 34) -- secret comment", .{}, .{});

    // Prepared statement with parameter binding and reuse.
    var ins_stmt = try db.prepare("INSERT INTO users (id, email, age) VALUES (?, ?, ?)");
    defer ins_stmt.deinit();
    try ins_stmt.exec(pctx, .{}, .{ @as(i64, 2), "bob@pii.example", @as(i64, 29) });
    ins_stmt.reset();
    try ins_stmt.exec(pctx, .{}, .{ @as(i64, 3), "carol@pii.example", @as(i64, 41) });

    // oneAlloc with SQLite double-quoted literal (sanitized to ? under SQLite dialect!).
    const fetched_email = (try db.oneAlloc(pctx, []const u8, testing.allocator, "SELECT email FROM users WHERE id = 1 AND email != \"hidden\"", .{}, .{})) orelse return error.TestUnexpectedResult;
    defer testing.allocator.free(fetched_email);
    try testing.expectEqualStrings("alice@pii.example", fetched_email);

    // allDynamic reading multiple rows.
    const Row = struct {
        id: i64,
        age: i64,
    };
    const rows = try db.allDynamic(pctx, Row, testing.allocator, "SELECT id, age FROM users WHERE age >= ? ORDER BY id", .{}, .{@as(i64, 30)});
    defer testing.allocator.free(rows);
    try testing.expectEqual(@as(usize, 2), rows.len);
    try testing.expectEqual(@as(i64, 1), rows[0].id);
    try testing.expectEqual(@as(i64, 3), rows[1].id);

    // DynamicStatement execution.
    var dyn = try db.prepareDynamic("UPDATE users SET age = ? WHERE id = ?");
    defer dyn.deinit();
    try dyn.exec(pctx, .{}, .{ @as(i64, 35), @as(i64, 1) });

    // Error query: missing table fails during prepare with error.SQLiteError
    // (avoiding zig-sqlite's finalize log.err on step failure) and must set
    // span ERROR with empty description, error.type, and db.response.status_code.
    try testing.expectError(
        error.SQLiteError,
        db.execDynamic(pctx, "SELECT * FROM missing_table WHERE token = 's3cr3t'", .{}, .{}),
    );

    parent.end();

    // Verify spans, attributes, sanitization, and exemplars.
    var insert_count: usize = 0;
    for (rec.spans()) |sp| {
        if (std.mem.eql(u8, sp.name, "INSERT users")) {
            insert_count += 1;
            const qt = findAttr(sp.attributes.items, "db.query.text").?.string;
            try testing.expect(std.mem.indexOf(u8, qt, "alice@pii.example") == null);
            try testing.expect(std.mem.indexOf(u8, qt, "secret comment") == null);
            try testing.expectEqualStrings("sqlite", findAttr(sp.attributes.items, "db.system.name").?.string);
            try testing.expectEqualStrings("test-mem", findAttr(sp.attributes.items, "db.namespace").?.string);
        }
    }
    try testing.expectEqual(@as(usize, 3), insert_count);

    const select_sp = try rec.expectSpan("SELECT users");
    try testing.expectEqual(o11y.SpanKind.client, select_sp.kind);
    try testing.expectEqualSlices(u8, &parent.spanContext().trace_id.bytes, &select_sp.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &parent.spanContext().span_id.bytes, &select_sp.parent.span_id.bytes);
    const select_qt = findAttr(select_sp.attributes.items, "db.query.text").?.string;
    try testing.expect(std.mem.indexOf(u8, select_qt, "hidden") == null);
    try testing.expectEqualStrings("SELECT email FROM users WHERE id = ? AND email != ?", select_qt);

    const update_sp = try rec.expectSpan("UPDATE users");
    try testing.expectEqualStrings("UPDATE", findAttr(update_sp.attributes.items, "db.operation.name").?.string);
    try testing.expectEqualStrings("users", findAttr(update_sp.attributes.items, "db.collection.name").?.string);

    const missing_sp = try rec.expectSpan("SELECT missing_table");
    try testing.expectEqual(o11y.StatusCode.@"error", missing_sp.status.code);
    try testing.expectEqualStrings("", missing_sp.status.description);
    try testing.expectEqualStrings("SQLiteError", findAttr(missing_sp.attributes.items, "error.type").?.string);
    try testing.expectEqualStrings("1", findAttr(missing_sp.attributes.items, "db.response.status_code").?.string);
    const missing_qt = findAttr(missing_sp.attributes.items, "db.query.text").?.string;
    try testing.expect(std.mem.indexOf(u8, missing_qt, "s3cr3t") == null);

    // Duration exemplar attached to a child DB client span (not the parent span).
    const ex = try rec.expectExemplar("db.client.operation.duration", select_sp.span_context.trace_id);
    try testing.expect(!std.mem.eql(u8, &parent.spanContext().span_id.bytes, &ex.span_id.bytes));
    var matched_client_span = false;
    for (rec.spans()) |sp| {
        if (sp.kind == .client and std.mem.eql(u8, &sp.span_context.span_id.bytes, &ex.span_id.bytes)) {
            matched_client_span = true;
            break;
        }
    }
    try testing.expect(matched_client_span);

    try rec.expectConforms();
}

test "o11ysqlite live: query_text=false omits db.query.text and Db.wrap preserves caller ownership" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var raw_db = try sqlite.Db.init(.{
        .mode = .Memory,
        .open_flags = .{ .write = true, .create = true },
    });
    defer raw_db.deinit();

    var wrapped = o11ysqlite.Db.wrap(raw_db, .{
        .telemetry = rec.telemetry(),
        .query_text = false,
    });
    defer wrapped.deinit();

    var parent = rec.tracer("handler").start(.background, "handler", .{});
    const pctx = o11y.Context.background.withSpan(&parent);
    try wrapped.exec(pctx, "CREATE TABLE items (id INTEGER)", .{}, .{});
    parent.end();

    const sp = try rec.expectSpan("CREATE items");
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(sp.attributes.items, "db.query.text"));
}

test "o11ysqlite live: non-SQLite errors omit db.response.status_code and statements survive Db moves" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var moved_db = try o11ysqlite.Db.init(.{
        .mode = .Memory,
        .open_flags = .{ .write = true, .create = true },
    }, .{
        .telemetry = rec.telemetry(),
        .database = "move-test",
    });

    // Prepare statements, then move `Db` by value and overwrite the original stack slot.
    var stmt = try moved_db.prepare("SELECT 1");
    defer stmt.deinit();
    var dyn = try moved_db.prepareDynamic("SELECT 2");
    defer dyn.deinit();

    var db = moved_db;
    moved_db = undefined;
    defer db.deinit();

    var parent = rec.tracer("handler").start(.background, "handler", .{});
    defer parent.end();
    const pctx = o11y.Context.background.withSpan(&parent);

    // Executing statements after Db was moved must work without dangling pointers.
    try testing.expectEqual(@as(?i64, 1), try stmt.one(pctx, i64, .{}, .{}));
    try testing.expectEqual(@as(?i64, 2), try dyn.one(pctx, i64, .{}, .{}));

    // Seed a SQLite error first, then trigger non-SQLite errors (ExecReturnedData
    // and EmptyQuery) to prove neither attaches 100 (SQLITE_ROW) nor a stale code.
    try testing.expectError(error.SQLiteError, db.execDynamic(pctx, "SELECT * FROM no_such_tbl", .{}, .{}));
    try testing.expectError(error.ExecReturnedData, db.execDynamic(pctx, "SELECT 42", .{}, .{}));
    try testing.expectError(error.EmptyQuery, db.execDynamic(pctx, "", .{}, .{}));

    parent.end();

    var saw_exec_returned_data = false;
    var saw_empty_query = false;
    for (rec.spans()) |sp| {
        const et = findAttr(sp.attributes.items, "error.type") orelse continue;
        if (std.mem.eql(u8, et.string, "ExecReturnedData")) {
            saw_exec_returned_data = true;
            try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(sp.attributes.items, "db.response.status_code"));
        } else if (std.mem.eql(u8, et.string, "EmptyQuery")) {
            saw_empty_query = true;
            try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(sp.attributes.items, "db.response.status_code"));
        }
    }
    try testing.expect(saw_exec_returned_data);
    try testing.expect(saw_empty_query);
}
