// Package sqltext prepares SQL text for telemetry. Sanitize removes every
// literal and comment, so a statement can be recorded as db.query.text
// without the values it carried, and Summarize derives the bounded
// db.operation.name and db.collection.name values from sanitized text.
package sqltext

import "strings"

// Dialect selects the lexical rules that differ between databases. The
// rules decide where each literal starts and ends, so a statement must be
// sanitized under the dialect of the server that runs it.
type Dialect int

const (
	// DialectStandard follows ANSI SQL and PostgreSQL: "..." quotes an
	// identifier, a backslash inside '...' is an ordinary character,
	// E'...' is a string in which a backslash escapes the next character,
	// $tag$...$tag$ quotes a string, and block comments nest. A Dialect
	// value not defined here gets these PostgreSQL rules, which can keep
	// part of a literal on other servers. o11ysql records query text only
	// for postgresql, mysql, mariadb, and sqlite, the systems these three
	// dialects describe.
	DialectStandard Dialect = iota
	// DialectMySQL follows MySQL and MariaDB: "..." quotes a string, # and --
	// followed by whitespace start a comment, and block comments do not nest.
	// Backslash-escaped quotes and /*! ... */ / /*M! ... */ versioned comments
	// fail closed (see [Sanitize]), because their meaning depends on server
	// mode and version.
	DialectMySQL
	// DialectSQLite follows SQLite: `...` and [...] quote identifiers, a
	// backslash inside '...' is an ordinary character, $ @ : and # start a
	// parameter name, and block comments do not nest. "..." is removed like
	// a string, because SQLite reads a "..." identifier that names no
	// column as a string.
	DialectSQLite
)

// maxCollection bounds a collection name, so a pathological statement
// cannot mint an oversized attribute value.
const maxCollection = 128

