package ing.o11y.libo11y.jdbc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;
import static org.junit.jupiter.params.provider.Arguments.arguments;

import ing.o11y.libo11y.jdbc.SqlSanitizer.Dialect;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Mirrors the table tests of the Go reference lexer, {@code go/o11ysql/internal/sqltext/sqltext_test.go},
 * case for case, so the two implementations agree on every input Go tests.
 */
class SqlSanitizerTest {

    /** Go {@code TestSanitize}. */
    static Stream<Arguments> sanitize() {
        return Stream.of(
                arguments("strings and numbers", "SELECT * FROM users WHERE email = 'a@example.com' AND age > 30", "SELECT * FROM users WHERE email = ? AND age > ?", Dialect.STANDARD),
                arguments("doubled quote and exponent", "INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)", "INSERT INTO t (a, b) VALUES (?, ?)", Dialect.STANDARD),
                arguments("quoted identifiers and placeholders kept", "SELECT \"Name\" FROM \"Users\" WHERE id = $1 AND x = ?", "SELECT \"Name\" FROM \"Users\" WHERE id = $1 AND x = ?", Dialect.STANDARD),
                arguments("mysql double quotes are strings", "SELECT * FROM t WHERE a = \"secret\" AND b = 'x\\'y'", "SELECT * FROM t WHERE a = ? AND b = ?", Dialect.MYSQL),
                arguments("mysql backticks kept", "SELECT `order` FROM `t`", "SELECT `order` FROM `t`", Dialect.MYSQL),
                arguments("comments removed", "SELECT 1 -- token=abc\nFROM t /* pw */", "SELECT ?  \nFROM t  ", Dialect.STANDARD),
                arguments("mysql hash comment", "SELECT 1 # pw\nFROM t", "SELECT ?  \nFROM t", Dialect.MYSQL),
                arguments("dollar quoting", "SELECT $tag$ secret $tag$, $$x$$, $2", "SELECT ?, ?, $2", Dialect.STANDARD),
                arguments("hex and leading dot", "SELECT 0xFF, .5, t1.c2 FROM t1", "SELECT ?, ?, t1.c2 FROM t1", Dialect.STANDARD),
                arguments("unterminated string", "SELECT 'abc", "SELECT ?", Dialect.STANDARD),
                arguments("unterminated comment", "SELECT a /* secret", "SELECT a  ", Dialect.STANDARD),
                arguments("named placeholders kept, colon digits are numbers", "SELECT * FROM t WHERE id = :1 AND name = :name AND p = @p1", "SELECT * FROM t WHERE id = :? AND name = :name AND p = @p1", Dialect.STANDARD),
                arguments("array slices and times", "SELECT data[1:5], data[:5] FROM t WHERE a = 12:34", "SELECT data[?:?], data[:?] FROM t WHERE a = ?:?", Dialect.STANDARD),
                arguments("mysql colon digits are numbers", "SELECT * FROM t WHERE a = 12:34 AND b = :5", "SELECT * FROM t WHERE a = ?:? AND b = :?", Dialect.MYSQL),
                arguments("sqlite colon digits are parameters", "SELECT * FROM t WHERE b = :5", "SELECT * FROM t WHERE b = :5", Dialect.SQLITE),
                arguments("standard backslash is literal", "SELECT 'C:\\' FROM t", "SELECT ? FROM t", Dialect.STANDARD),
                arguments("unicode identifier", "SELECT * FROM caf\u00e9 WHERE x = '\u00e9'", "SELECT * FROM caf\u00e9 WHERE x = ?", Dialect.STANDARD)
        );
    }

