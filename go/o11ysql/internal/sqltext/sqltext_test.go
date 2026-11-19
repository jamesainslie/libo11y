package sqltext_test

import (
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11ysql/internal/sqltext"
)

func TestSanitize(t *testing.T) {
	cases := []struct {
		name, in, want string
		dialect        sqltext.Dialect
	}{
		{"strings and numbers", `SELECT * FROM users WHERE email = 'a@example.com' AND age > 30`, `SELECT * FROM users WHERE email = ? AND age > ?`, sqltext.DialectStandard},
		{"doubled quote and exponent", `INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)`, `INSERT INTO t (a, b) VALUES (?, ?)`, sqltext.DialectStandard},
		{"quoted identifiers and placeholders kept", `SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?`, `SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?`, sqltext.DialectStandard},
		{"mysql double quotes are strings", `SELECT * FROM t WHERE a = "secret" AND b = 'x\'y'`, `SELECT * FROM t WHERE a = ? AND b = ?`, sqltext.DialectMySQL},
		{"mysql backticks kept", "SELECT `order` FROM `t`", "SELECT `order` FROM `t`", sqltext.DialectMySQL},
		{"comments removed", "SELECT 1 -- token=abc\nFROM t /* pw */", "SELECT ?  \nFROM t  ", sqltext.DialectStandard},
		{"mysql hash comment", "SELECT 1 # pw\nFROM t", "SELECT ?  \nFROM t", sqltext.DialectMySQL},
		{"dollar quoting", `SELECT $tag$ secret $tag$, $$x$$, $2`, `SELECT ?, ?, $2`, sqltext.DialectStandard},
		{"hex and leading dot", `SELECT 0xFF, .5, t1.c2 FROM t1`, `SELECT ?, ?, t1.c2 FROM t1`, sqltext.DialectStandard},
		{"unterminated string", `SELECT 'abc`, `SELECT ?`, sqltext.DialectStandard},
		{"unterminated comment", `SELECT a /* secret`, `SELECT a  `, sqltext.DialectStandard},
		{"named placeholders kept, colon digits are numbers", `SELECT * FROM t WHERE id = :1 AND name = :name AND p = @p1`, `SELECT * FROM t WHERE id = :? AND name = :name AND p = @p1`, sqltext.DialectStandard},
		{"array slices and times", `SELECT data[1:5], data[:5] FROM t WHERE a = 12:34`, `SELECT data[?:?], data[:?] FROM t WHERE a = ?:?`, sqltext.DialectStandard},
		{"mysql colon digits are numbers", `SELECT * FROM t WHERE a = 12:34 AND b = :5`, `SELECT * FROM t WHERE a = ?:? AND b = :?`, sqltext.DialectMySQL},
		{"sqlite colon digits are parameters", `SELECT * FROM t WHERE b = :5`, `SELECT * FROM t WHERE b = :5`, sqltext.DialectSQLite},
		{"standard backslash is literal", `SELECT 'C:\' FROM t`, `SELECT ? FROM t`, sqltext.DialectStandard},
		{"unicode identifier", `SELECT * FROM café WHERE x = 'é'`, `SELECT * FROM café WHERE x = ?`, sqltext.DialectStandard},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sqltext.Sanitize(tc.in, tc.dialect); got != tc.want {
				t.Errorf("Sanitize(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestSanitizeEdgeCases covers literal and comment forms where a naive
// lexer would let part of a value through.
func TestSanitizeEdgeCases(t *testing.T) {
	cases := []struct {
		name, in, want string
		dialect        sqltext.Dialect
	}{
		{"escape string with backslash quote", `SELECT E'it\'s secret', e'a\\' FROM t`, `SELECT ?, ? FROM t`, sqltext.DialectStandard},
		{"escape string with doubled quote", `SELECT E'it''s secret' FROM t`, `SELECT ? FROM t`, sqltext.DialectStandard},
		{"unterminated escape string", `SELECT E'secret\'`, `SELECT ?`, sqltext.DialectStandard},
		{"e prefix only escapes in standard", `SELECT e'a\'b'`, `SELECT e?`, sqltext.DialectMySQL},
		{"nested block comment", `SELECT a /* x /* y */ secret */ FROM t`, `SELECT a   FROM t`, sqltext.DialectStandard},
		{"unterminated nested comment", `SELECT a /* x /* y */ secret`, `SELECT a  `, sqltext.DialectStandard},
		{"mysql comments do not nest", `SELECT a /* x /* y */ FROM t`, `SELECT a   FROM t`, sqltext.DialectMySQL},
		{"line comment at end", `SELECT a -- secret`, `SELECT a  `, sqltext.DialectStandard},
		{"numeric forms", `SELECT 1_000_000, 0b1010, 0o17, 0x1F_FF, 1.5e+10, 12abc, 1., 1e5`, `SELECT ?, ?, ?, ?, ?, ?, ?, ?`, sqltext.DialectStandard},
		{"negative number", `SELECT * FROM t WHERE a = -5`, `SELECT * FROM t WHERE a = -?`, sqltext.DialectStandard},
		{"casts kept", `SELECT '1'::int, $1::text`, `SELECT ?::int, $1::text`, sqltext.DialectStandard},
		{"unterminated quoted identifier", `SELECT "abc 'secret'`, `SELECT ?`, sqltext.DialectStandard},
		{"unterminated backtick identifier", "SELECT `abc 'secret'", `SELECT ?`, sqltext.DialectMySQL},
		{"mysql escaped double quote", `SELECT "a\"secret" FROM t`, `SELECT ? FROM t`, sqltext.DialectMySQL},
		{"mysql doubled quote", `SELECT 'it''s secret' FROM t`, `SELECT ? FROM t`, sqltext.DialectMySQL},
		{"mysql trailing backslash", `SELECT 'abc\`, `SELECT ?`, sqltext.DialectMySQL},
		{"unterminated dollar quote", `SELECT $$secret`, `SELECT ?`, sqltext.DialectStandard},
		{"dollar tags must match", `SELECT $a$ x $b$ secret $a$ FROM t`, `SELECT ? FROM t`, sqltext.DialectStandard},
		{"string prefixes", `SELECT X'FF', B'01', N'abc', _utf8mb4'abc'`, `SELECT X?, B?, N?, _utf8mb4?`, sqltext.DialectMySQL},
		{"comment markers inside strings", `SELECT '-- x', '/* y', $$ */ $$ FROM t`, `SELECT ?, ?, ? FROM t`, sqltext.DialectStandard},
		{"empty", ``, ``, sqltext.DialectStandard},

		// $ continues an identifier, so it never opens a dollar quote there.
		{"dollar inside identifier", `SELECT a$b$, 'q', $b$ SECRET $b$`, `SELECT a$b$, ?, ?`, sqltext.DialectStandard},
		{"mysql has no dollar quoting", `SELECT a$t$b, 'x $t$ SECRET'`, `SELECT a$t$b, ?`, sqltext.DialectMySQL},
		{"mysql dollar starts identifier", `SELECT $$x$$ FROM t`, `SELECT $$x$$ FROM t`, sqltext.DialectMySQL},
		{"number before dollar quote", `SELECT 1$t$ SECRET $t$`, `SELECT ??`, sqltext.DialectStandard},
		{"number before escape string", `SELECT 1E'\'SECRET'`, `SELECT ??`, sqltext.DialectStandard},
		{"hex digit e before string", `SELECT 0x1E'C:\', 'SECRET'`, `SELECT ??, ?`, sqltext.DialectStandard},
		{"backtick is an operator in standard", "SELECT a ` 'SECRET' ` b", "SELECT a ` ? ` b", sqltext.DialectStandard},
		{"hash is an operator in standard", `SELECT a # 'SECRET'`, `SELECT a # ?`, sqltext.DialectStandard},
		{"nested comment ends after inner close", `SELECT /* /* */ ' */ 'SECRET'`, `SELECT   ?`, sqltext.DialectStandard},

		// MySQL needs whitespace after -- for a comment, and runs the body
		// of a versioned comment as SQL.
		{"mysql double minus before string", "SELECT a--'x\nSECRET'", `SELECT a--?`, sqltext.DialectMySQL},
		{"mysql double minus tab comment", "SELECT a --\tx\nFROM t", "SELECT a  \nFROM t", sqltext.DialectMySQL},
		{"mysql double minus at end", `SELECT a --`, `SELECT a  `, sqltext.DialectMySQL},
		{"mysql versioned comment", `SELECT /*!50000 'a*/SECRET' */ 1`, `SELECT   ?   ?`, sqltext.DialectMySQL},
		{"mariadb versioned comment", `SELECT /*M!100100 'a*/SECRET' */ 1`, `SELECT   ?   ?`, sqltext.DialectMySQL},
		{"mysql hint is a comment", `SELECT /*+ BKA(t) */ a FROM t`, `SELECT   a FROM t`, sqltext.DialectMySQL},

		// SQLite comments do not nest, "..." may be a string, [...] and
		// `...` quote names, and $ @ : # start parameters.
		{"sqlite comments do not nest", `SELECT /* /* */ 'x */ SECRET'`, `SELECT   ?`, sqltext.DialectSQLite},
		{"sqlite bracket identifier", `SELECT [O'Brien] FROM t WHERE a = 'SECRET'`, `SELECT [O'Brien] FROM t WHERE a = ?`, sqltext.DialectSQLite},
		{"sqlite unterminated bracket", `SELECT [abc 'SECRET'`, `SELECT ?`, sqltext.DialectSQLite},
		{"sqlite has no escape strings", `SELECT e'C:\', 'SECRET'`, `SELECT e?, ?`, sqltext.DialectSQLite},
		{"sqlite double quotes may be strings", `SELECT * FROM t WHERE name = "bob"`, `SELECT * FROM t WHERE name = ?`, sqltext.DialectSQLite},
		{"sqlite backticks kept", "SELECT `order` FROM t", "SELECT `order` FROM t", sqltext.DialectSQLite},
		{"sqlite parameters", `SELECT $p$, 'a $p$ SECRET', ?1, :a, @b, #c, $d::e, $f(SECRET)`, `SELECT $p$, ?, ?1, :a, @b, #c, $d::e, ?`, sqltext.DialectSQLite},
		{"sqlite numbers", `SELECT 1_000, 0x1F, .5e3`, `SELECT ?, ?, ?`, sqltext.DialectSQLite},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sqltext.Sanitize(tc.in, tc.dialect); got != tc.want {
				t.Errorf("Sanitize(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSummarize(t *testing.T) {
	cases := []struct{ in, op, coll string }{
		{`SELECT id FROM users WHERE email = ?`, "SELECT", "users"},
		{`select * from public."Users"`, "SELECT", "public.Users"},
		{`INSERT INTO orders (a, b) VALUES (?, ?)`, "INSERT", "orders"},
		{`UPDATE accounts SET n = ? WHERE id = ?`, "UPDATE", "accounts"},
		{`DELETE FROM t WHERE id IN (SELECT id FROM u)`, "DELETE", ""},
		{`SELECT * FROM a JOIN b ON a.id = b.id`, "SELECT", ""},
		{`SELECT * FROM a x JOIN a y ON x.p = y.id`, "SELECT", "a"},
		{`SELECT * FROM a, b`, "SELECT", ""},
		{`SELECT * FROM generate_series(?, ?)`, "SELECT", ""},
		{`SELECT * FROM jobs FOR UPDATE NOWAIT`, "SELECT", "jobs"},
		{`CREATE TABLE IF NOT EXISTS widgets (id INTEGER)`, "CREATE", "widgets"},
		{`WITH x AS (SELECT ?) SELECT * FROM x`, "", ""},
		{`COMMIT`, "COMMIT", ""},
		{`SELECT ?`, "SELECT", ""},
		{``, "", ""},
		{`hello world`, "", ""},
		{`SELECT * FROM ` + strings.Repeat("t", 200), "SELECT", ""},
	}
	for _, tc := range cases {
		op, coll := sqltext.Summarize(tc.in)
		if op != tc.op || coll != tc.coll {
			t.Errorf("Summarize(%q) = (%q, %q), want (%q, %q)", tc.in, op, coll, tc.op, tc.coll)
		}
	}
}

// TestSummarizeClauses covers clauses that use FROM or UPDATE without
// naming a table.
func TestSummarizeClauses(t *testing.T) {
	cases := []struct{ in, op, coll string }{
		{`INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = ?`, "INSERT", "t"},
		{`INSERT INTO t (a) VALUES (?) ON DUPLICATE KEY UPDATE a = ?`, "INSERT", "t"},
		{`SELECT * FROM jobs FOR NO KEY UPDATE SKIP LOCKED`, "SELECT", "jobs"},
		{`SELECT EXTRACT(YEAR FROM created_at) FROM events`, "SELECT", "events"},
		{`SELECT SUBSTRING(name FROM ?)`, "SELECT", ""},
		{`SELECT * FROM (SELECT * FROM t) x`, "SELECT", ""},
		{`DELETE FROM t WHERE id IN (SELECT id FROM t)`, "DELETE", "t"},
		{`SELECT COALESCE((SELECT v FROM u), ?) FROM t`, "SELECT", ""},
		{`DROP TABLE IF EXISTS widgets`, "DROP", "widgets"},
		{`INSERT INTO t (a) SELECT a FROM u`, "INSERT", ""},
		{`DROP TABLE a, b`, "DROP", ""},
		{`TRUNCATE TABLE a, b`, "TRUNCATE", ""},
		{`UPDATE a, b SET x = ?`, "UPDATE", ""},
		{`CREATE TABLE IF widgets`, "CREATE", ""},
		{`SELECT * FROM ONLY t`, "SELECT", "t"},
		{`UPDATE LOW_PRIORITY IGNORE t SET a = ?`, "UPDATE", "t"},
		{`CREATE TRIGGER trg AFTER INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f()`, "CREATE", ""},
		{`CREATE TRIGGER trg BEFORE UPDATE OF a ON t`, "CREATE", ""},
		{`SELECT * FROM t FOR UPDATE OF t`, "SELECT", "t"},
		{`SHOW TABLES FROM db`, "SHOW", ""},
		{`UPDATE OR IGNORE t SET a = ?`, "UPDATE", "t"},
		{`UPDATE OR REPLACE t SET a = ?`, "UPDATE", "t"},
		{`SELECT * FROM t WHERE a IS DISTINCT FROM b`, "SELECT", "t"},
		{`SELECT * FROM "a""b"`, "SELECT", `a"b`},
		{"SELECT * FROM `s`.`a``b`", "SELECT", "s.a`b"},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			op, coll := sqltext.Summarize(tc.in)
			if op != tc.op || coll != tc.coll {
				t.Errorf("Summarize(%q) = (%q, %q), want (%q, %q)", tc.in, op, coll, tc.op, tc.coll)
			}
		})
	}
}

// TestSummarizeLinear guards against a scan that restarts at every
// keyword: a long run of TABLE IF must not take quadratic time.
func TestSummarizeLinear(t *testing.T) {
	q := "CREATE" + strings.Repeat(" TABLE IF", 50_000) + " EXISTS t"
	done := make(chan struct{})
	go func() {
		defer close(done)
		sqltext.Summarize(q)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Summarize took more than 5s on 450 KB of TABLE IF")
	}
}

// The property test plants these markers inside literals and comments and
// checks that neither survives sanitizing.
const (
	marker    = "SECRET"
	numMarker = "8675309"
)

// noise is the alphabet for literal and comment bodies. It holds every
// character the lexer treats specially.
var noise = []string{"a", "Z", " ", "'", `"`, "`", `\`, "-", "/", "*", "$", "#", "\n", ":", "?", "1", "e", "é", "(", ";", "*/", "/*", "--", "$t$", "[", "]"}

func body(r *rand.Rand) string {
	var b strings.Builder
	n := r.IntN(8)
	at := r.IntN(n + 1)
	for i := 0; i <= n; i++ {
		if i == at {
			b.WriteString(marker)
		}
		if i < n {
			b.WriteString(noise[r.IntN(len(noise))])
		}
	}
	return b.String()
}

// quoted wraps a body in quote, escaping quote by doubling it and, when
// backslash is set, by a backslash too, and escaping each backslash.
func quoted(r *rand.Rand, quote string, backslash bool) string {
	s := body(r)
	if backslash {
		s = strings.ReplaceAll(s, `\`, `\\`)
	}
	escape := quote + quote
	if backslash && r.IntN(2) == 0 {
		escape = `\` + quote
	}
	return quote + strings.ReplaceAll(s, quote, escape) + quote
}

func numberLiteral(r *rand.Rand, d sqltext.Dialect) string {
	forms := []string{numMarker, "8_675_309", "0x" + numMarker, numMarker + ".5e-3", "." + numMarker, "1." + numMarker, numMarker + "e+2", numMarker + "abc"}
	if d != sqltext.DialectSQLite {
		// Outside SQLite a colon never starts a parameter, so the digits
		// after it are a number: an array slice, or a time written bare.
		forms = append(forms, "arr["+numMarker+":"+numMarker+"]", "arr[:"+numMarker+"]", "12:"+numMarker)
	}
	return forms[r.IntN(len(forms))]
}

// blockComment returns a /* */ comment whose body opens and closes no
// other comment, so it means the same with and without nesting.
func blockComment(r *rand.Rand) string {
	for {
		c := "/*" + body(r) + "*/"
		if strings.Count(c, "/*") == 1 && strings.Index(c[2:], "*/") == len(c)-4 {
			return c
		}
	}
}

func dollarQuoted(r *rand.Rand) string {
	tags := []string{"$$", "$t$", "$tag_1$"}
	tag := tags[r.IntN(len(tags))]
	for {
		s := body(r)
		if strings.Index(s+tag, tag) == len(s) {
			return tag + s + tag
		}
	}
}

func lineBody(r *rand.Rand) string { return strings.ReplaceAll(body(r), "\n", "") }

func literal(r *rand.Rand, d sqltext.Dialect) string {
	switch d {
	case sqltext.DialectMySQL:
		switch r.IntN(7) {
		case 0:
			return quoted(r, "'", true)
		case 1:
			return quoted(r, `"`, true)
		case 2:
			return "-- " + lineBody(r) + "\n"
		case 3:
			return "#" + lineBody(r) + "\n"
		case 4:
			return "--" + quoted(r, "'", true) // minus, minus, string
		case 5:
			return "/*!50000 " + quoted(r, "'", true) + " */"
		default:
			return blockComment(r)
		}
	case sqltext.DialectSQLite:
		switch r.IntN(5) {
		case 0:
			return quoted(r, "'", false)
		case 1:
			return quoted(r, `"`, false)
		case 2:
			return "--" + lineBody(r) + "\n"
		case 3:
			return "X" + quoted(r, "'", false)
		default:
			return blockComment(r)
		}
	}
	switch r.IntN(7) {
	case 0:
		return quoted(r, "'", false)
	case 1:
		return "E" + quoted(r, "'", true)
	case 2:
		return dollarQuoted(r)
	case 3:
		return "--" + strings.ReplaceAll(body(r), "\n", "") + "\n"
	case 4:
		return blockComment(r)
	case 5:
		return "/* a /* " + marker + " */ " + marker + " */"
	default:
		return "U&" + quoted(r, "'", false)
	}
}

// skeleton holds the non-literal tokens of each dialect, including names
// that look like the start of a literal in another dialect.
var skeleton = map[sqltext.Dialect][]string{
	sqltext.DialectStandard: {"a$t$", "`", "#", "arr[1]", `"Quoted"`, "$1"},
	sqltext.DialectMySQL:    {"a$t$", "$t$", "`tick`", "@v"},
	sqltext.DialectSQLite:   {"a$t$", "$t$", "[O'Brien]", "[a--b /*]", "`tick`", "?1", "#v", "$v::w"},
}

var common = []string{"SELECT", "FROM t", "WHERE c =", ",", "(", ")", "AND", "?", ":name", ":1", "@p1", "x.y", "::text", "-", "+"}

func statement(r *rand.Rand, d sqltext.Dialect) string {
	words := append(append([]string{}, common...), skeleton[d]...)
	var parts []string
	for n := 1 + r.IntN(12); n > 0; n-- {
		switch r.IntN(3) {
		case 0:
			parts = append(parts, words[r.IntN(len(words))])
		case 1:
			parts = append(parts, numberLiteral(r, d))
		default:
			parts = append(parts, literal(r, d))
		}
	}
	seps := []string{" ", "\n", "\t"}
	var b strings.Builder
	for _, p := range parts {
		b.WriteString(seps[r.IntN(len(seps))])
		b.WriteString(p)
	}
	return b.String()
}

func leaks(out string) bool {
	return strings.Contains(out, marker) || strings.Contains(out, numMarker)
}

// TestSanitizeLeaksNoLiteral generates statements with markers planted in
// every literal and comment form of each dialect, and checks that no
// marker survives in the statement or in any prefix of it, which models
// truncated or unterminated text.
func TestSanitizeLeaksNoLiteral(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for _, d := range dialects {
		for range 3000 {
			q := statement(r, d)
			out := sqltext.Sanitize(q, d)
			if leaks(out) {
				t.Fatalf("dialect %d: Sanitize(%q) = %q leaks a marker", d, q, out)
			}
			for range 4 {
				p := q[:r.IntN(len(q)+1)]
				if out := sqltext.Sanitize(p, d); leaks(out) {
					t.Fatalf("dialect %d: Sanitize(%q) = %q leaks a marker", d, p, out)
				}
			}
		}
	}
}

var dialects = []sqltext.Dialect{sqltext.DialectStandard, sqltext.DialectMySQL, sqltext.DialectSQLite}

// FuzzSanitize checks properties that hold for any input: Sanitize
// terminates, never grows the text, and is idempotent, and Summarize keeps
// the collection bounded. Idempotence cannot catch a leak, because a
// fragment of a literal that survives as an identifier or operator lexes
// the same way on the second pass. TestSanitizeLeaksNoLiteral is the leak
// guard. The one exception to idempotence is MySQL text with --, where the
// space left by a removed comment can turn a -- the first pass kept into a
// comment on the second.
func FuzzSanitize(f *testing.F) {
	seeds := []string{
		`SELECT * FROM users WHERE email = 'a@example.com' AND age > 30`,
		`INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)`,
		`SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?`,
		`SELECT * FROM t WHERE a = "secret" AND b = 'x\'y'`,
		"SELECT `order` FROM `t`",
		"SELECT 1 -- token=abc\nFROM t /* pw */",
		"SELECT 1 # pw\nFROM t",
		`SELECT $tag$ secret $tag$, $$x$$, $2`,
		`SELECT 0xFF, .5, t1.c2 FROM t1, 1_000, 0b1, 1e+5x`,
		`SELECT E'it\'s', e'\\'`,
		`SELECT a /* x /* y */ secret */ FROM t`,
		`SELECT "abc 'secret'`,
		`INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = ?`,
		`$a$'x'$/**/$-/**/-:/**/1.'x'5E'`,
		"SELECT a--'x\nSECRET', /*!50000 'a*/b' */ 1, /*M!1 2 */",
		`SELECT [O'Brien], $p$, ?1, #c, $d::e, $f(x), "s"`,
		`SELECT 1E'\'x', 1$t$ y $t$, a$t$`,
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, q string) {
		for _, d := range dialects {
			out := sqltext.Sanitize(q, d)
			if len(out) > len(q) {
				t.Fatalf("dialect %d: Sanitize(%q) = %q grew the text", d, q, out)
			}
			if _, coll := sqltext.Summarize(out); len(coll) > 128 {
				t.Fatalf("Summarize(%q) collection has %d bytes", out, len(coll))
			}
			again := sqltext.Sanitize(out, d)
			if d == sqltext.DialectMySQL && strings.Contains(out, "--") {
				if len(again) > len(out) {
					t.Fatalf("dialect %d: Sanitize(%q) = %q, but sanitizing that grows it to %q", d, q, out, again)
				}
				continue
			}
			if again != out {
				t.Fatalf("dialect %d: Sanitize(%q) = %q, but sanitizing that gives %q", d, q, out, again)
			}
		}
	})
}
