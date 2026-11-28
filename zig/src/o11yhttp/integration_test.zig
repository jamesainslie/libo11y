//! Loopback integration and parity tests for `o11yhttp` using `o11ytest`.
//!
//! Spins up a real loopback `std.http.Server` on `127.0.0.1:0` wrapped with
//! `o11yhttp.Server` and drives it with `o11yhttp.Client`, asserting
//! end-to-end trace/baggage propagation, `public_endpoint`, `ignore_paths`,
//! `filter`, `canonical_line`, `Server-Timing`, 200/404/500/handler-error
//! semantics, duration histograms with exemplars, URL credential stripping,
//! and libo11y conformance.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const net = Io.net;
const testing = std.testing;
const o11y = @import("o11y");
const spec = o11y.spec;
const o11yhttp = @import("o11yhttp");
const o11ytest = @import("o11ytest");

/// Deterministic loopback HTTP test server wrapping `std.http.Server` and
/// `o11yhttp.Server`. Signals `cond` AFTER `o11yhttp.Server.handle` returns
/// (so `sreq.finish()` has already ended the span and emitted metrics/summary)
/// eliminating all race conditions without sleeps.
fn LoopbackServer(comptime HandlerCtx: type, comptime handler_fn: anytype) type {
    return struct {
        const Self = @This();

        gpa: Allocator,
        io: Io,
        listener: net.Server,
        http_server: o11yhttp.Server,
        handler_ctx: HandlerCtx,
        accept_task: Io.Future(Io.Cancelable!void) = undefined,
        group: Io.Group = .init,
        mutex: Io.Mutex = .init,
        cond: Io.Condition = .init,
        handled: usize = 0,
        last_err: ?anyerror = null,
        open: std.ArrayList(net.Socket.Handle) = .empty,

        fn start(
            gpa: Allocator,
            io: Io,
            server_opts: o11yhttp.ServerOptions,
            handler_ctx: HandlerCtx,
        ) !*Self {
            const self = try gpa.create(Self);
            errdefer gpa.destroy(self);
            const addr = try net.IpAddress.parse("127.0.0.1", 0);
            var listener = try addr.listen(io, .{ .reuse_address = true });
            errdefer listener.deinit(io);
            self.* = .{
                .gpa = gpa,
                .io = io,
                .listener = listener,
                .http_server = o11yhttp.Server.init(server_opts),
                .handler_ctx = handler_ctx,
            };
            self.accept_task = try io.concurrent(acceptLoop, .{self});
            return self;
        }

        fn deinit(self: *Self) void {
            const io = self.io;
            const ls: net.Stream = .{ .socket = self.listener.socket };
            ls.shutdown(io, .both) catch {};
            self.accept_task.cancel(io) catch {};
            {
                self.mutex.lockUncancelable(io);
                defer self.mutex.unlock(io);
                for (self.open.items) |h| {
                    const s: net.Stream = .{ .socket = .{ .handle = h, .address = self.listener.socket.address } };
                    s.shutdown(io, .both) catch {};
                }
            }
            self.group.cancel(io);
            self.listener.deinit(io);
            self.open.deinit(self.gpa);
            self.gpa.destroy(self);
        }

        fn port(self: *const Self) u16 {
            return self.listener.socket.address.getPort();
        }

        fn url(self: *const Self, gpa: Allocator, path: []const u8) ![]u8 {
            return std.fmt.allocPrint(gpa, "http://127.0.0.1:{d}{s}", .{ self.port(), path });
        }

        fn waitHandled(self: *Self, n: usize) !void {
            const until: Io.Timeout = (Io.Timeout{ .duration = .{ .raw = .fromSeconds(5), .clock = .awake } }).toDeadline(self.io);
            self.mutex.lockUncancelable(self.io);
            defer self.mutex.unlock(self.io);
            while (self.handled < n) {
                try self.cond.waitTimeout(self.io, &self.mutex, until);
            }
        }

        fn acceptLoop(self: *Self) Io.Cancelable!void {
            const io = self.io;
            while (true) {
                const stream = self.listener.accept(io) catch |err| switch (err) {
                    error.Canceled => return error.Canceled,
                    error.ConnectionAborted => continue,
                    else => return,
                };
                {
                    self.mutex.lockUncancelable(io);
                    defer self.mutex.unlock(io);
                    self.open.append(self.gpa, stream.socket.handle) catch {
                        stream.close(io);
                        continue;
                    };
                }
                self.group.concurrent(io, serveConn, .{ self, stream }) catch {
                    self.forget(stream.socket.handle);
                    stream.close(io);
                };
            }
        }

        fn forget(self: *Self, handle: net.Socket.Handle) void {
            self.mutex.lockUncancelable(self.io);
            defer self.mutex.unlock(self.io);
            for (self.open.items, 0..) |h, i| {
                if (h == handle) {
                    _ = self.open.swapRemove(i);
                    return;
                }
            }
        }

        fn serveConn(self: *Self, stream: net.Stream) Io.Cancelable!void {
            const io = self.io;
            defer {
                self.forget(stream.socket.handle);
                stream.close(io);
            }
            var in_buf: [8192]u8 = undefined;
            var out_buf: [8192]u8 = undefined;
            var sr = stream.reader(io, &in_buf);
            var sw = stream.writer(io, &out_buf);
            var srv = std.http.Server.init(&sr.interface, &sw.interface);

            while (true) {
                var req = srv.receiveHead() catch return;
                const keep_alive = req.head.keep_alive;
                var err_seen: ?anyerror = null;
                self.http_server.handle(self.gpa, &req, null, self.handler_ctx, handler_fn) catch |err| {
                    err_seen = err;
                };
                {
                    self.mutex.lockUncancelable(io);
                    defer self.mutex.unlock(io);
                    self.handled += 1;
                    self.last_err = err_seen;
                    self.cond.broadcast(io);
                }
                if (!keep_alive or srv.reader.state != .ready) return;
            }
        }
    };
}

