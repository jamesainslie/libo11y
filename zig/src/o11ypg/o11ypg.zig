//! `o11ypg`: OpenTelemetry instrumentation wrapper for `karlseguin/pg.zig`
//! (`pg.Pool` and `pg.Conn`), gated behind `-Dpg`.
//!
//! Mirrors `go/o11ysql/`:
//! - `db.system.name = "postgresql"`, optional `db.namespace`, `server.address`,
//!   and `server.port`;
//! - client spans emitted ONLY when `ctx.span_context.isValid()` (parent span
//!   present), never minting orphan root spans on background/pool queries;
//! - `db.client.operation.duration` histogram (seconds, DB semconv buckets)
//!   recorded for every operation with trace exemplars;
//! - sanitized PostgreSQL `db.query.text` (literals, dollar-quoted strings,
//!   escape strings, and nested block comments removed; valid UTF-8; bounded to
//!   4096 bytes) on spans only, disabled when `query_text = false`;
//! - `error.type` and PostgreSQL SQLSTATE `db.response.status_code` on errors,
//!   with empty span status description so error messages never leak literals;
//! - observable pool metrics (`db.client.connection.count` by `idle`/`used`
//!   state and `db.client.connection.max` tagged with `db.client.connection.pool.name`).

const std = @import("std");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const pg = @import("pg");
const o11y = @import("o11y");
const db = @import("o11y_db");

/// Instrumentation scope name for `o11ypg` spans and metrics.
pub const scope_name = "github.com/jamesainslie/libo11y/zig/o11ypg";

/// Semantic convention `db.system.name` for PostgreSQL.
pub const system_name = "postgresql";

/// Stable DB client duration histogram bucket boundaries (in seconds).
pub const duration_buckets = db.telemetry.duration_buckets;

/// Configuration for `Pool`, `Conn`, and `registerPoolMetrics`.
pub const Options = struct {
    /// The SDK whose tracer and meter to use.
    telemetry: *o11y.Telemetry,
    /// Optional database name (`db.namespace`). Inferred from `pg.Pool.Opts`
    /// or connection URI by `Pool.init` / `Pool.initUri` when null.
    database: ?[]const u8 = null,
    /// Optional server host (`server.address`). Inferred when available.
    server_address: ?[]const u8 = null,
    /// Optional server port (`server.port`). Inferred when available.
    server_port: ?u16 = null,
    /// Pool name stamped as `db.client.connection.pool.name` on pool metrics.
    /// Defaults to `database` when set, else `"postgresql"`.
    pool_name: ?[]const u8 = null,
    /// Record sanitized `db.query.text` on client spans (default `true`).
    query_text: bool = true,
    /// Automatically register observable pool metrics on `Pool.init` /
    /// `Pool.initUri` / `Pool.wrap` (default `true`).
    pool_metrics: bool = true,
};

/// Parsed non-secret connection metadata extracted from a PostgreSQL URI.
pub const UriMetadata = struct {
    database: ?[]const u8 = null,
    server_address: ?[]const u8 = null,
    server_port: ?u16 = null,
};

/// Extracts non-secret telemetry metadata (`database`, `server_address`,
/// `server_port`) from a parsed PostgreSQL `std.Uri`. Never reads credentials.
pub fn metadataFromUri(arena: Allocator, uri: std.Uri) Allocator.Error!UriMetadata {
    const raw_path = try uri.path.toRawMaybeAlloc(arena);
    const trimmed_path = std.mem.trimStart(u8, raw_path, "/");
    const host_raw: ?[]const u8 = if (uri.host) |h| try h.toRawMaybeAlloc(arena) else null;
    const host = if (host_raw) |h| blk: {
        if (h.len >= 2 and h[0] == '[' and h[h.len - 1] == ']') break :blk h[1 .. h.len - 1];
        break :blk if (h.len > 0) h else null;
    } else null;
    const port: ?u16 = uri.port orelse if (host != null) @as(u16, 5432) else null;
    return .{
        .database = if (trimmed_path.len > 0) trimmed_path else null,
        .server_address = host,
        .server_port = port,
    };
}

