//! HTTP server instrumentation for Zig's `std.http.Server`, mirroring
//! `go/o11yhttp` and `@libo11y/server`'s `instrumentServe`.
//!
//! Wraps `std.http.Server.Request` handling with:
//! - W3C trace context and baggage extraction from request headers;
//! - `public_endpoint` mode (starts a linked root span instead of parenting);
//! - `ignore_paths` Go-style glob exclusions and custom `filter` predicates;
//! - route-aware span naming (`"{METHOD} {route}"` / `"{METHOD}"`) with
//!   optional pre-start `route_fn` and in-handler `setRoute`;
//! - stable HTTP semantic-convention attributes on spans and metrics;
//! - `http.server.request.duration` histogram (seconds, stable buckets) with
//!   trace exemplars;
//! - optional `Server-Timing: traceparent;desc="..."` response header;
//! - optional `canonical_line` emitting one correlated `o11y.request.summary`
//!   wide event backed by `o11y.Record`;
//! - 5xx and handler error status semantics (4xx leaves span status `.unset`,
//!   5xx and handler errors set `.@"error"` and `error.type`).

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const spec = o11y.spec;
const common = @import("common.zig");
const glob = @import("glob.zig");

/// Predicate deciding whether a request is instrumented. Return `false` to
/// skip tracing, metrics, and canonical-line emission for the request.
pub const FilterFn = *const fn (method: []const u8, target: []const u8) bool;

/// Optional route template resolver called before starting the server span
/// (for example returning `"/users/{id}"` or `"GET /users/{id}"`).
pub const RouteFn = *const fn (method: []const u8, path: []const u8) ?[]const u8;

/// Configuration for `Server`.
pub const ServerOptions = struct {
    /// The SDK whose tracer, meter, propagator, and logger/event pipeline to use.
    telemetry: *o11y.Telemetry,
    /// Fallback operation name when no route template is known.
    operation: []const u8 = "",
    /// URL scheme stamped on `url.scheme` (default `"http"`).
    scheme: []const u8 = "http",
    /// Internet-facing endpoint: inbound trace context starts a new root span
    /// linked to the inbound remote span context instead of parenting under it.
    /// Inbound baggage is still extracted.
    public_endpoint: bool = false,
    /// Go `path.Match` glob patterns for URL paths to leave uninstrumented
    /// (e.g. `"/healthz"`, `"/debug/*"`).
    ignore_paths: []const []const u8 = &.{},
    /// Optional predicate: requests for which it returns `false` are left
    /// uninstrumented (no span, metric, canonical line, or `Server-Timing`).
    filter: ?FilterFn = null,
    /// Optional route template resolver invoked before span start.
    route_fn: ?RouteFn = null,
    /// Emit one `o11y.request.summary` wide event per instrumented request,
    /// attaching an `o11y.Record` to `sreq.context()`.
    canonical_line: bool = false,
    /// Append `Server-Timing: traceparent;desc="00-<tid>-<sid>-<flags>"` to
    /// instrumented responses.
    server_timing: bool = false,
    /// When `server_timing` is true and this is true, emit `Server-Timing`
    /// only on `text/html` responses; otherwise emit on all instrumented responses.
    server_timing_html_only: bool = false,
};