fn findAttr(attrs: []const o11y.Attribute, key: []const u8) ?o11y.AttributeValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

test "o11yhttp loopback: client-to-server distributed trace, baggage egress, route naming, and duration exemplars" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{
        .baggage_egress_allow = struct {
            fn allow(key: []const u8) bool {
                return std.mem.eql(u8, key, "tenant");
            }
        }.allow,
    });
    defer rec.deinit();

    const State = struct {
        mutex: Io.Mutex = .init,
        got_tenant: [32]u8 = undefined,
        got_tenant_len: usize = 0,
        saw_secret_bag: bool = false,
        io: Io,
    };
    var state: State = .{ .io = testing.io };

    const Handler = struct {
        fn run(st: *State, sreq: *o11yhttp.ServerRequest) !void {
            sreq.setRoute("/users/{id}");
            const ctx = sreq.context();
            if (ctx.baggage) |bag| {
                st.mutex.lockUncancelable(st.io);
                defer st.mutex.unlock(st.io);
                if (bag.member("tenant")) |m| {
                    const n = @min(m.value.len, st.got_tenant.len);
                    @memcpy(st.got_tenant[0..n], m.value[0..n]);
                    st.got_tenant_len = n;
                }
                if (bag.member("session") != null) {
                    st.saw_secret_bag = true;
                }
            }
            try sreq.respond("hello user", .{ .status = .ok });
        }
    };

    const srv = try LoopbackServer(*State, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
    }, &state);
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{
        .telemetry = rec.telemetry(),
        .peer_service = "users-api",
    });

    // Start an outer caller span with baggage ("tenant" allowed, "session" filtered by egress).
    var caller = rec.tracer("caller").start(.background, "checkout", .{});
    const bag: o11y.Baggage = .{ .members = &.{
        .{ .key = "tenant", .value = "acme" },
        .{ .key = "session", .value = "s-secret" },
    } };
    const caller_ctx = o11y.Context.background.withSpan(&caller).withBaggage(&bag);

    const req_url = try srv.url(testing.allocator, "/users/42?expand=true");
    defer testing.allocator.free(req_url);

    var body: Io.Writer.Allocating = .init(testing.allocator);
    defer body.deinit();
    const res = try client.fetch(caller_ctx, .{
        .location = .{ .url = req_url },
        .response_writer = &body.writer,
    });
    caller.end();
    try srv.waitHandled(1);

    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expectEqualStrings("hello user", body.written());
    try testing.expectEqualStrings("acme", state.got_tenant[0..state.got_tenant_len]);
    try testing.expect(!state.saw_secret_bag);

    // Expect 3 spans: caller, client ("GET"), server ("GET /users/{id}").
    const server_span = try rec.expectSpan("GET /users/{id}");
    const client_span = try rec.expectSpan("GET");

    try testing.expectEqual(o11y.SpanKind.server, server_span.kind);
    try testing.expectEqual(o11y.SpanKind.client, client_span.kind);

    // Distributed trace linkage: caller -> client -> server.
    try testing.expectEqualSlices(u8, &caller.spanContext().trace_id.bytes, &client_span.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &caller.spanContext().span_id.bytes, &client_span.parent.span_id.bytes);
    try testing.expectEqualSlices(u8, &caller.spanContext().trace_id.bytes, &server_span.span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &client_span.span_context.span_id.bytes, &server_span.parent.span_id.bytes);

    // Stable HTTP semconv attributes on server span.
    try testing.expectEqualStrings("GET", findAttr(server_span.attributes.items, "http.request.method").?.string);
    try testing.expectEqualStrings("/users/{id}", findAttr(server_span.attributes.items, "http.route").?.string);
    try testing.expectEqualStrings("/users/42", findAttr(server_span.attributes.items, "url.path").?.string);
    try testing.expectEqualStrings("http", findAttr(server_span.attributes.items, "url.scheme").?.string);
    try testing.expectEqual(@as(i64, 200), findAttr(server_span.attributes.items, "http.response.status_code").?.int);
    try testing.expectEqual(o11y.StatusCode.unset, server_span.status.code);

    // Stable HTTP semconv attributes on client span.
    try testing.expectEqualStrings("GET", findAttr(client_span.attributes.items, "http.request.method").?.string);
    try testing.expectEqualStrings("127.0.0.1", findAttr(client_span.attributes.items, "server.address").?.string);
    try testing.expectEqual(@as(i64, srv.port()), findAttr(client_span.attributes.items, "server.port").?.int);
    try testing.expectEqualStrings("users-api", findAttr(client_span.attributes.items, "peer.service").?.string);
    try testing.expectEqual(@as(i64, 200), findAttr(client_span.attributes.items, "http.response.status_code").?.int);
    try testing.expectEqual(o11y.StatusCode.unset, client_span.status.code);

    // Duration histograms with stable buckets AND trace exemplars!
    const srv_hist = try rec.expectMetric("http.server.request.duration");
    try testing.expectEqualStrings("s", srv_hist.unit);
    try testing.expectEqualSlices(f64, &o11yhttp.duration_buckets, srv_hist.data.histogram.data_points[0].bounds);
    const srv_ex = try rec.expectExemplar("http.server.request.duration", server_span.span_context.trace_id);
    try testing.expectEqualSlices(u8, &server_span.span_context.span_id.bytes, &srv_ex.span_id.bytes);

    const cli_hist = try rec.expectMetric("http.client.request.duration");
    try testing.expectEqualStrings("s", cli_hist.unit);
    try testing.expectEqualSlices(f64, &o11yhttp.duration_buckets, cli_hist.data.histogram.data_points[0].bounds);
    const cli_ex = try rec.expectExemplar("http.client.request.duration", client_span.span_context.trace_id);
    try testing.expectEqualSlices(u8, &client_span.span_context.span_id.bytes, &cli_ex.span_id.bytes);

    try rec.expectConforms();
}