/// Active observable pool metrics registration. Call `deinit()` before the
/// underlying `*pg.Pool` is destroyed.
pub const PoolMetrics = struct {
    reg: o11y.Registration = .{},
    state: ?*PoolMetricsState = null,

    /// Unregisters the pool metrics callback and frees its state. Idempotent.
    pub fn deinit(self: *PoolMetrics) void {
        self.reg.unregister();
        if (self.state) |st| {
            self.state = null;
            const gpa = st.gpa;
            gpa.free(st.pool_name);
            gpa.destroy(st);
        }
    }
};

const PoolMetricsState = struct {
    gpa: Allocator,
    pool: *pg.Pool,
    pool_name: []u8,
    count_inst: o11y.ObservableUpDownCounter(i64),
    max_inst: o11y.ObservableUpDownCounter(i64),
};

/// Registers `db.client.connection.count` (by `idle`/`used` state) and
/// `db.client.connection.max` observable up-down counters for `raw_pool`.
/// Call `deinit()` on the returned handle before closing `raw_pool`.
pub fn registerPoolMetrics(raw_pool: *pg.Pool, options: Options) PoolMetrics {
    const gpa = options.telemetry.gpa;
    const meter = options.telemetry.meter(scope_name);
    const count_inst = meter.observableUpDownCounter(i64, "db.client.connection.count", .{
        .unit = "{connection}",
        .description = "The number of connections that are currently in state described by the `state` attribute.",
    });
    const max_inst = meter.observableUpDownCounter(i64, "db.client.connection.max", .{
        .unit = "{connection}",
        .description = "The maximum number of open connections allowed.",
    });

    const resolved_name = resolvePoolName(options);
    const name_copy = gpa.dupe(u8, resolved_name) catch return .{};
    const state = gpa.create(PoolMetricsState) catch {
        gpa.free(name_copy);
        return .{};
    };
    state.* = .{
        .gpa = gpa,
        .pool = raw_pool,
        .pool_name = name_copy,
        .count_inst = count_inst,
        .max_inst = max_inst,
    };

    const reg = meter.registerCallback(
        .{ .ptr = state, .func = poolMetricsCallback },
        &.{ count_inst.observable(), max_inst.observable() },
    );
    if (reg.entry == null) {
        gpa.free(name_copy);
        gpa.destroy(state);
        return .{};
    }
    return .{ .reg = reg, .state = state };
}

fn resolvePoolName(options: Options) []const u8 {
    if (options.pool_name) |pn| {
        if (pn.len > 0) return pn;
    }
    if (options.database) |d| {
        if (d.len > 0) return d;
    }
    return system_name;
}

fn poolMetricsCallback(ptr: ?*anyopaque, observer: o11y.Observer) void {
    const st: *const PoolMetricsState = @ptrCast(@alignCast(ptr orelse return));
    observePoolStats(observer, st.count_inst, st.max_inst, st.pool_name, st.pool.stats());
}

/// Emits pool observations from a `pg.Pool.Stats` snapshot. Exported internally
/// for unit testing without requiring a live PostgreSQL server.
pub fn observePoolStats(
    observer: o11y.Observer,
    count_inst: o11y.ObservableUpDownCounter(i64),
    max_inst: o11y.ObservableUpDownCounter(i64),
    pool_name: []const u8,
    stats: pg.Pool.Stats,
) void {
    const idle_attrs = [_]o11y.Attribute{
        o11y.kv("db.client.connection.pool.name", pool_name),
        o11y.kv("db.client.connection.state", "idle"),
    };
    const used_attrs = [_]o11y.Attribute{
        o11y.kv("db.client.connection.pool.name", pool_name),
        o11y.kv("db.client.connection.state", "used"),
    };
    const pool_attrs = [_]o11y.Attribute{
        o11y.kv("db.client.connection.pool.name", pool_name),
    };
    observer.observe(count_inst, @as(i64, @intCast(stats.available)), &idle_attrs);
    observer.observe(count_inst, @as(i64, @intCast(stats.in_use)), &used_attrs);
    if (stats.size > 0) {
        observer.observe(max_inst, @as(i64, @intCast(stats.size)), &pool_attrs);
    }
}

