//! SQL query text sanitization and operation/collection summarization, ported
//! from `go/o11ysql/internal/sqltext/sqltext.go`.
//!
//! `sanitize` removes every string, numeric, and dollar-quoted literal and
//! every SQL comment so a statement can be recorded as `db.query.text` without
//! leaking bound values or PII. `summarize` derives the bounded
//! `db.operation.name` and `db.collection.name` attributes from sanitized SQL.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// Selects the lexical rules that differ between database engines.
pub const Dialect = enum {
    /// ANSI SQL and PostgreSQL: `"..."` quotes an identifier, backslash inside
    /// `'...'` is an ordinary character, `E'...'` is a backslash-escape string,
    /// `$tag$...$tag$` quotes a string, and block comments nest.
    standard,
    /// MySQL and MariaDB: `"..."` quotes a string, backslash escapes in strings,
    /// `#` and `--` followed by whitespace start comments, `/*! ... */` bodies
    /// are lexed as SQL, and block comments do not nest.
    mysql,
    /// SQLite: `` `...` `` and `[...]` quote identifiers, backslash inside
    /// `'...'` is ordinary, `$`, `@`, `:`, and `#` start parameter names, block
    /// comments do not nest, and `"..."` is removed like a string because SQLite
    /// treats unmatched double-quoted tokens as string literals.
    sqlite,
};

/// Maximum byte length of `db.collection.name`.
pub const max_collection: usize = 128;

/// Maximum byte length of `db.query.text` (cut on a UTF-8 codepoint boundary).
pub const max_query_text: usize = 4096;

/// Replaces every string, number, and dollar-quoted literal in `query` with `?`
/// and every comment with a single space, following the lexical rules of
/// `dialect`. Identifiers, keywords, operators, and placeholders (`$1`, `?`,
/// `:name`, `@p1`, and SQLite's `?1` / `:1`) are preserved. Unterminated
/// literals, comments, or quoted identifiers are removed to the end of `query`.
/// The output is never longer than `query`.
pub fn sanitize(allocator: Allocator, query: []const u8, dialect: Dialect) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = try .initCapacity(allocator, query.len);
    errdefer out.deinit(allocator);

    const mysql = dialect == .mysql;
    const sqlite = dialect == .sqlite;
    const pg = !mysql and !sqlite;
    var in_versioned = false;

    var i: usize = 0;
    while (i < query.len) {
        const c = query[i];
        if (c == '\'') {
            i = skipQuoted(query, i, '\'', mysql).end;
            out.appendAssumeCapacity('?');
        } else if (pg and (c == 'E' or c == 'e') and nextByte(query, i) == '\'') {
            i = skipQuoted(query, i + 1, '\'', true).end;
            out.appendAssumeCapacity('?');
        } else if (c == '"' and !pg) {
            i = skipQuoted(query, i, '"', mysql).end;
            out.appendAssumeCapacity('?');
        } else if (c == '"' or (c == '`' and !pg) or (c == '[' and sqlite)) {
            const res = skipQuotedName(query, i);
            if (res.closed) {
                out.appendSliceAssumeCapacity(query[i..res.end]);
            } else {
                out.appendAssumeCapacity('?');
            }
            i = res.end;
        } else if ((c == '-' and nextByte(query, i) == '-' and (!mysql or mysqlDashComment(query, i))) or (c == '#' and mysql)) {
            i = skipLine(query, i);
            out.appendAssumeCapacity(' ');
        } else if (c == '/' and nextByte(query, i) == '*') {
            if (mysql) {
                if (skipVersionedOpen(query, i)) |end| {
                    in_versioned = true;
                    i = end;
                } else {
                    i = skipBlock(query, i, false);
                }
            } else {
                i = skipBlock(query, i, pg);
            }
            out.appendAssumeCapacity(' ');
        } else if (in_versioned and c == '*' and nextByte(query, i) == '/') {
            in_versioned = false;
            i += 2;
            out.appendAssumeCapacity(' ');
        } else if (pg and c == '$') {
            if (skipDollarQuoted(query, i)) |end| {
                out.appendAssumeCapacity('?');
                i = end;
            } else {
                const end = skipDigits(query, i + 1);
                out.appendSliceAssumeCapacity(query[i..end]);
                i = end;
            }
        } else if (sqlite and (c == '$' or c == '@' or c == ':' or c == '#')) {
            const res = skipSQLiteParameter(query, i);
            if (res.end == i + 1) {
                out.appendAssumeCapacity(c);
            } else if (res.plain) {
                out.appendSliceAssumeCapacity(query[i..res.end]);
            } else {
                out.appendAssumeCapacity('?');
            }
            i = res.end;
        } else if (sqlite and c == '?') {
            const end = skipDigits(query, i + 1);
            out.appendSliceAssumeCapacity(query[i..end]);
            i = end;
        } else if (isIdentStart(c) or (mysql and c == '$')) {
            const end = skipIdent(query, i);
            out.appendSliceAssumeCapacity(query[i..end]);
            i = end;
        } else if (isDigit(c) or (c == '.' and isDigit(nextByte(query, i)))) {
            i = skipNumber(query, i);
            out.appendAssumeCapacity('?');
        } else {
            out.appendAssumeCapacity(c);
            i += 1;
        }
    }

    return out.toOwnedSlice(allocator);
}

