//! `o11yhttpz`: OpenTelemetry HTTP server middleware for `karlseguin/http.zig`
//! (`httpz`), gated behind `-Dhttpz`.
//!
//! Mirrors `o11yhttp.Server` and `go/o11ygin`:
//! - extracts inbound W3C `traceparent`/`tracestate`/`baggage` from `req.headers`;
//! - supports `public_endpoint` (starts a linked root span instead of parenting);
//! - supports `ignore_paths` Go-style globs and custom `filter` predicates;
//! - sets `http.route` and span name `"{METHOD} {route}"` via `route_fn`,
//!   `RouteData` + `extractRouteData`, or in-handler `setRoute(req, pattern)`;
//! - records stable HTTP semantic-convention attributes on spans and metrics;
//! - records `http.server.request.duration` histogram (seconds, stable buckets)
//!   with trace exemplars;
//! - injects `Server-Timing: traceparent;desc="..."` when `server_timing` is true;
//! - emits one correlated `o11y.request.summary` wide event when `canonical_line`
//!   is true, backed by an `o11y.Record` accessible via `context(req)` / `record(req)`;
//! - leaves 4xx spans `.unset`, marks 5xx and handler errors `.@"error"` with
//!   `error.type`.

const std = @import("std");
const Io = std.Io;
const httpz = @import("httpz");
const o11y = @import("o11y");
const spec = o11y.spec;
const o11yhttp = @import("o11yhttp");
const common = o11yhttp.common;
const glob = o11yhttp.glob;

/// Instrumentation scope name for `o11yhttpz` spans and metrics.
pub const scope_name = "github.com/jamesainslie/libo11y/zig/o11yhttpz";

/// Stable OpenTelemetry HTTP duration histogram bucket boundaries (in seconds).
pub const duration_buckets = common.duration_buckets;

/// Predicate deciding whether a request is instrumented. Return `false` to
/// skip tracing, metrics, `Server-Timing`, and canonical-line emission.
pub const FilterFn = *const fn (req: *const httpz.Request) bool;

/// Optional route template resolver called before starting the server span
/// (returning e.g. `"/users/:id"` or `"GET /users/:id"`).
pub const RouteFn = *const fn (req: *const httpz.Request) ?[]const u8;

/// Optional route metadata struct for `httpz` route `.data` fields.
/// Pair with `route("/users/:id")` and `.route_fn = o11yhttpz.extractRouteData`.
pub const RouteData = struct {
    route: []const u8,
    user_data: ?*const anyopaque = null,
};

/// Returns a static `*const RouteData` pointer for use in `httpz` route configs:
/// `router.get("/users/:id", handler, .{ .data = o11yhttpz.route("/users/:id") });`
pub fn route(comptime pattern: []const u8) *const RouteData {
    return &struct {
        const value: RouteData = .{ .route = pattern };
    }.value;
}

/// Ready-made `RouteFn` that reads `*const RouteData` from `req.route_data`.
/// Use only when routes that populate `.data` store `*const RouteData`.
pub fn extractRouteData(req: *const httpz.Request) ?[]const u8 {
    const ptr = req.route_data orelse return null;
    const rd: *const RouteData = @ptrCast(@alignCast(ptr));
    return if (rd.route.len > 0) rd.route else null;
}

/// Configuration for `Middleware`.
pub const Options = struct {
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
    /// Go `path.Match` glob patterns for URL paths to leave uninstrumented.
    ignore_paths: []const []const u8 = &.{},
    /// Optional predicate: requests for which it returns `false` are skipped.
    filter: ?FilterFn = null,
    /// Optional route template resolver invoked before span start.
    route_fn: ?RouteFn = null,
    /// Emit one `o11y.request.summary` wide event per instrumented request,
    /// attaching an `o11y.Record` to `o11yhttpz.context(req)`.
    canonical_line: bool = false,
    /// Append `Server-Timing: traceparent;desc="00-<tid>-<sid>-<flags>"` to
    /// instrumented responses.
    server_timing: bool = false,
    /// When `server_timing` is true and this is true, emit `Server-Timing`
    /// only on `text/html` responses.
    server_timing_html_only: bool = false,
};