/// Instrumented wrapper around `*pg.Pool`.
pub const Pool = struct {
    gpa: Allocator,
    pool: *pg.Pool,
    owns_pool: bool,
    ins: db.telemetry.Instrumenter,
    pool_metrics: PoolMetrics = .{},
    owned_database: ?[]u8 = null,
    owned_host: ?[]u8 = null,

    /// Opens a `pg.Pool` and instruments all pool operations and pool metrics.
    pub fn init(gpa: Allocator, io: Io, pg_opts: pg.Pool.Opts, options: Options) !Pool {
        const raw_pool = try pg.Pool.init(io, gpa, pg_opts);
        errdefer raw_pool.deinit();

        var resolved = options;
        if (resolved.database == null) resolved.database = pg_opts.auth.database;
        if (resolved.server_address == null) resolved.server_address = pg_opts.connect.host;
        if (resolved.server_port == null) {
            resolved.server_port = pg_opts.connect.port orelse if (resolved.server_address != null) @as(u16, 5432) else null;
        }
        return wrapInternal(gpa, raw_pool, true, resolved);
    }

    /// Opens a `pg.Pool` from a PostgreSQL URI (`postgres://...` /
    /// `postgresql://...`) and instruments all operations and pool metrics.
    pub fn initUri(gpa: Allocator, io: Io, uri: std.Uri, pg_opts: pg.Pool.Opts, options: Options) !Pool {
        const raw_pool = try pg.Pool.initUri(io, gpa, uri, pg_opts);
        errdefer raw_pool.deinit();

        var tmp_arena: std.heap.ArenaAllocator = .init(gpa);
        defer tmp_arena.deinit();
        const meta = metadataFromUri(tmp_arena.allocator(), uri) catch UriMetadata{};

        var resolved = options;
        if (resolved.database == null) resolved.database = meta.database orelse pg_opts.auth.database;
        if (resolved.server_address == null) resolved.server_address = meta.server_address orelse pg_opts.connect.host;
        if (resolved.server_port == null) resolved.server_port = meta.server_port orelse pg_opts.connect.port;
        return wrapInternal(gpa, raw_pool, true, resolved);
    }

    /// Wraps an existing `*pg.Pool` without taking ownership of its lifetime.
    /// Call `deinit()` on the wrapper before calling `raw_pool.deinit()`.
    pub fn wrap(gpa: Allocator, raw_pool: *pg.Pool, options: Options) Allocator.Error!Pool {
        return wrapInternal(gpa, raw_pool, false, options);
    }

    fn wrapInternal(gpa: Allocator, raw_pool: *pg.Pool, owns_pool: bool, options: Options) Allocator.Error!Pool {
        const owned_db: ?[]u8 = if (options.database) |d| (if (d.len > 0) try gpa.dupe(u8, d) else null) else null;
        errdefer if (owned_db) |d| gpa.free(d);
        const owned_host: ?[]u8 = if (options.server_address) |h| (if (h.len > 0) try gpa.dupe(u8, h) else null) else null;
        errdefer if (owned_host) |h| gpa.free(h);

        var owned_opts = options;
        owned_opts.database = owned_db;
        owned_opts.server_address = owned_host;

        const ins = db.telemetry.Instrumenter.init(.{
            .telemetry = options.telemetry,
            .scope_name = scope_name,
            .system = system_name,
            .dialect = .standard,
            .namespace = owned_db,
            .server_address = owned_host,
            .server_port = options.server_port,
            .query_text = options.query_text,
        });

        const pm = if (options.pool_metrics) registerPoolMetrics(raw_pool, owned_opts) else PoolMetrics{};

        return .{
            .gpa = gpa,
            .pool = raw_pool,
            .owns_pool = owns_pool,
            .ins = ins,
            .pool_metrics = pm,
            .owned_database = owned_db,
            .owned_host = owned_host,
        };
    }

    /// Unregisters pool metrics and closes the underlying pool if owned.
    /// Idempotent.
    pub fn deinit(self: *Pool) void {
        self.pool_metrics.deinit();
        if (self.owns_pool) {
            self.owns_pool = false;
            self.pool.deinit();
        }
        if (self.owned_database) |d| self.gpa.free(d);
        if (self.owned_host) |h| self.gpa.free(h);
        self.owned_database = null;
        self.owned_host = null;
    }

    /// Returns the underlying `*pg.Pool`.
    pub fn raw(self: *Pool) *pg.Pool {
        return self.pool;
    }

    /// Returns a snapshot of connection pool statistics.
    pub fn stats(self: *Pool) pg.Pool.Stats {
        return self.pool.stats();
    }

    /// Acquires an instrumented connection from the pool. Call `conn.release()`
    /// when finished.
    pub fn acquire(self: *Pool) !Conn {
        const c = try self.pool.acquire();
        return .{
            .conn = c,
            .ins = self.ins,
        };
    }

    pub fn exec(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype) !?i64 {
        return self.execOpts(ctx, sql, values, .{});
    }

    pub fn execOpts(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !?i64 {
        const op = self.ins.beginQuery(sql);
        var conn = self.pool.acquire() catch |err| {
            op.finish(ctx, err, null);
            return err;
        };
        defer self.pool.release(conn);

        // Always keep release_conn=false inside pg.Conn so conn stays owned
        // until pgErrorCode runs and the single defer releases it.
        var inner_opts = opts;
        inner_opts.release_conn = false;

        const affected = conn.execOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(conn, err));
            return err;
        };
        op.finish(ctx, null, null);
        return affected;
    }

    pub fn query(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype) !*pg.Result {
        return self.queryOpts(ctx, sql, values, .{});
    }

    pub fn queryOpts(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !*pg.Result {
        const op = self.ins.beginQuery(sql);
        var conn = self.pool.acquire() catch |err| {
            op.finish(ctx, err, null);
            return err;
        };

        var inner_opts = opts;
        inner_opts.release_conn = false;

        const result = conn.queryOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(conn, err));
            self.pool.release(conn);
            return err;
        };
        // Transfer pool ownership to Result.deinit() (matches pg.Pool.queryOpts).
        result._release_conn = true;
        op.finish(ctx, null, null);
        return result;
    }

    pub fn row(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype) !?pg.QueryRow {
        return self.rowOpts(ctx, sql, values, .{});
    }

    pub fn rowOpts(self: *Pool, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !?pg.QueryRow {
        const op = self.ins.beginQuery(sql);
        var conn = self.pool.acquire() catch |err| {
            op.finish(ctx, err, null);
            return err;
        };

        var inner_opts = opts;
        inner_opts.release_conn = false;

        const qr_opt = conn.rowOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(conn, err));
            self.pool.release(conn);
            return err;
        };
        if (qr_opt) |qr| {
            // Transfer pool ownership to QueryRow.deinit() -> Result.deinit().
            qr.result._release_conn = true;
        } else {
            // No row returned: conn.rowOpts already finalized Result with
            // _release_conn=false, so release the connection back now.
            self.pool.release(conn);
        }
        op.finish(ctx, null, null);
        return qr_opt;
    }
};

