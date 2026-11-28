//! Loopback integration tests for `o11yhttpz` running a real `httpz.Server`
//! bound to `127.0.0.1:0` and driving requests with `o11yhttp.Client` and
//! `std.http.Client`, asserting with `o11ytest.Recorder`.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const testing = std.testing;
const httpz = @import("httpz");
const o11y = @import("o11y");
const spec = o11y.spec;
const o11yhttp = @import("o11yhttp");
const o11yhttpz = @import("o11yhttpz");
const o11ytest = @import("o11ytest");

fn boundPort(fd: std.posix.fd_t) !u16 {
    var addr: std.posix.sockaddr.in = std.mem.zeroes(std.posix.sockaddr.in);
    var len: std.posix.socklen_t = @sizeOf(std.posix.sockaddr.in);
    const rc = std.posix.system.getsockname(fd, @ptrCast(&addr), &len);
    if (std.posix.errno(rc) != .SUCCESS) return error.GetSockNameFailed;
    return std.mem.bigToNative(u16, addr.port);
}

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

test "o11yhttpz loopback: distributed trace, baggage, route template, Server-Timing, canonical line, and duration exemplar" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const State = struct {
        saw_tenant: bool = false,
        saw_user_id: [16]u8 = undefined,
        saw_user_id_len: usize = 0,

        pub fn uncaughtError(_: *@This(), _: *httpz.Request, res: *httpz.Response, _: anyerror) void {
            res.status = 500;
            res.body = "Internal Server Error";
        }
    };
    var state: State = .{};

    const Handlers = struct {
        fn getUser(st: *State, req: *httpz.Request, res: *httpz.Response) !void {
            const ctx = o11yhttpz.context(req);
            if (ctx.baggage) |bag| {
                if (bag.member("tenant")) |m| {
                    st.saw_tenant = std.mem.eql(u8, m.value, "acme");
                }
            }
            if (req.param("id")) |id| {
                const n = @min(id.len, st.saw_user_id.len);
                @memcpy(st.saw_user_id[0..n], id[0..n]);
                st.saw_user_id_len = n;
                o11yhttpz.record(req).set("user.id", id);
            }
            res.status = 200;
            // HTML, so the default Server-Timing setting adds the header.
            res.content_type = .HTML;
            res.body = "hello httpz";
        }

        fn missing(_: *State, req: *httpz.Request, res: *httpz.Response) !void {
            o11yhttpz.setRoute(req, "/missing");
            res.status = 404;
            res.body = "not here";
        }

        fn serverErr(_: *State, req: *httpz.Request, res: *httpz.Response) !void {
            o11yhttpz.setRoute(req, "/boom");
            res.status = 500;
            res.body = "boom";
        }

        fn handlerErr(_: *State, req: *httpz.Request, _: *httpz.Response) !void {
            o11yhttpz.setRoute(req, "/fail");
            return error.DownstreamFailed;
        }
    };

    var server = try httpz.Server(*State).init(testing.io, testing.allocator, .{
        .address = .localhost(0),
        .workers = .{ .count = 1 },
        .thread_pool = .{ .count = 2 },
    }, &state);
    defer server.deinit();

    const mw = try server.middleware(o11yhttpz.Middleware, .{
        .telemetry = rec.telemetry(),
        .route_fn = o11yhttpz.extractRouteData,
        .canonical_line = true,
        .server_timing = true,
    });
    var router = try server.router(.{ .middlewares = &.{mw} });
    router.get("/users/:id", Handlers.getUser, .{ .data = o11yhttpz.route("/users/:id") });
    router.get("/missing", Handlers.missing, .{});
    router.get("/boom", Handlers.serverErr, .{});
    router.get("/fail", Handlers.handlerErr, .{});

    const thread = try server.listenInNewThread();
    defer {
        server.stop();
        thread.join();
    }

    const port = try boundPort(server._listener.?);

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    // 1. 200 OK with distributed traceparent, baggage, RouteData route template,
    //    Server-Timing response header, canonical line, and exemplar!
    {
        var caller = rec.tracer("caller").start(.background, "checkout", .{});
        const bag: o11y.Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
        const caller_ctx = o11y.Context.background.withSpan(&caller).withBaggage(&bag);

        const u = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/users/42?expand=1", .{port});
        defer testing.allocator.free(u);
        const uri = try std.Uri.parse(u);

        var creq = try client.request(caller_ctx, .GET, uri, .{});
        defer creq.deinit();
        try creq.sendBodiless();
        var redir_buf: [512]u8 = undefined;
        var resp = try creq.receiveHead(&redir_buf);
        try testing.expectEqual(std.http.Status.ok, resp.head.status);

        var server_timing: ?[]u8 = null;
        defer if (server_timing) |st_val| testing.allocator.free(st_val);
        var hit = resp.head.iterateHeaders();
        while (hit.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "server-timing")) {
                server_timing = try testing.allocator.dupe(u8, h.value);
            }
        }
        var transfer: [256]u8 = undefined;
        const br = resp.reader(&transfer);
        const body_bytes = try br.allocRemaining(testing.allocator, .limited(4096));
        defer testing.allocator.free(body_bytes);
        caller.end();

        try testing.expectEqualStrings("hello httpz", body_bytes);
        try testing.expect(state.saw_tenant);
        try testing.expectEqualStrings("42", state.saw_user_id[0..state.saw_user_id_len]);

        const srv_span = try rec.expectSpan("GET /users/:id");
        const cli_span = try rec.expectSpan("GET");
        try testing.expectEqual(o11y.SpanKind.server, srv_span.kind);
        try testing.expectEqualSlices(u8, &caller.spanContext().trace_id.bytes, &srv_span.span_context.trace_id.bytes);
        try testing.expectEqualSlices(u8, &cli_span.span_context.span_id.bytes, &srv_span.parent.span_id.bytes);

        try testing.expectEqualStrings("GET", findAttr(srv_span.attributes.items, "http.request.method").?.string);
        try testing.expectEqualStrings("/users/:id", findAttr(srv_span.attributes.items, "http.route").?.string);
        try testing.expectEqualStrings("/users/42", findAttr(srv_span.attributes.items, "url.path").?.string);
        try testing.expectEqualStrings("http", findAttr(srv_span.attributes.items, "url.scheme").?.string);
        try testing.expectEqualStrings("127.0.0.1", findAttr(srv_span.attributes.items, "server.address").?.string);
        try testing.expectEqual(@as(i64, port), findAttr(srv_span.attributes.items, "server.port").?.int);
        try testing.expectEqual(@as(i64, 200), findAttr(srv_span.attributes.items, "http.response.status_code").?.int);
        try testing.expectEqual(o11y.StatusCode.unset, srv_span.status.code);

        var want_st_buf: [o11yhttp.common.server_timing_len]u8 = undefined;
        const want_st = o11yhttp.formatServerTiming(&want_st_buf, srv_span.span_context).?;
        try testing.expectEqualStrings(want_st, server_timing.?);

        const hist = try rec.expectMetric("http.server.request.duration");
        try testing.expectEqualStrings("s", hist.unit);
        try testing.expectEqualSlices(f64, &o11yhttpz.duration_buckets, hist.data.histogram.data_points[0].bounds);
        const ex = try rec.expectExemplar("http.server.request.duration", srv_span.span_context.trace_id);
        try testing.expectEqualSlices(u8, &srv_span.span_context.span_id.bytes, &ex.span_id.bytes);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("GET", ev.attrString("http.request.method").?);
        try testing.expectEqual(@as(i64, 200), ev.attr("http.response.status_code").?.int);
        try testing.expectEqualStrings("success", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqualStrings("/users/:id", ev.attrString("http.route").?);
        try testing.expectEqualStrings("42", ev.attrString("user.id").?);
        try rec.expectCorrelated();
        try rec.expectConforms();
    }

    // 2. 404 Not Found: span stays UNSET, canonical outcome is success.
    {
        rec.reset();
        const u = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/missing", .{port});
        defer testing.allocator.free(u);
        const res = try std_client.fetch(.{ .location = .{ .url = u } });
        try testing.expectEqual(std.http.Status.not_found, res.status);

        const sp = try rec.expectSpan("GET /missing");
        try testing.expectEqual(o11y.StatusCode.unset, sp.status.code);
        try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(sp.attributes.items, "error.type"));
        try testing.expectEqual(@as(i64, 404), findAttr(sp.attributes.items, "http.response.status_code").?.int);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("success", ev.attrString(spec.Outcome.key).?);
    }

    // 3. 500 Internal Server Error: span is ERROR with error.type="500".
    {
        rec.reset();
        const u = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/boom", .{port});
        defer testing.allocator.free(u);
        const res = try std_client.fetch(.{ .location = .{ .url = u } });
        try testing.expectEqual(std.http.Status.internal_server_error, res.status);

        const sp = try rec.expectSpan("GET /boom");
        try testing.expectEqual(o11y.StatusCode.@"error", sp.status.code);
        try testing.expectEqualStrings("500", findAttr(sp.attributes.items, "error.type").?.string);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
    }

    // 4. Handler error: span is ERROR with exception event + error.type="DownstreamFailed" + 500.
    {
        rec.reset();
        const u = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/fail", .{port});
        defer testing.allocator.free(u);
        const res = try std_client.fetch(.{ .location = .{ .url = u } });
        try testing.expectEqual(std.http.Status.internal_server_error, res.status);

        const sp = try rec.expectSpan("GET /fail");
        try testing.expectEqual(o11y.StatusCode.@"error", sp.status.code);
        try testing.expectEqualStrings("DownstreamFailed", findAttr(sp.attributes.items, "error.type").?.string);
        try testing.expectEqual(@as(i64, 500), findAttr(sp.attributes.items, "http.response.status_code").?.int);
        try testing.expectEqual(@as(usize, 1), sp.events.items.len);
        try testing.expectEqualStrings("exception", sp.events.items[0].name);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
    }
}