    /** Go {@code TestSanitizeEdgeCases}. */
    static Stream<Arguments> sanitizeEdgeCases() {
        return Stream.of(
                arguments("escape string with backslash quote", "SELECT E'it\\'s secret', e'a\\\\' FROM t", "SELECT ?, ? FROM t", Dialect.STANDARD),
                arguments("escape string with doubled quote", "SELECT E'it''s secret' FROM t", "SELECT ? FROM t", Dialect.STANDARD),
                arguments("unterminated escape string", "SELECT E'secret\\'", "SELECT ?", Dialect.STANDARD),
                arguments("e prefix only escapes in standard", "SELECT e'a\\'b'", "SELECT e?", Dialect.MYSQL),
                arguments("nested block comment", "SELECT a /* x /* y */ secret */ FROM t", "SELECT a   FROM t", Dialect.STANDARD),
                arguments("unterminated nested comment", "SELECT a /* x /* y */ secret", "SELECT a  ", Dialect.STANDARD),
                arguments("mysql comments do not nest", "SELECT a /* x /* y */ FROM t", "SELECT a   FROM t", Dialect.MYSQL),
                arguments("line comment at end", "SELECT a -- secret", "SELECT a  ", Dialect.STANDARD),
                arguments("numeric forms", "SELECT 1_000_000, 0b1010, 0o17, 0x1F_FF, 1.5e+10, 12abc, 1., 1e5", "SELECT ?, ?, ?, ?, ?, ?, ?, ?", Dialect.STANDARD),
                arguments("negative number", "SELECT * FROM t WHERE a = -5", "SELECT * FROM t WHERE a = -?", Dialect.STANDARD),
                arguments("casts kept", "SELECT '1'::int, $1::text", "SELECT ?::int, $1::text", Dialect.STANDARD),
                arguments("unterminated quoted identifier", "SELECT \"abc 'secret'", "SELECT ?", Dialect.STANDARD),
                arguments("unterminated backtick identifier", "SELECT `abc 'secret'", "SELECT ?", Dialect.MYSQL),
                arguments("mysql escaped double quote", "SELECT \"a\\\"secret\" FROM t", "SELECT ? FROM t", Dialect.MYSQL),
                arguments("mysql doubled quote", "SELECT 'it''s secret' FROM t", "SELECT ? FROM t", Dialect.MYSQL),
                arguments("mysql trailing backslash", "SELECT 'abc\\", "SELECT ?", Dialect.MYSQL),
                arguments("unterminated dollar quote", "SELECT $$secret", "SELECT ?", Dialect.STANDARD),
                arguments("dollar tags must match", "SELECT $a$ x $b$ secret $a$ FROM t", "SELECT ? FROM t", Dialect.STANDARD),
                arguments("string prefixes", "SELECT X'FF', B'01', N'abc', _utf8mb4'abc'", "SELECT X?, B?, N?, _utf8mb4?", Dialect.MYSQL),
                arguments("comment markers inside strings", "SELECT '-- x', '/* y', $$ */ $$ FROM t", "SELECT ?, ?, ? FROM t", Dialect.STANDARD),
                arguments("empty", "", "", Dialect.STANDARD),
                arguments("dollar inside identifier", "SELECT a$b$, 'q', $b$ SECRET $b$", "SELECT a$b$, ?, ?", Dialect.STANDARD),
                arguments("mysql has no dollar quoting", "SELECT a$t$b, 'x $t$ SECRET'", "SELECT a$t$b, ?", Dialect.MYSQL),
                arguments("mysql dollar starts identifier", "SELECT $$x$$ FROM t", "SELECT $$x$$ FROM t", Dialect.MYSQL),
                arguments("number before dollar quote", "SELECT 1$t$ SECRET $t$", "SELECT ??", Dialect.STANDARD),
                arguments("number before escape string", "SELECT 1E'\\'SECRET'", "SELECT ??", Dialect.STANDARD),
                arguments("hex digit e before string", "SELECT 0x1E'C:\\', 'SECRET'", "SELECT ??, ?", Dialect.STANDARD),
                arguments("backtick is an operator in standard", "SELECT a ` 'SECRET' ` b", "SELECT a ` ? ` b", Dialect.STANDARD),
                arguments("hash is an operator in standard", "SELECT a # 'SECRET'", "SELECT a # ?", Dialect.STANDARD),
                arguments("nested comment ends after inner close", "SELECT /* /* */ ' */ 'SECRET'", "SELECT   ?", Dialect.STANDARD),
                arguments("mysql double minus before string", "SELECT a--'x\nSECRET'", "SELECT a--?", Dialect.MYSQL),
                arguments("mysql double minus tab comment", "SELECT a --\tx\nFROM t", "SELECT a  \nFROM t", Dialect.MYSQL),
                arguments("mysql double minus at end", "SELECT a --", "SELECT a  ", Dialect.MYSQL),
                arguments("mysql versioned comment", "SELECT /*!50000 'a*/SECRET' */ 1", "SELECT   ?   ?", Dialect.MYSQL),
                arguments("mariadb versioned comment", "SELECT /*M!100100 'a*/SECRET' */ 1", "SELECT   ?   ?", Dialect.MYSQL),
                arguments("mysql hint is a comment", "SELECT /*+ BKA(t) */ a FROM t", "SELECT   a FROM t", Dialect.MYSQL),
                arguments("sqlite comments do not nest", "SELECT /* /* */ 'x */ SECRET'", "SELECT   ?", Dialect.SQLITE),
                arguments("sqlite bracket identifier", "SELECT [O'Brien] FROM t WHERE a = 'SECRET'", "SELECT [O'Brien] FROM t WHERE a = ?", Dialect.SQLITE),
                arguments("sqlite unterminated bracket", "SELECT [abc 'SECRET'", "SELECT ?", Dialect.SQLITE),
                arguments("sqlite has no escape strings", "SELECT e'C:\\', 'SECRET'", "SELECT e?, ?", Dialect.SQLITE),
                arguments("sqlite double quotes may be strings", "SELECT * FROM t WHERE name = \"bob\"", "SELECT * FROM t WHERE name = ?", Dialect.SQLITE),
                arguments("sqlite backticks kept", "SELECT `order` FROM t", "SELECT `order` FROM t", Dialect.SQLITE),
                arguments("sqlite parameters", "SELECT $p$, 'a $p$ SECRET', ?1, :a, @b, #c, $d::e, $f(SECRET)", "SELECT $p$, ?, ?1, :a, @b, #c, $d::e, ?", Dialect.SQLITE),
                arguments("sqlite numbers", "SELECT 1_000, 0x1F, .5e3", "SELECT ?, ?, ?", Dialect.SQLITE)
        );
    }

