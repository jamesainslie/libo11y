//! Shared database client telemetry helper (`Instrumenter` / `Operation`)
//! used by `o11ypg` and `o11ysqlite`, matching `go/o11ysql/telemetry.go`.
//!
//! Guarantees:
//! - Client spans are created ONLY when `ctx.span_context.isValid()` (a parent
//!   span is active), so pool maintenance and rootless background queries never
//!   mint orphan root spans.
//! - `db.client.operation.duration` (seconds, stable DB semconv buckets) is
//!   recorded for every operation whether or not a parent span exists, with an
//!   exemplar pointing at the client span when one was created.
//! - `db.query.text` is sanitized under the engine's SQL dialect, forced to
//!   valid UTF-8, bounded to 4096 bytes on a UTF-8 boundary, and placed on
//!   spans only (never on metrics).
//! - On error, `error.type` and optional `db.response.status_code` are recorded
//!   and span status is set to `.@"error"` with an EMPTY description so raw
//!   database error messages never leak literal statement values.

const std = @import("std");
const Io = std.Io;
const o11y = @import("o11y");
const sqltext = @import("sqltext.zig");

/// Advisory histogram bucket boundaries (in seconds) for
/// `db.client.operation.duration`, matching Go's `o11ysql` and OTel DB semconv.
pub const duration_buckets = [_]f64{
    0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10,
};

/// Configuration for `Instrumenter`.
pub const Config = struct {
    telemetry: *o11y.Telemetry,
    scope_name: []const u8,
    system: []const u8,
    dialect: sqltext.Dialect,
    namespace: ?[]const u8 = null,
    server_address: ?[]const u8 = null,
    server_port: ?u16 = null,
    query_text: bool = true,
};

/// Turns database client operations into spans and duration histograms.
pub const Instrumenter = struct {
    telemetry: *o11y.Telemetry,
    tracer: *const o11y.Tracer,
    duration: o11y.Histogram(f64),
    system: []const u8,
    dialect: sqltext.Dialect,
    namespace: ?[]const u8,
    server_address: ?[]const u8,
    server_port: ?u16,
    query_text: bool,

    pub fn init(cfg: Config) Instrumenter {
        const meter = cfg.telemetry.meter(cfg.scope_name);
        return .{
            .telemetry = cfg.telemetry,
            .tracer = cfg.telemetry.tracer(cfg.scope_name),
            .duration = meter.histogram(f64, "db.client.operation.duration", .{
                .unit = "s",
                .description = "Duration of database client operations.",
                .explicit_bucket_boundaries = &duration_buckets,
            }),
            .system = cfg.system,
            .dialect = cfg.dialect,
            .namespace = if (cfg.namespace) |ns| (if (ns.len > 0) ns else null) else null,
            .server_address = if (cfg.server_address) |addr| (if (addr.len > 0) addr else null) else null,
            .server_port = if (cfg.server_port) |p| (if (p > 0) p else null) else null,
            .query_text = cfg.query_text,
        };
    }

    /// Starts timing a SQL statement execution.
    pub fn beginQuery(self: *const Instrumenter, sql: []const u8) Operation {
        const io = self.telemetry.io;
        return .{
            .in = self,
            .kind = .{ .sql = sql },
            .start_awake = Io.Clock.awake.now(io),
            .start_unix_nano = nowUnixNano(io),
        };
    }

    /// Starts timing a named database operation without SQL text (such as
    /// `BEGIN`, `COMMIT`, or `ROLLBACK`).
    pub fn beginNamed(self: *const Instrumenter, operation: []const u8, collection: []const u8) Operation {
        const io = self.telemetry.io;
        return .{
            .in = self,
            .kind = .{ .named = .{ .operation = operation, .collection = collection } },
            .start_awake = Io.Clock.awake.now(io),
            .start_unix_nano = nowUnixNano(io),
        };
    }
};