/// Reusable, concurrency-safe server instrumenter for `std.http.Server`.
pub const Server = struct {
    options: ServerOptions,
    tracer: *const o11y.Tracer,
    duration: o11y.Histogram(f64),

    /// Initializes the server instrumenter and resolves the `o11yhttp` tracer
    /// and `http.server.request.duration` histogram once.
    pub fn init(options: ServerOptions) Server {
        const meter = options.telemetry.meter(common.scope_name);
        return .{
            .options = options,
            .tracer = options.telemetry.tracer(common.scope_name),
            .duration = meter.histogram(f64, "http.server.request.duration", .{
                .unit = "s",
                .description = "Duration of HTTP server requests.",
                .explicit_bucket_boundaries = &common.duration_buckets,
            }),
        };
    }

    /// Begins instrumentation for one incoming `std.http.Server.Request`.
    /// Call `defer sreq.finish();` to record metrics, emit the canonical line
    /// (when enabled), end the span, and free per-request scratch memory.
    ///
    /// Hot-path safe: never fails the host.
    pub fn begin(self: *const Server, gpa: Allocator, raw: *std.http.Server.Request) ServerRequest {
        return self.beginWithRoute(gpa, raw, null);
    }

    /// Like `begin`, supplying an explicit initial `route` template (such as
    /// `"/orders/{id}"`). Overrides `options.route_fn` when non-null.
    pub fn beginWithRoute(
        self: *const Server,
        gpa: Allocator,
        raw: *std.http.Server.Request,
        explicit_route: ?[]const u8,
    ) ServerRequest {
        var sreq: ServerRequest = .{
            .server = self,
            .raw = raw,
            .gpa = gpa,
            .arena = .init(gpa),
            .start_time = Io.Clock.awake.now(self.options.telemetry.io),
        };
        const a = sreq.arena.allocator();

        // Snapshot method, target, and headers before the handler reads the
        // body (which invalidates `raw.head` string slices in std.http.Server).
        sreq.method_str = @tagName(raw.head.method);
        sreq.target_str = a.dupe(u8, raw.head.target) catch raw.head.target;
        const parts = common.splitTarget(sreq.target_str);
        sreq.path_str = parts.path;

        var hdr_list: std.ArrayList(std.http.Header) = .empty;
        var it = raw.iterateHeaders();
        while (it.next()) |h| {
            const name_copy = a.dupe(u8, h.name) catch break;
            const val_copy = a.dupe(u8, h.value) catch break;
            hdr_list.append(a, .{ .name = name_copy, .value = val_copy }) catch break;
        }
        sreq.headers = hdr_list.items;

        // Check ignore_paths globs and custom filter.
        const decoded_path = common.decodePath(a, sreq.path_str) catch sreq.path_str;
        if (self.options.ignore_paths.len > 0 and glob.matchesAny(self.options.ignore_paths, decoded_path)) {
            return sreq;
        }
        if (self.options.filter) |filter_fn| {
            if (!filter_fn(sreq.method_str, sreq.target_str)) {
                return sreq;
            }
        }

        sreq.instrumented = true;
        const norm = common.normalizeMethod(sreq.method_str);
        sreq.normalized_method = norm.normalized;
        sreq.method_exact = norm.exact;

        // Extract inbound W3C trace context & baggage from headers.
        var carrier: RequestHeaderCarrier = .{ .headers = sreq.headers };
        const extracted = self.options.telemetry.propagator().extract(.background, a, carrier.carrier());
        sreq.base_ctx = extracted;

        // Resolve initial route template.
        const initial_route: ?[]const u8 = if (explicit_route) |r|
            (if (r.len > 0) r else null)
        else if (self.options.route_fn) |rf| blk: {
            const resolved = rf(sreq.method_str, decoded_path) orelse break :blk null;
            break :blk if (resolved.len > 0) resolved else null;
        } else null;

        if (initial_route) |r| {
            sreq.route = a.dupe(u8, r) catch r;
        }

        const op: ?[]const u8 = if (self.options.operation.len > 0) self.options.operation else null;
        const span_name = common.formatSpanName(a, norm.normalized, sreq.route, op) catch common.methodSpanToken(norm.normalized);

        // Assemble initial HTTP server semconv attributes.
        var attrs_buf: [10]o11y.Attribute = undefined;
        var attr_n: usize = 0;
        attrs_buf[attr_n] = o11y.kv("http.request.method", norm.normalized);
        attr_n += 1;
        if (!norm.exact) {
            attrs_buf[attr_n] = o11y.kv("http.request.method_original", sreq.method_str);
            attr_n += 1;
        }
        attrs_buf[attr_n] = o11y.kv("url.scheme", self.options.scheme);
        attr_n += 1;
        attrs_buf[attr_n] = o11y.kv("url.path", sreq.path_str);
        attr_n += 1;
        if (sreq.header("host")) |host_hdr| {
            const hp = common.parseHostPort(host_hdr, common.defaultPortForScheme(self.options.scheme));
            if (hp.address.len > 0) {
                attrs_buf[attr_n] = o11y.kv("server.address", hp.address);
                attr_n += 1;
                attrs_buf[attr_n] = o11y.kv("server.port", @as(i64, hp.port));
                attr_n += 1;
            }
        }
        if (sreq.header("user-agent")) |ua| {
            if (ua.len > 0) {
                attrs_buf[attr_n] = o11y.kv("user_agent.original", ua);
                attr_n += 1;
            }
        }
        if (sreq.route) |r| {
            attrs_buf[attr_n] = o11y.kv("http.route", common.routeOnly(r));
            attr_n += 1;
        }

        var start_opts: o11y.StartOptions = .{
            .kind = .server,
            .attributes = attrs_buf[0..attr_n],
        };
        var link_buf: [1]o11y.Link = undefined;
        if (self.options.public_endpoint) {
            start_opts.new_root = true;
            if (extracted.span_context.isValid() and extracted.span_context.remote) {
                link_buf[0] = .{ .span_context = extracted.span_context };
                start_opts.links = &link_buf;
            }
        }

        sreq.span = self.tracer.start(extracted, span_name, start_opts);

        if (self.options.canonical_line) {
            sreq.record = o11y.Record.init(gpa, self.options.telemetry.io);
        }

        return sreq;
    }

    /// Runs `handler` on `raw` inside full server instrumentation.
    ///
    /// `handler` may take `(*ServerRequest)` (when `handler_ctx` is `{}` / `void`)
    /// or `(@TypeOf(handler_ctx), *ServerRequest)`, and may return `void` or an
    /// error union `!void`.
    ///
    /// When the handler returns an error:
    /// - marks the server span with `recordError`, `error.type`, and `.@"error"`
    ///   status;
    /// - if no response status has been committed yet, sends a best-effort
    ///   `500 Internal Server Error` response and records status 500;
    /// - still returns the handler's error to the caller.
    pub fn handle(
        self: *const Server,
        gpa: Allocator,
        raw: *std.http.Server.Request,
        route: ?[]const u8,
        handler_ctx: anytype,
        comptime handler: anytype,
    ) HandleReturnType(@TypeOf(handler)) {
        var sreq = self.beginWithRoute(gpa, raw, route);
        defer sreq.finish();

        const Ret = HandleReturnType(@TypeOf(handler));
        if (@typeInfo(Ret) == .error_union) {
            const call_res = if (@TypeOf(handler_ctx) == void)
                handler(&sreq)
            else
                handler(handler_ctx, &sreq);
            call_res catch |err| {
                sreq.fail(err);
                return err;
            };
        } else {
            if (@TypeOf(handler_ctx) == void) {
                handler(&sreq);
            } else {
                handler(handler_ctx, &sreq);
            }
        }
    }
};

