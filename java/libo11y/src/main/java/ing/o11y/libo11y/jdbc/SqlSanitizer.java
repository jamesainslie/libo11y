package ing.o11y.libo11y.jdbc;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Prepares SQL text for telemetry. {@link #sanitize(String, String)} removes every literal and
 * comment, so a statement can be recorded as {@code db.query.text} without the values it carried.
 *
 * <p>This is a port of the Go reference lexer ({@code go/o11ysql/internal/sqltext}) and agrees with
 * it on every input the Go table tests cover. Removing every literal needs the lexical rules of the
 * database that runs the statement, so text is sanitized only for {@code postgresql}, {@code sqlite},
 * {@code mysql}, and {@code mariadb}. For any other system no rules are known to be correct and
 * {@link #sanitize(String, String)} returns {@code null}: such a statement gets no {@code
 * db.query.text} at all.
 *
 * <p>Server settings the lexer cannot see can change what counts as a literal, and under them part
 * of a value can be kept: PostgreSQL with {@code standard_conforming_strings} off and MySQL with
 * {@code NO_BACKSLASH_ESCAPES} read a backslash in {@code '...'} the other way, MySQL with {@code
 * ANSI_QUOTES} reads {@code "..."} as an identifier, and a MySQL connection in a multibyte character
 * set such as GBK can read a backslash byte as half of a character.
 */
public final class SqlSanitizer {

    /**
     * The lexical rules that differ between databases. They decide where each literal starts and
     * ends, so a statement must be sanitized under the dialect of the server that runs it.
     */
    enum Dialect {
        /**
         * ANSI SQL and PostgreSQL: {@code "..."} quotes an identifier, a backslash inside {@code
         * '...'} is an ordinary character, {@code E'...'} is a string in which a backslash escapes
         * the next character, {@code $tag$...$tag$} quotes a string, and block comments nest.
         */
        STANDARD,
        /**
         * MySQL and MariaDB: {@code "..."} quotes a string, a backslash escapes the next character
         * in a string, {@code #} and {@code --} followed by whitespace start a comment, the body of
         * a {@code /*! ... *}{@code /} comment is lexed as SQL, and block comments do not nest.
         */
        MYSQL,
        /**
         * SQLite: {@code `...`} and {@code [...]} quote identifiers, a backslash inside {@code '...'}
         * is an ordinary character, {@code $ @ :} and {@code #} start a parameter name, and block
         * comments do not nest. {@code "..."} is removed like a string, because SQLite reads a
         * {@code "..."} identifier that names no column as a string.
         */
        SQLITE
    }

    /** The bounded operation and collection names of a sanitized statement; empty when unknown. */
    record Summary(String operation, String collection) {
        static final Summary EMPTY = new Summary("", "");
    }

    /** Bounds a collection name in UTF-8 bytes, so a pathological statement cannot mint an oversized value. */
    private static final int MAX_COLLECTION_BYTES = 128;

    /**
     * The statement keywords {@link #summarize} reports. Any other first word yields no operation, so
     * arbitrary text never becomes an attribute value.
     */
    private static final Set<String> OPERATIONS = Set.of(
            "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "CREATE", "ALTER", "DROP",
            "TRUNCATE", "CALL", "EXEC", "EXECUTE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
            "PRAGMA", "VACUUM", "ANALYZE", "EXPLAIN", "SHOW", "SET");

    /**
     * The words that put UPDATE inside a clause rather than at the head of an UPDATE statement: FOR
     * UPDATE, FOR NO KEY UPDATE, ON CONFLICT DO UPDATE, ON DUPLICATE KEY UPDATE, MERGE's THEN UPDATE,
     * and a trigger's BEFORE, AFTER, OR, or INSTEAD OF UPDATE.
     */
    private static final Set<String> UPDATE_CLAUSE = Set.of("FOR", "KEY", "DO", "THEN", "OR", "BEFORE", "AFTER", "OF");

    /** The words that can stand between a keyword and the table it names, as in FROM ONLY t. */
    private static final Set<String> TABLE_MODIFIERS = Set.of("ONLY", "LOW_PRIORITY", "IGNORE");

    private SqlSanitizer() {}

    /**
     * Reports whether statements for {@code dbSystem} (a {@code db.system.name} value) can be
     * sanitized into {@code db.query.text}: {@code postgresql}, {@code sqlite}, {@code mysql}, and
     * {@code mariadb}.
     *
     * @param dbSystem the {@code db.system.name} value, case-insensitive; may be {@code null}
     * @return whether a lexer known to find every literal exists for the system
     */
    public static boolean isSupported(String dbSystem) {
        return dialectFor(dbSystem) != null;
    }

    /**
     * Returns the operation of {@code sql}, such as {@code SELECT}, upper cased, when its first
     * keyword after any comments is a known SQL operation, and the empty string otherwise. A
     * statement that starts with {@code WITH} has none.
     *
     * @param sql the raw statement text; may be {@code null}
     * @return the {@code db.operation.name} value, or the empty string
     */
    public static String extractOperation(String sql) {
        if (sql == null) {
            return "";
        }
        return summarize(sanitizeText(sql, Dialect.STANDARD)).operation();
    }

    /**
     * Returns {@code sql} with every string, number, and dollar-quoted literal replaced by {@code ?}
     * and every comment replaced by one space, under the lexical rules of {@code dbSystem}.
     * Identifiers, keywords, operators, and placeholders ({@code $1}, {@code ?}, {@code :name},
     * {@code @p1}, and SQLite's {@code ?1}) are kept. An unterminated literal, comment, or quoted
     * identifier is removed up to the end of the text. The result is never longer than {@code sql}.
     *
     * @param dbSystem the {@code db.system.name} value, case-insensitive
     * @param sql the raw statement text
     * @return the sanitized text, or {@code null} when {@code sql} is {@code null} or the system is not
     *     {@linkplain #isSupported(String) supported}
     */
    public static String sanitize(String dbSystem, String sql) {
        Dialect dialect = dialectFor(dbSystem);
        if (dialect == null || sql == null) {
            return null;
        }
        return sanitizeText(sql, dialect);
    }

    /**
     * Returns the lexer for a {@code db.system.name} value, or {@code null} when no lexer is known to
     * find every literal the database reads.
     */
    static Dialect dialectFor(String dbSystem) {
        if (dbSystem == null) {
            return null;
        }
        return switch (dbSystem.toLowerCase(Locale.ROOT)) {
            case "postgresql" -> Dialect.STANDARD;
            case "sqlite" -> Dialect.SQLITE;
            case "mysql", "mariadb" -> Dialect.MYSQL;
            default -> null;
        };
    }

    /** Sanitizes {@code query} under {@code dialect}; see {@link #sanitize(String, String)}. */
    static String sanitizeText(String query, Dialect dialect) {
        int n = query.length();
        StringBuilder b = new StringBuilder(n);
        boolean mysql = dialect == Dialect.MYSQL;
        boolean sqlite = dialect == Dialect.SQLITE;
        boolean pg = !mysql && !sqlite;
        boolean inVersioned = false; // inside a MySQL /*! ... */ comment, whose body is SQL
        int i = 0;
        while (i < n) {
            char c = query.charAt(i);
            if (c == '\'') {
                i = endOf(skipQuoted(query, i, '\'', mysql), n);
                b.append('?');
            } else if (pg && (c == 'E' || c == 'e') && next(query, i) == '\'') {
                i = endOf(skipQuoted(query, i + 1, '\'', true), n); // E'...' escape string
                b.append('?');
            } else if (c == '"' && !pg) {
                i = endOf(skipQuoted(query, i, '"', mysql), n);
                b.append('?');
            } else if (c == '"' || (c == '`' && !pg) || (c == '[' && sqlite)) {
                int end = skipQuotedName(query, i);
                if (end >= 0) {
                    b.append(query, i, end);
                    i = end;
                } else {
                    b.append('?'); // an unterminated name may hold anything
                    i = n;
                }
            } else if ((c == '-' && next(query, i) == '-' && (!mysql || mysqlDashComment(query, i)))
                    || (c == '#' && mysql)) {
                i = skipLine(query, i);
                b.append(' ');
            } else if (c == '/' && next(query, i) == '*') {
                int end = mysql ? skipVersionedOpen(query, i) : -1;
                if (end >= 0) {
                    inVersioned = true;
                    i = end;
                } else {
                    i = skipBlock(query, i, pg);
                }
                b.append(' ');
            } else if (inVersioned && c == '*' && next(query, i) == '/') {
                inVersioned = false;
                i += 2;
                b.append(' ');
            } else if (pg && c == '$') {
                int end = skipDollarQuoted(query, i);
                if (end >= 0) {
                    b.append('?');
                    i = end;
                } else {
                    end = skipDigits(query, i + 1); // $1 placeholder, or a lone $
                    b.append(query, i, end);
                    i = end;
                }
            } else if (sqlite && (c == '$' || c == '@' || c == ':' || c == '#')) {
                int r = skipSqliteParameter(query, i);
                int end = Math.abs(r);
                if (end == i + 1) {
                    b.append(c); // no name follows, so not a parameter
                } else if (r > 0) {
                    b.append(query, i, end);
                } else {
                    b.append('?'); // a $name(...) suffix may hold anything
                }
                i = end;
            } else if (sqlite && c == '?') {
                int end = skipDigits(query, i + 1); // ?1 placeholder
                b.append(query, i, end);
                i = end;
            } else if (isIdentStart(c) || (mysql && c == '$')) {
                int end = skipIdent(query, i);
                b.append(query, i, end);
                i = end;
            } else if (isDigit(c) || (c == '.' && isDigit(next(query, i)))) {
                i = skipNumber(query, i);
                b.append('?');
            } else {
                b.append(c);
                i++;
            }
        }
        return b.toString();
    }

    /**
     * Returns the operation and collection names of a sanitized statement. The operation is the first
     * keyword, upper cased, when it is a known SQL operation, and empty otherwise. The collection is
     * the one table the statement names after FROM, JOIN, INTO, UPDATE, or TABLE, without quotes and
     * with its schema when qualified. It is empty when the statement names no table, more than one, a
     * subquery, or a table function, and for SHOW, whose FROM names a database.
     */
    static Summary summarize(String sanitized) {
        List<String> toks = tokenize(sanitized);
        int len = toks.size();
        if (len == 0) {
            return Summary.EMPTY;
        }
        String operation = toks.get(0).toUpperCase(Locale.ROOT);
        if (!OPERATIONS.contains(operation)) {
            return Summary.EMPTY;
        }
        Summary noCollection = new Summary(operation, "");
        if (operation.equals("SHOW")) {
            return noCollection;
        }
        BitSet subquery = new BitSet(); // per open parenthesis: whether it holds a subquery
        int depth = 0;
        String collection = "";
        for (int k = 0; k < len - 1; k++) {
            String tok = toks.get(k);
            if (tok.equals("(")) {
                String first = toks.get(k + 1).toUpperCase(Locale.ROOT);
                subquery.set(depth++, first.equals("SELECT") || first.equals("WITH"));
                continue;
            }
            if (tok.equals(")")) {
                if (depth > 0) {
                    depth--;
                }
                continue;
            }
            if (depth > 0 && !subquery.get(depth - 1)) {
                continue; // inside a call or a column list
            }
            String keyword = tok.toUpperCase(Locale.ROOT);
            if (!namesTable(keyword, toks, k)) {
                continue;
            }
            int j = k + 1;
            if (keyword.equals("TABLE")) {
                j = skipIfExists(toks, j);
            }
            if (keyword.equals("UPDATE") && toks.get(j).equalsIgnoreCase("OR")) {
                j += 2; // SQLite's UPDATE OR IGNORE t, UPDATE OR REPLACE t
            }
            while (j < len && TABLE_MODIFIERS.contains(toks.get(j).toUpperCase(Locale.ROOT))) {
                j++;
            }
            if (j >= len || !isName(toks.get(j))) {
                return noCollection; // a subquery or something unrecognized
            }
            if (j + 1 < len) {
                String after = toks.get(j + 1);
                if (after.equals(",") || (after.equals("(") && (keyword.equals("FROM") || keyword.equals("JOIN")))) {
                    return noCollection; // a list of tables, or a table function
                }
            }
            String name = unquoteName(toks.get(j));
            if (!collection.isEmpty() && !collection.equals(name)) {
                return noCollection;
            }
            collection = name;
        }
        if (collection.getBytes(StandardCharsets.UTF_8).length > MAX_COLLECTION_BYTES) {
            return noCollection;
        }
        return new Summary(operation, collection);
    }

    /** Reports whether {@code keyword}, the upper-cased {@code toks[k]}, is followed by a table name. */
    private static boolean namesTable(String keyword, List<String> toks, int k) {
        String prev = k > 0 ? toks.get(k - 1).toUpperCase(Locale.ROOT) : "";
        return switch (keyword) {
            case "JOIN", "INTO", "TABLE" -> true;
            case "FROM" -> !prev.equals("DISTINCT"); // a IS DISTINCT FROM b compares values
            case "UPDATE" -> !UPDATE_CLAUSE.contains(prev);
            default -> false;
        };
    }

    /**
     * Returns the index past IF EXISTS or IF NOT EXISTS at {@code toks[j]}, {@code j} when it is not
     * IF, and the token count when IF is not followed by [NOT] EXISTS. It looks at no more than three
     * tokens, so {@link #summarize} stays linear.
     */
    private static int skipIfExists(List<String> toks, int j) {
        int len = toks.size();
        if (j >= len || !toks.get(j).equalsIgnoreCase("IF")) {
            return j;
        }
        j++;
        if (j < len && toks.get(j).equalsIgnoreCase("NOT")) {
            j++;
        }
        if (j < len && toks.get(j).equalsIgnoreCase("EXISTS")) {
            return j + 1;
        }
        return len;
    }

    /** Removes the quotes around each part of a possibly qualified name and undoubles inner quotes. */
    private static String unquoteName(String tok) {
        if (tok.indexOf('"') < 0 && tok.indexOf('`') < 0) {
            return tok;
        }
        StringBuilder b = new StringBuilder(tok.length());
        int n = tok.length();
        int i = 0;
        while (i < n) {
            char q = tok.charAt(i);
            if (q != '"' && q != '`') {
                b.append(q);
                i++;
                continue;
            }
            int r = skipQuoted(tok, i, q, false);
            int end = endOf(r, n);
            String inner = r >= 0 ? tok.substring(i + 1, end - 1) : tok.substring(i + 1, end);
            b.append(inner.replace(String.valueOf(q) + q, String.valueOf(q)));
            i = end;
        }
        return b.toString();
    }

    /** Splits sanitized SQL into names (possibly qualified and quoted) and single punctuation characters. */
    private static List<String> tokenize(String s) {
        List<String> toks = new ArrayList<>();
        int n = s.length();
        int i = 0;
        while (i < n) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                i++;
            } else if (isNameStart(c)) {
                int end = skipName(s, i);
                toks.add(s.substring(i, end));
                i = end;
            } else {
                toks.add(s.substring(i, i + 1));
                i++;
            }
        }
        return toks;
    }

    /** Returns the end of a possibly qualified, possibly quoted name that starts at {@code s[i]}. */
    private static int skipName(String s, int i) {
        int n = s.length();
        while (true) {
            char c = s.charAt(i);
            if (c == '"' || c == '`') {
                i = endOf(skipQuoted(s, i, c, false), n);
            } else {
                i = skipIdent(s, i);
            }
            if (i + 1 < n && s.charAt(i) == '.' && isNameStart(s.charAt(i + 1))) {
                i++;
                continue;
            }
            return i;
        }
    }

    private static boolean isName(String tok) {
        return !tok.isEmpty() && isNameStart(tok.charAt(0));
    }

    private static boolean isNameStart(char c) {
        return isIdentStart(c) || c == '"' || c == '`';
    }

    private static boolean isIdentStart(char c) {
        return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80;
    }

    /** Reports whether {@code c} can continue a dollar-quote tag or a number. */
    private static boolean isIdentPart(char c) {
        return isIdentStart(c) || isDigit(c);
    }

    /** Reports whether {@code c} can continue an identifier; all three dialects allow {@code $}. */
    private static boolean isIdentCont(char c) {
        return isIdentPart(c) || c == '$';
    }

    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    private static boolean isSpace(char c) {
        return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r';
    }

    /** Returns the character after {@code s[i]}, or NUL at the end of {@code s}. */
    private static char next(String s, int i) {
        return i + 1 < s.length() ? s.charAt(i + 1) : 0;
    }

    /** Maps the negative "unterminated" result of a skip helper to the end of the text. */
    private static int endOf(int end, int n) {
        return end < 0 ? n : end;
    }

    private static int skipIdent(String s, int i) {
        i++;
        while (i < s.length() && isIdentCont(s.charAt(i))) {
            i++;
        }
        return i;
    }

    private static int skipDigits(String s, int i) {
        while (i < s.length() && isDigit(s.charAt(i))) {
            i++;
        }
        return i;
    }

    /**
     * Returns the index just past the run quoted by {@code quote} that starts at {@code s[i]}, or -1
     * when it is unterminated. A doubled quote is an escaped quote; with {@code backslash} set, a
     * backslash escapes the next character.
     */
    private static int skipQuoted(String s, int i, char quote, boolean backslash) {
        int n = s.length();
        for (int j = i + 1; j < n; j++) {
            char c = s.charAt(j);
            if (c == '\\') {
                if (backslash) {
                    j++;
                }
            } else if (c == quote) {
                if (j + 1 < n && s.charAt(j + 1) == quote) {
                    j++;
                    continue;
                }
                return j + 1;
            }
        }
        return -1;
    }

    /**
     * Returns the index just past the quoted identifier that starts at {@code s[i]} ({@code "..."},
     * {@code `...`}, or SQLite's {@code [...]}), or -1 when it is not closed. A {@code [...]} name
     * ends at the first {@code ]}; the others double their quote to escape it.
     */
    private static int skipQuotedName(String s, int i) {
        if (s.charAt(i) != '[') {
            return skipQuoted(s, i, s.charAt(i), false);
        }
        int end = s.indexOf(']', i + 1);
        return end >= 0 ? end + 1 : -1;
    }

    /**
     * Reports whether the {@code --} at {@code s[i]} starts a MySQL comment, which needs whitespace, a
     * control character, or the end of the text after it. Otherwise {@code a--1} is a minus minus one.
     */
    private static boolean mysqlDashComment(String s, int i) {
        return i + 2 >= s.length() || s.charAt(i + 2) <= ' ' || s.charAt(i + 2) == 0x7f;
    }

    /** Returns the index of the newline ending the comment at {@code s[i]}, or the end of {@code s}. */
    private static int skipLine(String s, int i) {
        int end = s.indexOf('\n', i);
        return end >= 0 ? end : s.length();
    }

    /**
     * Returns the index just past the block comment at {@code s[i]}, or the end of {@code s} when it
     * is unterminated. With {@code nested} set, each opener inside the comment needs its own closer,
     * as in PostgreSQL and the SQL standard.
     */
    private static int skipBlock(String s, int i, boolean nested) {
        int n = s.length();
        int depth = 0;
        int j = i;
        while (j + 1 < n) {
            char c = s.charAt(j);
            char d = s.charAt(j + 1);
            if (c == '/' && d == '*' && (nested || depth == 0)) {
                depth++;
                j += 2;
            } else if (c == '*' && d == '/') {
                depth--;
                j += 2;
                if (depth == 0) {
                    return j;
                }
            } else {
                j++;
            }
        }
        return n;
    }

    /**
     * Returns the index past a MySQL {@code /*!NNNNN} or MariaDB {@code /*M!NNNNNN} versioned
     * comment opener and its version digits, or -1 when {@code s[i]} opens no such comment.
     */
    private static int skipVersionedOpen(String s, int i) {
        int n = s.length();
        int j = i + 2;
        if (j < n && s.charAt(j) == 'M') {
            j++;
        }
        if (j >= n || s.charAt(j) != '!') {
            return -1;
        }
        return skipDigits(s, j + 1);
    }

    /**
     * Returns the index just past the PostgreSQL dollar-quoted string ({@code $$...$$} or {@code
     * $tag$...$tag$}) that {@code s[i]} opens, the end of {@code s} when it is unterminated, or -1
     * when {@code s[i]} opens none because no valid tag follows.
     */
    private static int skipDollarQuoted(String s, int i) {
        int n = s.length();
        int j = i + 1;
        if (j < n && isIdentStart(s.charAt(j))) {
            for (j++; j < n && isIdentPart(s.charAt(j)); j++) {
                // the tag runs over identifier characters
            }
        }
        if (j >= n || s.charAt(j) != '$') {
            return -1;
        }
        String tag = s.substring(i, j + 1);
        int body = j + 1;
        int end = s.indexOf(tag, body);
        return end >= 0 ? end + tag.length() : n;
    }

    /**
     * Returns the end of the SQLite parameter that starts at {@code s[i]} with {@code $ @ :} or
     * {@code #}, following SQLite's tokenizer: a name of identifier characters and {@code ::} pairs,
     * optionally ending in a Tcl-style {@code (...)} suffix that runs to {@code )} or whitespace. The
     * result is negated when the suffix is present, and is {@code i + 1} when no name follows.
     */
    private static int skipSqliteParameter(String s, int i) {
        int n = s.length();
        int j = i + 1;
        int count = 0;
        while (j < n) {
            char c = s.charAt(j);
            if (isIdentCont(c)) {
                count++;
                j++;
            } else if (c == '(' && count > 0) {
                for (j++; j < n && s.charAt(j) != ')' && !isSpace(s.charAt(j)); j++) {
                    // the suffix runs to ) or whitespace
                }
                if (j < n && s.charAt(j) == ')') {
                    j++;
                }
                return -j;
            } else if (c == ':' && next(s, j) == ':') {
                j += 2;
            } else {
                return count == 0 ? i + 1 : j;
            }
        }
        return count == 0 ? i + 1 : j;
    }

    /**
     * Returns the end of the number that starts at {@code s[i]}. It takes the longest run a numeric
     * literal could span, so digit separators, radix prefixes (0x, 0o, 0b), fractions, signed
     * exponents, and any trailing letters all stay inside the literal. It stops before a {@code $},
     * and outside a hex number (where E is a digit) before an {@code E'} that opens a PostgreSQL
     * escape string.
     */
    private static int skipNumber(String s, int i) {
        int n = s.length();
        boolean hex = s.charAt(i) == '0' && (next(s, i) == 'x' || next(s, i) == 'X');
        for (i++; i < n; i++) {
            char c = s.charAt(i);
            if (!hex && (c == 'e' || c == 'E') && next(s, i) == '\'') {
                return i;
            } else if (isIdentPart(c) || c == '.') {
                continue;
            } else if ((c == '+' || c == '-') && (s.charAt(i - 1) == 'e' || s.charAt(i - 1) == 'E')
                    && isDigit(next(s, i))) {
                continue;
            } else {
                return i;
            }
        }
        return i;
    }
}