test "o11yhttp loopback: public_endpoint links inbound span instead of parenting while preserving baggage" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var saw_tenant = false;
    const Handler = struct {
        fn run(flag: *bool, sreq: *o11yhttp.ServerRequest) !void {
            if (sreq.context().baggage) |bag| {
                if (bag.member("tenant")) |m| {
                    flag.* = std.mem.eql(u8, m.value, "acme");
                }
            }
            try sreq.respond("ok", .{ .status = .ok });
        }
    };

    const srv = try LoopbackServer(*bool, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .public_endpoint = true,
        .operation = "public-api",
    }, &saw_tenant);
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    const bag: o11y.Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    const req_url = try srv.url(testing.allocator, "/public");
    defer testing.allocator.free(req_url);

    const res = try client.fetch(o11y.Context.background.withBaggage(&bag), .{
        .location = .{ .url = req_url },
    });
    try srv.waitHandled(1);
    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expect(saw_tenant);

    const client_span = try rec.expectSpan("GET");
    const server_span = try rec.expectSpan("public-api");

    // Public endpoint MUST start a new root trace (no parent, different trace_id)
    // and link to the inbound remote client span!
    try testing.expect(!server_span.parent.isValid());
    try testing.expect(!std.mem.eql(u8, &client_span.span_context.trace_id.bytes, &server_span.span_context.trace_id.bytes));
    try testing.expectEqual(@as(usize, 1), server_span.links.items.len);
    try testing.expectEqualSlices(u8, &client_span.span_context.trace_id.bytes, &server_span.links.items[0].span_context.trace_id.bytes);
    try testing.expectEqualSlices(u8, &client_span.span_context.span_id.bytes, &server_span.links.items[0].span_context.span_id.bytes);
    try testing.expect(server_span.links.items[0].span_context.remote);
}

test "o11yhttp loopback: ignore_paths globs and custom filter skip spans, metrics, and canonical lines" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn run(sreq: *o11yhttp.ServerRequest) !void {
            if (std.mem.eql(u8, sreq.path(), "/work")) {
                sreq.setRoute("/work");
            }
            try sreq.respond("ok", .{ .status = .ok });
        }
    };

    const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .ignore_paths = &.{ "/healthz", "/debug/*" },
        .filter = struct {
            fn allow(method: []const u8, target: []const u8) bool {
                _ = method;
                return !std.mem.startsWith(u8, target, "/skip");
            }
        }.allow,
        .canonical_line = true,
        .server_timing = true,
    }, {});
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();

    const targets = [_][]const u8{ "/healthz", "/debug/vars", "/skip/me", "/work" };
    for (targets, 1..) |path, idx| {
        const u = try srv.url(testing.allocator, path);
        defer testing.allocator.free(u);
        const res = try std_client.fetch(.{ .location = .{ .url = u } });
        try testing.expectEqual(std.http.Status.ok, res.status);
        try srv.waitHandled(idx);
    }

    // Only `/work` should have produced a span and a canonical summary event.
    try testing.expectEqual(@as(usize, 1), rec.spans().len);
    const sp = try rec.expectSpan("GET /work");
    try testing.expectEqualStrings("/work", findAttr(sp.attributes.items, "http.route").?.string);

    var summaries: usize = 0;
    for (rec.logs()) |l| {
        if (l.eventName()) |en| {
            if (std.mem.eql(u8, en, spec.event.request_summary)) summaries += 1;
        }
    }
    try testing.expectEqual(@as(usize, 1), summaries);
    try rec.expectCorrelated();
    try rec.expectConforms();
}