fn HandleReturnType(comptime FnType: type) type {
    const info = @typeInfo(FnType);
    const fn_info = switch (info) {
        .@"fn" => |f| f,
        .pointer => |p| @typeInfo(p.child).@"fn",
        else => @compileError("o11yhttp.Server.handle expects a function, got " ++ @typeName(FnType)),
    };
    return fn_info.return_type orelse void;
}

/// Per-request server handle created by `Server.begin` / `Server.handle`.
///
/// Wraps `std.http.Server.Request` so response status codes are tracked,
/// `Server-Timing` headers are injected when enabled, and `context()` carries
/// the active server span, extracted baggage, and canonical `Record`.
pub const ServerRequest = struct {
    server: *const Server,
    raw: *std.http.Server.Request,
    gpa: Allocator,
    arena: std.heap.ArenaAllocator,
    start_time: Io.Timestamp,

    instrumented: bool = false,
    finished: bool = false,
    method_str: []const u8 = "",
    normalized_method: []const u8 = "",
    method_exact: bool = true,
    target_str: []const u8 = "",
    path_str: []const u8 = "",
    headers: []const std.http.Header = &.{},

    route: ?[]const u8 = null,
    route_updated: bool = false,
    base_ctx: o11y.Context = .background,
    span: o11y.Span = .noop,
    record: ?o11y.Record = null,

    status: ?u16 = null,
    responded: bool = false,
    handler_err: ?anyerror = null,

    /// Returns the request `o11y.Context` carrying the server span (when
    /// instrumented), extracted baggage, and the canonical wide-event `Record`
    /// (when `canonical_line` is enabled). Valid until `finish()`.
    pub fn context(self: *ServerRequest) o11y.Context {
        if (!self.instrumented) return .background;
        var ctx = self.base_ctx.withSpan(&self.span);
        if (self.record) |*rec| {
            ctx = o11y.startRecord(ctx, rec);
        }
        return ctx;
    }

    /// Returns the original HTTP method name (safe even after reading the body).
    pub fn method(self: *const ServerRequest) []const u8 {
        return self.method_str;
    }

    /// Returns the full request target (safe even after reading the body).
    pub fn target(self: *const ServerRequest) []const u8 {
        return self.target_str;
    }

    /// Returns the request URL path without query string or fragment.
    pub fn path(self: *const ServerRequest) []const u8 {
        return self.path_str;
    }

    /// Looks up the first request header named `name` (ASCII case-insensitive).
    pub fn header(self: *const ServerRequest, name: []const u8) ?[]const u8 {
        for (self.headers) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
        }
        return null;
    }

    /// Sets or updates the matched route template (e.g. `"/users/{id}"` or
    /// `"GET /users/{id}"`) during handler execution. Updates the span name,
    /// `http.route` attribute, duration metric, and canonical summary on finish.
    pub fn setRoute(self: *ServerRequest, route: []const u8) void {
        if (!self.instrumented or self.finished or route.len == 0) return;
        self.route = self.arena.allocator().dupe(u8, route) catch return;
        self.route_updated = true;
    }

    /// Records a committed HTTP response status (first final status wins,
    /// ignoring 1xx responses other than 101 Switching Protocols).
    /// Also marks the request as responded once a final status is recorded,
    /// so a subsequent handler error will not double-write a 500 response.
    pub fn recordStatus(self: *ServerRequest, status: std.http.Status) void {
        const code: u16 = @intCast(@backingInt(status));
        self.observeStatus(code);
        if (self.status != null) {
            self.responded = true;
        }
    }

    /// Sends a full HTTP response via `raw.respond`, recording the status code
    /// and appending `Server-Timing` when enabled.
    pub fn respond(
        self: *ServerRequest,
        content: []const u8,
        options: std.http.Server.Request.RespondOptions,
    ) std.http.Server.Request.ExpectContinueError!void {
        var opts = options;
        var timing_buf: [common.server_timing_len]u8 = undefined;
        var hdr_stack: [32]std.http.Header = undefined;
        opts.extra_headers = self.withServerTimingHeaders(options.extra_headers, &timing_buf, &hdr_stack);

        try self.raw.respond(content, opts);
        self.responded = true;
        self.observeStatus(@intCast(@backingInt(options.status)));
    }

    /// Begins a streaming HTTP response via `raw.respondStreaming`, recording
    /// the status code and appending `Server-Timing` when enabled.
    pub fn respondStreaming(
        self: *ServerRequest,
        buffer: []u8,
        options: std.http.Server.Request.RespondStreamingOptions,
    ) std.http.Server.Request.ExpectContinueError!std.http.BodyWriter {
        var opts = options;
        var timing_buf: [common.server_timing_len]u8 = undefined;
        var hdr_stack: [32]std.http.Header = undefined;
        opts.respond_options.extra_headers = self.withServerTimingHeaders(
            options.respond_options.extra_headers,
            &timing_buf,
            &hdr_stack,
        );

        const bw = try self.raw.respondStreaming(buffer, opts);
        self.responded = true;
        self.observeStatus(@intCast(@backingInt(options.respond_options.status)));
        return bw;
    }

    /// Upgrades the connection to WebSocket via `raw.respondWebSocket`,
    /// recording status 101 Switching Protocols.
    pub fn respondWebSocket(
        self: *ServerRequest,
        options: std.http.Server.Request.WebSocketOptions,
    ) std.http.Server.Request.ExpectContinueError!std.http.Server.WebSocket {
        const ws = try self.raw.respondWebSocket(options);
        self.responded = true;
        self.observeStatus(@intCast(@backingInt(std.http.Status.switching_protocols)));
        return ws;
    }

    /// Records a handler error on the request. If no response has been sent
    /// yet, sends a best-effort `500 Internal Server Error` response so the
    /// client does not hang and marks status 500.
    pub fn fail(self: *ServerRequest, err: anyerror) void {
        self.handler_err = err;
        if (!self.responded and self.status == null) {
            self.respond("Internal Server Error", .{
                .status = .internal_server_error,
                .keep_alive = false,
            }) catch {};
            self.observeStatus(500);
        }
    }

    /// Completes instrumentation: updates route/status/error attributes, records
    /// `http.server.request.duration` with exemplar, emits the canonical
    /// `o11y.request.summary` event if enabled, ends the span, and frees memory.
    /// Idempotent.
    pub fn finish(self: *ServerRequest) void {
        if (self.finished) return;
        self.finished = true;
        defer {
            if (self.record) |*rec| {
                rec.deinit();
                self.record = null;
            }
            self.arena.deinit();
        }
        if (!self.instrumented) return;

        const a = self.arena.allocator();
        const op: ?[]const u8 = if (self.server.options.operation.len > 0) self.server.options.operation else null;
        const route_only: ?[]const u8 = if (self.route) |r| common.routeOnly(r) else null;

        if (self.route_updated) {
            if (common.formatSpanName(a, self.normalized_method, self.route, op)) |new_name| {
                self.span.setName(new_name);
            } else |_| {}
            if (route_only) |ro| {
                self.span.setAttribute("http.route", ro);
            }
        }

        const status_code: u16 = self.status orelse if (self.handler_err != null) 500 else 200;
        const status_i64: i64 = @intCast(status_code);
        var status_str_buf: [8]u8 = undefined;
        const error_type: ?[]const u8 = if (self.handler_err) |err|
            @errorName(err)
        else if (status_code >= 500)
            common.formatStatusCode(&status_str_buf, status_code)
        else
            null;

        self.span.setAttribute("http.response.status_code", status_i64);
        if (error_type) |et| {
            self.span.setAttribute("error.type", et);
        }
        if (self.handler_err) |err| {
            self.span.recordError(err, .{});
            self.span.setStatus(.@"error", @errorName(err));
        } else if (status_code >= 500) {
            self.span.setStatus(.@"error", "");
        }

        const elapsed = common.elapsedSeconds(self.start_time, Io.Clock.awake.now(self.server.options.telemetry.io));

        // Record http.server.request.duration WITH exemplar under active span context.
        var m_attrs_buf: [5]o11y.Attribute = undefined;
        var m_n: usize = 0;
        m_attrs_buf[m_n] = o11y.kv("http.request.method", self.normalized_method);
        m_n += 1;
        m_attrs_buf[m_n] = o11y.kv("url.scheme", self.server.options.scheme);
        m_n += 1;
        if (route_only) |ro| {
            m_attrs_buf[m_n] = o11y.kv("http.route", ro);
            m_n += 1;
        }
        m_attrs_buf[m_n] = o11y.kv("http.response.status_code", status_i64);
        m_n += 1;
        if (error_type) |et| {
            m_attrs_buf[m_n] = o11y.kv("error.type", et);
            m_n += 1;
        }
        const span_ctx = self.base_ctx.withSpan(&self.span);
        self.server.duration.record(span_ctx, elapsed, m_attrs_buf[0..m_n]);

        // Emit canonical wide event inside the server span so it is correlated.
        if (self.record) |*rec| {
            const failed = self.handler_err != null or status_code >= 500;
            const outcome = if (failed) spec.Outcome.failure else spec.Outcome.success;
            var ev_attrs: [6]o11y.LogAttribute = undefined;
            var ev_n: usize = 0;
            ev_attrs[ev_n] = o11y.logKv("http.request.method", self.normalized_method);
            ev_n += 1;
            if (!self.method_exact) {
                ev_attrs[ev_n] = o11y.logKv("http.request.method_original", self.method_str);
                ev_n += 1;
            }
            ev_attrs[ev_n] = o11y.logKv("http.response.status_code", status_i64);
            ev_n += 1;
            ev_attrs[ev_n] = o11y.logKv(spec.Outcome.key, outcome.asStr());
            ev_n += 1;
            ev_attrs[ev_n] = o11y.logKv(spec.attr.duration, elapsed);
            ev_n += 1;
            if (route_only) |ro| {
                ev_attrs[ev_n] = o11y.logKv("http.route", ro);
                ev_n += 1;
            }
            rec.emitEvent(span_ctx, self.server.options.telemetry, spec.event.request_summary, @as([]const o11y.LogAttribute, ev_attrs[0..ev_n]));
        }

        self.span.end();
    }

    fn observeStatus(self: *ServerRequest, code: u16) void {
        if (self.status != null) return;
        if (code >= 100 and code < 200 and code != 101) return;
        self.status = code;
    }

    fn withServerTimingHeaders(
        self: *ServerRequest,
        existing: []const std.http.Header,
        timing_buf: *[common.server_timing_len]u8,
        stack_buf: *[32]std.http.Header,
    ) []const std.http.Header {
        if (!self.instrumented or !self.server.options.server_timing) return existing;
        if (self.server.options.server_timing_html_only) {
            const ct = findHeader(existing, "content-type");
            if (!common.isHtmlContentType(ct)) return existing;
        }
        const timing_val = common.formatServerTiming(timing_buf, self.span.spanContext()) orelse return existing;
        const timing_hdr: std.http.Header = .{ .name = "server-timing", .value = timing_val };
        const needed = existing.len + 1;
        if (needed <= stack_buf.len) {
            @memcpy(stack_buf[0..existing.len], existing);
            stack_buf[existing.len] = timing_hdr;
            return stack_buf[0..needed];
        }
        const heap = self.arena.allocator().alloc(std.http.Header, needed) catch return existing;
        @memcpy(heap[0..existing.len], existing);
        heap[existing.len] = timing_hdr;
        return heap;
    }
};

fn findHeader(headers: []const std.http.Header, name: []const u8) ?[]const u8 {
    for (headers) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, name)) return h.value;
    }
    return null;
}

/// Case-insensitive multi-value header carrier for W3C trace context & baggage
/// extraction on incoming HTTP requests.
const RequestHeaderCarrier = struct {
    headers: []const std.http.Header,

    fn carrier(self: *RequestHeaderCarrier) o11y.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn, .valueAt = valueAtFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        return valueAtFn(ptr, key, 0);
    }

    fn valueAtFn(ptr: *anyopaque, key: []const u8, index: usize) ?[]const u8 {
        const self: *RequestHeaderCarrier = @ptrCast(@alignCast(ptr));
        var seen: usize = 0;
        for (self.headers) |h| {
            if (!std.ascii.eqlIgnoreCase(h.name, key)) continue;
            if (seen == index) return h.value;
            seen += 1;
        }
        return null;
    }

    fn setFn(_: *anyopaque, _: []const u8, _: []const u8) void {}
};