test "o11yhttpz loopback: public_endpoint links inbound trace and ignore_paths/filter skip instrumentation" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handlers = struct {
        fn ok(req: *httpz.Request, res: *httpz.Response) !void {
            if (std.mem.eql(u8, req.url.path, "/public")) {
                o11yhttpz.setRoute(req, "/public");
            }
            res.status = 200;
            res.body = "ok";
        }
    };

    var server = try httpz.Server(void).init(testing.io, testing.allocator, .{
        .address = .localhost(0),
        .workers = .{ .count = 1 },
        .thread_pool = .{ .count = 2 },
    }, {});
    defer server.deinit();

    const mw = try server.middleware(o11yhttpz.Middleware, .{
        .telemetry = rec.telemetry(),
        .public_endpoint = true,
        .ignore_paths = &.{ "/healthz", "/debug/*" },
        .filter = struct {
            fn allow(req: *const httpz.Request) bool {
                return !std.mem.startsWith(u8, req.url.path, "/skip");
            }
        }.allow,
        .canonical_line = true,
    });
    var router = try server.router(.{ .middlewares = &.{mw} });
    router.get("/healthz", Handlers.ok, .{});
    router.get("/debug/vars", Handlers.ok, .{});
    router.get("/skip/me", Handlers.ok, .{});
    router.get("/public", Handlers.ok, .{});

    const thread = try server.listenInNewThread();
    defer {
        server.stop();
        thread.join();
    }

    const port = try boundPort(server._listener.?);

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();

    for ([_][]const u8{ "/healthz", "/debug/vars", "/skip/me" }) |p| {
        const u = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}{s}", .{ port, p });
        defer testing.allocator.free(u);
        const res = try std_client.fetch(.{ .location = .{ .url = u } });
        try testing.expectEqual(std.http.Status.ok, res.status);
    }
    try testing.expectEqual(@as(usize, 0), rec.spans().len);
    try testing.expectEqual(@as(usize, 0), rec.logs().len);

    // Hit /public with an inbound client traceparent: public_endpoint MUST link, not parent!
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });
    const pub_url = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/public", .{port});
    defer testing.allocator.free(pub_url);
    const res = try client.fetch(.background, .{ .location = .{ .url = pub_url } });
    try testing.expectEqual(std.http.Status.ok, res.status);

    const cli_span = try rec.expectSpan("GET");
    const srv_span = try rec.expectSpan("GET /public");
    try testing.expect(!srv_span.parent.isValid());
    try testing.expect(!std.mem.eql(u8, &cli_span.span_context.trace_id.bytes, &srv_span.span_context.trace_id.bytes));
    try testing.expectEqual(@as(usize, 1), srv_span.links.items.len);
    try testing.expectEqualSlices(u8, &cli_span.span_context.trace_id.bytes, &srv_span.links.items[0].span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &cli_span.span_context.span_id.bytes, &srv_span.links.items[0].span_context.span_id.bytes);
    try testing.expect(srv_span.links.items[0].span_context.remote);
}
