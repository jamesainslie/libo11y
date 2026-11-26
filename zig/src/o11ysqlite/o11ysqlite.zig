//! `o11ysqlite`: OpenTelemetry instrumentation wrapper for
//! `vrischmann/zig-sqlite` (`sqlite.Db` and prepared statements), gated behind
//! `-Dsqlite`.
//!
//! Mirrors `go/o11ysql/`:
//! - `db.system.name = "sqlite"`, optional `db.namespace`;
//! - client spans emitted ONLY when `ctx.span_context.isValid()` (parent span
//!   present), never minting orphan root spans;
//! - `db.client.operation.duration` histogram (seconds, DB semconv buckets)
//!   recorded for every operation with trace exemplars;
//! - sanitized SQLite `db.query.text` (single-quoted and double-quoted strings,
//!   numbers, and comments removed; `[...]` and backtick identifiers and SQLite
//!   parameters kept; valid UTF-8; bounded to 4096 bytes) on spans only;
//! - `error.type` and SQLite extended error code `db.response.status_code` on
//!   errors, with empty span status description so error messages never leak
//!   statement values.

const std = @import("std");
const Allocator = std.mem.Allocator;
const sqlite = @import("sqlite");
const o11y = @import("o11y");
const db = @import("o11y_db");

/// Instrumentation scope name for `o11ysqlite` spans and metrics.
pub const scope_name = "github.com/jamesainslie/libo11y/zig/o11ysqlite";

/// Semantic convention `db.system.name` for SQLite.
pub const system_name = "sqlite";

/// Stable DB client duration histogram bucket boundaries (in seconds).
pub const duration_buckets = db.telemetry.duration_buckets;

/// Configuration for `Db`.
pub const Options = struct {
    /// The SDK whose tracer and meter to use.
    telemetry: *o11y.Telemetry,
    /// Optional database namespace (`db.namespace`, e.g. filename or `"main"`).
    /// When null on `Db.init` with `.mode = .{ .File = path }`, defaults to `path`.
    database: ?[]const u8 = null,
    /// Record sanitized `db.query.text` on client spans (default `true`).
    query_text: bool = true,
};