// Sanitize returns query with every string, number, and dollar-quoted
// literal replaced by ? and every comment replaced by one space, along with
// whether the result is unambiguous for dialect. Identifiers, keywords,
// operators, and placeholders ($1, ?, :name, @p1, and SQLite's ?1 and :1)
// are kept. Outside SQLite a colon never starts a numbered placeholder, so
// the digits in arr[1:5] and 12:34 are numbers and each becomes ?. A number
// takes every letter, digit, underscore, and dot that follows it, so 1_000,
// 0x1F, 0b1010, and 1.5e-3 each become one ?; a MySQL name that starts with
// a digit is removed the same way. An unterminated literal, comment, or
// quoted identifier is removed up to the end of the text. The result is
// never longer than query.
//
// When query contains a construct whose literal or comment boundaries
// depend on server settings or version that Sanitize cannot observe, it
// fails closed: it replaces the rest of the statement from that construct
// onward and returns safe=false so callers omit db.query.text. This covers:
//   - an odd run of backslashes before a closing quote in a plain
//     PostgreSQL '...' string (affected by standard_conforming_strings=off)
//     or a MySQL '...' / "..." string (affected by NO_BACKSLASH_ESCAPES and
//     ANSI_QUOTES);
//   - a MySQL /*! ... */ or MariaDB /*M! ... */ versioned comment, whose
//     body may be executed as SQL or skipped as a comment depending on
//     server version.
func Sanitize(query string, dialect Dialect) (sanitized string, safe bool) {
	var b strings.Builder
	b.Grow(len(query))
	mysql, sqlite := dialect == DialectMySQL, dialect == DialectSQLite
	pg := !mysql && !sqlite
	for i := 0; i < len(query); {
		c := query[i]
		switch {
		case c == '\'':
			if pg || mysql {
				end, ambiguous := skipQuotedChecked(query, i, '\'')
				b.WriteByte('?')
				if ambiguous {
					return b.String(), false
				}
				i = end
			} else {
				i, _ = skipQuoted(query, i, '\'', false)
				b.WriteByte('?')
			}
		case pg && (c == 'E' || c == 'e') && next(query, i) == '\'':
			i, _ = skipQuoted(query, i+1, '\'', true) // E'...' always uses backslash escapes
			b.WriteByte('?')
		case c == '"' && !pg:
			if mysql {
				end, ambiguous := skipQuotedChecked(query, i, '"')
				b.WriteByte('?')
				if ambiguous {
					return b.String(), false
				}
				i = end
			} else {
				i, _ = skipQuoted(query, i, '"', false)
				b.WriteByte('?')
			}
		case c == '"', c == '`' && !pg, c == '[' && sqlite:
			end, closed := skipQuotedName(query, i)
			if closed {
				b.WriteString(query[i:end])
			} else {
				b.WriteByte('?') // an unterminated name may hold anything
			}
			i = end
		case c == '-' && next(query, i) == '-' && (!mysql || mysqlDashComment(query, i)), c == '#' && mysql:
			i = skipLine(query, i)
			b.WriteByte(' ')
		case c == '/' && next(query, i) == '*':
			if mysql && isVersionedComment(query, i) {
				b.WriteByte(' ')
				return b.String(), false
			}
			i = skipBlock(query, i, pg)
			b.WriteByte(' ')
		case pg && c == '$':
			if end, ok := skipDollarQuoted(query, i); ok {
				b.WriteByte('?')
				i = end
				continue
			}
			end := skipDigits(query, i+1) // $1 placeholder, or a lone $
			b.WriteString(query[i:end])
			i = end
		case sqlite && (c == '$' || c == '@' || c == ':' || c == '#'):
			end, plain := skipSQLiteParameter(query, i)
			switch {
			case end == i+1:
				b.WriteByte(c) // no name follows, so not a parameter
			case plain:
				b.WriteString(query[i:end])
			default:
				b.WriteByte('?') // a $name(...) suffix may hold anything
			}
			i = end
		case sqlite && c == '?':
			end := skipDigits(query, i+1) // ?1 placeholder
			b.WriteString(query[i:end])
			i = end
		case isIdentStart(c), mysql && c == '$':
			end := skipIdent(query, i)
			b.WriteString(query[i:end])
			i = end
		case isDigit(c), c == '.' && isDigit(next(query, i)):
			i = skipNumber(query, i)
			b.WriteByte('?')
		default:
			b.WriteByte(c)
			i++
		}
	}
	return b.String(), true
}

// operations are the statement keywords Summarize reports. Any other first
// word yields no operation, so arbitrary text never becomes an attribute
// value.
var operations = map[string]bool{
	"SELECT": true, "INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true,
	"REPLACE": true, "UPSERT": true, "CREATE": true, "ALTER": true, "DROP": true,
	"TRUNCATE": true, "CALL": true, "EXEC": true, "EXECUTE": true, "BEGIN": true,
	"COMMIT": true, "ROLLBACK": true, "SAVEPOINT": true, "RELEASE": true,
	"PRAGMA": true, "VACUUM": true, "ANALYZE": true, "EXPLAIN": true, "SHOW": true,
	"SET": true,
}

// updateClause holds the words that put UPDATE inside a clause rather than
// at the head of an UPDATE statement: FOR UPDATE, FOR NO KEY UPDATE, ON
// CONFLICT DO UPDATE, ON DUPLICATE KEY UPDATE, MERGE's THEN UPDATE, and a
// trigger's BEFORE, AFTER, OR, or INSTEAD OF UPDATE.
var updateClause = map[string]bool{
	"FOR": true, "KEY": true, "DO": true, "THEN": true,
	"OR": true, "BEFORE": true, "AFTER": true, "OF": true,
}

// tableModifiers are the words that can stand between a keyword and the
// table it names, as in FROM ONLY t or UPDATE LOW_PRIORITY IGNORE t.
var tableModifiers = map[string]bool{"ONLY": true, "LOW_PRIORITY": true, "IGNORE": true}