test "o11yhttp loopback: canonical_line, Server-Timing, route_fn, and 200/404/500/handler-error semantics" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn routeFn(_: []const u8, path: []const u8) ?[]const u8 {
            if (std.mem.startsWith(u8, path, "/orders/")) return "/orders/{id}";
            return null;
        }

        fn run(sreq: *o11yhttp.ServerRequest) !void {
            const p = sreq.path();
            if (std.mem.eql(u8, p, "/orders/42")) {
                const r = o11y.recordFromContext(sreq.context());
                r.set("order.id", "42");
                r.add("db.queries", 2);
                try sreq.respond("<html>ok</html>", .{
                    .status = .ok,
                    .extra_headers = &.{.{ .name = "content-type", .value = "text/html; charset=utf-8" }},
                });
                return;
            }
            if (std.mem.eql(u8, p, "/missing")) {
                sreq.setRoute("/missing");
                try sreq.respond("nope", .{ .status = .not_found });
                return;
            }
            if (std.mem.eql(u8, p, "/server-err")) {
                sreq.setRoute("/server-err");
                try sreq.respond("boom", .{ .status = .internal_server_error });
                return;
            }
            if (std.mem.eql(u8, p, "/handler-err")) {
                sreq.setRoute("/handler-err");
                return error.DatabaseUnavailable;
            }
            if (std.mem.eql(u8, p, "/err-after-201")) {
                sreq.setRoute("/err-after-201");
                try sreq.respond("created", .{ .status = .created });
                return error.AfterCommit;
            }
            try sreq.respond("ok", .{ .status = .ok });
        }
    };

    const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .route_fn = Handler.routeFn,
        .canonical_line = true,
        .server_timing = true,
    }, {});
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    // 1. 200 OK with Server-Timing header verification via Client.request!
    {
        const u = try srv.url(testing.allocator, "/orders/42");
        defer testing.allocator.free(u);
        const uri = try std.Uri.parse(u);
        var creq = try client.request(.background, .GET, uri, .{});
        defer creq.deinit();
        try creq.sendBodiless();
        var redir_buf: [1024]u8 = undefined;
        var resp = try creq.receiveHead(&redir_buf);
        try testing.expectEqual(std.http.Status.ok, resp.head.status);

        var server_timing: ?[]u8 = null;
        defer if (server_timing) |st| testing.allocator.free(st);
        var hit = resp.head.iterateHeaders();
        while (hit.next()) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, "server-timing")) {
                server_timing = try testing.allocator.dupe(u8, h.value);
            }
        }
        var transfer: [256]u8 = undefined;
        const body_r = resp.reader(&transfer);
        _ = try body_r.discardRemaining();
        try srv.waitHandled(1);

        const order_span = try rec.expectSpan("GET /orders/{id}");
        var want_st_buf: [o11yhttp.common.server_timing_len]u8 = undefined;
        const want_st = o11yhttp.formatServerTiming(&want_st_buf, order_span.span_context).?;
        try testing.expectEqualStrings(want_st, server_timing.?);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("GET", ev.attrString("http.request.method").?);
        try testing.expectEqual(@as(i64, 200), ev.attr("http.response.status_code").?.int);
        try testing.expectEqualStrings("success", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqualStrings("/orders/{id}", ev.attrString("http.route").?);
        try testing.expectEqualStrings("42", ev.attrString("order.id").?);
        try testing.expectEqual(@as(i64, 2), ev.attr("db.queries").?.int);
        try rec.expectCorrelated();
        try rec.expectConforms();
    }

    // 2. 404 Not Found: server span stays UNSET, client span is ERROR ("404").
    {
        rec.reset();
        const u = try srv.url(testing.allocator, "/missing");
        defer testing.allocator.free(u);
        const res = try client.fetch(.background, .{ .location = .{ .url = u } });
        try srv.waitHandled(2);
        try testing.expectEqual(std.http.Status.not_found, res.status);

        const srv_sp = try rec.expectSpan("GET /missing");
        try testing.expectEqual(o11y.StatusCode.unset, srv_sp.status.code);
        try testing.expectEqual(@as(?o11y.AttributeValue, null), findAttr(srv_sp.attributes.items, "error.type"));
        try testing.expectEqual(@as(i64, 404), findAttr(srv_sp.attributes.items, "http.response.status_code").?.int);

        const cli_sp = try rec.expectSpan("GET");
        try testing.expectEqual(o11y.StatusCode.@"error", cli_sp.status.code);
        try testing.expectEqualStrings("404", findAttr(cli_sp.attributes.items, "error.type").?.string);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("success", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqual(@as(i64, 404), ev.attr("http.response.status_code").?.int);
    }

    // 3. 500 Internal Server Error: both server and client spans ERROR ("500"), canonical outcome failure.
    {
        rec.reset();
        const u = try srv.url(testing.allocator, "/server-err");
        defer testing.allocator.free(u);
        const res = try client.fetch(.background, .{ .location = .{ .url = u } });
        try srv.waitHandled(3);
        try testing.expectEqual(std.http.Status.internal_server_error, res.status);

        const srv_sp = try rec.expectSpan("GET /server-err");
        try testing.expectEqual(o11y.StatusCode.@"error", srv_sp.status.code);
        try testing.expectEqualStrings("500", findAttr(srv_sp.attributes.items, "error.type").?.string);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqual(@as(i64, 500), ev.attr("http.response.status_code").?.int);
    }

    // 4. Handler returns error before writing response -> 500 + recordError + ERROR status + failure outcome.
    {
        rec.reset();
        const u = try srv.url(testing.allocator, "/handler-err");
        defer testing.allocator.free(u);
        const res = try client.fetch(.background, .{ .location = .{ .url = u } });
        try srv.waitHandled(4);
        try testing.expectEqual(std.http.Status.internal_server_error, res.status);

        const srv_sp = try rec.expectSpan("GET /handler-err");
        try testing.expectEqual(o11y.StatusCode.@"error", srv_sp.status.code);
        try testing.expectEqualStrings("DatabaseUnavailable", findAttr(srv_sp.attributes.items, "error.type").?.string);
        try testing.expectEqual(@as(i64, 500), findAttr(srv_sp.attributes.items, "http.response.status_code").?.int);
        try testing.expectEqual(@as(usize, 1), srv_sp.events.items.len);
        try testing.expectEqualStrings("exception", srv_sp.events.items[0].name);
        try testing.expectEqualStrings(
            "error.DatabaseUnavailable",
            findAttr(srv_sp.events.items[0].attributes, "exception.type").?.string,
        );

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqual(@as(i64, 500), ev.attr("http.response.status_code").?.int);
    }

    // 5. Handler commits 201 and then returns error -> status stays 201, span is ERROR, outcome is failure.
    {
        rec.reset();
        const u = try srv.url(testing.allocator, "/err-after-201");
        defer testing.allocator.free(u);
        const res = try client.fetch(.background, .{ .location = .{ .url = u } });
        try srv.waitHandled(5);
        try testing.expectEqual(std.http.Status.created, res.status);

        const srv_sp = try rec.expectSpan("GET /err-after-201");
        try testing.expectEqual(o11y.StatusCode.@"error", srv_sp.status.code);
        try testing.expectEqual(@as(i64, 201), findAttr(srv_sp.attributes.items, "http.response.status_code").?.int);

        const ev = try rec.expectEvent(spec.event.request_summary);
        try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
        try testing.expectEqual(@as(i64, 201), ev.attr("http.response.status_code").?.int);
    }
}