/// Instrumented wrapper around `sqlite.Db`.
pub const Db = struct {
    inner: sqlite.Db,
    owned: bool,
    ins: db.telemetry.Instrumenter,
    owned_database: ?[]u8 = null,

    /// Opens a `sqlite.Db` and returns an owned instrumented `Db`.
    /// Call `deinit()` to close the database.
    pub fn init(sqlite_opts: sqlite.InitOptions, options: Options) (sqlite.Db.InitError || Allocator.Error)!Db {
        var raw_db = try sqlite.Db.init(sqlite_opts);
        errdefer raw_db.deinit();

        const inferred_db: ?[]const u8 = options.database orelse switch (sqlite_opts.mode) {
            .File => |p| p,
            .Memory => null,
        };
        const gpa = options.telemetry.gpa;
        const owned_db: ?[]u8 = if (inferred_db) |d| (if (d.len > 0) try gpa.dupe(u8, d) else null) else null;
        errdefer if (owned_db) |d| gpa.free(d);

        return .{
            .inner = raw_db,
            .owned = true,
            .owned_database = owned_db,
            .ins = db.telemetry.Instrumenter.init(.{
                .telemetry = options.telemetry,
                .scope_name = scope_name,
                .system = system_name,
                .dialect = .sqlite,
                .namespace = owned_db,
                .query_text = options.query_text,
            }),
        };
    }

    /// Wraps an already-open `sqlite.Db` without taking ownership of its
    /// lifetime. Callers remain responsible for closing the underlying `sqlite.Db`.
    /// Any borrowed `options.database` slice must outlive the wrapper.
    pub fn wrap(raw_db: sqlite.Db, options: Options) Db {
        return .{
            .inner = raw_db,
            .owned = false,
            .ins = db.telemetry.Instrumenter.init(.{
                .telemetry = options.telemetry,
                .scope_name = scope_name,
                .system = system_name,
                .dialect = .sqlite,
                .namespace = options.database,
                .query_text = options.query_text,
            }),
        };
    }

    /// Closes the underlying SQLite database when owned and frees wrapper state.
    pub fn deinit(self: *Db) void {
        if (self.owned) {
            self.inner.deinit();
            self.owned = false;
        }
        if (self.owned_database) |d| {
            self.ins.telemetry.gpa.free(d);
            self.owned_database = null;
        }
    }

    /// Returns a pointer to the underlying `sqlite.Db`.
    pub fn raw(self: *Db) *sqlite.Db {
        return &self.inner;
    }

    pub fn rowsAffected(self: *Db) usize {
        return self.inner.rowsAffected();
    }

    pub fn getLastInsertRowID(self: *Db) i64 {
        return self.inner.getLastInsertRowID();
    }

    /// Prepares and executes a comptime SQL statement that returns no rows.
    pub fn exec(self: *Db, ctx: o11y.Context, comptime query: []const u8, options: sqlite.QueryOptions, values: anytype) !void {
        const op = self.ins.beginQuery(query);
        self.inner.exec(query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
    }

    /// Prepares and executes a runtime SQL statement that returns no rows.
    pub fn execDynamic(self: *Db, ctx: o11y.Context, query: []const u8, options: sqlite.QueryOptions, values: anytype) !void {
        const op = self.ins.beginQuery(query);
        self.inner.execDynamic(query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
    }

    /// Allocator-backed variant of `exec`.
    pub fn execAlloc(self: *Db, ctx: o11y.Context, allocator: Allocator, comptime query: []const u8, options: sqlite.QueryOptions, values: anytype) !void {
        const op = self.ins.beginQuery(query);
        self.inner.execAlloc(allocator, query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
    }

    /// Executes a multi-statement SQL script without bind parameters.
    pub fn execMulti(self: *Db, ctx: o11y.Context, query: []const u8, options: sqlite.QueryOptions) !void {
        const op = self.ins.beginQuery(query);
        self.inner.execMulti(query, options) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
    }

    /// Prepares a comptime SQL query and reads a single row without allocation.
    pub fn one(self: *Db, ctx: o11y.Context, comptime Type: type, comptime query: []const u8, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(query);
        const res = self.inner.one(Type, query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    /// Prepares a runtime SQL query and reads a single row without allocation.
    pub fn oneDynamic(self: *Db, ctx: o11y.Context, comptime Type: type, query: []const u8, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(query);
        const res = self.inner.oneDynamic(Type, query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    /// Prepares a comptime SQL query and reads a single row with allocation.
    pub fn oneAlloc(self: *Db, ctx: o11y.Context, comptime Type: type, allocator: Allocator, comptime query: []const u8, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(query);
        const res = self.inner.oneAlloc(Type, allocator, query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    /// Prepares a runtime SQL query and reads a single row with allocation.
    pub fn oneDynamicAlloc(self: *Db, ctx: o11y.Context, comptime Type: type, allocator: Allocator, query: []const u8, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(query);
        const res = self.inner.oneDynamicAlloc(Type, allocator, query, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    /// Prepares a comptime SQL query and reads all rows into an allocated slice.
    pub fn all(self: *Db, ctx: o11y.Context, comptime Type: type, allocator: Allocator, comptime query: []const u8, options: sqlite.QueryOptions, values: anytype) ![]Type {
        const op = self.ins.beginQuery(query);
        var stmt = self.inner.prepareWithDiags(query, options) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        defer stmt.deinit();
        const rows = stmt.all(Type, allocator, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return rows;
    }

    /// Prepares a runtime SQL query and reads all rows into an allocated slice.
    pub fn allDynamic(self: *Db, ctx: o11y.Context, comptime Type: type, allocator: Allocator, query: []const u8, options: sqlite.QueryOptions, values: anytype) ![]Type {
        const op = self.ins.beginQuery(query);
        var stmt = self.inner.prepareDynamicWithDiags(query, options) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        defer stmt.deinit();
        const rows = stmt.all(Type, allocator, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.inner.db, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return rows;
    }

    /// Prepares an instrumented comptime SQL statement.
    pub fn prepare(self: *Db, comptime query: []const u8) sqlite.DynamicStatement.PrepareError!Statement(query) {
        return self.prepareWithDiags(query, .{});
    }

    /// Prepares an instrumented comptime SQL statement with diagnostics options.
    pub fn prepareWithDiags(self: *Db, comptime query: []const u8, options: sqlite.QueryOptions) sqlite.DynamicStatement.PrepareError!Statement(query) {
        @setEvalBranchQuota(100000);
        const stmt = try self.inner.prepareWithDiags(query, options);
        return .{
            .stmt = stmt,
            .db_handle = self.inner.db,
            .ins = &self.ins,
        };
    }

    /// Prepares an instrumented dynamic SQL statement.
    pub fn prepareDynamic(self: *Db, query: []const u8) (sqlite.DynamicStatement.PrepareError || Allocator.Error)!DynamicStatement {
        return self.prepareDynamicWithDiags(query, .{});
    }

    /// Prepares an instrumented dynamic SQL statement with diagnostics options.
    pub fn prepareDynamicWithDiags(self: *Db, query: []const u8, options: sqlite.QueryOptions) (sqlite.DynamicStatement.PrepareError || Allocator.Error)!DynamicStatement {
        var stmt = try self.inner.prepareDynamicWithDiags(query, options);
        errdefer stmt.deinit();
        const sql_copy = try self.ins.telemetry.gpa.dupe(u8, query);
        return .{
            .stmt = stmt,
            .db_handle = self.inner.db,
            .ins = &self.ins,
            .sql = sql_copy,
        };
    }
};

/// Instrumented wrapper around a comptime-checked `sqlite.StatementType`.
pub fn Statement(comptime query: []const u8) type {
    @setEvalBranchQuota(100000);
    const Inner = sqlite.StatementType(.{}, query);
    return struct {
        const Self = @This();

        stmt: Inner,
        db_handle: *sqlite.c.sqlite3,
        ins: *const db.telemetry.Instrumenter,

        pub fn deinit(self: *Self) void {
            self.stmt.deinit();
        }

        pub fn reset(self: *Self) void {
            self.stmt.reset();
        }

        pub fn exec(self: *Self, ctx: o11y.Context, options: sqlite.QueryOptions, values: anytype) !void {
            const op = self.ins.beginQuery(query);
            self.stmt.exec(options, values) catch |err| {
                var code_buf: [16]u8 = undefined;
                op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
                return err;
            };
            op.finish(ctx, null, null);
        }

        pub fn one(self: *Self, ctx: o11y.Context, comptime Type: type, options: sqlite.QueryOptions, values: anytype) !?Type {
            const op = self.ins.beginQuery(query);
            const res = self.stmt.one(Type, options, values) catch |err| {
                var code_buf: [16]u8 = undefined;
                op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
                return err;
            };
            op.finish(ctx, null, null);
            return res;
        }

        pub fn oneAlloc(self: *Self, ctx: o11y.Context, comptime Type: type, allocator: Allocator, options: sqlite.QueryOptions, values: anytype) !?Type {
            const op = self.ins.beginQuery(query);
            const res = self.stmt.oneAlloc(Type, allocator, options, values) catch |err| {
                var code_buf: [16]u8 = undefined;
                op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
                return err;
            };
            op.finish(ctx, null, null);
            return res;
        }

        pub fn all(self: *Self, ctx: o11y.Context, comptime Type: type, allocator: Allocator, options: sqlite.QueryOptions, values: anytype) ![]Type {
            const op = self.ins.beginQuery(query);
            const rows = self.stmt.all(Type, allocator, options, values) catch |err| {
                var code_buf: [16]u8 = undefined;
                op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
                return err;
            };
            op.finish(ctx, null, null);
            return rows;
        }
    };
}

/// Instrumented wrapper around `sqlite.DynamicStatement`.
pub const DynamicStatement = struct {
    stmt: sqlite.DynamicStatement,
    db_handle: *sqlite.c.sqlite3,
    ins: *const db.telemetry.Instrumenter,
    sql: []u8,

    pub fn deinit(self: *DynamicStatement) void {
        self.stmt.deinit();
        self.ins.telemetry.gpa.free(self.sql);
    }

    pub fn reset(self: *DynamicStatement) void {
        self.stmt.reset();
    }

    pub fn exec(self: *DynamicStatement, ctx: o11y.Context, options: sqlite.QueryOptions, values: anytype) !void {
        const op = self.ins.beginQuery(self.sql);
        self.stmt.exec(options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
    }

    pub fn one(self: *DynamicStatement, ctx: o11y.Context, comptime Type: type, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(self.sql);
        const res = self.stmt.one(Type, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    pub fn oneAlloc(self: *DynamicStatement, ctx: o11y.Context, comptime Type: type, allocator: Allocator, options: sqlite.QueryOptions, values: anytype) !?Type {
        const op = self.ins.beginQuery(self.sql);
        const res = self.stmt.oneAlloc(Type, allocator, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return res;
    }

    pub fn all(self: *DynamicStatement, ctx: o11y.Context, comptime Type: type, allocator: Allocator, options: sqlite.QueryOptions, values: anytype) ![]Type {
        const op = self.ins.beginQuery(self.sql);
        const rows = self.stmt.all(Type, allocator, options, values) catch |err| {
            var code_buf: [16]u8 = undefined;
            op.finish(ctx, err, sqliteErrorCode(self.db_handle, &code_buf));
            return err;
        };
        op.finish(ctx, null, null);
        return rows;
    }
};

fn sqliteErrorCode(handle: *sqlite.c.sqlite3, buf: *[16]u8) ?[]const u8 {
    const code = sqlite.c.sqlite3_extended_errcode(handle);
    if (code == 0 or code == sqlite.c.SQLITE_OK) return null;
    return std.fmt.bufPrint(buf, "{d}", .{code}) catch null;
}

test "o11ysqlite exposes stable scope name and duration buckets" {
    try std.testing.expectEqualStrings("sqlite", system_name);
    try std.testing.expectEqual(@as(usize, 9), duration_buckets.len);
}