// clauseKeywords are SQL clause keywords that cannot serve as an implicit
// (un-AS'd) table alias after a table name.
var clauseKeywords = map[string]bool{
	"WHERE": true, "JOIN": true, "INNER": true, "LEFT": true, "RIGHT": true,
	"FULL": true, "CROSS": true, "NATURAL": true, "OUTER": true, "ON": true,
	"USING": true, "GROUP": true, "ORDER": true, "HAVING": true, "LIMIT": true,
	"OFFSET": true, "FETCH": true, "FOR": true, "UNION": true, "INTERSECT": true,
	"EXCEPT": true, "SET": true, "VALUES": true, "SELECT": true, "RETURNING": true,
	"WINDOW": true, "INTO": true, "FROM": true,
}

// Summarize returns the operation and collection names of a sanitized
// statement (see [Sanitize]). The operation is the first keyword, upper
// cased, when it is a known SQL operation, and empty otherwise; a
// statement that starts with WITH has none. The collection is the one
// table the statement names after FROM, JOIN, INTO, UPDATE, or TABLE,
// without quotes and with its schema when qualified (including SQLite
// [bracket] identifiers under DialectSQLite). It is empty when the
// statement names no table, more than one (including comma-separated
// aliased tables), a subquery, or a table function, as the semantic
// conventions ask, and for SHOW, whose FROM names a database. Keywords
// inside the parentheses of a function call, such as EXTRACT(YEAR FROM ts),
// name no table; those inside a parenthesized SELECT or WITH do.
func Summarize(sanitized string, dialect Dialect) (operation, collection string) {
	sqlite := dialect == DialectSQLite
	toks := tokenize(sanitized, sqlite)
	if len(toks) == 0 {
		return "", ""
	}
	operation = strings.ToUpper(toks[0])
	if !operations[operation] {
		return "", ""
	}
	if operation == "SHOW" {
		return operation, ""
	}
	var subquery []bool // per open parenthesis: whether it holds a subquery
	for k := 0; k < len(toks)-1; k++ {
		switch toks[k] {
		case "(":
			first := strings.ToUpper(toks[k+1])
			subquery = append(subquery, first == "SELECT" || first == "WITH")
			continue
		case ")":
			if len(subquery) > 0 {
				subquery = subquery[:len(subquery)-1]
			}
			continue
		}
		if len(subquery) > 0 && !subquery[len(subquery)-1] {
			continue // inside a call or a column list
		}
		keyword := strings.ToUpper(toks[k])
		if !namesTable(keyword, toks, k) {
			continue
		}
		j := k + 1
		if keyword == "TABLE" {
			j = skipIfExists(toks, j)
		}
		if keyword == "UPDATE" && j < len(toks) && strings.EqualFold(toks[j], "OR") {
			j += 2 // SQLite's UPDATE OR IGNORE t, UPDATE OR REPLACE t
		}
		for j < len(toks) && tableModifiers[strings.ToUpper(toks[j])] {
			j++
		}
		if j >= len(toks) || !isName(toks[j], sqlite) {
			return operation, "" // a subquery or something unrecognized
		}
		after, multi := checkTableFollower(keyword, toks, j, sqlite)
		if multi {
			return operation, "" // a list of tables, or a table function
		}
		name := unquoteName(toks[j], sqlite)
		if collection != "" && collection != name {
			return operation, ""
		}
		collection = name
		if after > k {
			k = after - 1
		}
	}
	if len(collection) > maxCollection {
		return operation, ""
	}
	return operation, collection
}