test "o11yhttp loopback: Server-Timing goes on HTML responses only unless the option says otherwise" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn run(sreq: *o11yhttp.ServerRequest) !void {
            if (std.mem.eql(u8, sreq.path(), "/page")) {
                try sreq.respond("<html></html>", .{
                    .extra_headers = &.{.{ .name = "content-type", .value = "text/html; charset=utf-8" }},
                });
                return;
            }
            try sreq.respond("{}", .{
                .extra_headers = &.{.{ .name = "content-type", .value = "application/json" }},
            });
        }
    };
    const Probe = struct {
        /// Reports whether the response to `path` carries Server-Timing.
        fn hasServerTiming(server_url: []const u8, client: *std.http.Client) !bool {
            var req = try client.request(.GET, try std.Uri.parse(server_url), .{});
            defer req.deinit();
            try req.sendBodiless();
            var resp = try req.receiveHead(&.{});
            var found = false;
            var headers = resp.head.iterateHeaders();
            while (headers.next()) |h| {
                if (std.ascii.eqlIgnoreCase(h.name, "server-timing")) found = true;
            }
            var transfer: [256]u8 = undefined;
            _ = try resp.reader(&transfer).discardRemaining();
            return found;
        }
    };

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();

    // The default, as Go's WithServerTiming: an API response does not
    // expose trace IDs to its callers.
    {
        const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
            .telemetry = rec.telemetry(),
            .server_timing = true,
        }, {});
        defer srv.deinit();
        const page = try srv.url(testing.allocator, "/page");
        defer testing.allocator.free(page);
        const json = try srv.url(testing.allocator, "/json");
        defer testing.allocator.free(json);
        try testing.expect(try Probe.hasServerTiming(page, &std_client));
        try testing.expect(!try Probe.hasServerTiming(json, &std_client));
    }
    {
        const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
            .telemetry = rec.telemetry(),
            .server_timing = true,
            .server_timing_html_only = false,
        }, {});
        defer srv.deinit();
        const json = try srv.url(testing.allocator, "/json");
        defer testing.allocator.free(json);
        try testing.expect(try Probe.hasServerTiming(json, &std_client));
    }
}

