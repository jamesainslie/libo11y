//! HTTP client instrumentation for Zig's `std.http.Client`, mirroring
//! `go/o11yhttp.NewTransport` and `@libo11y/server`'s `instrumentFetch`.
//!
//! Wraps `std.http.Client.fetch` and `std.http.Client.request` with:
//! - a `.client` span named `"{METHOD}"` (or `"HTTP"` for unknown methods);
//! - W3C `traceparent`/`tracestate`/`baggage` header injection via the SDK's
//!   propagator (respecting the baggage egress filter and optional `propagate_fn`);
//! - redirect handling that strips propagated trace/baggage headers and
//!   privileged headers on cross-origin redirects or when `propagate_fn`
//!   declines the redirect target (Zig 0.17.1's `std.http.Client.Request.sendHead`
//!   does not serialize `privileged_headers`, so `o11yhttp.Client` manages
//!   redirect hops explicitly and writes active headers through `extra_headers`);
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

    /// Performs a one-shot instrumented HTTP request matching
    /// `std.http.Client.fetch`, injecting W3C trace context and egress-filtered
    /// baggage headers (stripped on cross-origin redirects) and recording the
    /// client span and `http.client.request.duration` metric.
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

        const redirect_behavior: std.http.Client.Request.RedirectBehavior = options.redirect_behavior orelse
            if (options.payload == null) std.http.Client.Request.RedirectBehavior.init(3) else .unhandled;

        var req = try self.request(ctx, method, uri, .{
            .redirect_behavior = redirect_behavior,
            .headers = options.headers,
            .extra_headers = options.extra_headers,
            .privileged_headers = options.privileged_headers,
            .keep_alive = options.keep_alive,
        });
        defer req.deinit();

        if (options.payload) |payload| {
            req.raw.transfer_encoding = .{ .content_length = payload.len };
            var body = req.raw.sendBodyUnflushed(&.{}) catch |err| {
                req.recordFailure(err);
                return err;
            };
            body.writer.writeAll(payload) catch |err| {
                req.recordFailure(err);
                return err;
            };
            body.end() catch |err| {
                req.recordFailure(err);
                return err;
            };
            req.raw.connection.?.flush() catch |err| {
                req.recordFailure(err);
                return err;
            };
        } else {
            try req.sendBodiless();
        }

        const redirect_buffer: []u8 = if (redirect_behavior == .unhandled) &.{} else options.redirect_buffer orelse
            try self.http_client.allocator.alloc(u8, 8 * 1024);
        defer if (options.redirect_buffer == null) self.http_client.allocator.free(redirect_buffer);

        // fetch reads the body itself, so the span and the duration cover
        // it: a body that fails to arrive marks the span as an error.
        req.finish_on_head = false;
        var response = try req.receiveHead(redirect_buffer);
        const status = response.head.status;
        self.readBody(options, &response) catch |err| {
            req.recordFailure(err);
            return err;
        };
        req.finishWith(status);
        return .{ .status = status };
    }

    /// Reads the response body as `std.http.Client.fetch` does: into
    /// `options.response_writer`, decompressed, or discarded without one.
    fn readBody(
        self: *const Client,
        options: std.http.Client.FetchOptions,
        response: *std.http.Client.Response,
    ) std.http.Client.FetchError!void {
        // A response to HEAD has no body. For it `Response.reader` returns
        // `Io.Reader.ending`, a shared constant, and draining that writes
        // to read-only memory in a release build (Zig 0.17.1).
        if (response.request.method == .HEAD) return;
        const response_writer = options.response_writer orelse {
            const reader = response.reader(&.{});
            _ = reader.discardRemaining() catch |err| switch (err) {
                error.ReadFailed => return response.bodyErr().?,
            };
            return;
        };

        const decompress_buffer: []u8 = switch (response.head.content_encoding) {
            .identity => &.{},
            .zstd => options.decompress_buffer orelse try self.http_client.allocator.alloc(u8, std.compress.zstd.default_window_len),
            .deflate, .gzip => options.decompress_buffer orelse try self.http_client.allocator.alloc(u8, std.compress.flate.max_window_len),
            .compress => return error.UnsupportedCompressionMethod,
        };
        defer if (options.decompress_buffer == null) self.http_client.allocator.free(decompress_buffer);

        var transfer_buffer: [64]u8 = undefined;
        var decompress: std.http.Decompress = undefined;
        const reader = response.readerDecompressing(&transfer_buffer, &decompress, decompress_buffer);

        _ = reader.streamRemaining(response_writer) catch |err| switch (err) {
            error.ReadFailed => return response.bodyErr().?,
            else => |e| return e,
        };
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

        const orig_extra = try dupeHeaders(a, options.extra_headers);
        const orig_priv = try dupeHeaders(a, options.privileged_headers);

        const header_set = try self.buildHopHeaders(a, span_ctx, uri, orig_extra, orig_priv, true);

        var patched = options;
        // Handle redirects inside ClientRequest.receiveHead so propagated
        // headers are stripped on cross-origin redirects (Zig 0.17.1's
        // std.http.Client.Request.sendHead does not write privileged_headers).
        patched.redirect_behavior = .unhandled;
        patched.extra_headers = header_set.wire_headers;
        patched.privileged_headers = header_set.privileged_headers;

        const raw = self.http_client.request(method, uri, patched) catch |err| {
            self.finishError(&span, ctx, info, start_time, err);
            return err;
        };

        return .{
            .client = self,
            .raw = raw,
            .has_raw = true,
            .arena = arena_state,
            .parent_ctx = ctx,
            .span = span,
            .info = info,
            .start_time = start_time,
            .redirect_behavior = options.redirect_behavior,
            .orig_extra_headers = orig_extra,
            .orig_privileged_headers = orig_priv,
            .initial_uri = uri,
        };
    }

    fn shouldPropagate(self: *const Client, uri: std.Uri) bool {
        if (self.options.propagate_fn) |pred| {
            return pred(uri);
        }
        return true;
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

    const HopHeaders = struct {
        /// Headers actually serialized by Zig 0.17.1 `std.http.Client.Request.sendHead`.
        wire_headers: []const std.http.Header,
        /// Non-shadowed privileged headers retained for same-origin hops.
        privileged_headers: []const std.http.Header,
    };

    /// Builds the header slices for one HTTP hop.
    ///
    /// When `same_origin` is true and `propagate_fn(uri)` allows propagation:
    /// injects trace/baggage headers, deduplicates shadowed header names from
    /// BOTH `extra` and `privileged`, and appends the injected headers to
    /// `wire_headers` (and keeps non-shadowed `privileged` headers on
    /// `privileged_headers` plus serialized into `wire_headers` so caller
    /// privileged headers are also preserved on same-origin hops).
    ///
    /// When `same_origin` is false (cross-origin redirect) or `propagate_fn`
    /// returns false: omits injected propagation headers AND strips any
    /// propagator field names (e.g. `traceparent`, `tracestate`, `baggage`)
    /// the caller supplied, from `extra` and `privileged` alike. A
    /// cross-origin hop also drops every caller `privileged` header.
    ///
    /// Fails when memory runs out. It never falls back to the caller's
    /// headers, because those can hold the fields this function removes.
    fn buildHopHeaders(
        self: *const Client,
        arena: Allocator,
        span_ctx: o11y.Context,
        uri: std.Uri,
        extra: []const std.http.Header,
        privileged: []const std.http.Header,
        same_origin: bool,
    ) Allocator.Error!HopHeaders {
        const prop = self.options.telemetry.propagator();
        const allow_prop = same_origin and self.shouldPropagate(uri);

        var inj: HeaderInjectCarrier = .{ .arena = arena };
        if (allow_prop) {
            prop.inject(span_ctx, arena, inj.carrier());
        }

        const prop_fields = prop.fields();
        const keep_priv = same_origin;

        var wire: std.ArrayList(std.http.Header) = .empty;
        var priv_out: std.ArrayList(std.http.Header) = .empty;

        for (extra) |h| {
            const shadowed = headerInList(h.name, inj.headers.items) or
                (!allow_prop and nameInSlice(h.name, prop_fields));
            if (!shadowed) try wire.append(arena, h);
        }
        if (keep_priv) {
            for (privileged) |h| {
                const shadowed = headerInList(h.name, inj.headers.items) or
                    (!allow_prop and nameInSlice(h.name, prop_fields));
                if (!shadowed) {
                    try priv_out.append(arena, h);
                    try wire.append(arena, h);
                }
            }
        }
        for (inj.headers.items) |ih| {
            try wire.append(arena, ih);
            try priv_out.append(arena, ih);
        }

        return .{
            .wire_headers = wire.items,
            .privileged_headers = priv_out.items,
        };
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
    has_raw: bool = true,
    arena: std.heap.ArenaAllocator,
    parent_ctx: o11y.Context,
    span: o11y.Span,
    info: SpanInfo,
    start_time: Io.Timestamp,
    redirect_behavior: std.http.Client.Request.RedirectBehavior,
    orig_extra_headers: []const std.http.Header,
    orig_privileged_headers: []const std.http.Header,
    initial_uri: std.Uri,
    finished: bool = false,
    /// Set once a redirect leaves the first origin. From then on every hop
    /// counts as cross-origin, also one back to the first origin, so
    /// stripped headers are never restored. `std.http.Client` drops its
    /// privileged headers for good in the same way.
    left_origin: bool = false,
    /// Whether `receiveHead` ends the span. `Client.fetch` clears it and
    /// ends the span after it has read the body.
    finish_on_head: bool = true,

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

    /// Receives response headers, following redirects hop-by-hop (stripping
    /// propagated trace/baggage and privileged headers on cross-origin hops),
    /// recording HTTP status and client duration metric with exemplar, and
    /// ending the client span. The span ends here because the caller reads
    /// the body afterwards, outside the wrapper. `Client.fetch` reads the
    /// body itself and ends the span after it.
    pub fn receiveHead(
        self: *ClientRequest,
        redirect_buffer: []u8,
    ) std.http.Client.Request.ReceiveHeadError!std.http.Client.Response {
        var aux_buf = redirect_buffer;
        while (true) {
            var resp = self.raw.receiveHead(&.{}) catch |err| {
                self.recordFailure(err);
                return err;
            };
            const head = &resp.head;
            // As in `std.http.Client.Request.receiveHead`: any response to
            // HEAD, and a 304, ends at its header block and is returned
            // as it is, never followed as a redirect.
            const final = self.raw.method == .HEAD or head.status == .not_modified;
            if (!final and head.status.class() == .redirect and self.redirect_behavior != .unhandled) {
                if (self.redirect_behavior == .not_allowed) {
                    const body_r = resp.reader(&.{});
                    _ = body_r.discardRemaining() catch {};
                    self.recordFailure(error.TooManyHttpRedirects);
                    return error.TooManyHttpRedirects;
                }
                const loc_raw = head.location orelse {
                    self.recordFailure(error.HttpRedirectLocationMissing);
                    return error.HttpRedirectLocationMissing;
                };
                if (loc_raw.len > aux_buf.len) {
                    self.recordFailure(error.HttpRedirectLocationOversize);
                    return error.HttpRedirectLocationOversize;
                }
                @memcpy(aux_buf[0..loc_raw.len], loc_raw);
                const loc_len = loc_raw.len;
                const status = head.status;
                // Discard the redirect response body so the connection can be reused.
                {
                    const body_r = resp.reader(&.{});
                    _ = body_r.discardRemaining() catch {};
                }
                const new_uri = self.raw.uri.resolveInPlace(loc_len, &aux_buf) catch |err| {
                    const mapped: std.http.Client.Request.ReceiveHeadError = switch (err) {
                        error.UnexpectedCharacter,
                        error.InvalidFormat,
                        error.InvalidPort,
                        error.InvalidHostName,
                        => error.HttpRedirectLocationInvalid,
                        error.NoSpaceLeft => error.HttpRedirectLocationOversize,
                    };
                    self.recordFailure(mapped);
                    return mapped;
                };

                var next_method = self.raw.method;
                var next_headers = self.raw.headers;
                const switch_to_get = switch (status) {
                    .see_other => true,
                    .moved_permanently, .found => self.raw.method == .POST,
                    else => false,
                };
                if (switch_to_get) {
                    next_method = .GET;
                    next_headers.content_type = .omit;
                } else if (self.raw.transfer_encoding != .none) {
                    self.recordFailure(error.RedirectRequiresResend);
                    return error.RedirectRequiresResend;
                }

                const a = self.arena.allocator();
                if (!common.sameOrigin(a, self.initial_uri, new_uri)) self.left_origin = true;
                const same_origin = !self.left_origin;
                const span_ctx = self.parent_ctx.withSpan(&self.span);
                const header_set = self.client.buildHopHeaders(
                    a,
                    span_ctx,
                    new_uri,
                    self.orig_extra_headers,
                    self.orig_privileged_headers,
                    same_origin,
                ) catch |err| {
                    self.recordFailure(err);
                    return err;
                };

                const version = self.raw.version;
                const keep_alive = self.raw.keep_alive;
                const handle_continue = self.raw.handle_continue;

                self.redirect_behavior.subtractOne();
                self.raw.deinit();
                self.has_raw = false;

                const next_raw = self.client.http_client.request(next_method, new_uri, .{
                    .version = version,
                    .keep_alive = keep_alive,
                    .handle_continue = handle_continue,
                    .redirect_behavior = .unhandled,
                    .headers = next_headers,
                    .extra_headers = header_set.wire_headers,
                    .privileged_headers = header_set.privileged_headers,
                }) catch |err| {
                    self.recordFailure(err);
                    return err;
                };
                self.raw = next_raw;
                self.has_raw = true;
                self.raw.sendBodiless() catch |err| {
                    self.recordFailure(err);
                    return err;
                };
                continue;
            }

            if (self.finish_on_head) self.finishWith(resp.head.status);
            return resp;
        }
    }

    /// Records the response status and the request duration and ends the
    /// span, once.
    fn finishWith(self: *ClientRequest, status: std.http.Status) void {
        if (self.finished) return;
        self.finished = true;
        self.client.finishStatus(&self.span, self.parent_ctx, self.info, self.start_time, status);
    }

    /// Releases the underlying `std.http.Client.Request`, ends the span if not
    /// already finished, and frees injected header storage.
    pub fn deinit(self: *ClientRequest) void {
        if (!self.finished) {
            self.finished = true;
            self.span.end();
        }
        if (self.has_raw) {
            self.raw.deinit();
            self.has_raw = false;
        }
        self.arena.deinit();
    }

    fn recordFailure(self: *ClientRequest, err: anyerror) void {
        if (self.finished) return;
        self.finished = true;
        self.client.finishError(&self.span, self.parent_ctx, self.info, self.start_time, err);
    }
};

fn dupeHeaders(arena: Allocator, headers: []const std.http.Header) Allocator.Error![]const std.http.Header {
    if (headers.len == 0) return &.{};
    const out = try arena.alloc(std.http.Header, headers.len);
    for (out, headers) |*dst, src| {
        dst.* = .{
            .name = try arena.dupe(u8, src.name),
            .value = try arena.dupe(u8, src.value),
        };
    }
    return out;
}

fn headerInList(name: []const u8, list: []const std.http.Header) bool {
    for (list) |h| {
        if (std.ascii.eqlIgnoreCase(name, h.name)) return true;
    }
    return false;
}

fn nameInSlice(name: []const u8, names: []const []const u8) bool {
    for (names) |n| {
        if (std.ascii.eqlIgnoreCase(name, n)) return true;
    }
    return false;
}

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

const testing = std.testing;

test "buildHopHeaders deduplicates shadowed headers from both extra and privileged and strips on cross-origin" {
    const sdk = try o11y.init(testing.allocator, testing.io, .{
        .service_name = "client-hdr-test",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
    });
    defer sdk.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const c = Client.init(&std_client, .{ .telemetry = sdk });

    var sp = sdk.tracer("test").start(.background, "out", .{});
    defer sp.end();
    const bag: o11y.Baggage = .{ .members = &.{.{ .key = "tenant", .value = "acme" }} };
    const ctx = o11y.Context.background.withSpan(&sp).withBaggage(&bag);
    const uri = try std.Uri.parse("http://127.0.0.1:8080/api");

    const extra = [_]std.http.Header{
        .{ .name = "X-Custom", .value = "1" },
        .{ .name = "TraceParent", .value = "00-stale-stale-00" },
    };
    const priv = [_]std.http.Header{
        .{ .name = "X-Secret-Token", .value = "tok" },
        .{ .name = "Baggage", .value = "stale=1" },
    };

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();

    // Same-origin hop: propagated headers land in both privileged_headers and
    // wire_headers, shadowing stale duplicates from extra and privileged.
    const same = try c.buildHopHeaders(a, ctx, uri, &extra, &priv, true);
    var tp_count: usize = 0;
    var bag_count: usize = 0;
    var saw_custom = false;
    var saw_priv_tok = false;
    for (same.wire_headers) |h| {
        if (std.ascii.eqlIgnoreCase(h.name, "traceparent")) {
            tp_count += 1;
            try testing.expect(!std.mem.eql(u8, h.value, "00-stale-stale-00"));
        } else if (std.ascii.eqlIgnoreCase(h.name, "baggage")) {
            bag_count += 1;
            try testing.expectEqualStrings("tenant=acme", h.value);
        } else if (std.mem.eql(u8, h.name, "X-Custom")) {
            saw_custom = true;
        } else if (std.mem.eql(u8, h.name, "X-Secret-Token")) {
            saw_priv_tok = true;
        }
    }
    try testing.expectEqual(@as(usize, 1), tp_count);
    try testing.expectEqual(@as(usize, 1), bag_count);
    try testing.expect(saw_custom);
    try testing.expect(saw_priv_tok);
    try testing.expect(headerInList("traceparent", same.privileged_headers));
    try testing.expect(headerInList("baggage", same.privileged_headers));

    // Cross-origin hop: propagation headers and privileged headers are stripped.
    const cross = try c.buildHopHeaders(a, ctx, uri, &extra, &priv, false);
    try testing.expectEqual(@as(usize, 0), cross.privileged_headers.len);
    try testing.expect(!headerInList("traceparent", cross.wire_headers));
    try testing.expect(!headerInList("baggage", cross.wire_headers));
    try testing.expect(!headerInList("X-Secret-Token", cross.wire_headers));
    try testing.expect(headerInList("X-Custom", cross.wire_headers));
}

test "buildHopHeaders strips propagator fields when propagate_fn denies the destination" {
    const sdk = try o11y.init(testing.allocator, testing.io, .{
        .service_name = "client-hdr-test",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
    });
    defer sdk.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const c = Client.init(&std_client, .{
        .telemetry = sdk,
        .propagate_fn = struct {
            fn deny(_: std.Uri) bool {
                return false;
            }
        }.deny,
    });

    var sp = sdk.tracer("test").start(.background, "out", .{});
    defer sp.end();
    const ctx = o11y.Context.background.withSpan(&sp);
    const uri = try std.Uri.parse("http://third-party.example/api");

    const extra = [_]std.http.Header{
        .{ .name = "X-Custom", .value = "1" },
        .{ .name = "TraceParent", .value = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    };
    const priv = [_]std.http.Header{
        .{ .name = "X-Secret-Token", .value = "tok" },
        .{ .name = "Baggage", .value = "tenant=acme" },
        .{ .name = "tracestate", .value = "vendor=1" },
    };

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();

    // The first hop, and a same-origin redirect, of a destination the
    // predicate denies: nothing is injected, and trace context the caller
    // put in the headers is removed too. Other headers stay.
    const denied = try c.buildHopHeaders(arena.allocator(), ctx, uri, &extra, &priv, true);
    for ([_][]const u8{ "traceparent", "tracestate", "baggage" }) |name| {
        try testing.expect(!headerInList(name, denied.wire_headers));
        try testing.expect(!headerInList(name, denied.privileged_headers));
    }
    try testing.expect(headerInList("X-Custom", denied.wire_headers));
    try testing.expect(headerInList("X-Secret-Token", denied.wire_headers));
    try testing.expect(headerInList("X-Secret-Token", denied.privileged_headers));
}

test "buildHopHeaders fails when memory runs out and never falls back to the unfiltered headers" {
    const sdk = try o11y.init(testing.allocator, testing.io, .{
        .service_name = "client-hdr-test",
        .environment = "test",
        .console_enabled = false,
        .runtime_metrics = false,
        .sampler = .always_on,
    });
    defer sdk.deinit();

    var std_client: std.http.Client = .{ .allocator = testing.allocator, .io = testing.io };
    defer std_client.deinit();
    const c = Client.init(&std_client, .{ .telemetry = sdk });

    var sp = sdk.tracer("test").start(.background, "out", .{});
    defer sp.end();
    const ctx = o11y.Context.background.withSpan(&sp);
    const uri = try std.Uri.parse("http://other-origin.example/api");

    const extra = [_]std.http.Header{
        .{ .name = "X-Custom", .value = "1" },
        .{ .name = "traceparent", .value = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    };
    const priv = [_]std.http.Header{.{ .name = "X-Secret-Token", .value = "tok" }};

    // A cross-origin hop must strip trace context and privileged headers.
    // Whichever allocation fails, the result is an error, never a header
    // list that still carries them.
    var fail_index: usize = 0;
    while (true) : (fail_index += 1) {
        var failing: std.testing.FailingAllocator = .init(testing.allocator, .{ .fail_index = fail_index });
        var arena: std.heap.ArenaAllocator = .init(failing.allocator());
        defer arena.deinit();
        const hop = c.buildHopHeaders(arena.allocator(), ctx, uri, &extra, &priv, false) catch |err| {
            try testing.expectEqual(error.OutOfMemory, err);
            continue;
        };
        try testing.expect(!headerInList("traceparent", hop.wire_headers));
        try testing.expect(!headerInList("X-Secret-Token", hop.wire_headers));
        try testing.expectEqual(@as(usize, 0), hop.privileged_headers.len);
        try testing.expect(!failing.has_induced_failure);
        break;
    }
    try testing.expect(fail_index > 0);
}