// checkTableFollower inspects the tokens after the table name at toks[j]
// for a table-list comma (directly or after an optional alias and column
// alias list) or a table-function call. It returns the index past any
// skipped alias tokens (so Summarize stays linear) and whether the table
// belongs to a multi-table list or table function.
func checkTableFollower(keyword string, toks []string, j int, sqlite bool) (int, bool) {
	nextIdx := j + 1
	if nextIdx >= len(toks) {
		return nextIdx, false
	}
	if toks[nextIdx] == "," {
		return nextIdx, true // a list of tables
	}
	if toks[nextIdx] == "(" && (keyword == "FROM" || keyword == "JOIN") {
		return nextIdx, true // a table function
	}
	if keyword != "FROM" && keyword != "JOIN" && keyword != "UPDATE" {
		return nextIdx, false
	}
	switch {
	case strings.EqualFold(toks[nextIdx], "AS"):
		if nextIdx+1 >= len(toks) || !isName(toks[nextIdx+1], sqlite) {
			return nextIdx, false
		}
		nextIdx += 2
	case isName(toks[nextIdx], sqlite) && !clauseKeywords[strings.ToUpper(toks[nextIdx])]:
		nextIdx++
	default:
		return nextIdx, false
	}
	if nextIdx < len(toks) && toks[nextIdx] == "(" && (keyword == "FROM" || keyword == "JOIN") {
		// Skip an optional flat column alias list: FROM users u(a, b), orders o
		closeIdx := nextIdx + 1
		for closeIdx < len(toks) && toks[closeIdx] != ")" && toks[closeIdx] != "(" {
			closeIdx++
		}
		if closeIdx < len(toks) && toks[closeIdx] == ")" {
			nextIdx = closeIdx + 1
		}
	}
	return nextIdx, nextIdx < len(toks) && toks[nextIdx] == ","
}

// namesTable reports whether keyword, the upper-cased toks[k], is followed
// by a table name.
func namesTable(keyword string, toks []string, k int) bool {
	prev := ""
	if k > 0 {
		prev = strings.ToUpper(toks[k-1])
	}
	switch keyword {
	case "JOIN", "INTO", "TABLE":
		return true
	case "FROM":
		return prev != "DISTINCT" // a IS DISTINCT FROM b compares values
	case "UPDATE":
		return !updateClause[prev]
	}
	return false
}

// skipIfExists returns the index past IF EXISTS or IF NOT EXISTS at
// toks[j], j when toks[j] is not IF, and len(toks) when IF is not
// followed by [NOT] EXISTS. It looks at no more than three tokens, so
// Summarize stays linear.
func skipIfExists(toks []string, j int) int {
	if j >= len(toks) || !strings.EqualFold(toks[j], "IF") {
		return j
	}
	j++
	if j < len(toks) && strings.EqualFold(toks[j], "NOT") {
		j++
	}
	if j < len(toks) && strings.EqualFold(toks[j], "EXISTS") {
		return j + 1
	}
	return len(toks)
}

// unquoteName removes the quotes around each part of a possibly qualified
// name and turns each doubled quote inside them back into one. With sqlite
// set, SQLite [bracket] identifiers are unquoted too.
func unquoteName(tok string, sqlite bool) string {
	if !strings.ContainsAny(tok, "\"`[") {
		return tok
	}
	var b strings.Builder
	for i := 0; i < len(tok); {
		q := tok[i]
		if q == '[' && sqlite {
			end, closed := skipQuotedName(tok, i)
			inner := tok[i+1 : end]
			if closed {
				inner = tok[i+1 : end-1]
			}
			b.WriteString(inner)
			i = end
			continue
		}
		if q != '"' && q != '`' {
			b.WriteByte(q)
			i++
			continue
		}
		end, closed := skipQuoted(tok, i, q, false)
		inner := tok[i+1 : end]
		if closed {
			inner = tok[i+1 : end-1]
		}
		b.WriteString(strings.ReplaceAll(inner, string([]byte{q, q}), string(q)))
		i = end
	}
	return b.String()
}

// tokenize splits sanitized SQL into names (possibly qualified and quoted)
// and single punctuation characters, dropping whitespace.
func tokenize(s string, sqlite bool) []string {
	var toks []string
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case isNameStart(c, sqlite):
			end := skipName(s, i, sqlite)
			toks = append(toks, s[i:end])
			i = end
		default:
			toks = append(toks, s[i:i+1])
			i++
		}
	}
	return toks
}