test "o11yhttp client: strips credentials from url.full, honors propagate_fn, and records transport errors" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    var saw_traceparent = false;
    const Handler = struct {
        fn run(flag: *bool, sreq: *o11yhttp.ServerRequest) !void {
            flag.* = sreq.header("traceparent") != null;
            try sreq.respond("ok", .{ .status = .ok });
        }
    };

    const srv = try LoopbackServer(*bool, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "upstream",
    }, &saw_traceparent);
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();

    // propagate_fn returning false suppresses outbound traceparent header.
    const no_prop_client = o11yhttp.Client.init(&std_client, .{
        .telemetry = rec.telemetry(),
        .propagate_fn = struct {
            fn allow(_: std.Uri) bool {
                return false;
            }
        }.allow,
    });

    const auth_url = try std.fmt.allocPrint(testing.allocator, "http://alice:s3cr3t@127.0.0.1:{d}/secret", .{srv.port()});
    defer testing.allocator.free(auth_url);

    const res = try no_prop_client.fetch(.background, .{ .location = .{ .url = auth_url } });
    try srv.waitHandled(1);
    try testing.expectEqual(std.http.Status.ok, res.status);
    try testing.expect(!saw_traceparent);

    // Client span url.full must NOT contain credentials.
    const cli_span = try rec.expectSpan("GET");
    const url_full = findAttr(cli_span.attributes.items, "url.full").?.string;
    try testing.expect(std.mem.indexOf(u8, url_full, "alice") == null);
    try testing.expect(std.mem.indexOf(u8, url_full, "s3cr3t") == null);
    try testing.expect(std.mem.endsWith(u8, url_full, "/secret"));

    // Transport error (dialing a closed loopback port) marks client span ERROR + exception + metric.
    rec.reset();
    const closed_addr = try net.IpAddress.parse("127.0.0.1", 0);
    var temp_listener = try closed_addr.listen(testing.io, .{});
    const closed_port = temp_listener.socket.address.getPort();
    temp_listener.deinit(testing.io);

    const dead_url = try std.fmt.allocPrint(testing.allocator, "http://127.0.0.1:{d}/dead", .{closed_port});
    defer testing.allocator.free(dead_url);

    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });
    const err_res = client.fetch(.background, .{ .location = .{ .url = dead_url } });
    try testing.expect(std.meta.isError(err_res));

    const err_span = try rec.expectSpan("GET");
    try testing.expectEqual(o11y.StatusCode.@"error", err_span.status.code);
    try testing.expect(findAttr(err_span.attributes.items, "error.type") != null);
    try testing.expectEqual(@as(usize, 1), err_span.events.items.len);
    try testing.expectEqualStrings("exception", err_span.events.items[0].name);
}

test "o11yhttp loopback: cross-origin redirect strips propagated trace and baggage headers, same-origin keeps them" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const LandingState = struct {
        saw_traceparent: bool = false,
        saw_baggage: bool = false,
        saw_custom: bool = false,
        saw_priv: bool = false,
    };
    var cross_state: LandingState = .{};

    const LandingHandler = struct {
        fn run(st: *LandingState, sreq: *o11yhttp.ServerRequest) !void {
            st.saw_traceparent = sreq.header("traceparent") != null;
            st.saw_baggage = sreq.header("baggage") != null;
            st.saw_custom = sreq.header("x-custom") != null;
            st.saw_priv = sreq.header("x-secret") != null;
            try sreq.respond("landed", .{ .status = .ok });
        }
    };

    const target_srv = try LoopbackServer(*LandingState, LandingHandler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "cross-target",
    }, &cross_state);
    defer target_srv.deinit();

    const RedirectCtx = struct {
        cross_target_url: []const u8,
        same_origin_saw_tp: bool = false,
    };
    const cross_url = try target_srv.url(testing.allocator, "/cross");
    defer testing.allocator.free(cross_url);
    var rctx: RedirectCtx = .{ .cross_target_url = cross_url };

    const OriginHandler = struct {
        fn run(rc: *RedirectCtx, sreq: *o11yhttp.ServerRequest) !void {
            if (std.mem.eql(u8, sreq.path(), "/go-cross")) {
                try sreq.respond("", .{
                    .status = .found,
                    .extra_headers = &.{.{ .name = "location", .value = rc.cross_target_url }},
                });
                return;
            }
            if (std.mem.eql(u8, sreq.path(), "/go-same")) {
                try sreq.respond("", .{
                    .status = .found,
                    .extra_headers = &.{.{ .name = "location", .value = "/same-landing" }},
                });
                return;
            }
            rc.same_origin_saw_tp = sreq.header("traceparent") != null;
            try sreq.respond("same-ok", .{ .status = .ok });
        }
    };

    const origin_srv = try LoopbackServer(*RedirectCtx, OriginHandler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "origin",
    }, &rctx);
    defer origin_srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    const bag: o11y.Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    const ctx = o11y.Context.background.withBaggage(&bag);

    // 1. Cross-origin redirect (different port -> different origin): traceparent,
    // baggage, and privileged headers must NOT leak; normal extra headers stay.
    {
        const u = try origin_srv.url(testing.allocator, "/go-cross");
        defer testing.allocator.free(u);
        var body: Io.Writer.Allocating = .init(testing.allocator);
        defer body.deinit();
        const res = try client.fetch(ctx, .{
            .location = .{ .url = u },
            .response_writer = &body.writer,
            .extra_headers = &.{.{ .name = "x-custom", .value = "keep" }},
            .privileged_headers = &.{.{ .name = "x-secret", .value = "drop" }},
        });
        try origin_srv.waitHandled(1);
        try target_srv.waitHandled(1);
        try testing.expectEqual(std.http.Status.ok, res.status);
        try testing.expectEqualStrings("landed", body.written());
        try testing.expect(!cross_state.saw_traceparent);
        try testing.expect(!cross_state.saw_baggage);
        try testing.expect(!cross_state.saw_priv);
        try testing.expect(cross_state.saw_custom);
    }

    // 2. Same-origin redirect (relative path on same host:port): traceparent stays.
    {
        const u = try origin_srv.url(testing.allocator, "/go-same");
        defer testing.allocator.free(u);
        var body: Io.Writer.Allocating = .init(testing.allocator);
        defer body.deinit();
        const res = try client.fetch(ctx, .{
            .location = .{ .url = u },
            .response_writer = &body.writer,
        });
        try origin_srv.waitHandled(3);
        try testing.expectEqual(std.http.Status.ok, res.status);
        try testing.expectEqualStrings("same-ok", body.written());
        try testing.expect(rctx.same_origin_saw_tp);
    }
}