    /** Go {@code TestSummarize}. */
    static Stream<Arguments> summarize() {
        return Stream.of(
                arguments("SELECT id FROM users WHERE email = ?", "SELECT", "users"),
                arguments("select * from public.\"Users\"", "SELECT", "public.Users"),
                arguments("INSERT INTO orders (a, b) VALUES (?, ?)", "INSERT", "orders"),
                arguments("UPDATE accounts SET n = ? WHERE id = ?", "UPDATE", "accounts"),
                arguments("DELETE FROM t WHERE id IN (SELECT id FROM u)", "DELETE", ""),
                arguments("SELECT * FROM a JOIN b ON a.id = b.id", "SELECT", ""),
                arguments("SELECT * FROM a x JOIN a y ON x.p = y.id", "SELECT", "a"),
                arguments("SELECT * FROM a, b", "SELECT", ""),
                arguments("SELECT * FROM generate_series(?, ?)", "SELECT", ""),
                arguments("SELECT * FROM jobs FOR UPDATE NOWAIT", "SELECT", "jobs"),
                arguments("CREATE TABLE IF NOT EXISTS widgets (id INTEGER)", "CREATE", "widgets"),
                arguments("WITH x AS (SELECT ?) SELECT * FROM x", "", ""),
                arguments("COMMIT", "COMMIT", ""),
                arguments("SELECT ?", "SELECT", ""),
                arguments("", "", ""),
                arguments("hello world", "", ""),
                arguments("SELECT * FROM " + "t".repeat(200), "SELECT", "")
        );
    }