// skipName returns the end of a possibly qualified, possibly quoted name
// that starts at s[i], such as users, "Users", public."Users", or SQLite's
// [users].
func skipName(s string, i int, sqlite bool) int {
	for {
		if s[i] == '"' || s[i] == '`' || (sqlite && s[i] == '[') {
			i, _ = skipQuotedName(s, i)
		} else {
			i = skipIdent(s, i)
		}
		if i+1 < len(s) && s[i] == '.' && isNameStart(s[i+1], sqlite) {
			i++
			continue
		}
		return i
	}
}

func isName(tok string, sqlite bool) bool { return tok != "" && isNameStart(tok[0], sqlite) }

func isNameStart(c byte, sqlite bool) bool {
	return isIdentStart(c) || c == '"' || c == '`' || (sqlite && c == '[')
}

func isIdentStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

// isIdentPart reports whether c can continue a dollar-quote tag or a
// number. Identifiers also take $ (see isIdentCont).
func isIdentPart(c byte) bool { return isIdentStart(c) || isDigit(c) }

// isIdentCont reports whether c can continue an identifier. PostgreSQL,
// MySQL, and SQLite all allow $ after the first character.
func isIdentCont(c byte) bool { return isIdentPart(c) || c == '$' }

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// next returns the byte after s[i], or 0 at the end of s.
func next(s string, i int) byte {
	if i+1 < len(s) {
		return s[i+1]
	}
	return 0
}

func skipIdent(s string, i int) int {
	i++
	for i < len(s) && isIdentCont(s[i]) {
		i++
	}
	return i
}

func skipDigits(s string, i int) int {
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	return i
}

// skipQuotedChecked scans a quoted string where server configuration
// (PostgreSQL standard_conforming_strings=off, MySQL NO_BACKSLASH_ESCAPES
// or ANSI_QUOTES) decides whether backslash escapes the closing quote. If an
// odd run of backslashes immediately precedes quote, the two server modes
// disagree on whether the string ended, so skipQuotedChecked fails closed
// and reports ambiguous=true.
func skipQuotedChecked(s string, i int, quote byte) (end int, ambiguous bool) {
	slashes := 0
	for j := i + 1; j < len(s); j++ {
		switch s[j] {
		case '\\':
			slashes++
		case quote:
			if slashes%2 == 1 {
				return len(s), true
			}
			if j+1 < len(s) && s[j+1] == quote {
				j++
				slashes = 0
				continue
			}
			return j + 1, false
		default:
			slashes = 0
		}
	}
	return len(s), false
}

// skipQuoted returns the index just past the run quoted by quote that
// starts at s[i], and whether the closing quote was found; an unterminated
// run ends at the end of s. A doubled quote is an escaped quote; with
// backslash set, a backslash escapes the next byte.
func skipQuoted(s string, i int, quote byte, backslash bool) (int, bool) {
	for j := i + 1; j < len(s); j++ {
		switch s[j] {
		case '\\':
			if backslash {
				j++
			}
		case quote:
			if j+1 < len(s) && s[j+1] == quote {
				j++
				continue
			}
			return j + 1, true
		}
	}
	return len(s), false
}

// skipQuotedName returns the index just past the quoted identifier that
// starts at s[i] ("...", `...`, or SQLite's [...]), and whether it was
// closed. A [...] name ends at the first ]; the others double their quote
// to escape it.
func skipQuotedName(s string, i int) (int, bool) {
	if s[i] != '[' {
		return skipQuoted(s, i, s[i], false)
	}
	if end := strings.IndexByte(s[i+1:], ']'); end >= 0 {
		return i + 1 + end + 1, true
	}
	return len(s), false
}