test "o11yhttp client: a redirect back to the first origin does not restore stripped headers" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    // Another origin that sends the request straight back.
    const Bounce = struct {
        back_url: []const u8 = "",
        fn run(self: *@This(), sreq: *o11yhttp.ServerRequest) !void {
            try sreq.respond("", .{
                .status = .found,
                .extra_headers = &.{.{ .name = "location", .value = self.back_url }},
            });
        }
    };
    var bounce: Bounce = .{};
    const other = try LoopbackServer(*Bounce, Bounce.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "other",
    }, &bounce);
    defer other.deinit();

    const Origin = struct {
        out_url: []const u8,
        saw_traceparent: bool = false,
        saw_secret: bool = false,
        saw_custom: bool = false,
        fn run(self: *@This(), sreq: *o11yhttp.ServerRequest) !void {
            if (std.mem.eql(u8, sreq.path(), "/out")) {
                try sreq.respond("", .{
                    .status = .found,
                    .extra_headers = &.{.{ .name = "location", .value = self.out_url }},
                });
                return;
            }
            self.saw_traceparent = sreq.header("traceparent") != null;
            self.saw_secret = sreq.header("x-secret") != null;
            self.saw_custom = sreq.header("x-custom") != null;
            try sreq.respond("back", .{ .status = .ok });
        }
    };
    const out_url = try other.url(testing.allocator, "/bounce");
    defer testing.allocator.free(out_url);
    var origin_state: Origin = .{ .out_url = out_url };
    const origin = try LoopbackServer(*Origin, Origin.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "origin",
    }, &origin_state);
    defer origin.deinit();
    const back_url = try origin.url(testing.allocator, "/landing");
    defer testing.allocator.free(back_url);
    bounce.back_url = back_url;

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    const start_url = try origin.url(testing.allocator, "/out");
    defer testing.allocator.free(start_url);
    const res = try client.fetch(.background, .{
        .location = .{ .url = start_url },
        .extra_headers = &.{.{ .name = "x-custom", .value = "keep" }},
        .privileged_headers = &.{.{ .name = "x-secret", .value = "token" }},
    });
    try origin.waitHandled(2);
    try testing.expectEqual(std.http.Status.ok, res.status);
    // The request left the first origin, so what was stripped there stays
    // stripped, as in std.http.Client.
    try testing.expect(!origin_state.saw_secret);
    try testing.expect(!origin_state.saw_traceparent);
    try testing.expect(origin_state.saw_custom);
}

test "o11yhttp client: fetch keeps the span open while it reads the body" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn run(sreq: *o11yhttp.ServerRequest) !void {
            try sreq.respond("a body longer than the caller has room for", .{ .status = .ok });
        }
    };
    const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "upstream",
    }, {});
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    const url = try srv.url(testing.allocator, "/body");
    defer testing.allocator.free(url);

    // The head arrives with status 200, then copying the body fails
    // because the caller's writer is full.
    var small: [4]u8 = undefined;
    var full: Io.Writer = .fixed(&small);
    try testing.expectError(error.WriteFailed, client.fetch(.background, .{
        .location = .{ .url = url },
        .response_writer = &full,
        .keep_alive = false,
    }));

    // The caller got an error, so the span says so. It used to end as a
    // clean 200 before the body was read.
    const failed = try rec.expectSpan("GET");
    try testing.expectEqual(o11y.StatusCode.@"error", failed.status.code);
    try testing.expectEqualStrings("WriteFailed", findAttr(failed.attributes.items, "error.type").?.string);

    rec.reset();
    var sink: Io.Writer.Allocating = .init(testing.allocator);
    defer sink.deinit();
    const ok = try client.fetch(.background, .{ .location = .{ .url = url }, .response_writer = &sink.writer });
    try testing.expectEqual(std.http.Status.ok, ok.status);
    try testing.expectEqualStrings("a body longer than the caller has room for", sink.written());
    const done = try rec.expectSpan("GET");
    try testing.expectEqual(o11y.StatusCode.unset, done.status.code);
    try testing.expectEqual(@as(i64, 200), findAttr(done.attributes.items, "http.response.status_code").?.int);
}

