//! Dialect-aware SQL text sanitizer and summarizer for telemetry.
//!
//! [`sanitize`] strips comments, replaces string, numeric, hex, bit, and
//! dollar-quoted literals with `?`, and collapses repeated `IN (?, ?, ...)`
//! lists so statements can be recorded as `db.query.text` without leaking
//! values. [`summarize`] extracts bounded `db.operation.name` and
//! `db.collection.name` values from sanitized SQL text.
//!
//! Ported directly from Go's `go/o11ysql/internal/sqltext`.

/// Maximum byte length of `db.query.text` (4096 bytes, cut on a UTF-8 boundary).
pub const MAX_QUERY_TEXT: usize = 4096;

/// Maximum byte length of `db.collection.name` so a pathological statement
/// cannot mint an oversized attribute value.
pub const MAX_COLLECTION_LEN: usize = 128;

/// SQL lexical dialect selecting how literals, quoted identifiers, and
/// comments are recognized.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Dialect {
    /// ANSI SQL and `PostgreSQL`: `"..."` quotes an identifier, backslashes
    /// inside `'...'` are ordinary characters, `E'...'` is a backslash-escaped
    /// string, `$tag$...$tag$` quotes a string, and block comments nest.
    Postgres,
    /// `SQLite`: `` `...` `` and `[...]` quote identifiers, backslashes inside
    /// `'...'` are ordinary characters, `$`, `@`, `:`, and `#` start parameter
    /// names, block comments do not nest, and `"..."` is treated as a literal
    /// because `SQLite` falls back to string semantics when `"..."` matches no
    /// column.
    Sqlite,
    /// `MySQL`: `"..."` quotes a string, backslash escapes the next byte inside
    /// strings, `#` and `--` followed by whitespace start comments, `/*! ... */`
    /// versioned comment bodies are lexed as SQL, and block comments do not
    /// nest.
    Mysql,
    /// `MariaDB`: same lexical rules as [`Dialect::Mysql`], including
    /// `/*M! ... */` versioned comments.
    Mariadb,
    /// Any other SQL database (for example `other_sql`, `microsoft.sql_server`,
    /// or `oracle.db`).
    ///
    /// Uses standard SQL lexing for [`summarize`], while instrumentation omits
    /// `db.query.text` because no lexer is guaranteed to recognize every
    /// server-specific literal form.
    Other,
}

impl Dialect {
    /// Maps a semantic-convention `db.system.name` value to its [`Dialect`].
    #[must_use]
    pub fn from_system(system: &str) -> Self {
        match system {
            "postgresql" => Self::Postgres,
            "sqlite" => Self::Sqlite,
            "mysql" => Self::Mysql,
            "mariadb" => Self::Mariadb,
            _ => Self::Other,
        }
    }

    /// Reports whether this dialect has a lexer that [`sanitize`] uses to
    /// strip literals, so instrumentation records `db.query.text` for it.
    ///
    /// The lexer follows each server's default settings. Some server
    /// settings change what counts as a literal, and under them part of a
    /// value can be kept. See [`sanitize`] for the list.
    #[must_use]
    pub const fn supports_query_text(self) -> bool {
        matches!(
            self,
            Self::Postgres | Self::Sqlite | Self::Mysql | Self::Mariadb
        )
    }
}

/// Summary extracted from a sanitized SQL statement.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    /// Upper-cased SQL operation keyword (e.g. `SELECT`, `INSERT`), or empty
    /// when the first token is not a known operation (including `WITH`).
    pub operation: String,
    /// Unquoted single table/collection name (qualified with schema when
    /// present), or empty when zero or multiple tables, subqueries, table
    /// functions, or oversized names are involved.
    pub collection: String,
}

/// Replaces every string, numeric, and dollar-quoted literal in `query` with
/// `?`, replaces every comment with a single space, and collapses repeated
/// `IN (?, ?, ...)` placeholder lists to `IN (?)`.
///
/// The output is never longer than `query` in bytes.
///
/// # Limits
///
/// Server settings that `sanitize` cannot see can change what counts as a
/// literal, and under them part of a value can be kept:
///
/// - `PostgreSQL` with `standard_conforming_strings` off, and `MySQL` with
///   `NO_BACKSLASH_ESCAPES`, read a backslash in `'...'` the other way.
/// - `MySQL` with `ANSI_QUOTES` reads `"..."` as an identifier, in which a
///   backslash is an ordinary character.
/// - A `MySQL` connection in a multibyte character set such as GBK, SJIS, or
///   Big5 can read a backslash byte as half of a character.
/// - `MySQL` skips a `/*!NNNNN ... */` body when its own version is lower
///   than `NNNNN`, and `MySQL`, unlike `MariaDB`, skips every `/*M! ... */`
///   body. [`Dialect::Mysql`] and [`Dialect::Mariadb`] lex both bodies as
///   SQL, as `MariaDB` does.
/// - [`Dialect::Mysql`] and [`Dialect::Mariadb`] remove a `/*+ ... */`
///   optimizer hint as a comment that ends at the first `*/`, even inside a
///   quoted hint argument.
///
/// Turn `db.query.text` off with
/// [`DbConfig::without_query_text`](crate::DbConfig::without_query_text)
/// when a server runs with one of these settings.
#[must_use]
#[allow(
    clippy::too_many_lines,
    reason = "single-pass dialect lexer ported directly from Go sqltext.Sanitize"
)]
pub fn sanitize(query: &str, dialect: Dialect) -> String {
    let bytes = query.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mysql = matches!(dialect, Dialect::Mysql | Dialect::Mariadb);
    let sqlite = matches!(dialect, Dialect::Sqlite);
    let pg = !mysql && !sqlite;
    let mut in_versioned = false;

    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\'' {
            let (end, _) = skip_quoted(bytes, i, b'\'', mysql);
            out.push(b'?');
            i = end;
        } else if pg && matches!(c, b'E' | b'e') && next_byte(bytes, i) == b'\'' {
            let (end, _) = skip_quoted(bytes, i + 1, b'\'', true);
            out.push(b'?');
            i = end;
        } else if c == b'"' && !pg {
            let (end, _) = skip_quoted(bytes, i, b'"', mysql);
            out.push(b'?');
            i = end;
        } else if c == b'"' || (c == b'`' && !pg) || (c == b'[' && sqlite) {
            let (end, closed) = skip_quoted_name(bytes, i);
            if closed {
                out.extend_from_slice(&bytes[i..end]);
            } else {
                out.push(b'?');
            }
            i = end;
        } else if (c == b'-'
            && next_byte(bytes, i) == b'-'
            && (!mysql || mysql_dash_comment(bytes, i)))
            || (c == b'#' && mysql)
        {
            i = skip_line(bytes, i);
            out.push(b' ');
        } else if c == b'/' && next_byte(bytes, i) == b'*' {
            if mysql && let Some(end) = skip_versioned_open(bytes, i) {
                in_versioned = true;
                i = end;
            } else {
                i = skip_block(bytes, i, pg);
            }
            out.push(b' ');
        } else if in_versioned && c == b'*' && next_byte(bytes, i) == b'/' {
            in_versioned = false;
            i += 2;
            out.push(b' ');
        } else if pg && c == b'$' {
            if let Some(end) = skip_dollar_quoted(bytes, i) {
                out.push(b'?');
                i = end;
            } else {
                let end = skip_digits(bytes, i + 1);
                out.extend_from_slice(&bytes[i..end]);
                i = end;
            }
        } else if sqlite && matches!(c, b'$' | b'@' | b':' | b'#') {
            let (end, plain) = skip_sqlite_parameter(bytes, i);
            if end == i + 1 {
                out.push(c);
            } else if plain {
                out.extend_from_slice(&bytes[i..end]);
            } else {
                out.push(b'?');
            }
            i = end;
        } else if sqlite && c == b'?' {
            let end = skip_digits(bytes, i + 1);
            out.extend_from_slice(&bytes[i..end]);
            i = end;
        } else if is_ident_start(c) || (mysql && c == b'$') {
            let end = skip_ident(bytes, i);
            out.extend_from_slice(&bytes[i..end]);
            i = end;
        } else if is_digit(c) || (c == b'.' && is_digit(next_byte(bytes, i))) {
            i = skip_number(bytes, i);
            out.push(b'?');
        } else {
            out.push(c);
            i += 1;
        }
    }

    // Input was valid UTF-8 and every kept slice begins and ends on ASCII
    // character boundaries, so `out` is valid UTF-8; lossy conversion is a
    // defensive fallback that guarantees valid UTF-8 without panicking.
    let lexed = match String::from_utf8(out) {
        Ok(s) => s,
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    };
    collapse_in_lists(&lexed, dialect)
}

