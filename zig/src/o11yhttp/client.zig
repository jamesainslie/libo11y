//! HTTP client instrumentation for Zig's `std.http.Client`, mirroring
//! `go/o11yhttp.NewTransport` and `@libo11y/server`'s `instrumentFetch`.
//!
//! Wraps `std.http.Client.fetch` and `std.http.Client.request` with:
//! - a `.client` span named `"{METHOD}"` (or `"HTTP"` for unknown methods);
//! - W3C `traceparent`/`tracestate`/`baggage` header injection via the SDK's
//!   propagator (respecting the baggage egress filter and optional `propagate_fn`);
//! - stable HTTP client semconv attributes (`http.request.method`, sanitized
//!   `url.full` without credentials, `server.address`, `server.port`,
//!   `http.response.status_code`, `error.type`, optional `peer.service`);
//! - `http.client.request.duration` histogram (seconds, stable buckets) with
//!   trace exemplars;
//! - `.@"error"` span status on transport errors or 4xx/5xx HTTP statuses.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const o11y = @import("o11y");
const common = @import("common.zig");

/// Predicate deciding whether outbound trace context and baggage headers are
/// injected for a destination URI. Return `false` for third-party hosts that
/// must not receive internal trace IDs.
pub const PropagateFn = *const fn (uri: std.Uri) bool;

/// Configuration for `Client`.
pub const ClientOptions = struct {
    /// The SDK whose tracer, meter, and egress-filtered propagator to use.
    telemetry: *o11y.Telemetry,
    /// Optional logical name of the remote service (`peer.service`).
    peer_service: ?[]const u8 = null,
    /// Optional predicate controlling per-URL header propagation. Defaults to
    /// propagating for every request.
    propagate_fn: ?PropagateFn = null,
};