/// Replaces each run of invalid UTF-8 bytes in `input` with U+FFFD so OTLP
/// protobuf strings are always valid UTF-8 (matching Go's `strings.ToValidUTF8`).
pub fn toValidUtf8(allocator: Allocator, input: []const u8) Allocator.Error![]u8 {
    if (std.unicode.utf8ValidateSlice(input)) {
        return allocator.dupe(u8, input);
    }
    var out: std.ArrayList(u8) = try .initCapacity(allocator, input.len);
    errdefer out.deinit(allocator);

    var i: usize = 0;
    var prev_invalid = false;
    while (i < input.len) {
        const seq_len = std.unicode.utf8ByteSequenceLength(input[i]) catch {
            if (!prev_invalid) {
                try out.appendSlice(allocator, "\u{FFFD}");
                prev_invalid = true;
            }
            i += 1;
            continue;
        };
        if (i + seq_len > input.len) {
            if (!prev_invalid) {
                try out.appendSlice(allocator, "\u{FFFD}");
                prev_invalid = true;
            }
            i += 1;
            continue;
        }
        const valid = switch (seq_len) {
            1 => true,
            2 => (std.unicode.utf8Decode2(input[i..][0..2].*) catch null) != null,
            3 => (std.unicode.utf8Decode3(input[i..][0..3].*) catch null) != null,
            4 => (std.unicode.utf8Decode4(input[i..][0..4].*) catch null) != null,
            else => false,
        };
        if (valid) {
            try out.appendSlice(allocator, input[i .. i + seq_len]);
            i += seq_len;
            prev_invalid = false;
        } else {
            if (!prev_invalid) {
                try out.appendSlice(allocator, "\u{FFFD}");
                prev_invalid = true;
            }
            i += 1;
        }
    }
    return out.toOwnedSlice(allocator);
}

/// Returns the longest prefix of `s` of at most `max_bytes` bytes that ends on
/// a UTF-8 codepoint boundary.
pub fn truncateUtf8(s: []const u8, max_bytes: usize) []const u8 {
    if (s.len <= max_bytes) return s;
    var n = max_bytes;
    while (n > 0 and (s[n] & 0xC0) == 0x80) {
        n -= 1;
    }
    return s[0..n];
}

/// Extracted `db.operation.name` and `db.collection.name` from sanitized SQL.
pub const Summary = struct {
    operation: []const u8 = "",
    collection: []const u8 = "",
};

const known_operations = [_][]const u8{
    "SELECT",   "INSERT",   "UPDATE",    "DELETE",  "MERGE",
    "REPLACE",  "UPSERT",   "CREATE",    "ALTER",   "DROP",
    "TRUNCATE", "CALL",     "EXEC",      "EXECUTE", "BEGIN",
    "COMMIT",   "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA",
    "VACUUM",   "ANALYZE",  "EXPLAIN",   "SHOW",    "SET",
};

fn matchKnownOperation(tok: []const u8) ?[]const u8 {
    for (known_operations) |op| {
        if (std.ascii.eqlIgnoreCase(tok, op)) return op;
    }
    return null;
}

fn isUpdateClauseWord(tok: []const u8) bool {
    const words = [_][]const u8{ "FOR", "KEY", "DO", "THEN", "OR", "BEFORE", "AFTER", "OF" };
    for (words) |w| {
        if (std.ascii.eqlIgnoreCase(tok, w)) return true;
    }
    return false;
}

fn isTableModifier(tok: []const u8) bool {
    return std.ascii.eqlIgnoreCase(tok, "ONLY") or
        std.ascii.eqlIgnoreCase(tok, "LOW_PRIORITY") or
        std.ascii.eqlIgnoreCase(tok, "IGNORE");
}