// mysqlDashComment reports whether the -- at s[i] starts a MySQL comment,
// which needs whitespace, a control character, or the end of the text
// after it. Otherwise a--1 is a minus minus one.
func mysqlDashComment(s string, i int) bool {
	return i+2 >= len(s) || s[i+2] <= ' ' || s[i+2] == 0x7f
}

// skipLine returns the index of the newline ending the comment at s[i], or
// the end of s.
func skipLine(s string, i int) int {
	if end := strings.IndexByte(s[i:], '\n'); end >= 0 {
		return i + end
	}
	return len(s)
}

// skipBlock returns the index just past the /* */ comment at s[i], or the
// end of s when it is unterminated. With nested set, each /* inside the
// comment needs its own */, as in PostgreSQL and the SQL standard.
func skipBlock(s string, i int, nested bool) int {
	depth := 0
	for j := i; j+1 < len(s); {
		switch {
		case s[j] == '/' && s[j+1] == '*' && (nested || depth == 0):
			depth++
			j += 2
		case s[j] == '*' && s[j+1] == '/':
			depth--
			j += 2
			if depth == 0 {
				return j
			}
		default:
			j++
		}
	}
	return len(s)
}

// isVersionedComment reports whether s[i] opens a MySQL /*! or a MariaDB
// /*M! versioned comment.
func isVersionedComment(s string, i int) bool {
	j := i + 2
	if j < len(s) && s[j] == 'M' {
		j++
	}
	return j < len(s) && s[j] == '!'
}

// skipDollarQuoted reports whether s[i] opens a PostgreSQL dollar-quoted
// string ($$...$$ or $tag$...$tag$) and returns the index just past it, or
// the end of s when it is unterminated.
func skipDollarQuoted(s string, i int) (int, bool) {
	j := i + 1
	if j < len(s) && isIdentStart(s[j]) {
		for j++; j < len(s) && isIdentPart(s[j]); j++ {
		}
	}
	if j >= len(s) || s[j] != '$' {
		return 0, false
	}
	tag := s[i : j+1]
	body := j + 1
	if end := strings.Index(s[body:], tag); end >= 0 {
		return body + end + len(tag), true
	}
	return len(s), true
}

// skipSQLiteParameter returns the end of the SQLite parameter that starts
// at s[i] with $, @, :, or #, following SQLite's tokenizer: a name of
// identifier characters and :: pairs, optionally ending in a Tcl-style
// (...) suffix that runs to ) or whitespace. plain is false when the
// suffix is present. The end is i+1 when no name follows.
func skipSQLiteParameter(s string, i int) (end int, plain bool) {
	j, n := i+1, 0
	for j < len(s) {
		c := s[j]
		switch {
		case isIdentCont(c):
			n++
			j++
		case c == '(' && n > 0:
			for j++; j < len(s) && s[j] != ')' && !isSpace(s[j]); j++ {
			}
			if j < len(s) && s[j] == ')' {
				j++
			}
			return j, false
		case c == ':' && next(s, j) == ':':
			j += 2
		default:
			if n == 0 {
				return i + 1, true
			}
			return j, true
		}
	}
	if n == 0 {
		return i + 1, true
	}
	return j, true
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r'
}

// skipNumber returns the end of the number that starts at s[i]. It takes
// the longest run a numeric literal could span, so digit separators,
// radix prefixes (0x, 0o, 0b), fractions, signed exponents, and any
// trailing letters all stay inside the literal. It stops before a $, and
// outside a hex number (where E is a digit) before an E' that opens a
// PostgreSQL escape string.
func skipNumber(s string, i int) int {
	hex := s[i] == '0' && (next(s, i) == 'x' || next(s, i) == 'X')
	for i++; i < len(s); i++ {
		c := s[i]
		switch {
		case !hex && (c == 'e' || c == 'E') && next(s, i) == '\'':
			return i
		case isIdentPart(c), c == '.':
		case (c == '+' || c == '-') && (s[i-1] == 'e' || s[i-1] == 'E') && isDigit(next(s, i)):
		default:
			return i
		}
	}
	return i
}