test "o11yhttp client: a 304 and a redirect answer to HEAD are final responses, as in std.http.Client" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn run(sreq: *o11yhttp.ServerRequest) !void {
            if (std.mem.eql(u8, sreq.path(), "/cached")) {
                // A conditional GET the cache still satisfies: 304, no Location.
                try sreq.respond("", .{ .status = .not_modified });
                return;
            }
            if (std.mem.eql(u8, sreq.path(), "/moved")) {
                try sreq.respond("", .{
                    .status = .moved_permanently,
                    .extra_headers = &.{.{ .name = "location", .value = "/landing" }},
                });
                return;
            }
            try sreq.respond("landed", .{ .status = .ok });
        }
    };
    const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .operation = "origin",
    }, {});
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const client = o11yhttp.Client.init(&std_client, .{ .telemetry = rec.telemetry() });

    const cached_url = try srv.url(testing.allocator, "/cached");
    defer testing.allocator.free(cached_url);
    const moved_url = try srv.url(testing.allocator, "/moved");
    defer testing.allocator.free(moved_url);

    // The wrapper answers exactly as the client it wraps does.
    const plain_cached = try std_client.fetch(.{
        .location = .{ .url = cached_url },
        .extra_headers = &.{.{ .name = "if-none-match", .value = "\"v1\"" }},
    });
    try testing.expectEqual(std.http.Status.not_modified, plain_cached.status);
    const cached = try client.fetch(.background, .{
        .location = .{ .url = cached_url },
        .extra_headers = &.{.{ .name = "if-none-match", .value = "\"v1\"" }},
    });
    try testing.expectEqual(std.http.Status.not_modified, cached.status);

    // std.http.Client.Request.receiveHead returns any response to HEAD as
    // final. Its fetch is not called here for comparison: in Zig 0.17.1 it
    // discards the body through the shared read-only empty reader, which
    // crashes a release build. The wrapper skips the body of a HEAD.
    const head = try client.fetch(.background, .{ .location = .{ .url = moved_url }, .method = .HEAD });
    try testing.expectEqual(std.http.Status.moved_permanently, head.status);
    var unused: Io.Writer.Allocating = .init(testing.allocator);
    defer unused.deinit();
    const head_to_writer = try client.fetch(.background, .{
        .location = .{ .url = moved_url },
        .method = .HEAD,
        .response_writer = &unused.writer,
    });
    try testing.expectEqual(std.http.Status.moved_permanently, head_to_writer.status);
    try testing.expectEqual(@as(usize, 0), unused.written().len);

    // A GET still follows the redirect.
    const followed = try client.fetch(.background, .{ .location = .{ .url = moved_url } });
    try testing.expectEqual(std.http.Status.ok, followed.status);
}

test "o11yhttp loopback: recordStatus after direct raw.respond prevents double-write on handler error" {
    const rec = try o11ytest.start(testing.allocator, testing.io, .{});
    defer rec.deinit();

    const Handler = struct {
        fn run(sreq: *o11yhttp.ServerRequest) !void {
            sreq.setRoute("/direct");
            try sreq.raw.respond("direct-202", .{ .status = .accepted });
            sreq.recordStatus(.accepted);
            return error.PostDirectError;
        }
    };

    const srv = try LoopbackServer(void, Handler.run).start(testing.allocator, testing.io, .{
        .telemetry = rec.telemetry(),
        .canonical_line = true,
    }, {});
    defer srv.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const u = try srv.url(testing.allocator, "/direct");
    defer testing.allocator.free(u);

    var body: Io.Writer.Allocating = .init(testing.allocator);
    defer body.deinit();
    const res = try std_client.fetch(.{
        .location = .{ .url = u },
        .response_writer = &body.writer,
    });
    try srv.waitHandled(1);

    try testing.expectEqual(std.http.Status.accepted, res.status);
    try testing.expectEqualStrings("direct-202", body.written());

    const sp = try rec.expectSpan("GET /direct");
    try testing.expectEqual(o11y.StatusCode.@"error", sp.status.code);
    try testing.expectEqual(@as(i64, 202), findAttr(sp.attributes.items, "http.response.status_code").?.int);
    try testing.expectEqualStrings("PostDirectError", findAttr(sp.attributes.items, "error.type").?.string);

    const ev = try rec.expectEvent(spec.event.request_summary);
    try testing.expectEqual(@as(i64, 202), ev.attr("http.response.status_code").?.int);
    try testing.expectEqualStrings("failure", ev.attrString(spec.Outcome.key).?);
}