/// One in-flight database operation.
pub const Operation = struct {
    in: *const Instrumenter,
    kind: Kind,
    start_awake: Io.Timestamp,
    start_unix_nano: u64,

    const Kind = union(enum) {
        sql: []const u8,
        named: struct {
            operation: []const u8,
            collection: []const u8,
        },
    };

    /// Records the completed database operation's span (only when `ctx` has a
    /// valid parent span) and `db.client.operation.duration` histogram.
    ///
    /// Hot-path safe: returns `void` and never fails the caller.
    pub fn finish(
        self: Operation,
        ctx: o11y.Context,
        err: ?anyerror,
        response_status_code: ?[]const u8,
    ) void {
        const io = self.in.telemetry.io;
        const end_awake = Io.Clock.awake.now(io);
        const end_unix_nano = @max(self.start_unix_nano, nowUnixNano(io));
        const elapsed = elapsedSeconds(self.start_awake, end_awake);

        var stack_buf: [8192]u8 = undefined;
        var fb: std.heap.BufferFirstAllocator = .init(&stack_buf, self.in.telemetry.gpa);
        var arena: std.heap.ArenaAllocator = .init(fb.allocator());
        defer arena.deinit();
        const a = arena.allocator();

        var op_name: []const u8 = "";
        var coll_name: []const u8 = "";
        var query_text: []const u8 = "";

        switch (self.kind) {
            .sql => |raw_sql| {
                const sanitized_raw = sqltext.sanitize(a, raw_sql, self.in.dialect) catch "";
                const sanitized = sqltext.toValidUtf8(a, sanitized_raw) catch "";
                const sum = sqltext.summarize(a, sanitized) catch sqltext.Summary{};
                op_name = sum.operation;
                coll_name = sum.collection;
                if (self.in.query_text and sanitized.len > 0) {
                    query_text = sqltext.truncateUtf8(sanitized, sqltext.max_query_text);
                }
            },
            .named => |n| {
                op_name = n.operation;
                coll_name = n.collection;
            },
        }

        // Common attributes for both span and metric.
        var attrs_buf: [9]o11y.Attribute = undefined;
        var n_attrs: usize = 0;
        attrs_buf[n_attrs] = o11y.kv("db.system.name", self.in.system);
        n_attrs += 1;
        if (op_name.len > 0) {
            attrs_buf[n_attrs] = o11y.kv("db.operation.name", op_name);
            n_attrs += 1;
        }
        if (coll_name.len > 0) {
            attrs_buf[n_attrs] = o11y.kv("db.collection.name", coll_name);
            n_attrs += 1;
        }
        if (self.in.namespace) |ns| {
            attrs_buf[n_attrs] = o11y.kv("db.namespace", ns);
            n_attrs += 1;
        }
        if (self.in.server_address) |addr| {
            attrs_buf[n_attrs] = o11y.kv("server.address", addr);
            n_attrs += 1;
        }
        if (self.in.server_port) |port| {
            attrs_buf[n_attrs] = o11y.kv("server.port", @as(i64, port));
            n_attrs += 1;
        }
        if (response_status_code) |code| {
            if (code.len > 0) {
                attrs_buf[n_attrs] = o11y.kv("db.response.status_code", code);
                n_attrs += 1;
            }
        }
        if (err) |e| {
            attrs_buf[n_attrs] = o11y.kv("error.type", @errorName(e));
            n_attrs += 1;
        }
        const metric_attrs = attrs_buf[0..n_attrs];

        // Emit client span ONLY when a valid parent span is in `ctx`.
        if (ctx.span_context.isValid()) {
            const span_name = formatSpanName(a, self.in.system, op_name, coll_name);
            var span_n = n_attrs;
            if (query_text.len > 0) {
                attrs_buf[span_n] = o11y.kv("db.query.text", query_text);
                span_n += 1;
            }
            var span = self.in.tracer.start(ctx, span_name, .{
                .kind = .client,
                .start_time = self.start_unix_nano,
                .attributes = attrs_buf[0..span_n],
            });
            if (err != null) {
                // Empty description: DB errors often quote literal values.
                span.setStatus(.@"error", "");
            }
            const span_ctx = ctx.withSpan(&span);
            self.in.duration.record(span_ctx, elapsed, metric_attrs);
            span.endAt(end_unix_nano);
        } else {
            self.in.duration.record(ctx, elapsed, metric_attrs);
        }
    }
};

fn formatSpanName(arena: std.mem.Allocator, system: []const u8, op: []const u8, coll: []const u8) []const u8 {
    if (op.len > 0 and coll.len > 0) {
        return std.fmt.allocPrint(arena, "{s} {s}", .{ op, coll }) catch op;
    }
    if (op.len > 0) return op;
    if (coll.len > 0) return coll;
    return system;
}

fn nowUnixNano(io: Io) u64 {
    const ns = Io.Clock.real.now(io).nanoseconds;
    return std.math.cast(u64, ns) orelse 0;
}

fn elapsedSeconds(start: Io.Timestamp, end: Io.Timestamp) f64 {
    const diff = end.nanoseconds - start.nanoseconds;
    if (diff <= 0) return 0.0;
    return @as(f64, @floatFromInt(diff)) / 1_000_000_000.0;
}