const middleware_state_key = "libo11y.o11yhttpz.state";

/// Per-request instrumentation state stored on `req.middlewares` for the
/// duration of `executor.next()`.
const RequestState = struct {
    base_ctx: o11y.Context = .background,
    span: o11y.Span = .noop,
    record: ?o11y.Record = null,
    route: ?[]const u8 = null,
    route_updated: bool = false,

    fn context(self: *RequestState) o11y.Context {
        var ctx = self.base_ctx.withSpan(&self.span);
        if (self.record) |*rec| {
            ctx = o11y.startRecord(ctx, rec);
        }
        return ctx;
    }
};

/// Returns the active `o11y.Context` for `req` (carrying the server span,
/// extracted baggage, and canonical `Record` when enabled). Returns
/// `o11y.Context.background` when the request was ignored/filtered or the
/// middleware is not active.
pub fn context(req: *const httpz.Request) o11y.Context {
    const ptr = req.middlewares.get(middleware_state_key) orelse return .background;
    const state: *RequestState = @ptrCast(@alignCast(ptr));
    return state.context();
}

/// Returns a non-nil `o11y.RecordHandle` for `req` (no-op when `canonical_line`
/// is disabled or the request is not instrumented).
pub fn record(req: *const httpz.Request) o11y.RecordHandle {
    return o11y.recordFromContext(context(req));
}

/// Sets or updates the matched route template (e.g. `"/users/:id"` or
/// `"GET /users/:id"`) during handler execution. Updates the span name,
/// `http.route` attribute, duration metric, and canonical summary on finish.
pub fn setRoute(req: *httpz.Request, pattern: []const u8) void {
    if (pattern.len == 0) return;
    const ptr = req.middlewares.get(middleware_state_key) orelse return;
    const state: *RequestState = @ptrCast(@alignCast(ptr));
    state.route = req.arena.dupe(u8, pattern) catch return;
    state.route_updated = true;
}