    /** Go {@code TestSummarizeClauses}. */
    static Stream<Arguments> summarizeClauses() {
        return Stream.of(
                arguments("INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = ?", "INSERT", "t"),
                arguments("INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = ?", "INSERT", "t"),
                arguments("SELECT * FROM jobs FOR NO KEY UPDATE SKIP LOCKED", "SELECT", "jobs"),
                arguments("SELECT EXTRACT(YEAR FROM created_at) FROM events", "SELECT", "events"),
                arguments("SELECT SUBSTRING(name FROM ?)", "SELECT", ""),
                arguments("SELECT * FROM (SELECT * FROM t) x", "SELECT", ""),
                arguments("DELETE FROM t WHERE id IN (SELECT id FROM t)", "DELETE", "t"),
                arguments("SELECT COALESCE((SELECT v FROM u), ?) FROM t", "SELECT", ""),
                arguments("DROP TABLE IF EXISTS widgets", "DROP", "widgets"),
                arguments("INSERT INTO t (a) SELECT a FROM u", "INSERT", ""),
                arguments("DROP TABLE a, b", "DROP", ""),
                arguments("TRUNCATE TABLE a, b", "TRUNCATE", ""),
                arguments("UPDATE a, b SET x = ?", "UPDATE", ""),
                arguments("CREATE TABLE IF widgets", "CREATE", ""),
                arguments("SELECT * FROM ONLY t", "SELECT", "t"),
                arguments("UPDATE LOW_PRIORITY IGNORE t SET a = ?", "UPDATE", "t"),
                arguments("CREATE TRIGGER trg AFTER INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f()", "CREATE", ""),
                arguments("CREATE TRIGGER trg BEFORE UPDATE OF a ON t", "CREATE", ""),
                arguments("SELECT * FROM t FOR UPDATE OF t", "SELECT", "t"),
                arguments("SHOW TABLES FROM db", "SHOW", ""),
                arguments("UPDATE OR IGNORE t SET a = ?", "UPDATE", "t"),
                arguments("UPDATE OR REPLACE t SET a = ?", "UPDATE", "t"),
                arguments("SELECT * FROM t WHERE a IS DISTINCT FROM b", "SELECT", "t"),
                arguments("SELECT * FROM \"a\"\"b\"", "SELECT", "a\"b"),
                arguments("SELECT * FROM `s`.`a``b`", "SELECT", "s.a`b")
        );
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource({"sanitize", "sanitizeEdgeCases"})
    void sanitizesLikeGo(String name, String in, String want, Dialect dialect) {
        assertEquals(want, SqlSanitizer.sanitizeText(in, dialect), name);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource({"summarize", "summarizeClauses"})
    void summarizesLikeGo(String in, String operation, String collection) {
        SqlSanitizer.Summary got = SqlSanitizer.summarize(in);
        assertEquals(operation, got.operation(), "operation of " + in);
        assertEquals(collection, got.collection(), "collection of " + in);
    }

    @Test
    void summarizeIsLinear() {
        String q = "CREATE" + " TABLE IF".repeat(50_000) + " EXISTS t";
        long start = System.nanoTime();
        SqlSanitizer.summarize(q);
        assertTrue(System.nanoTime() - start < 5_000_000_000L, "summarize took more than 5s on 450 KB of TABLE IF");
    }

    /** The reviewers' reproductions of the literal leaks. */
    @Test
    void reviewerReproductionsLeakNothing() {
        assertEquals("SELECT * FROM t WHERE email = ? AND k = ?",
                SqlSanitizer.sanitize("mysql", "SELECT * FROM t WHERE email = \"alice@example.com\" AND k = 0xDEADBEEF"));
        assertEquals("SELECT ? FROM t",
                SqlSanitizer.sanitize("postgresql", "SELECT E'it\\'s my ssn 123-45-6789' FROM t"));
    }

    @Test
    void removedCommentLeavesASpace() {
        assertEquals("SELECT ?", SqlSanitizer.sanitize("postgresql", "SELECT/*c*/1"));
        assertEquals("SELECT ? ?", SqlSanitizer.sanitize("postgresql", "SELECT 1/*c*/2"));
    }

    @Test
    void onlyTheFourKnownSystemsGetQueryText() {
        assertTrue(SqlSanitizer.isSupported("postgresql"));
        assertTrue(SqlSanitizer.isSupported("sqlite"));
        assertTrue(SqlSanitizer.isSupported("mysql"));
        assertTrue(SqlSanitizer.isSupported("mariadb"));
        assertFalse(SqlSanitizer.isSupported("h2"));
        assertFalse(SqlSanitizer.isSupported("h2database"));
        assertFalse(SqlSanitizer.isSupported("microsoft.sql_server"));
        assertFalse(SqlSanitizer.isSupported("other_sql"));
        assertFalse(SqlSanitizer.isSupported(null));
        assertNull(SqlSanitizer.sanitize("h2", "SELECT 'secret'"));
        assertNull(SqlSanitizer.sanitize("other_sql", "SELECT 'secret'"));
        assertNull(SqlSanitizer.sanitize("postgresql", null));
    }

    @Test
    void extractOperationSkipsLeadingComments() {
        assertEquals("SELECT", SqlSanitizer.extractOperation("/* app=checkout */ SELECT 1"));
        assertEquals("UPDATE", SqlSanitizer.extractOperation("-- note\n  update t set a = 1"));
        assertEquals("SELECT", SqlSanitizer.extractOperation("SELECT/*c*/1"));
        assertEquals("", SqlSanitizer.extractOperation("hello world"));
        assertEquals("", SqlSanitizer.extractOperation(null));
    }

    // The leak property test below mirrors Go's TestSanitizeLeaksNoLiteral: it plants markers
    // inside every literal and comment form of each dialect and checks that neither survives
    // sanitizing, in the statement or in any prefix of it.

    private static final String MARKER = "SECRET";
    private static final String NUM_MARKER = "8675309";
    private static final String[] NOISE = {
        "a", "Z", " ", "'", "\"", "`", "\\", "-", "/", "*", "$", "#", "\n", ":", "?", "1", "e", "é", "(", ";",
        "*/", "/*", "--", "$t$", "[", "]"
    };

    private static String body(Random r) {
        StringBuilder b = new StringBuilder();
        int n = r.nextInt(8);
        int at = r.nextInt(n + 1);
        for (int i = 0; i <= n; i++) {
            if (i == at) {
                b.append(MARKER);
            }
            if (i < n) {
                b.append(NOISE[r.nextInt(NOISE.length)]);
            }
        }
        return b.toString();
    }

    private static String quoted(Random r, String quote, boolean backslash) {
        String s = body(r);
        if (backslash) {
            s = s.replace("\\", "\\\\");
        }
        String escape = quote + quote;
        if (backslash && r.nextInt(2) == 0) {
            escape = "\\" + quote;
        }
        return quote + s.replace(quote, escape) + quote;
    }

    private static String numberLiteral(Random r, Dialect d) {
        List<String> forms = new ArrayList<>(List.of(
                NUM_MARKER, "8_675_309", "0x" + NUM_MARKER, NUM_MARKER + ".5e-3", "." + NUM_MARKER,
                "1." + NUM_MARKER, NUM_MARKER + "e+2", NUM_MARKER + "abc"));
        if (d != Dialect.SQLITE) {
            forms.add("arr[" + NUM_MARKER + ":" + NUM_MARKER + "]");
            forms.add("arr[:" + NUM_MARKER + "]");
            forms.add("12:" + NUM_MARKER);
        }
        return forms.get(r.nextInt(forms.size()));
    }

    private static String blockComment(Random r) {
        while (true) {
            String c = "/*" + body(r) + "*/";
            if (c.indexOf("/*", 1) < 0 && c.indexOf("*/", 2) == c.length() - 2) {
                return c;
            }
        }
    }

    private static String dollarQuoted(Random r) {
        String[] tags = {"$$", "$t$", "$tag_1$"};
        String tag = tags[r.nextInt(tags.length)];
        while (true) {
            String s = body(r);
            if ((s + tag).indexOf(tag) == s.length()) {
                return tag + s + tag;
            }
        }
    }

    private static String lineBody(Random r) {
        return body(r).replace("\n", "");
    }

    private static String literal(Random r, Dialect d) {
        switch (d) {
            case MYSQL -> {
                return switch (r.nextInt(7)) {
                    case 0 -> quoted(r, "'", true);
                    case 1 -> quoted(r, "\"", true);
                    case 2 -> "-- " + lineBody(r) + "\n";
                    case 3 -> "#" + lineBody(r) + "\n";
                    case 4 -> "--" + quoted(r, "'", true);
                    case 5 -> "/*!50000 " + quoted(r, "'", true) + " */";
                    default -> blockComment(r);
                };
            }
            case SQLITE -> {
                return switch (r.nextInt(5)) {
                    case 0 -> quoted(r, "'", false);
                    case 1 -> quoted(r, "\"", false);
                    case 2 -> "--" + lineBody(r) + "\n";
                    case 3 -> "X" + quoted(r, "'", false);
                    default -> blockComment(r);
                };
            }
            default -> {
                return switch (r.nextInt(7)) {
                    case 0 -> quoted(r, "'", false);
                    case 1 -> "E" + quoted(r, "'", true);
                    case 2 -> dollarQuoted(r);
                    case 3 -> "--" + lineBody(r) + "\n";
                    case 4 -> blockComment(r);
                    case 5 -> "/* a /* " + MARKER + " */ " + MARKER + " */";
                    default -> "U&" + quoted(r, "'", false);
                };
            }
        }
    }

    private static List<String> skeleton(Dialect d) {
        return switch (d) {
            case STANDARD -> List.of("a$t$", "`", "#", "arr[1]", "\"Quoted\"", "$1");
            case MYSQL -> List.of("a$t$", "$t$", "`tick`", "@v");
            case SQLITE -> List.of("a$t$", "$t$", "[O'Brien]", "[a--b /*]", "`tick`", "?1", "#v", "$v::w");
        };
    }

    private static final List<String> COMMON = List.of(
            "SELECT", "FROM t", "WHERE c =", ",", "(", ")", "AND", "?", ":name", ":1", "@p1", "x.y", "::text", "-", "+");

    private static String statement(Random r, Dialect d) {
        List<String> words = new ArrayList<>(COMMON);
        words.addAll(skeleton(d));
        String[] seps = {" ", "\n", "\t"};
        StringBuilder b = new StringBuilder();
        for (int n = 1 + r.nextInt(12); n > 0; n--) {
            b.append(seps[r.nextInt(seps.length)]);
            switch (r.nextInt(3)) {
                case 0 -> b.append(words.get(r.nextInt(words.size())));
                case 1 -> b.append(numberLiteral(r, d));
                default -> b.append(literal(r, d));
            }
        }
        return b.toString();
    }

    private static boolean leaks(String out) {
        return out.contains(MARKER) || out.contains(NUM_MARKER);
    }

    @Test
    void sanitizeLeaksNoLiteral() {
        Random r = new Random(12);
        for (Dialect d : Dialect.values()) {
            for (int k = 0; k < 3000; k++) {
                String q = statement(r, d);
                String out = SqlSanitizer.sanitizeText(q, d);
                if (leaks(out)) {
                    fail(d + ": sanitize(" + q + ") = " + out + " leaks a marker");
                }
                if (out.length() > q.length()) {
                    fail(d + ": sanitize(" + q + ") = " + out + " grew the text");
                }
                for (int p = 0; p < 4; p++) {
                    String prefix = q.substring(0, r.nextInt(q.length() + 1));
                    String pout = SqlSanitizer.sanitizeText(prefix, d);
                    if (leaks(pout)) {
                        fail(d + ": sanitize(" + prefix + ") = " + pout + " leaks a marker");
                    }
                }
            }
        }
    }
}