/// Derives the SQL operation keyword and target collection (table) name from
/// sanitized SQL text (matching `go/o11ysql/internal/sqltext.Summarize`).
///
/// Any allocated unquoted collection string lives in `arena`.
pub fn summarize(arena: Allocator, sanitized: []const u8) Allocator.Error!Summary {
    const toks = try tokenize(arena, sanitized);
    if (toks.len == 0) return .{};

    const operation = matchKnownOperation(toks[0]) orelse return .{};
    if (std.mem.eql(u8, operation, "SHOW")) {
        return .{ .operation = operation, .collection = "" };
    }

    var subquery: std.ArrayList(bool) = .empty;
    var collection: []const u8 = "";

    var k: usize = 0;
    while (k + 1 < toks.len) : (k += 1) {
        if (std.mem.eql(u8, toks[k], "(")) {
            const first = toks[k + 1];
            const is_sub = std.ascii.eqlIgnoreCase(first, "SELECT") or std.ascii.eqlIgnoreCase(first, "WITH");
            try subquery.append(arena, is_sub);
            continue;
        }
        if (std.mem.eql(u8, toks[k], ")")) {
            if (subquery.items.len > 0) {
                _ = subquery.pop();
            }
            continue;
        }
        if (subquery.items.len > 0 and !subquery.items[subquery.items.len - 1]) {
            continue;
        }
        const kw_kind = namesTable(toks, k) orelse continue;
        var j = k + 1;
        if (kw_kind == .table) {
            j = skipIfExists(toks, j);
        }
        if (kw_kind == .update and j < toks.len and std.ascii.eqlIgnoreCase(toks[j], "OR")) {
            j += 2;
        }
        while (j < toks.len and isTableModifier(toks[j])) {
            j += 1;
        }
        if (j >= toks.len or !isName(toks[j])) {
            return .{ .operation = operation, .collection = "" };
        }
        if (j + 1 < toks.len) {
            const next_tok = toks[j + 1];
            if (std.mem.eql(u8, next_tok, ",") or
                (std.mem.eql(u8, next_tok, "(") and (kw_kind == .from or kw_kind == .join)))
            {
                return .{ .operation = operation, .collection = "" };
            }
        }
        const name = try unquoteName(arena, toks[j]);
        if (collection.len > 0 and !std.mem.eql(u8, collection, name)) {
            return .{ .operation = operation, .collection = "" };
        }
        collection = name;
    }

    if (collection.len > max_collection) {
        return .{ .operation = operation, .collection = "" };
    }
    return .{ .operation = operation, .collection = collection };
}

const TableKeyword = enum { from, join, into, update, table };

fn namesTable(toks: []const []const u8, k: usize) ?TableKeyword {
    const tok = toks[k];
    if (std.ascii.eqlIgnoreCase(tok, "JOIN")) return .join;
    if (std.ascii.eqlIgnoreCase(tok, "INTO")) return .into;
    if (std.ascii.eqlIgnoreCase(tok, "TABLE")) return .table;
    if (std.ascii.eqlIgnoreCase(tok, "FROM")) {
        if (k > 0 and std.ascii.eqlIgnoreCase(toks[k - 1], "DISTINCT")) return null;
        return .from;
    }
    if (std.ascii.eqlIgnoreCase(tok, "UPDATE")) {
        if (k > 0 and isUpdateClauseWord(toks[k - 1])) return null;
        return .update;
    }
    return null;
}

fn skipIfExists(toks: []const []const u8, start: usize) usize {
    var j = start;
    if (j >= toks.len or !std.ascii.eqlIgnoreCase(toks[j], "IF")) {
        return j;
    }
    j += 1;
    if (j < toks.len and std.ascii.eqlIgnoreCase(toks[j], "NOT")) {
        j += 1;
    }
    if (j < toks.len and std.ascii.eqlIgnoreCase(toks[j], "EXISTS")) {
        return j + 1;
    }
    return toks.len;
}

fn unquoteName(arena: Allocator, tok: []const u8) Allocator.Error![]const u8 {
    if (std.mem.indexOfAny(u8, tok, "\"`") == null) return tok;
    var out: std.ArrayList(u8) = try .initCapacity(arena, tok.len);
    var i: usize = 0;
    while (i < tok.len) {
        const q = tok[i];
        if (q != '"' and q != '`') {
            out.appendAssumeCapacity(q);
            i += 1;
            continue;
        }
        const res = skipQuoted(tok, i, q, false);
        const inner = if (res.closed) tok[i + 1 .. res.end - 1] else tok[i + 1 .. res.end];
        var j: usize = 0;
        while (j < inner.len) {
            out.appendAssumeCapacity(inner[j]);
            if (inner[j] == q and j + 1 < inner.len and inner[j + 1] == q) {
                j += 2;
            } else {
                j += 1;
            }
        }
        i = res.end;
    }
    return out.items;
}

fn tokenize(arena: Allocator, s: []const u8) Allocator.Error![]const []const u8 {
    var toks: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < s.len) {
        const c = s[i];
        if (c == ' ' or c == '\t' or c == '\n' or c == '\r') {
            i += 1;
        } else if (isNameStart(c)) {
            const end = skipName(s, i);
            try toks.append(arena, s[i..end]);
            i = end;
        } else {
            try toks.append(arena, s[i .. i + 1]);
            i += 1;
        }
    }
    return toks.items;
}

fn skipName(s: []const u8, start: usize) usize {
    var i = start;
    while (true) {
        if (s[i] == '"' or s[i] == '`') {
            i = skipQuoted(s, i, s[i], false).end;
        } else {
            i = skipIdent(s, i);
        }
        if (i + 1 < s.len and s[i] == '.' and isNameStart(s[i + 1])) {
            i += 1;
            continue;
        }
        return i;
    }
}

fn isName(tok: []const u8) bool {
    return tok.len > 0 and isNameStart(tok[0]);
}

fn isNameStart(c: u8) bool {
    return isIdentStart(c) or c == '"' or c == '`';
}