/// Instrumented wrapper around `*pg.Conn`.
pub const Conn = struct {
    conn: *pg.Conn,
    ins: db.telemetry.Instrumenter,

    /// Wraps a standalone `*pg.Conn` with OpenTelemetry instrumentation.
    /// Any borrowed slices in `options` (`database`, `server_address`) must
    /// outlive the `Conn` wrapper.
    pub fn wrap(raw_conn: *pg.Conn, options: Options) Conn {
        return .{
            .conn = raw_conn,
            .ins = db.telemetry.Instrumenter.init(.{
                .telemetry = options.telemetry,
                .scope_name = scope_name,
                .system = system_name,
                .dialect = .standard,
                .namespace = options.database,
                .server_address = options.server_address,
                .server_port = options.server_port,
                .query_text = options.query_text,
            }),
        };
    }

    /// Returns the underlying `*pg.Conn`.
    pub fn raw(self: *Conn) *pg.Conn {
        return self.conn;
    }

    /// Releases a pooled connection back to its pool (or closes a standalone
    /// connection, matching `pg.Conn.release`).
    pub fn release(self: *Conn) void {
        self.conn.release();
    }

    pub fn exec(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype) !?i64 {
        return self.execOpts(ctx, sql, values, .{});
    }

    pub fn execOpts(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !?i64 {
        const op = self.ins.beginQuery(sql);
        var inner_opts = opts;
        inner_opts.release_conn = false;

        const affected = self.conn.execOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            if (opts.release_conn) self.conn.release();
            return err;
        };
        op.finish(ctx, null, null);
        if (opts.release_conn) self.conn.release();
        return affected;
    }

    pub fn query(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype) !*pg.Result {
        return self.queryOpts(ctx, sql, values, .{});
    }

    pub fn queryOpts(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !*pg.Result {
        const op = self.ins.beginQuery(sql);
        var inner_opts = opts;
        inner_opts.release_conn = false;

        const result = self.conn.queryOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            if (opts.release_conn) self.conn.release();
            return err;
        };
        if (opts.release_conn) result._release_conn = true;
        op.finish(ctx, null, null);
        return result;
    }

    pub fn row(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype) !?pg.QueryRow {
        return self.rowOpts(ctx, sql, values, .{});
    }

    pub fn rowOpts(self: *Conn, ctx: o11y.Context, sql: []const u8, values: anytype, opts: pg.Conn.QueryOpts) !?pg.QueryRow {
        const op = self.ins.beginQuery(sql);
        var inner_opts = opts;
        inner_opts.release_conn = false;

        const qr_opt = self.conn.rowOpts(sql, values, inner_opts) catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            if (opts.release_conn) self.conn.release();
            return err;
        };
        if (qr_opt) |qr| {
            if (opts.release_conn) qr.result._release_conn = true;
        } else {
            if (opts.release_conn) self.conn.release();
        }
        op.finish(ctx, null, null);
        return qr_opt;
    }

    pub fn begin(self: *Conn, ctx: o11y.Context) !void {
        const op = self.ins.beginNamed("BEGIN", "");
        self.conn.begin() catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            return err;
        };
        op.finish(ctx, null, null);
    }

    pub fn commit(self: *Conn, ctx: o11y.Context) !void {
        const op = self.ins.beginNamed("COMMIT", "");
        self.conn.commit() catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            return err;
        };
        op.finish(ctx, null, null);
    }

    pub fn rollback(self: *Conn, ctx: o11y.Context) !void {
        const op = self.ins.beginNamed("ROLLBACK", "");
        self.conn.rollback() catch |err| {
            op.finish(ctx, err, pgErrorCode(self.conn, err));
            return err;
        };
        op.finish(ctx, null, null);
    }
};

fn pgErrorCode(conn: *const pg.Conn, err: anyerror) ?[]const u8 {
    if (err != error.PG) return null;
    const pg_err = conn.err orelse return null;
    return if (pg_err.code.len > 0) pg_err.code else null;
}

test "o11ypg.metadataFromUri extracts host, port, and database without credentials" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();

    const uri = try std.Uri.parse("postgres://alice:s3cr3t@127.0.0.1:5433/libo11y_test");
    const meta = try metadataFromUri(arena.allocator(), uri);
    try std.testing.expectEqualStrings("libo11y_test", meta.database.?);
    try std.testing.expectEqualStrings("127.0.0.1", meta.server_address.?);
    try std.testing.expectEqual(@as(u16, 5433), meta.server_port.?);

    const uri_default = try std.Uri.parse("postgresql://db.internal/prod");
    const meta_default = try metadataFromUri(arena.allocator(), uri_default);
    try std.testing.expectEqualStrings("prod", meta_default.database.?);
    try std.testing.expectEqualStrings("db.internal", meta_default.server_address.?);
    try std.testing.expectEqual(@as(u16, 5432), meta_default.server_port.?);
}