/// Instrumented wrapper around `std.http.Client`.
pub const Client = struct {
    http_client: *std.http.Client,
    options: ClientOptions,
    tracer: *const o11y.Tracer,
    duration: o11y.Histogram(f64),

    /// Initializes the client wrapper around `http_client` and resolves the
    /// `o11yhttp` tracer and `http.client.request.duration` histogram once.
    pub fn init(http_client: *std.http.Client, options: ClientOptions) Client {
        const meter = options.telemetry.meter(common.scope_name);
        return .{
            .http_client = http_client,
            .options = options,
            .tracer = options.telemetry.tracer(common.scope_name),
            .duration = meter.histogram(f64, "http.client.request.duration", .{
                .unit = "s",
                .description = "Duration of HTTP client requests.",
                .explicit_bucket_boundaries = &common.duration_buckets,
            }),
        };
    }

    /// Performs a one-shot instrumented HTTP request via `std.http.Client.fetch`,
    /// injecting W3C trace context & egress-filtered baggage headers and
    /// recording the client span and `http.client.request.duration` metric.
    pub fn fetch(
        self: *const Client,
        ctx: o11y.Context,
        options: std.http.Client.FetchOptions,
    ) std.http.Client.FetchError!std.http.Client.FetchResult {
        const uri = switch (options.location) {
            .url => |u| try std.Uri.parse(u),
            .uri => |u| u,
        };
        const method: std.http.Method = options.method orelse
            if (options.payload != null) .POST else .GET;

        var arena_state: std.heap.ArenaAllocator = .init(self.http_client.allocator);
        defer arena_state.deinit();
        const a = arena_state.allocator();

        const start_time = Io.Clock.awake.now(self.http_client.io);
        const info = self.startSpan(a, ctx, method, uri);
        var span = info.span;
        const span_ctx = ctx.withSpan(&span);

        var patched = options;
        patched.location = .{ .uri = uri };
        patched.method = method;
        patched.extra_headers = self.buildHeaders(a, span_ctx, uri, options.extra_headers);

        const res = self.http_client.fetch(patched) catch |err| {
            self.finishError(&span, ctx, info, start_time, err);
            return err;
        };
        self.finishStatus(&span, ctx, info, start_time, res.status);
        return res;
    }

    /// Opens an instrumented `ClientRequest` wrapping `std.http.Client.request`
    /// for full control over request body streaming and response header
    /// inspection (including reading `Server-Timing`).
    ///
    /// Caller must call `defer req.deinit();`.
    pub fn request(
        self: *const Client,
        ctx: o11y.Context,
        method: std.http.Method,
        uri: std.Uri,
        options: std.http.Client.RequestOptions,
    ) std.http.Client.RequestError!ClientRequest {
        var arena_state: std.heap.ArenaAllocator = .init(self.http_client.allocator);
        errdefer arena_state.deinit();
        const a = arena_state.allocator();

        const start_time = Io.Clock.awake.now(self.http_client.io);
        const info = self.startSpan(a, ctx, method, uri);
        var span = info.span;
        const span_ctx = ctx.withSpan(&span);

        var patched = options;
        patched.extra_headers = self.buildHeaders(a, span_ctx, uri, options.extra_headers);

        const raw = self.http_client.request(method, uri, patched) catch |err| {
            self.finishError(&span, ctx, info, start_time, err);
            return err;
        };

        return .{
            .client = self,
            .raw = raw,
            .arena = arena_state,
            .parent_ctx = ctx,
            .span = span,
            .info = info,
            .start_time = start_time,
        };
    }

    fn startSpan(
        self: *const Client,
        arena: Allocator,
        ctx: o11y.Context,
        method: std.http.Method,
        uri: std.Uri,
    ) SpanInfo {
        const raw_method = @tagName(method);
        const norm = common.normalizeMethod(raw_method);
        const hp: common.HostPort = common.serverAddressFromUri(arena, uri) catch .{
            .address = "",
            .port = common.defaultPortForScheme(uri.scheme),
        };
        const url_full = common.sanitizeUrlFull(arena, uri) catch "";

        var attrs_buf: [7]o11y.Attribute = undefined;
        var n: usize = 0;
        attrs_buf[n] = o11y.kv("http.request.method", norm.normalized);
        n += 1;
        if (!norm.exact) {
            attrs_buf[n] = o11y.kv("http.request.method_original", raw_method);
            n += 1;
        }
        if (url_full.len > 0) {
            attrs_buf[n] = o11y.kv("url.full", url_full);
            n += 1;
        }
        if (hp.address.len > 0) {
            attrs_buf[n] = o11y.kv("server.address", hp.address);
            n += 1;
            attrs_buf[n] = o11y.kv("server.port", @as(i64, hp.port));
            n += 1;
        }
        if (self.options.peer_service) |ps| {
            if (ps.len > 0) {
                attrs_buf[n] = o11y.kv("peer.service", ps);
                n += 1;
            }
        }

        const span = self.tracer.start(ctx, common.methodSpanToken(norm.normalized), .{
            .kind = .client,
            .attributes = attrs_buf[0..n],
        });
        return .{
            .span = span,
            .normalized_method = norm.normalized,
            .server_address = hp.address,
            .server_port = hp.port,
        };
    }

    fn buildHeaders(
        self: *const Client,
        arena: Allocator,
        span_ctx: o11y.Context,
        uri: std.Uri,
        existing: []const std.http.Header,
    ) []const std.http.Header {
        if (self.options.propagate_fn) |pred| {
            if (!pred(uri)) return existing;
        }
        var inj: HeaderInjectCarrier = .{ .arena = arena };
        self.options.telemetry.propagator().inject(span_ctx, arena, inj.carrier());
        if (inj.headers.items.len == 0) return existing;

        const out = arena.alloc(std.http.Header, existing.len + inj.headers.items.len) catch return existing;
        var n: usize = 0;
        for (existing) |h| {
            const shadowed = for (inj.headers.items) |ih| {
                if (std.ascii.eqlIgnoreCase(h.name, ih.name)) break true;
            } else false;
            if (!shadowed) {
                out[n] = h;
                n += 1;
            }
        }
        for (inj.headers.items) |ih| {
            out[n] = ih;
            n += 1;
        }
        return out[0..n];
    }

    fn finishStatus(
        self: *const Client,
        span: *o11y.Span,
        parent_ctx: o11y.Context,
        info: SpanInfo,
        start_time: Io.Timestamp,
        status: std.http.Status,
    ) void {
        const code: u16 = @intCast(@backingInt(status));
        const code_i64: i64 = @intCast(code);
        span.setAttribute("http.response.status_code", code_i64);

        var status_buf: [8]u8 = undefined;
        const error_type: ?[]const u8 = if (code >= 400) common.formatStatusCode(&status_buf, code) else null;
        if (error_type) |et| {
            span.setAttribute("error.type", et);
            span.setStatus(.@"error", "");
        }

        const elapsed = common.elapsedSeconds(start_time, Io.Clock.awake.now(self.http_client.io));
        var m_attrs: [5]o11y.Attribute = undefined;
        var n: usize = 0;
        m_attrs[n] = o11y.kv("http.request.method", info.normalized_method);
        n += 1;
        if (info.server_address.len > 0) {
            m_attrs[n] = o11y.kv("server.address", info.server_address);
            n += 1;
            m_attrs[n] = o11y.kv("server.port", @as(i64, info.server_port));
            n += 1;
        }
        m_attrs[n] = o11y.kv("http.response.status_code", code_i64);
        n += 1;
        if (error_type) |et| {
            m_attrs[n] = o11y.kv("error.type", et);
            n += 1;
        }
        self.duration.record(parent_ctx.withSpan(span), elapsed, m_attrs[0..n]);
        span.end();
    }

    fn finishError(
        self: *const Client,
        span: *o11y.Span,
        parent_ctx: o11y.Context,
        info: SpanInfo,
        start_time: Io.Timestamp,
        err: anyerror,
    ) void {
        const err_name = @errorName(err);
        span.recordError(err, .{});
        span.setAttribute("error.type", err_name);
        span.setStatus(.@"error", err_name);

        const elapsed = common.elapsedSeconds(start_time, Io.Clock.awake.now(self.http_client.io));
        var m_attrs: [4]o11y.Attribute = undefined;
        var n: usize = 0;
        m_attrs[n] = o11y.kv("http.request.method", info.normalized_method);
        n += 1;
        if (info.server_address.len > 0) {
            m_attrs[n] = o11y.kv("server.address", info.server_address);
            n += 1;
            m_attrs[n] = o11y.kv("server.port", @as(i64, info.server_port));
            n += 1;
        }
        m_attrs[n] = o11y.kv("error.type", err_name);
        n += 1;
        self.duration.record(parent_ctx.withSpan(span), elapsed, m_attrs[0..n]);
        span.end();
    }
};