/// `httpz` middleware instrumenting requests with OpenTelemetry traces,
/// `http.server.request.duration` histograms with exemplars, `Server-Timing`,
/// and optional `o11y.request.summary` canonical log lines.
///
/// Register with:
/// ```zig
/// const mw = try server.middleware(o11yhttpz.Middleware, .{ .telemetry = t });
/// var router = try server.router(.{ .middlewares = &.{mw} });
/// ```
pub const Middleware = struct {
    pub const Config = Options;

    options: Options,
    tracer: *const o11y.Tracer,
    duration: o11y.Histogram(f64),

    pub fn init(config: Config) !Middleware {
        const meter = config.telemetry.meter(scope_name);
        return .{
            .options = config,
            .tracer = config.telemetry.tracer(scope_name),
            .duration = meter.histogram(f64, "http.server.request.duration", .{
                .unit = "s",
                .description = "Duration of HTTP server requests.",
                .explicit_bucket_boundaries = &duration_buckets,
            }),
        };
    }

    pub fn execute(
        self: *const Middleware,
        req: *httpz.Request,
        res: *httpz.Response,
        executor: anytype,
    ) !void {
        const decoded_path = common.decodePath(req.arena, req.url.path) catch req.url.path;
        if (self.options.ignore_paths.len > 0 and glob.matchesAny(self.options.ignore_paths, decoded_path)) {
            return executor.next();
        }
        if (self.options.filter) |filter_fn| {
            if (!filter_fn(req)) {
                return executor.next();
            }
        }

        const io = self.options.telemetry.io;
        const start_time = Io.Clock.awake.now(io);

        const raw_method = rawMethod(req);
        const norm = common.normalizeMethod(raw_method);

        // Extract inbound W3C trace context and baggage from request headers.
        var carrier: RequestHeaderCarrier = .{ .headers = req.headers };
        const extracted = self.options.telemetry.propagator().extract(.background, req.arena, carrier.carrier());

        const initial_route: ?[]const u8 = if (self.options.route_fn) |rf| blk: {
            const r = rf(req) orelse break :blk null;
            break :blk if (r.len > 0) r else null;
        } else null;

        const op: ?[]const u8 = if (self.options.operation.len > 0) self.options.operation else null;
        const span_name = common.formatSpanName(req.arena, norm.normalized, initial_route, op) catch common.methodSpanToken(norm.normalized);

        // Assemble initial HTTP server semconv attributes.
        var attrs_buf: [10]o11y.Attribute = undefined;
        var attr_n: usize = 0;
        attrs_buf[attr_n] = o11y.kv("http.request.method", norm.normalized);
        attr_n += 1;
        if (!norm.exact) {
            attrs_buf[attr_n] = o11y.kv("http.request.method_original", raw_method);
            attr_n += 1;
        }
        attrs_buf[attr_n] = o11y.kv("url.scheme", self.options.scheme);
        attr_n += 1;
        attrs_buf[attr_n] = o11y.kv("url.path", req.url.path);
        attr_n += 1;
        if (req.header("host")) |host_hdr| {
            const hp = common.parseHostPort(host_hdr, common.defaultPortForScheme(self.options.scheme));
            if (hp.address.len > 0) {
                attrs_buf[attr_n] = o11y.kv("server.address", hp.address);
                attr_n += 1;
                attrs_buf[attr_n] = o11y.kv("server.port", @as(i64, hp.port));
                attr_n += 1;
            }
        }
        if (req.header("user-agent")) |ua| {
            if (ua.len > 0) {
                attrs_buf[attr_n] = o11y.kv("user_agent.original", ua);
                attr_n += 1;
            }
        }
        if (initial_route) |r| {
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

        var state: RequestState = .{
            .base_ctx = extracted,
            .span = self.tracer.start(extracted, span_name, start_opts),
            .record = if (self.options.canonical_line) o11y.Record.init(self.options.telemetry.gpa, io) else null,
            .route = initial_route,
        };
        defer {
            if (state.record) |*rec| {
                rec.deinit();
                state.record = null;
            }
        }

        // Attach Server-Timing up front when applying to all responses so
        // chunked/streaming handlers also include the header.
        if (self.options.server_timing and !self.options.server_timing_html_only) {
            attachServerTiming(res, state.span.spanContext());
        }

        req.middlewares.put(middleware_state_key, &state) catch {};
        defer _ = req.middlewares.remove(middleware_state_key);

        var handler_err: ?anyerror = null;
        executor.next() catch |err| {
            handler_err = err;
        };

        if (self.options.server_timing and self.options.server_timing_html_only and isResponseHtml(res)) {
            attachServerTiming(res, state.span.spanContext());
        }

        const route_only: ?[]const u8 = if (state.route) |r| common.routeOnly(r) else null;
        if (state.route_updated) {
            if (common.formatSpanName(req.arena, norm.normalized, state.route, op)) |new_name| {
                state.span.setName(new_name);
            } else |_| {}
            if (route_only) |ro| {
                state.span.setAttribute("http.route", ro);
            }
        }

        // If the handler returned an error before changing the default 200 status,
        // httpz's default error path writes 500 Internal Server Error.
        const status_code: u16 = if (handler_err != null and res.status == 200 and !res.written)
            500
        else
            res.status;
        const status_i64: i64 = @intCast(status_code);

        var status_str_buf: [8]u8 = undefined;
        const error_type: ?[]const u8 = if (handler_err) |err|
            @errorName(err)
        else if (status_code >= 500)
            common.formatStatusCode(&status_str_buf, status_code)
        else
            null;

        state.span.setAttribute("http.response.status_code", status_i64);
        if (error_type) |et| {
            state.span.setAttribute("error.type", et);
        }
        if (handler_err) |err| {
            state.span.recordError(err, .{});
            state.span.setStatus(.@"error", @errorName(err));
        } else if (status_code >= 500) {
            state.span.setStatus(.@"error", "");
        }

        const elapsed = common.elapsedSeconds(start_time, Io.Clock.awake.now(io));

        var m_attrs_buf: [5]o11y.Attribute = undefined;
        var m_n: usize = 0;
        m_attrs_buf[m_n] = o11y.kv("http.request.method", norm.normalized);
        m_n += 1;
        m_attrs_buf[m_n] = o11y.kv("url.scheme", self.options.scheme);
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

        const span_ctx = state.base_ctx.withSpan(&state.span);
        self.duration.record(span_ctx, elapsed, m_attrs_buf[0..m_n]);

        if (state.record) |*rec| {
            const failed = handler_err != null or status_code >= 500;
            const outcome = if (failed) spec.Outcome.failure else spec.Outcome.success;
            var ev_attrs: [6]o11y.LogAttribute = undefined;
            var ev_n: usize = 0;
            ev_attrs[ev_n] = o11y.logKv("http.request.method", norm.normalized);
            ev_n += 1;
            if (!norm.exact) {
                ev_attrs[ev_n] = o11y.logKv("http.request.method_original", raw_method);
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
            rec.emitEvent(span_ctx, self.options.telemetry, spec.event.request_summary, @as([]const o11y.LogAttribute, ev_attrs[0..ev_n]));
        }

        state.span.end();

        if (handler_err) |err| return err;
    }
};

fn rawMethod(req: *const httpz.Request) []const u8 {
    return switch (req.method) {
        .OTHER => req.method_string,
        else => @tagName(req.method),
    };
}

fn attachServerTiming(res: *httpz.Response, sc: o11y.SpanContext) void {
    if (res.written or res.chunked) return;
    var buf: [common.server_timing_len]u8 = undefined;
    const val = common.formatServerTiming(&buf, sc) orelse return;
    res.headerOpts("server-timing", val, .{ .dupe_value = true }) catch {};
}

fn isResponseHtml(res: *const httpz.Response) bool {
    if (res.content_type) |ct| {
        if (ct == .HTML) return true;
    }
    const keys = res.headers.keys[0..res.headers.len];
    const vals = res.headers.values[0..res.headers.len];
    for (keys, vals) |k, v| {
        if (std.ascii.eqlIgnoreCase(k, "content-type")) {
            return common.isHtmlContentType(v);
        }
    }
    return false;
}

/// Case-insensitive multi-value header carrier over `httpz.key_value.StringKeyValue`.
const RequestHeaderCarrier = struct {
    headers: *const httpz.key_value.StringKeyValue,

    fn carrier(self: *RequestHeaderCarrier) o11y.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn, .valueAt = valueAtFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        return valueAtFn(ptr, key, 0);
    }

    fn valueAtFn(ptr: *anyopaque, key: []const u8, index: usize) ?[]const u8 {
        const self: *RequestHeaderCarrier = @ptrCast(@alignCast(ptr));
        const keys = self.headers.keys[0..self.headers.len];
        const vals = self.headers.values[0..self.headers.len];
        var seen: usize = 0;
        for (keys, vals) |k, v| {
            if (!std.ascii.eqlIgnoreCase(k, key)) continue;
            if (seen == index) return v;
            seen += 1;
        }
        return null;
    }

    fn setFn(_: *anyopaque, _: []const u8, _: []const u8) void {}
};

test "o11yhttpz route helper returns stable RouteData pointer" {
    const rd = route("/users/:id");
    try std.testing.expectEqualStrings("/users/:id", rd.route);
    try std.testing.expectEqual(@as(?*const anyopaque, null), rd.user_data);
}