fn isIdentStart(c: u8) bool {
    return c == '_' or (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c >= 0x80;
}

fn isIdentPart(c: u8) bool {
    return isIdentStart(c) or isDigit(c);
}

fn isIdentCont(c: u8) bool {
    return isIdentPart(c) or c == '$';
}

fn isDigit(c: u8) bool {
    return c >= '0' and c <= '9';
}

fn isSpace(c: u8) bool {
    return c == ' ' or c == '\t' or c == '\n' or c == 0x0C or c == '\r';
}

fn nextByte(s: []const u8, i: usize) u8 {
    return if (i + 1 < s.len) s[i + 1] else 0;
}

fn skipIdent(s: []const u8, start: usize) usize {
    var i = start + 1;
    while (i < s.len and isIdentCont(s[i])) : (i += 1) {}
    return i;
}

fn skipDigits(s: []const u8, start: usize) usize {
    var i = start;
    while (i < s.len and isDigit(s[i])) : (i += 1) {}
    return i;
}

const QuotedResult = struct {
    end: usize,
    closed: bool,
};

fn skipQuoted(s: []const u8, i: usize, quote: u8, backslash: bool) QuotedResult {
    var j = i + 1;
    while (j < s.len) : (j += 1) {
        if (s[j] == '\\' and backslash) {
            j += 1;
            if (j >= s.len) break;
        } else if (s[j] == quote) {
            if (j + 1 < s.len and s[j + 1] == quote) {
                j += 1;
                continue;
            }
            return .{ .end = j + 1, .closed = true };
        }
    }
    return .{ .end = s.len, .closed = false };
}

fn skipQuotedName(s: []const u8, i: usize) QuotedResult {
    if (s[i] != '[') {
        return skipQuoted(s, i, s[i], false);
    }
    if (std.mem.indexOfScalarPos(u8, s, i + 1, ']')) |end| {
        return .{ .end = end + 1, .closed = true };
    }
    return .{ .end = s.len, .closed = false };
}

fn mysqlDashComment(s: []const u8, i: usize) bool {
    return i + 2 >= s.len or s[i + 2] <= ' ' or s[i + 2] == 0x7f;
}

fn skipLine(s: []const u8, i: usize) usize {
    if (std.mem.indexOfScalarPos(u8, s, i, '\n')) |end| {
        return end;
    }
    return s.len;
}

fn skipBlock(s: []const u8, i: usize, nested: bool) usize {
    var depth: usize = 0;
    var j = i;
    while (j + 1 < s.len) {
        if (s[j] == '/' and s[j + 1] == '*' and (nested or depth == 0)) {
            depth += 1;
            j += 2;
        } else if (s[j] == '*' and s[j + 1] == '/') {
            if (depth > 0) depth -= 1;
            j += 2;
            if (depth == 0) return j;
        } else {
            j += 1;
        }
    }
    return s.len;
}

fn skipVersionedOpen(s: []const u8, i: usize) ?usize {
    var j = i + 2;
    if (j < s.len and s[j] == 'M') {
        j += 1;
    }
    if (j >= s.len or s[j] != '!') return null;
    return skipDigits(s, j + 1);
}

fn skipDollarQuoted(s: []const u8, i: usize) ?usize {
    var j = i + 1;
    if (j < s.len and isIdentStart(s[j])) {
        j += 1;
        while (j < s.len and isIdentPart(s[j])) : (j += 1) {}
    }
    if (j >= s.len or s[j] != '$') return null;
    const tag = s[i .. j + 1];
    const body = j + 1;
    if (std.mem.indexOf(u8, s[body..], tag)) |rel| {
        return body + rel + tag.len;
    }
    return s.len;
}

const ParamResult = struct {
    end: usize,
    plain: bool,
};

fn skipSQLiteParameter(s: []const u8, i: usize) ParamResult {
    var j = i + 1;
    var n: usize = 0;
    while (j < s.len) {
        const c = s[j];
        if (isIdentCont(c)) {
            n += 1;
            j += 1;
        } else if (c == '(' and n > 0) {
            j += 1;
            while (j < s.len and s[j] != ')' and !isSpace(s[j])) : (j += 1) {}
            if (j < s.len and s[j] == ')') j += 1;
            return .{ .end = j, .plain = false };
        } else if (c == ':' and nextByte(s, j) == ':') {
            j += 2;
        } else {
            if (n == 0) return .{ .end = i + 1, .plain = true };
            return .{ .end = j, .plain = true };
        }
    }
    if (n == 0) return .{ .end = i + 1, .plain = true };
    return .{ .end = j, .plain = true };
}

fn skipNumber(s: []const u8, start: usize) usize {
    const hex = s[start] == '0' and (nextByte(s, start) == 'x' or nextByte(s, start) == 'X');
    var i = start + 1;
    while (i < s.len) : (i += 1) {
        const c = s[i];
        if (!hex and (c == 'e' or c == 'E') and nextByte(s, i) == '\'') {
            return i;
        }
        if (isIdentPart(c) or c == '.') {
            continue;
        }
        if ((c == '+' or c == '-') and (s[i - 1] == 'e' or s[i - 1] == 'E') and isDigit(nextByte(s, i))) {
            continue;
        }
        return i;
    }
    return i;
}

const testing = std.testing;

test "sqltext.sanitize matches Go cases across standard, mysql, and sqlite dialects" {
    const Case = struct {
        in: []const u8,
        want: []const u8,
        dialect: Dialect,
    };
    const cases = [_]Case{
        .{ .in = "SELECT * FROM users WHERE email = 'a@example.com' AND age > 30", .want = "SELECT * FROM users WHERE email = ? AND age > ?", .dialect = .standard },
        .{ .in = "INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)", .want = "INSERT INTO t (a, b) VALUES (?, ?)", .dialect = .standard },
        .{ .in = "SELECT \"Name\" FROM \"Users\" WHERE id = $1 AND x = ?", .want = "SELECT \"Name\" FROM \"Users\" WHERE id = $1 AND x = ?", .dialect = .standard },
        .{ .in = "SELECT * FROM t WHERE a = \"secret\" AND b = 'x\\'y'", .want = "SELECT * FROM t WHERE a = ? AND b = ?", .dialect = .mysql },
        .{ .in = "SELECT `order` FROM `t`", .want = "SELECT `order` FROM `t`", .dialect = .mysql },
        .{ .in = "SELECT 1 -- token=abc\nFROM t /* pw */", .want = "SELECT ?  \nFROM t  ", .dialect = .standard },
        .{ .in = "SELECT 1 # pw\nFROM t", .want = "SELECT ?  \nFROM t", .dialect = .mysql },
        .{ .in = "SELECT $tag$ secret $tag$, $$x$$, $2", .want = "SELECT ?, ?, $2", .dialect = .standard },
        .{ .in = "SELECT 0xFF, .5, t1.c2 FROM t1", .want = "SELECT ?, ?, t1.c2 FROM t1", .dialect = .standard },
        .{ .in = "SELECT 'abc", .want = "SELECT ?", .dialect = .standard },
        .{ .in = "SELECT a /* secret", .want = "SELECT a  ", .dialect = .standard },
        .{ .in = "SELECT * FROM t WHERE id = :1 AND name = :name AND p = @p1", .want = "SELECT * FROM t WHERE id = :? AND name = :name AND p = @p1", .dialect = .standard },
        .{ .in = "SELECT data[1:5], data[:5] FROM t WHERE a = 12:34", .want = "SELECT data[?:?], data[:?] FROM t WHERE a = ?:?", .dialect = .standard },
        .{ .in = "SELECT * FROM t WHERE a = 12:34 AND b = :5", .want = "SELECT * FROM t WHERE a = ?:? AND b = :?", .dialect = .mysql },
        .{ .in = "SELECT * FROM t WHERE b = :5", .want = "SELECT * FROM t WHERE b = :5", .dialect = .sqlite },
        .{ .in = "SELECT 'C:\\' FROM t", .want = "SELECT ? FROM t", .dialect = .standard },
        .{ .in = "SELECT * FROM café WHERE x = 'é'", .want = "SELECT * FROM café WHERE x = ?", .dialect = .standard },
        // Edge cases from Go TestSanitizeEdgeCases.
        .{ .in = "SELECT E'it\\'s secret', e'a\\\\' FROM t", .want = "SELECT ?, ? FROM t", .dialect = .standard },
        .{ .in = "SELECT E'it''s secret' FROM t", .want = "SELECT ? FROM t", .dialect = .standard },
        .{ .in = "SELECT E'secret\\'", .want = "SELECT ?", .dialect = .standard },
        .{ .in = "SELECT e'a\\'b'", .want = "SELECT e?", .dialect = .mysql },
        .{ .in = "SELECT a /* x /* y */ secret */ FROM t", .want = "SELECT a   FROM t", .dialect = .standard },
        .{ .in = "SELECT a /* x /* y */ secret", .want = "SELECT a  ", .dialect = .standard },
        .{ .in = "SELECT a /* x /* y */ FROM t", .want = "SELECT a   FROM t", .dialect = .mysql },
        .{ .in = "SELECT a -- secret", .want = "SELECT a  ", .dialect = .standard },
        .{ .in = "SELECT 1_000_000, 0b1010, 0o17, 0x1F_FF, 1.5e+10, 12abc, 1., 1e5", .want = "SELECT ?, ?, ?, ?, ?, ?, ?, ?", .dialect = .standard },
        .{ .in = "SELECT * FROM t WHERE a = -5", .want = "SELECT * FROM t WHERE a = -?", .dialect = .standard },
        .{ .in = "SELECT '1'::int, $1::text", .want = "SELECT ?::int, $1::text", .dialect = .standard },
        .{ .in = "SELECT \"abc 'secret'", .want = "SELECT ?", .dialect = .standard },
        .{ .in = "SELECT `abc 'secret'", .want = "SELECT ?", .dialect = .mysql },
        .{ .in = "SELECT \"a\\\"secret\" FROM t", .want = "SELECT ? FROM t", .dialect = .mysql },
        .{ .in = "SELECT 'it''s secret' FROM t", .want = "SELECT ? FROM t", .dialect = .mysql },
        .{ .in = "SELECT 'abc\\", .want = "SELECT ?", .dialect = .mysql },
        .{ .in = "SELECT $$secret", .want = "SELECT ?", .dialect = .standard },
        .{ .in = "SELECT $a$ x $b$ secret $a$ FROM t", .want = "SELECT ? FROM t", .dialect = .standard },
        .{ .in = "SELECT X'FF', B'01', N'abc', _utf8mb4'abc'", .want = "SELECT X?, B?, N?, _utf8mb4?", .dialect = .mysql },
        .{ .in = "SELECT '-- x', '/* y', $$ */ $$ FROM t", .want = "SELECT ?, ?, ? FROM t", .dialect = .standard },
        .{ .in = "", .want = "", .dialect = .standard },
        .{ .in = "SELECT a$b$, 'q', $b$ SECRET $b$", .want = "SELECT a$b$, ?, ?", .dialect = .standard },
        .{ .in = "SELECT a$t$b, 'x $t$ SECRET'", .want = "SELECT a$t$b, ?", .dialect = .mysql },
        .{ .in = "SELECT $$x$$ FROM t", .want = "SELECT $$x$$ FROM t", .dialect = .mysql },
        .{ .in = "SELECT 1$t$ SECRET $t$", .want = "SELECT ??", .dialect = .standard },
        .{ .in = "SELECT 1E'\\'SECRET'", .want = "SELECT ??", .dialect = .standard },
        .{ .in = "SELECT 0x1E'C:\\', 'SECRET'", .want = "SELECT ??, ?", .dialect = .standard },
        .{ .in = "SELECT a ` 'SECRET' ` b", .want = "SELECT a ` ? ` b", .dialect = .standard },
        .{ .in = "SELECT a # 'SECRET'", .want = "SELECT a # ?", .dialect = .standard },
        .{ .in = "SELECT /* /* */ ' */ 'SECRET'", .want = "SELECT   ?", .dialect = .standard },
        .{ .in = "SELECT a--'x\nSECRET'", .want = "SELECT a--?", .dialect = .mysql },
        .{ .in = "SELECT a --\tx\nFROM t", .want = "SELECT a  \nFROM t", .dialect = .mysql },
        .{ .in = "SELECT a --", .want = "SELECT a  ", .dialect = .mysql },
        .{ .in = "SELECT /*!50000 'a*/SECRET' */ 1", .want = "SELECT   ?   ?", .dialect = .mysql },
        .{ .in = "SELECT /*M!100100 'a*/SECRET' */ 1", .want = "SELECT   ?   ?", .dialect = .mysql },
        .{ .in = "SELECT /*+ BKA(t) */ a FROM t", .want = "SELECT   a FROM t", .dialect = .mysql },
        .{ .in = "SELECT /* /* */ 'x */ SECRET'", .want = "SELECT   ?", .dialect = .sqlite },
        .{ .in = "SELECT [O'Brien] FROM t WHERE a = 'SECRET'", .want = "SELECT [O'Brien] FROM t WHERE a = ?", .dialect = .sqlite },
        .{ .in = "SELECT [abc 'SECRET'", .want = "SELECT ?", .dialect = .sqlite },
        .{ .in = "SELECT e'C:\\', 'SECRET'", .want = "SELECT e?, ?", .dialect = .sqlite },
        .{ .in = "SELECT * FROM t WHERE name = \"bob\"", .want = "SELECT * FROM t WHERE name = ?", .dialect = .sqlite },
        .{ .in = "SELECT `order` FROM t", .want = "SELECT `order` FROM t", .dialect = .sqlite },
        .{ .in = "SELECT $p$, 'a $p$ SECRET', ?1, :a, @b, #c, $d::e, $f(SECRET)", .want = "SELECT $p$, ?, ?1, :a, @b, #c, $d::e, ?", .dialect = .sqlite },
        .{ .in = "SELECT 1_000, 0x1F, .5e3", .want = "SELECT ?, ?, ?", .dialect = .sqlite },
    };

    for (cases) |tc| {
        const got = try sanitize(testing.allocator, tc.in, tc.dialect);
        defer testing.allocator.free(got);
        try testing.expectEqualStrings(tc.want, got);
    }
}

test "sqltext.summarize matches Go cases and clauses" {
    const Case = struct {
        in: []const u8,
        op: []const u8,
        coll: []const u8,
    };
    const cases = [_]Case{
        .{ .in = "SELECT id FROM users WHERE email = ?", .op = "SELECT", .coll = "users" },
        .{ .in = "select * from public.\"Users\"", .op = "SELECT", .coll = "public.Users" },
        .{ .in = "INSERT INTO orders (a, b) VALUES (?, ?)", .op = "INSERT", .coll = "orders" },
        .{ .in = "UPDATE accounts SET n = ? WHERE id = ?", .op = "UPDATE", .coll = "accounts" },
        .{ .in = "DELETE FROM t WHERE id IN (SELECT id FROM u)", .op = "DELETE", .coll = "" },
        .{ .in = "SELECT * FROM a JOIN b ON a.id = b.id", .op = "SELECT", .coll = "" },
        .{ .in = "SELECT * FROM a x JOIN a y ON x.p = y.id", .op = "SELECT", .coll = "a" },
        .{ .in = "SELECT * FROM a, b", .op = "SELECT", .coll = "" },
        .{ .in = "SELECT * FROM generate_series(?, ?)", .op = "SELECT", .coll = "" },
        .{ .in = "SELECT * FROM jobs FOR UPDATE NOWAIT", .op = "SELECT", .coll = "jobs" },
        .{ .in = "CREATE TABLE IF NOT EXISTS widgets (id INTEGER)", .op = "CREATE", .coll = "widgets" },
        .{ .in = "WITH x AS (SELECT ?) SELECT * FROM x", .op = "", .coll = "" },
        .{ .in = "COMMIT", .op = "COMMIT", .coll = "" },
        .{ .in = "SELECT ?", .op = "SELECT", .coll = "" },
        .{ .in = "", .op = "", .coll = "" },
        .{ .in = "hello world", .op = "", .coll = "" },
        .{ .in = "INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = ?", .op = "INSERT", .coll = "t" },
        .{ .in = "INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = ?", .op = "INSERT", .coll = "t" },
        .{ .in = "SELECT * FROM jobs FOR NO KEY UPDATE SKIP LOCKED", .op = "SELECT", .coll = "jobs" },
        .{ .in = "SELECT EXTRACT(YEAR FROM created_at) FROM events", .op = "SELECT", .coll = "events" },
        .{ .in = "SELECT SUBSTRING(name FROM ?)", .op = "SELECT", .coll = "" },
        .{ .in = "SELECT * FROM (SELECT * FROM t) x", .op = "SELECT", .coll = "" },
        .{ .in = "DELETE FROM t WHERE id IN (SELECT id FROM t)", .op = "DELETE", .coll = "t" },
        .{ .in = "SELECT COALESCE((SELECT v FROM u), ?) FROM t", .op = "SELECT", .coll = "" },
        .{ .in = "DROP TABLE IF EXISTS widgets", .op = "DROP", .coll = "widgets" },
        .{ .in = "INSERT INTO t (a) SELECT a FROM u", .op = "INSERT", .coll = "" },
        .{ .in = "DROP TABLE a, b", .op = "DROP", .coll = "" },
        .{ .in = "TRUNCATE TABLE a, b", .op = "TRUNCATE", .coll = "" },
        .{ .in = "UPDATE a, b SET x = ?", .op = "UPDATE", .coll = "" },
        .{ .in = "CREATE TABLE IF widgets", .op = "CREATE", .coll = "" },
        .{ .in = "SELECT * FROM ONLY t", .op = "SELECT", .coll = "t" },
        .{ .in = "UPDATE LOW_PRIORITY IGNORE t SET a = ?", .op = "UPDATE", .coll = "t" },
        .{ .in = "CREATE TRIGGER trg AFTER INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f()", .op = "CREATE", .coll = "" },
        .{ .in = "CREATE TRIGGER trg BEFORE UPDATE OF a ON t", .op = "CREATE", .coll = "" },
        .{ .in = "SELECT * FROM t FOR UPDATE OF t", .op = "SELECT", .coll = "t" },
        .{ .in = "SHOW TABLES FROM db", .op = "SHOW", .coll = "" },
        .{ .in = "UPDATE OR IGNORE t SET a = ?", .op = "UPDATE", .coll = "t" },
        .{ .in = "UPDATE OR REPLACE t SET a = ?", .op = "UPDATE", .coll = "t" },
        .{ .in = "SELECT * FROM t WHERE a IS DISTINCT FROM b", .op = "SELECT", .coll = "t" },
        .{ .in = "SELECT * FROM \"a\"\"b\"", .op = "SELECT", .coll = "a\"b" },
        .{ .in = "SELECT * FROM `s`.`a``b`", .op = "SELECT", .coll = "s.a`b" },
    };

    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();

    for (cases) |tc| {
        const s = try summarize(arena.allocator(), tc.in);
        try testing.expectEqualStrings(tc.op, s.operation);
        try testing.expectEqualStrings(tc.coll, s.collection);
    }

    // Oversized table name (> 128 bytes) returns empty collection.
    const long_tbl = "SELECT * FROM " ++ @as([200]u8, @splat('t'));
    const s = try summarize(arena.allocator(), long_tbl);
    try testing.expectEqualStrings("SELECT", s.operation);
    try testing.expectEqualStrings("", s.collection);
}

test "sqltext.truncateUtf8 and toValidUtf8 keep attributes valid UTF-8 on rune boundaries" {
    try testing.expectEqualStrings("abc", truncateUtf8("abc", 4));
    try testing.expectEqualStrings("abcd", truncateUtf8("abcd", 4));
    try testing.expectEqualStrings("abcd", truncateUtf8("abcde", 4));
    try testing.expectEqualStrings("abc", truncateUtf8("abcé", 4));
    try testing.expectEqualStrings("ab", truncateUtf8("ab€", 4));
    try testing.expectEqualStrings("a€", truncateUtf8("a€b", 4));
    try testing.expectEqualStrings("a", truncateUtf8("a😀", 4));
    try testing.expectEqualStrings("", truncateUtf8("", 4));

    const fixed = try toValidUtf8(testing.allocator, "SELECT a\xff FROM t\xfe\xfd WHERE b = ?");
    defer testing.allocator.free(fixed);
    try testing.expect(std.unicode.utf8ValidateSlice(fixed));
    try testing.expectEqualStrings("SELECT a\u{FFFD} FROM t\u{FFFD} WHERE b = ?", fixed);
}

test "sqltext.sanitize leaks no planted markers across generated statements and prefixes" {
    var prng = std.Random.DefaultPrng.init(0x51a7_2026);
    const rand = prng.random();
    const marker = "SECRET";
    const num_marker = "8675309";
    const dialects = [_]Dialect{ .standard, .sqlite, .mysql };

    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(testing.allocator);

    for (dialects) |d| {
        for (0..300) |_| {
            buf.clearRetainingCapacity();
            try buf.appendSlice(testing.allocator, "SELECT ");
            const parts = 2 + rand.uintLessThan(usize, 6);
            for (0..parts) |pi| {
                if (pi > 0) try buf.appendSlice(testing.allocator, ", ");
                switch (rand.uintLessThan(u8, 6)) {
                    0 => try buf.appendSlice(testing.allocator, "'prefix '' SECRET '''"),
                    1 => try buf.appendSlice(testing.allocator, num_marker),
                    2 => try buf.appendSlice(testing.allocator, "0x" ++ num_marker),
                    3 => try buf.appendSlice(testing.allocator, "-- " ++ marker ++ "\n"),
                    4 => try buf.appendSlice(testing.allocator, "/* " ++ marker ++ " */"),
                    else => switch (d) {
                        .standard => try buf.appendSlice(testing.allocator, "$tag$ " ++ marker ++ " $tag$, E'\\'" ++ marker ++ "'"),
                        .sqlite => try buf.appendSlice(testing.allocator, "\"" ++ marker ++ "\", $f(" ++ marker ++ ")"),
                        .mysql => try buf.appendSlice(testing.allocator, "\"" ++ marker ++ "\", # " ++ marker ++ "\n"),
                    },
                }
            }
            try buf.appendSlice(testing.allocator, " FROM users WHERE id = $1");

            const q = buf.items;
            const out = try sanitize(testing.allocator, q, d);
            defer testing.allocator.free(out);
            try testing.expect(out.len <= q.len);
            try testing.expect(std.mem.indexOf(u8, out, marker) == null);
            try testing.expect(std.mem.indexOf(u8, out, num_marker) == null);

            // Check random prefixes (models truncated/unterminated literals).
            for (0..3) |_| {
                const cut = rand.uintAtMost(usize, q.len);
                const pout = try sanitize(testing.allocator, q[0..cut], d);
                defer testing.allocator.free(pout);
                try testing.expect(pout.len <= cut);
                try testing.expect(std.mem.indexOf(u8, pout, marker) == null);
                try testing.expect(std.mem.indexOf(u8, pout, num_marker) == null);
            }
        }
    }
}

test "sqltext fuzz: bounded length, bounded collection, and idempotence" {
    const Context = struct {
        fn testOne(_: @This(), smith: *testing.Smith) anyerror!void {
            var buf: [1024]u8 = undefined;
            const input = smith.in orelse buf[0..smith.slice(&buf)];
            var arena: std.heap.ArenaAllocator = .init(testing.allocator);
            defer arena.deinit();
            const a = arena.allocator();
            for ([_]Dialect{ .standard, .sqlite, .mysql }) |d| {
                const out = try sanitize(a, input, d);
                try testing.expect(out.len <= input.len);
                const sum = try summarize(a, out);
                try testing.expect(sum.collection.len <= max_collection);
                const again = try sanitize(a, out, d);
                if (d == .mysql and std.mem.indexOf(u8, out, "--") != null) {
                    try testing.expect(again.len <= out.len);
                } else {
                    try testing.expectEqualStrings(out, again);
                }
            }
        }
    };
    try testing.fuzz(Context{}, Context.testOne, .{
        .corpus = &.{
            "SELECT * FROM users WHERE email = 'a@example.com' AND age > 30",
            "INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)",
            "SELECT $tag$ secret $tag$, $$x$$, $2",
            "SELECT [O'Brien], $p$, ?1, #c, $d::e, $f(x), \"s\"",
            "$a$'x'$/**/$-/**/-:/**/1.'x'5E'",
        },
    });
}