const SpanInfo = struct {
    span: o11y.Span,
    normalized_method: []const u8,
    server_address: []const u8,
    server_port: u16,
};

/// Active instrumented client request returned by `Client.request`.
pub const ClientRequest = struct {
    client: *const Client,
    raw: std.http.Client.Request,
    arena: std.heap.ArenaAllocator,
    parent_ctx: o11y.Context,
    span: o11y.Span,
    info: SpanInfo,
    start_time: Io.Timestamp,
    finished: bool = false,

    /// Sends a bodiless HTTP request. Marks the client span as error on failure.
    pub fn sendBodiless(self: *ClientRequest) Io.Writer.Error!void {
        self.raw.sendBodiless() catch |err| {
            self.recordFailure(err);
            return err;
        };
    }

    /// Sends request headers and returns a `BodyWriter` for streaming the body.
    pub fn sendBody(self: *ClientRequest, buffer: []u8) Io.Writer.Error!std.http.BodyWriter {
        return self.raw.sendBody(buffer) catch |err| {
            self.recordFailure(err);
            return err;
        };
    }

    /// Sends request headers and a complete body buffer.
    pub fn sendBodyComplete(self: *ClientRequest, body: []u8) Io.Writer.Error!void {
        self.raw.sendBodyComplete(body) catch |err| {
            self.recordFailure(err);
            return err;
        };
    }

    /// Receives response headers, recording HTTP status, client duration metric
    /// with exemplar, and ending the client span.
    pub fn receiveHead(
        self: *ClientRequest,
        redirect_buffer: []u8,
    ) std.http.Client.Request.ReceiveHeadError!std.http.Client.Response {
        const resp = self.raw.receiveHead(redirect_buffer) catch |err| {
            self.recordFailure(err);
            return err;
        };
        if (!self.finished) {
            self.finished = true;
            self.client.finishStatus(&self.span, self.parent_ctx, self.info, self.start_time, resp.head.status);
        }
        return resp;
    }

    /// Releases the underlying `std.http.Client.Request`, ends the span if not
    /// already finished, and frees injected header storage.
    pub fn deinit(self: *ClientRequest) void {
        if (!self.finished) {
            self.finished = true;
            self.span.end();
        }
        self.raw.deinit();
        self.arena.deinit();
    }

    fn recordFailure(self: *ClientRequest, err: anyerror) void {
        if (self.finished) return;
        self.finished = true;
        self.client.finishError(&self.span, self.parent_ctx, self.info, self.start_time, err);
    }
};

const HeaderInjectCarrier = struct {
    arena: Allocator,
    headers: std.ArrayList(std.http.Header) = .empty,

    fn carrier(self: *HeaderInjectCarrier) o11y.Carrier {
        return .{ .ptr = self, .vtable = &.{ .get = getFn, .set = setFn } };
    }

    fn getFn(ptr: *anyopaque, key: []const u8) ?[]const u8 {
        const self: *HeaderInjectCarrier = @ptrCast(@alignCast(ptr));
        for (self.headers.items) |h| {
            if (std.ascii.eqlIgnoreCase(h.name, key)) return h.value;
        }
        return null;
    }

    fn setFn(ptr: *anyopaque, key: []const u8, value: []const u8) void {
        const self: *HeaderInjectCarrier = @ptrCast(@alignCast(ptr));
        const val_copy = self.arena.dupe(u8, value) catch return;
        for (self.headers.items) |*h| {
            if (std.ascii.eqlIgnoreCase(h.name, key)) {
                h.value = val_copy;
                return;
            }
        }
        const key_copy = self.arena.dupe(u8, key) catch return;
        self.headers.append(self.arena, .{ .name = key_copy, .value = val_copy }) catch {};
    }
};
