//! Unit tests for the shared database telemetry helper (`o11y_db`) using
//! `o11ytest.Recorder`.

const std = @import("std");
const testing = std.testing;
const o11y = @import("o11y");
const o11ytest = @import("o11ytest");
const db = @import("o11y_db");

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

test "db telemetry: parented query emits client span with sanitized query text and exemplar; rootless emits metric only" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const ins = db.telemetry.Instrumenter.init(.{
        .telemetry = rec.telemetry(),
        .scope_name = "test/db",
        .system = "postgresql",
        .dialect = .standard,
        .namespace = "appdb",
        .server_address = "127.0.0.1",
        .server_port = 5432,
    });

    // 1. Rootless query: NO span, metric IS recorded.
    {
        const op = ins.beginQuery("UPDATE users SET secret = 'topsecret' WHERE id = 42");
        op.finish(.background, null, null);
        try testing.expectEqual(@as(usize, 0), rec.spans().len);
        const hist = try rec.expectMetric("db.client.operation.duration");
        try testing.expectEqualStrings("s", hist.unit);
        try testing.expectEqualSlices(f64, &db.telemetry.duration_buckets, hist.data.histogram.data_points[0].bounds);
        try testing.expectEqual(@as(u64, 1), hist.data.histogram.data_points[0].count);
        // db.query.text must NEVER appear on metric attributes.
        try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(hist.data.histogram.data_points[0].attributes, "db.query.text"));
    }

    // 2. Parented query: child client span + sanitized db.query.text + exemplar.
    rec.reset();
    var parent = rec.tracer("handler").start(.background, "GET /users/{id}", .{});
    const pctx = o11y.Context.background.withSpan(&parent);
    {
        const op = ins.beginQuery("SELECT id FROM users WHERE email = 'alice@example.com' AND age > 30");
        op.finish(pctx, null, null);
    }
    parent.end();

    const sp = try rec.expectSpan("SELECT users");
    try testing.expectEqual(o11y.SpanKind.client, sp.kind);
    try testing.expectEqualSlices(u8, &parent.spanContext().trace_id.bytes, &sp.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &parent.spanContext().span_id.bytes, &sp.parent.span_id.bytes);
    try testing.expectEqualStrings("postgresql", findAttr(sp.attributes.items, "db.system.name").?.string);
    try testing.expectEqualStrings("SELECT", findAttr(sp.attributes.items, "db.operation.name").?.string);
    try testing.expectEqualStrings("users", findAttr(sp.attributes.items, "db.collection.name").?.string);
    try testing.expectEqualStrings("appdb", findAttr(sp.attributes.items, "db.namespace").?.string);
    try testing.expectEqualStrings("127.0.0.1", findAttr(sp.attributes.items, "server.address").?.string);
    try testing.expectEqual(@as(i64, 5432), findAttr(sp.attributes.items, "server.port").?.int);
    try testing.expectEqualStrings(
        "SELECT id FROM users WHERE email = ? AND age > ?",
        findAttr(sp.attributes.items, "db.query.text").?.string,
    );
    try testing.expectEqual(o11y.StatusCode.unset, sp.status.code);

    const ex = try rec.expectExemplar("db.client.operation.duration", sp.span_context.trace_id);
    try testing.expectEqualSlices(u8, &sp.span_context.span_id.bytes, &ex.span_id.bytes);
    try rec.expectConforms();
}

test "db telemetry: error records error.type and db.response.status_code with empty span description, and query_text=false omits query" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const ins = db.telemetry.Instrumenter.init(.{
        .telemetry = rec.telemetry(),
        .scope_name = "test/db",
        .system = "postgresql",
        .dialect = .standard,
        .query_text = false,
    });

    var parent = rec.tracer("handler").start(.background, "POST /orders", .{});
    const pctx = o11y.Context.background.withSpan(&parent);
    const op = ins.beginQuery("INSERT INTO orders (email) VALUES ('pii@example.com')");
    op.finish(pctx, error.PG, "23505");
    parent.end();

    const sp = try rec.expectSpan("INSERT orders");
    try testing.expectEqual(o11y.StatusCode.@"error", sp.status.code);
    try testing.expectEqualStrings("", sp.status.description);
    try testing.expectEqualStrings("PG", findAttr(sp.attributes.items, "error.type").?.string);
    try testing.expectEqualStrings("23505", findAttr(sp.attributes.items, "db.response.status_code").?.string);
    try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(sp.attributes.items, "db.query.text"));
}

test "db telemetry: query text truncated to 4096 bytes on UTF-8 boundary and invalid UTF-8 replaced" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const ins = db.telemetry.Instrumenter.init(.{
        .telemetry = rec.telemetry(),
        .scope_name = "test/db",
        .system = "postgresql",
        .dialect = .standard,
    });

    // 2-byte 'é' straddling byte 4095..4096.
    const prefix = "SELECT " ++ @as([4088]u8, @splat('a'));
    const full = prefix ++ "é FROM t WHERE x = 'secret'";

    var parent = rec.tracer("handler").start(.background, "handler", .{});
    const pctx = o11y.Context.background.withSpan(&parent);
    ins.beginQuery(full).finish(pctx, null, null);
    ins.beginQuery("SELECT a\xff FROM t\xfe WHERE b = 'x'").finish(pctx, null, null);
    parent.end();

    const sp1 = try rec.expectSpan("SELECT t");
    const qt1 = findAttr(sp1.attributes.items, "db.query.text").?.string;
    try testing.expect(std.unicode.utf8ValidateSlice(qt1));
    try testing.expectEqualStrings(prefix, qt1);

    const sp2 = try rec.expectSpan("SELECT t\u{FFFD}");
    const qt2 = findAttr(sp2.attributes.items, "db.query.text").?.string;
    try testing.expect(std.unicode.utf8ValidateSlice(qt2));
}