/// Sanitizes raw bytes (which may contain invalid UTF-8), replacing any
/// invalid UTF-8 sequences with `U+FFFD` so the result is always valid UTF-8
/// for OTLP protobuf string attributes.
#[must_use]
pub fn sanitize_lossy(query: &[u8], dialect: Dialect) -> String {
    let text = String::from_utf8_lossy(query);
    sanitize(&text, dialect)
}

/// Collapses repeated `IN (?, ?, ...)` placeholder lists into `IN (?)`.
///
/// Only collapses parenthesized lists immediately following the standalone
/// SQL keyword `IN` (case-insensitive) whose elements are two or more `?`
/// placeholders separated by commas and optional ASCII whitespace. Quoted
/// identifiers for `dialect` are skipped verbatim.
fn collapse_in_lists(s: &str, dialect: Dialect) -> String {
    let bytes = s.as_bytes();
    if bytes.len() < 7 {
        return s.to_owned();
    }
    let pg = matches!(dialect, Dialect::Postgres | Dialect::Other);
    let sqlite = dialect == Dialect::Sqlite;
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last_copied = 0;

    while i < bytes.len() {
        let c = bytes[i];
        if (c == b'"' && pg) || (c == b'`' && !pg) || (c == b'[' && sqlite) {
            let (end, _) = skip_quoted_name(bytes, i);
            i = end;
            continue;
        }
        if i + 2 <= bytes.len() {
            let is_in = matches!(c, b'I' | b'i') && matches!(bytes[i + 1], b'N' | b'n');
            let prev_ok = i == 0 || !is_ident_cont(bytes[i - 1]);
            let next_ok = i + 2 == bytes.len() || !is_ident_cont(bytes[i + 2]);
            if is_in && prev_ok && next_ok {
                let mut j = i + 2;
                while j < bytes.len() && is_space(bytes[j]) {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'(' {
                    let open_paren = j;
                    if let Some(close_paren) = match_repeated_question_list(bytes, open_paren) {
                        out.push_str(&s[last_copied..=open_paren]);
                        out.push('?');
                        out.push(')');
                        i = close_paren + 1;
                        last_copied = i;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }

    if last_copied == 0 {
        return s.to_owned();
    }
    out.push_str(&s[last_copied..]);
    out
}

/// If `bytes[open_paren..]` starts with `( ? , ? (, ?)* )` (at least two `?`
/// placeholders with optional whitespace), returns the index of the closing
/// `)`.
fn match_repeated_question_list(bytes: &[u8], open_paren: usize) -> Option<usize> {
    let mut j = open_paren + 1;
    while j < bytes.len() && is_space(bytes[j]) {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b'?' {
        return None;
    }
    // Do not collapse SQLite numbered placeholders like `?1`.
    if is_digit(next_byte(bytes, j)) {
        return None;
    }
    j += 1;
    let mut count = 1usize;
    loop {
        while j < bytes.len() && is_space(bytes[j]) {
            j += 1;
        }
        if j >= bytes.len() {
            return None;
        }
        if bytes[j] == b')' {
            return (count >= 2).then_some(j);
        }
        if bytes[j] != b',' {
            return None;
        }
        j += 1;
        while j < bytes.len() && is_space(bytes[j]) {
            j += 1;
        }
        if j >= bytes.len() || bytes[j] != b'?' || is_digit(next_byte(bytes, j)) {
            return None;
        }
        j += 1;
        count += 1;
    }
}

/// Returns the longest valid UTF-8 prefix of `s` with at most `max_bytes`
/// bytes.
#[must_use]
pub fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut n = max_bytes;
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}

/// Extracts `db.operation.name` and `db.collection.name` from sanitized SQL
/// text (see [`sanitize`]).
///
/// The operation is the upper-cased first token when it is a known SQL
/// operation keyword (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, etc.). A
/// statement starting with `WITH` returns an empty [`Summary`]. The collection
/// is the single table named after `FROM`, `JOIN`, `INTO`, `UPDATE`, or
/// `TABLE`, unquoted and qualified with its schema when present. It is empty
/// when the statement names zero or multiple tables, a subquery, a table
/// function, or a name exceeding [`MAX_COLLECTION_LEN`] bytes, and for `SHOW`.
#[must_use]
pub fn summarize(sanitized: &str) -> Summary {
    let toks = tokenize(sanitized);
    let Some(first_tok) = toks.first() else {
        return Summary::default();
    };
    let operation = first_tok.to_ascii_uppercase();
    if !is_known_operation(&operation) {
        return Summary::default();
    }
    if operation == "SHOW" {
        return Summary {
            operation,
            collection: String::new(),
        };
    }

    let mut collection = String::new();
    let mut subquery: Vec<bool> = Vec::new();
    let mut k = 0;
    while k + 1 < toks.len() {
        match toks[k] {
            "(" => {
                let next_upper = toks[k + 1].to_ascii_uppercase();
                subquery.push(next_upper == "SELECT" || next_upper == "WITH");
                k += 1;
                continue;
            }
            ")" => {
                subquery.pop();
                k += 1;
                continue;
            }
            _ => {}
        }
        if subquery.last().is_some_and(|&is_sub| !is_sub) {
            k += 1;
            continue;
        }
        let keyword = toks[k].to_ascii_uppercase();
        if !names_table(&keyword, &toks, k) {
            k += 1;
            continue;
        }
        let mut j = k + 1;
        if keyword == "TABLE" {
            j = skip_if_exists(&toks, j);
        }
        if keyword == "UPDATE" && j < toks.len() && toks[j].eq_ignore_ascii_case("OR") {
            j += 2;
        }
        while j < toks.len() && is_table_modifier(toks[j]) {
            j += 1;
        }
        if j >= toks.len() || !is_name(toks[j]) {
            return Summary {
                operation,
                collection: String::new(),
            };
        }
        if j + 1 < toks.len()
            && (toks[j + 1] == ","
                || (toks[j + 1] == "(" && (keyword == "FROM" || keyword == "JOIN")))
        {
            return Summary {
                operation,
                collection: String::new(),
            };
        }
        let name = unquote_name(toks[j]);
        if !collection.is_empty() && collection != name {
            return Summary {
                operation,
                collection: String::new(),
            };
        }
        collection = name;
        k += 1;
    }

    if collection.len() > MAX_COLLECTION_LEN {
        collection.clear();
    }
    Summary {
        operation,
        collection,
    }
}

fn is_known_operation(op: &str) -> bool {
    matches!(
        op,
        "SELECT"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
            | "MERGE"
            | "REPLACE"
            | "UPSERT"
            | "CREATE"
            | "ALTER"
            | "DROP"
            | "TRUNCATE"
            | "CALL"
            | "EXEC"
            | "EXECUTE"
            | "BEGIN"
            | "COMMIT"
            | "ROLLBACK"
            | "SAVEPOINT"
            | "RELEASE"
            | "PRAGMA"
            | "VACUUM"
            | "ANALYZE"
            | "EXPLAIN"
            | "SHOW"
            | "SET"
    )
}

fn is_update_clause_prev(prev: &str) -> bool {
    matches!(
        prev,
        "FOR" | "KEY" | "DO" | "THEN" | "OR" | "BEFORE" | "AFTER" | "OF"
    )
}

fn is_table_modifier(tok: &str) -> bool {
    tok.eq_ignore_ascii_case("ONLY")
        || tok.eq_ignore_ascii_case("LOW_PRIORITY")
        || tok.eq_ignore_ascii_case("IGNORE")
}

fn names_table(keyword: &str, toks: &[&str], k: usize) -> bool {
    let prev = if k > 0 {
        toks[k - 1].to_ascii_uppercase()
    } else {
        String::new()
    };
    match keyword {
        "JOIN" | "INTO" | "TABLE" => true,
        "FROM" => prev != "DISTINCT",
        "UPDATE" => !is_update_clause_prev(&prev),
        _ => false,
    }
}

fn skip_if_exists(toks: &[&str], mut j: usize) -> usize {
    if j >= toks.len() || !toks[j].eq_ignore_ascii_case("IF") {
        return j;
    }
    j += 1;
    if j < toks.len() && toks[j].eq_ignore_ascii_case("NOT") {
        j += 1;
    }
    if j < toks.len() && toks[j].eq_ignore_ascii_case("EXISTS") {
        return j + 1;
    }
    toks.len()
}

fn unquote_name(tok: &str) -> String {
    if !tok.contains(['"', '`']) {
        return tok.to_owned();
    }
    let bytes = tok.as_bytes();
    let mut out = String::with_capacity(tok.len());
    let mut i = 0;
    while i < bytes.len() {
        let q = bytes[i];
        if q != b'"' && q != b'`' {
            let ch = tok[i..].chars().next();
            if let Some(ch) = ch {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
            continue;
        }
        let (end, closed) = skip_quoted(bytes, i, q, false);
        let inner = if closed {
            &tok[i + 1..end - 1]
        } else {
            &tok[i + 1..end]
        };
        let q_char = char::from(q);
        let doubled = [q_char, q_char].into_iter().collect::<String>();
        let single = q_char.to_string();
        out.push_str(&inner.replace(&doubled, &single));
        i = end;
    }
    out
}

fn tokenize(s: &str) -> Vec<&str> {
    let bytes = s.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if matches!(c, b' ' | b'\t' | b'\n' | b'\r') {
            i += 1;
        } else if is_name_start(c) {
            let end = skip_name(bytes, i);
            toks.push(&s[i..end]);
            i = end;
        } else {
            let len = s[i..].chars().next().map_or(1, char::len_utf8);
            toks.push(&s[i..i + len]);
            i += len;
        }
    }
    toks
}

fn skip_name(s: &[u8], mut i: usize) -> usize {
    loop {
        if matches!(s[i], b'"' | b'`') {
            let (end, _) = skip_quoted(s, i, s[i], false);
            i = end;
        } else {
            i = skip_ident(s, i);
        }
        if i + 1 < s.len() && s[i] == b'.' && is_name_start(s[i + 1]) {
            i += 1;
            continue;
        }
        return i;
    }
}

fn is_name(tok: &str) -> bool {
    tok.as_bytes().first().is_some_and(|&c| is_name_start(c))
}

fn is_name_start(c: u8) -> bool {
    is_ident_start(c) || c == b'"' || c == b'`'
}

fn is_ident_start(c: u8) -> bool {
    c == b'_' || c.is_ascii_alphabetic() || c >= 0x80
}

fn is_ident_part(c: u8) -> bool {
    is_ident_start(c) || is_digit(c)
}

fn is_ident_cont(c: u8) -> bool {
    is_ident_part(c) || c == b'$'
}

fn is_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | 0x0c | b'\r')
}

fn next_byte(s: &[u8], i: usize) -> u8 {
    s.get(i + 1).copied().unwrap_or(0)
}

fn skip_ident(s: &[u8], mut i: usize) -> usize {
    i += 1;
    while i < s.len() && is_ident_cont(s[i]) {
        i += 1;
    }
    i
}

fn skip_digits(s: &[u8], mut i: usize) -> usize {
    while i < s.len() && is_digit(s[i]) {
        i += 1;
    }
    i
}

fn skip_quoted(s: &[u8], i: usize, quote: u8, backslash: bool) -> (usize, bool) {
    let mut j = i + 1;
    while j < s.len() {
        let b = s[j];
        if b == b'\\' && backslash {
            j += 2;
            continue;
        }
        if b == quote {
            if j + 1 < s.len() && s[j + 1] == quote {
                j += 2;
                continue;
            }
            return (j + 1, true);
        }
        j += 1;
    }
    (s.len(), false)
}

fn skip_quoted_name(s: &[u8], i: usize) -> (usize, bool) {
    if s[i] != b'[' {
        return skip_quoted(s, i, s[i], false);
    }
    if let Some(rel) = s[i + 1..].iter().position(|&b| b == b']') {
        return (i + 1 + rel + 1, true);
    }
    (s.len(), false)
}

fn mysql_dash_comment(s: &[u8], i: usize) -> bool {
    i + 2 >= s.len() || s[i + 2] <= b' ' || s[i + 2] == 0x7f
}

fn skip_line(s: &[u8], i: usize) -> usize {
    s[i..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(s.len(), |rel| i + rel)
}

fn skip_block(s: &[u8], i: usize, nested: bool) -> usize {
    let mut depth = 0usize;
    let mut j = i;
    while j + 1 < s.len() {
        if s[j] == b'/' && s[j + 1] == b'*' && (nested || depth == 0) {
            depth += 1;
            j += 2;
        } else if s[j] == b'*' && s[j + 1] == b'/' {
            depth = depth.saturating_sub(1);
            j += 2;
            if depth == 0 {
                return j;
            }
        } else {
            j += 1;
        }
    }
    s.len()
}

fn skip_versioned_open(s: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 2;
    if j < s.len() && s[j] == b'M' {
        j += 1;
    }
    if j >= s.len() || s[j] != b'!' {
        return None;
    }
    Some(skip_digits(s, j + 1))
}

fn skip_dollar_quoted(s: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    if j < s.len() && is_ident_start(s[j]) {
        j += 1;
        while j < s.len() && is_ident_part(s[j]) {
            j += 1;
        }
    }
    if j >= s.len() || s[j] != b'$' {
        return None;
    }
    let tag = &s[i..=j];
    let body = j + 1;
    if let Some(rel) = find_subslice(&s[body..], tag) {
        return Some(body + rel + tag.len());
    }
    Some(s.len())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn skip_sqlite_parameter(bytes: &[u8], start: usize) -> (usize, bool) {
    let mut pos = start + 1;
    let mut count = 0usize;
    while pos < bytes.len() {
        let ch = bytes[pos];
        if is_ident_cont(ch) {
            count += 1;
            pos += 1;
        } else if ch == b'(' && count > 0 {
            pos += 1;
            while pos < bytes.len() && bytes[pos] != b')' && !is_space(bytes[pos]) {
                pos += 1;
            }
            if pos < bytes.len() && bytes[pos] == b')' {
                pos += 1;
            }
            return (pos, false);
        } else if ch == b':' && next_byte(bytes, pos) == b':' {
            pos += 2;
        } else {
            return if count == 0 {
                (start + 1, true)
            } else {
                (pos, true)
            };
        }
    }
    if count == 0 {
        (start + 1, true)
    } else {
        (pos, true)
    }
}

fn skip_number(s: &[u8], mut i: usize) -> usize {
    let hex = s[i] == b'0' && matches!(next_byte(s, i), b'x' | b'X');
    i += 1;
    while i < s.len() {
        let c = s[i];
        if !hex && matches!(c, b'e' | b'E') && next_byte(s, i) == b'\'' {
            return i;
        }
        let is_exponent_sign = matches!(c, b'+' | b'-')
            && matches!(s[i - 1], b'e' | b'E')
            && is_digit(next_byte(s, i));
        if is_ident_part(c) || c == b'.' || is_exponent_sign {
            i += 1;
        } else {
            return i;
        }
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSanitize
    #[test]
    fn sanitize_core_cases() {
        let cases = [
            (
                "strings and numbers",
                "SELECT * FROM users WHERE email = 'a@example.com' AND age > 30",
                "SELECT * FROM users WHERE email = ? AND age > ?",
                Dialect::Postgres,
            ),
            (
                "doubled quote and exponent",
                "INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)",
                "INSERT INTO t (a, b) VALUES (?, ?)",
                Dialect::Postgres,
            ),
            (
                "quoted identifiers and placeholders kept",
                r#"SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?"#,
                r#"SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?"#,
                Dialect::Postgres,
            ),
            (
                "mysql double quotes are strings",
                r#"SELECT * FROM t WHERE a = "secret" AND b = 'x\'y'"#,
                "SELECT * FROM t WHERE a = ? AND b = ?",
                Dialect::Mysql,
            ),
            (
                "mysql backticks kept",
                "SELECT `order` FROM `t`",
                "SELECT `order` FROM `t`",
                Dialect::Mysql,
            ),
            (
                "comments removed",
                "SELECT 1 -- token=abc\nFROM t /* pw */",
                "SELECT ?  \nFROM t  ",
                Dialect::Postgres,
            ),
            (
                "mysql hash comment",
                "SELECT 1 # pw\nFROM t",
                "SELECT ?  \nFROM t",
                Dialect::Mysql,
            ),
            (
                "dollar quoting",
                "SELECT $tag$ secret $tag$, $$x$$, $2",
                "SELECT ?, ?, $2",
                Dialect::Postgres,
            ),
            (
                "hex and leading dot",
                "SELECT 0xFF, .5, t1.c2 FROM t1",
                "SELECT ?, ?, t1.c2 FROM t1",
                Dialect::Postgres,
            ),
            (
                "unterminated string",
                "SELECT 'abc",
                "SELECT ?",
                Dialect::Postgres,
            ),
            (
                "unterminated comment",
                "SELECT a /* secret",
                "SELECT a  ",
                Dialect::Postgres,
            ),
            (
                "named placeholders kept, colon digits are numbers",
                "SELECT * FROM t WHERE id = :1 AND name = :name AND p = @p1",
                "SELECT * FROM t WHERE id = :? AND name = :name AND p = @p1",
                Dialect::Postgres,
            ),
            (
                "array slices and times",
                "SELECT data[1:5], data[:5] FROM t WHERE a = 12:34",
                "SELECT data[?:?], data[:?] FROM t WHERE a = ?:?",
                Dialect::Postgres,
            ),
            (
                "mysql colon digits are numbers",
                "SELECT * FROM t WHERE a = 12:34 AND b = :5",
                "SELECT * FROM t WHERE a = ?:? AND b = :?",
                Dialect::Mysql,
            ),
            (
                "sqlite colon digits are parameters",
                "SELECT * FROM t WHERE b = :5",
                "SELECT * FROM t WHERE b = :5",
                Dialect::Sqlite,
            ),
            (
                "standard backslash is literal",
                r"SELECT 'C:\' FROM t",
                "SELECT ? FROM t",
                Dialect::Postgres,
            ),
            (
                "unicode identifier",
                "SELECT * FROM café WHERE x = 'é'",
                "SELECT * FROM café WHERE x = ?",
                Dialect::Postgres,
            ),
        ];

        for (name, input, want, dialect) in cases {
            assert_eq!(sanitize(input, dialect), want, "{name}");
        }
    }

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSanitizeEdgeCases
    #[test]
    #[allow(clippy::too_many_lines, reason = "complete Go edge-case parity table")]
    fn sanitize_edge_cases() {
        let cases = [
            (
                "escape string with backslash quote",
                r"SELECT E'it\'s secret', e'a\\' FROM t",
                "SELECT ?, ? FROM t",
                Dialect::Postgres,
            ),
            (
                "escape string with doubled quote",
                "SELECT E'it''s secret' FROM t",
                "SELECT ? FROM t",
                Dialect::Postgres,
            ),
            (
                "unterminated escape string",
                r"SELECT E'secret\'",
                "SELECT ?",
                Dialect::Postgres,
            ),
            (
                "e prefix only escapes in standard",
                r"SELECT e'a\'b'",
                "SELECT e?",
                Dialect::Mysql,
            ),
            (
                "nested block comment",
                "SELECT a /* x /* y */ secret */ FROM t",
                "SELECT a   FROM t",
                Dialect::Postgres,
            ),
            (
                "unterminated nested comment",
                "SELECT a /* x /* y */ secret",
                "SELECT a  ",
                Dialect::Postgres,
            ),
            (
                "mysql comments do not nest",
                "SELECT a /* x /* y */ FROM t",
                "SELECT a   FROM t",
                Dialect::Mysql,
            ),
            (
                "line comment at end",
                "SELECT a -- secret",
                "SELECT a  ",
                Dialect::Postgres,
            ),
            (
                "numeric forms",
                "SELECT 1_000_000, 0b1010, 0o17, 0x1F_FF, 1.5e+10, 12abc, 1., 1e5",
                "SELECT ?, ?, ?, ?, ?, ?, ?, ?",
                Dialect::Postgres,
            ),
            (
                "negative number",
                "SELECT * FROM t WHERE a = -5",
                "SELECT * FROM t WHERE a = -?",
                Dialect::Postgres,
            ),
            (
                "casts kept",
                "SELECT '1'::int, $1::text",
                "SELECT ?::int, $1::text",
                Dialect::Postgres,
            ),
            (
                "unterminated quoted identifier",
                r#"SELECT "abc 'secret'"#,
                "SELECT ?",
                Dialect::Postgres,
            ),
            (
                "unterminated backtick identifier",
                "SELECT `abc 'secret'",
                "SELECT ?",
                Dialect::Mysql,
            ),
            (
                "mysql escaped double quote",
                r#"SELECT "a\"secret" FROM t"#,
                "SELECT ? FROM t",
                Dialect::Mysql,
            ),
            (
                "mysql doubled quote",
                "SELECT 'it''s secret' FROM t",
                "SELECT ? FROM t",
                Dialect::Mysql,
            ),
            (
                "mysql trailing backslash",
                r"SELECT 'abc\",
                "SELECT ?",
                Dialect::Mysql,
            ),
            (
                "unterminated dollar quote",
                "SELECT $$secret",
                "SELECT ?",
                Dialect::Postgres,
            ),
            (
                "dollar tags must match",
                "SELECT $a$ x $b$ secret $a$ FROM t",
                "SELECT ? FROM t",
                Dialect::Postgres,
            ),
            (
                "string prefixes",
                "SELECT X'FF', B'01', N'abc', _utf8mb4'abc'",
                "SELECT X?, B?, N?, _utf8mb4?",
                Dialect::Mysql,
            ),
            (
                "comment markers inside strings",
                "SELECT '-- x', '/* y', $$ */ $$ FROM t",
                "SELECT ?, ?, ? FROM t",
                Dialect::Postgres,
            ),
            ("empty", "", "", Dialect::Postgres),
            (
                "dollar inside identifier",
                "SELECT a$b$, 'q', $b$ SECRET $b$",
                "SELECT a$b$, ?, ?",
                Dialect::Postgres,
            ),
            (
                "mysql has no dollar quoting",
                "SELECT a$t$b, 'x $t$ SECRET'",
                "SELECT a$t$b, ?",
                Dialect::Mysql,
            ),
            (
                "mysql dollar starts identifier",
                "SELECT $$x$$ FROM t",
                "SELECT $$x$$ FROM t",
                Dialect::Mysql,
            ),
            (
                "number before dollar quote",
                "SELECT 1$t$ SECRET $t$",
                "SELECT ??",
                Dialect::Postgres,
            ),
            (
                "number before escape string",
                r"SELECT 1E'\'SECRET'",
                "SELECT ??",
                Dialect::Postgres,
            ),
            (
                "hex digit e before string",
                r"SELECT 0x1E'C:\', 'SECRET'",
                "SELECT ??, ?",
                Dialect::Postgres,
            ),
            (
                "backtick is an operator in standard",
                "SELECT a ` 'SECRET' ` b",
                "SELECT a ` ? ` b",
                Dialect::Postgres,
            ),
            (
                "hash is an operator in standard",
                "SELECT a # 'SECRET'",
                "SELECT a # ?",
                Dialect::Postgres,
            ),
            (
                "nested comment ends after inner close",
                "SELECT /* /* */ ' */ 'SECRET'",
                "SELECT   ?",
                Dialect::Postgres,
            ),
            (
                "mysql double minus before string",
                "SELECT a--'x\nSECRET'",
                "SELECT a--?",
                Dialect::Mysql,
            ),
            (
                "mysql double minus tab comment",
                "SELECT a --\tx\nFROM t",
                "SELECT a  \nFROM t",
                Dialect::Mysql,
            ),
            (
                "mysql double minus at end",
                "SELECT a --",
                "SELECT a  ",
                Dialect::Mysql,
            ),
            (
                "mysql versioned comment",
                "SELECT /*!50000 'a*/SECRET' */ 1",
                "SELECT   ?   ?",
                Dialect::Mysql,
            ),
            (
                "mariadb versioned comment",
                "SELECT /*M!100100 'a*/SECRET' */ 1",
                "SELECT   ?   ?",
                Dialect::Mariadb,
            ),
            (
                "mysql hint is a comment",
                "SELECT /*+ BKA(t) */ a FROM t",
                "SELECT   a FROM t",
                Dialect::Mysql,
            ),
            (
                "sqlite comments do not nest",
                "SELECT /* /* */ 'x */ SECRET'",
                "SELECT   ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite bracket identifier",
                "SELECT [O'Brien] FROM t WHERE a = 'SECRET'",
                "SELECT [O'Brien] FROM t WHERE a = ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite unterminated bracket",
                "SELECT [abc 'SECRET'",
                "SELECT ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite has no escape strings",
                r"SELECT e'C:\', 'SECRET'",
                "SELECT e?, ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite double quotes may be strings",
                r#"SELECT * FROM t WHERE name = "bob""#,
                "SELECT * FROM t WHERE name = ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite backticks kept",
                "SELECT `order` FROM t",
                "SELECT `order` FROM t",
                Dialect::Sqlite,
            ),
            (
                "sqlite parameters",
                "SELECT $p$, 'a $p$ SECRET', ?1, :a, @b, #c, $d::e, $f(SECRET)",
                "SELECT $p$, ?, ?1, :a, @b, #c, $d::e, ?",
                Dialect::Sqlite,
            ),
            (
                "sqlite numbers",
                "SELECT 1_000, 0x1F, .5e3",
                "SELECT ?, ?, ?",
                Dialect::Sqlite,
            ),
        ];

        for (name, input, want, dialect) in cases {
            assert_eq!(sanitize(input, dialect), want, "{name}");
        }
    }

    #[test]
    fn collapses_repeated_in_lists() {
        assert_eq!(
            sanitize(
                "SELECT * FROM users WHERE id IN (1, 2, 3, 4)",
                Dialect::Postgres
            ),
            "SELECT * FROM users WHERE id IN (?)"
        );
        assert_eq!(
            sanitize(
                "SELECT * FROM users WHERE email not in ('a', 'b', 'c')",
                Dialect::Sqlite
            ),
            "SELECT * FROM users WHERE email not in (?)"
        );
        assert_eq!(
            sanitize("SELECT * FROM users WHERE id IN (?, ?, ?)", Dialect::Mysql),
            "SELECT * FROM users WHERE id IN (?)"
        );
        // Single-element IN, non-IN tuples, subqueries, and function names ending in `in` stay intact.
        assert_eq!(
            sanitize("SELECT * FROM users WHERE id IN (1)", Dialect::Postgres),
            "SELECT * FROM users WHERE id IN (?)"
        );
        assert_eq!(
            sanitize("INSERT INTO t (a, b) VALUES (1, 2)", Dialect::Postgres),
            "INSERT INTO t (a, b) VALUES (?, ?)"
        );
        assert_eq!(
            sanitize(
                "SELECT * FROM t WHERE id IN (SELECT id FROM u)",
                Dialect::Postgres
            ),
            "SELECT * FROM t WHERE id IN (SELECT id FROM u)"
        );
        assert_eq!(
            sanitize("SELECT foo_in(1, 2) FROM t", Dialect::Postgres),
            "SELECT foo_in(?, ?) FROM t"
        );
        // SQLite numbered placeholders inside IN are preserved.
        assert_eq!(
            sanitize("SELECT * FROM t WHERE id IN (?1, ?2)", Dialect::Sqlite),
            "SELECT * FROM t WHERE id IN (?1, ?2)"
        );
    }

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSummarize
    #[test]
    fn summarize_core_cases() {
        let long_table = format!("SELECT * FROM {}", "t".repeat(200));
        let cases = [
            ("SELECT id FROM users WHERE email = ?", "SELECT", "users"),
            (r#"select * from public."Users""#, "SELECT", "public.Users"),
            (
                "INSERT INTO orders (a, b) VALUES (?, ?)",
                "INSERT",
                "orders",
            ),
            (
                "UPDATE accounts SET n = ? WHERE id = ?",
                "UPDATE",
                "accounts",
            ),
            ("DELETE FROM t WHERE id IN (SELECT id FROM u)", "DELETE", ""),
            ("SELECT * FROM a JOIN b ON a.id = b.id", "SELECT", ""),
            ("SELECT * FROM a x JOIN a y ON x.p = y.id", "SELECT", "a"),
            ("SELECT * FROM a, b", "SELECT", ""),
            ("SELECT * FROM generate_series(?, ?)", "SELECT", ""),
            ("SELECT * FROM jobs FOR UPDATE NOWAIT", "SELECT", "jobs"),
            (
                "CREATE TABLE IF NOT EXISTS widgets (id INTEGER)",
                "CREATE",
                "widgets",
            ),
            ("WITH x AS (SELECT ?) SELECT * FROM x", "", ""),
            ("COMMIT", "COMMIT", ""),
            ("SELECT ?", "SELECT", ""),
            ("", "", ""),
            ("hello world", "", ""),
            (long_table.as_str(), "SELECT", ""),
        ];

        for (input, op, coll) in cases {
            let got = summarize(input);
            assert_eq!(
                (got.operation.as_str(), got.collection.as_str()),
                (op, coll),
                "{input}"
            );
        }
    }

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSummarizeClauses
    #[test]
    fn summarize_clauses() {
        let cases = [
            (
                "INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = ?",
                "INSERT",
                "t",
            ),
            (
                "INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = ?",
                "INSERT",
                "t",
            ),
            (
                "SELECT * FROM jobs FOR NO KEY UPDATE SKIP LOCKED",
                "SELECT",
                "jobs",
            ),
            (
                "SELECT EXTRACT(YEAR FROM created_at) FROM events",
                "SELECT",
                "events",
            ),
            ("SELECT SUBSTRING(name FROM ?)", "SELECT", ""),
            ("SELECT * FROM (SELECT * FROM t) x", "SELECT", ""),
            (
                "DELETE FROM t WHERE id IN (SELECT id FROM t)",
                "DELETE",
                "t",
            ),
            ("SELECT COALESCE((SELECT v FROM u), ?) FROM t", "SELECT", ""),
            ("DROP TABLE IF EXISTS widgets", "DROP", "widgets"),
            ("INSERT INTO t (a) SELECT a FROM u", "INSERT", ""),
            ("DROP TABLE a, b", "DROP", ""),
            ("TRUNCATE TABLE a, b", "TRUNCATE", ""),
            ("UPDATE a, b SET x = ?", "UPDATE", ""),
            ("CREATE TABLE IF widgets", "CREATE", ""),
            ("SELECT * FROM ONLY t", "SELECT", "t"),
            ("UPDATE LOW_PRIORITY IGNORE t SET a = ?", "UPDATE", "t"),
            (
                "CREATE TRIGGER trg AFTER INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f()",
                "CREATE",
                "",
            ),
            ("CREATE TRIGGER trg BEFORE UPDATE OF a ON t", "CREATE", ""),
            ("SELECT * FROM t FOR UPDATE OF t", "SELECT", "t"),
            ("SHOW TABLES FROM db", "SHOW", ""),
            ("UPDATE OR IGNORE t SET a = ?", "UPDATE", "t"),
            ("UPDATE OR REPLACE t SET a = ?", "UPDATE", "t"),
            ("SELECT * FROM t WHERE a IS DISTINCT FROM b", "SELECT", "t"),
            (r#"SELECT * FROM "a""b""#, "SELECT", r#"a"b"#),
            ("SELECT * FROM `s`.`a``b`", "SELECT", "s.a`b"),
        ];

        for (input, op, coll) in cases {
            let got = summarize(input);
            assert_eq!(
                (got.operation.as_str(), got.collection.as_str()),
                (op, coll),
                "{input}"
            );
        }
    }

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSummarizeLinear
    #[test]
    fn summarize_is_linear_on_repeated_table_if() {
        let q = format!("CREATE{} EXISTS t", " TABLE IF".repeat(50_000));
        let start = std::time::Instant::now();
        let _ = summarize(&q);
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
    }

    // go/o11ysql/telemetry_internal_test.go TestTruncate
    #[test]
    fn truncate_utf8_respects_boundaries() {
        for (name, input, n, want) in [
            ("short", "abc", 4, "abc"),
            ("exact", "abcd", 4, "abcd"),
            ("one over", "abcde", 4, "abcd"),
            ("two-byte rune at cut", "abcé", 4, "abc"),
            ("three-byte rune at cut", "ab€", 4, "ab"),
            ("three-byte rune ends at cut", "a€b", 4, "a€"),
            ("four-byte rune at cut", "a😀", 4, "a"),
            ("empty", "", 4, ""),
        ] {
            assert_eq!(truncate_utf8(input, n), want, "{name}");
        }
    }

    // go/o11ysql/telemetry_internal_test.go TestDescribeKeepsTextValidUTF8
    #[test]
    fn sanitize_lossy_replaces_invalid_utf8() {
        let raw = b"SELECT a\xff FROM t\xfe WHERE b = 'x'";
        let sanitized = sanitize_lossy(raw, Dialect::Postgres);
        assert_eq!(sanitized, "SELECT a\u{FFFD} FROM t\u{FFFD} WHERE b = ?");
        let summary = summarize(&sanitized);
        assert_eq!(summary.operation, "SELECT");
        assert_eq!(summary.collection, "t\u{FFFD}");
    }

    // go/o11ysql/internal/sqltext/sqltext_test.go TestSanitizeLeaksNoLiteral
    #[test]
    #[allow(
        clippy::too_many_lines,
        reason = "self-contained dialect property generator ported from Go sqltext_test.go"
    )]
    fn property_sanitize_leaks_no_literal_and_is_idempotent() {
        struct XorShift64(u64);
        impl XorShift64 {
            fn next(&mut self) -> u64 {
                let mut x = self.0;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                self.0 = x;
                x
            }
            fn next_usize(&mut self, bound: usize) -> usize {
                usize::try_from(self.next() % u64::try_from(bound).expect("bound")).expect("usize")
            }
        }

        const MARKER: &str = "SECRET";
        const NUM_MARKER: &str = "8675309";
        const NOISE: &[&str] = &[
            "a", "Z", " ", "'", "\"", "`", "\\", "-", "/", "*", "$", "#", "\n", ":", "?", "1", "e",
            "é", "(", ";", "*/", "/*", "--", "$t$", "[", "]",
        ];

        fn body(rng: &mut XorShift64) -> String {
            let n = rng.next_usize(8);
            let at = rng.next_usize(n + 1);
            let mut b = String::new();
            for i in 0..=n {
                if i == at {
                    b.push_str(MARKER);
                }
                if i < n {
                    b.push_str(NOISE[rng.next_usize(NOISE.len())]);
                }
            }
            b
        }

        fn quoted(rng: &mut XorShift64, q: &str, backslash: bool) -> String {
            let mut s = body(rng);
            if backslash {
                s = s.replace('\\', r"\\");
            }
            let esc = if backslash && rng.next_usize(2) == 0 {
                format!(r"\{q}")
            } else {
                format!("{q}{q}")
            };
            format!("{q}{}{q}", s.replace(q, &esc))
        }

        fn block_comment(rng: &mut XorShift64) -> String {
            loop {
                let c = format!("/*{}*/", body(rng));
                if c.matches("/*").count() == 1 && c[2..].find("*/") == Some(c.len() - 4) {
                    return c;
                }
            }
        }

        fn dollar_quoted(rng: &mut XorShift64) -> String {
            let tags = ["$$", "$t$", "$tag_1$"];
            let tag = tags[rng.next_usize(tags.len())];
            loop {
                let s = body(rng);
                if format!("{s}{tag}").find(tag) == Some(s.len()) {
                    return format!("{tag}{s}{tag}");
                }
            }
        }

        fn number_literal(rng: &mut XorShift64, d: Dialect) -> String {
            let mut forms = vec![
                NUM_MARKER.to_owned(),
                "8_675_309".to_owned(),
                format!("0x{NUM_MARKER}"),
                format!("{NUM_MARKER}.5e-3"),
                format!(".{NUM_MARKER}"),
                format!("1.{NUM_MARKER}"),
                format!("{NUM_MARKER}e+2"),
                format!("{NUM_MARKER}abc"),
            ];
            if d != Dialect::Sqlite {
                forms.push(format!("arr[{NUM_MARKER}:{NUM_MARKER}]"));
                forms.push(format!("arr[:{NUM_MARKER}]"));
                forms.push(format!("12:{NUM_MARKER}"));
            }
            forms.swap_remove(rng.next_usize(forms.len()))
        }

        fn literal(rng: &mut XorShift64, d: Dialect) -> String {
            match d {
                Dialect::Mysql | Dialect::Mariadb => match rng.next_usize(7) {
                    0 => quoted(rng, "'", true),
                    1 => quoted(rng, "\"", true),
                    2 => format!("-- {}\n", body(rng).replace('\n', "")),
                    3 => format!("#{}\n", body(rng).replace('\n', "")),
                    4 => format!("--{}", quoted(rng, "'", true)),
                    5 => format!("/*!50000 {} */", quoted(rng, "'", true)),
                    _ => block_comment(rng),
                },
                Dialect::Sqlite => match rng.next_usize(5) {
                    0 => quoted(rng, "'", false),
                    1 => quoted(rng, "\"", false),
                    2 => format!("--{}\n", body(rng).replace('\n', "")),
                    3 => format!("X{}", quoted(rng, "'", false)),
                    _ => block_comment(rng),
                },
                Dialect::Postgres | Dialect::Other => match rng.next_usize(7) {
                    0 => quoted(rng, "'", false),
                    1 => format!("E{}", quoted(rng, "'", true)),
                    2 => dollar_quoted(rng),
                    3 => format!("--{}\n", body(rng).replace('\n', "")),
                    4 => block_comment(rng),
                    5 => format!("/* a /* {MARKER} */ {MARKER} */"),
                    _ => format!("U&{}", quoted(rng, "'", false)),
                },
            }
        }

        let common = [
            "SELECT",
            "FROM t",
            "WHERE c =",
            ",",
            "(",
            ")",
            "AND",
            "?",
            ":name",
            ":1",
            "@p1",
            "x.y",
            "::text",
            "-",
            "+",
        ];
        let mut rng = XorShift64(0x9e37_79b9_7f4a_7c15);

        for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite] {
            let extra: &[&str] = match d {
                Dialect::Postgres | Dialect::Other => {
                    &["a$t$", "`", "#", "arr[1]", r#""Quoted""#, "$1"]
                }
                Dialect::Mysql | Dialect::Mariadb => &["a$t$", "$t$", "`tick`", "@v"],
                Dialect::Sqlite => &[
                    "a$t$",
                    "$t$",
                    "[O'Brien]",
                    "[a--b /*]",
                    "`tick`",
                    "?1",
                    "#v",
                    "$v::w",
                ],
            };
            let words: Vec<&str> = common.iter().chain(extra.iter()).copied().collect();
            let seps = [" ", "\n", "\t"];

            for _ in 0..1000 {
                let count = 1 + rng.next_usize(12);
                let mut q = String::new();
                for _ in 0..count {
                    q.push_str(seps[rng.next_usize(seps.len())]);
                    match rng.next_usize(3) {
                        0 => q.push_str(words[rng.next_usize(words.len())]),
                        1 => q.push_str(&number_literal(&mut rng, d)),
                        _ => q.push_str(&literal(&mut rng, d)),
                    }
                }
                let out = sanitize(&q, d);
                assert!(
                    !out.contains(MARKER) && !out.contains(NUM_MARKER),
                    "dialect {d:?}: sanitize({q:?}) = {out:?} leaked marker"
                );
                assert!(out.len() <= q.len(), "output grew: {q:?} -> {out:?}");
                assert!(summarize(&out).collection.len() <= MAX_COLLECTION_LEN);

                let again = sanitize(&out, d);
                if matches!(d, Dialect::Mysql | Dialect::Mariadb) && out.contains("--") {
                    assert!(again.len() <= out.len());
                } else {
                    assert_eq!(again, out, "not idempotent for {d:?}: {q:?}");
                }

                // Prefix checks model truncated/unterminated queries.
                for _ in 0..3 {
                    let cut = truncate_utf8(&q, rng.next_usize(q.len() + 1));
                    let prefix_out = sanitize(cut, d);
                    assert!(
                        !prefix_out.contains(MARKER) && !prefix_out.contains(NUM_MARKER),
                        "dialect {d:?}: prefix sanitize({cut:?}) = {prefix_out:?} leaked marker"
                    );
                }
            }
        }
    }

    #[test]
    fn collapse_in_lists_skips_quoted_identifiers() {
        assert_eq!(
            sanitize(
                r#"SELECT * FROM "t IN (?, ?)" WHERE id IN (1, 2, 3)"#,
                Dialect::Postgres
            ),
            r#"SELECT * FROM "t IN (?, ?)" WHERE id IN (?)"#
        );
        assert_eq!(
            sanitize(
                "SELECT * FROM `t IN (?, ?)` WHERE id IN (1, 2)",
                Dialect::Mysql
            ),
            "SELECT * FROM `t IN (?, ?)` WHERE id IN (?)"
        );
        assert_eq!(
            sanitize(
                "SELECT * FROM [t IN (?, ?)] WHERE id IN (1, 2)",
                Dialect::Sqlite
            ),
            "SELECT * FROM [t IN (?, ?)] WHERE id IN (?)"
        );
    }
}
