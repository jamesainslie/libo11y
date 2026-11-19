package o11ysql

import (
	"testing"
	"unicode/utf8"

	"github.com/jamesainslie/libo11y/go/o11ysql/internal/sqltext"
)

func TestDialectForSystem(t *testing.T) {
	for _, tc := range []struct {
		system    string
		dialect   sqltext.Dialect
		queryText bool
	}{
		{system: "postgresql", dialect: sqltext.DialectStandard, queryText: true},
		{system: "sqlite", dialect: sqltext.DialectSQLite, queryText: true},
		{system: "mysql", dialect: sqltext.DialectMySQL, queryText: true},
		{system: "mariadb", dialect: sqltext.DialectMySQL, queryText: true},
		{system: "other_sql", dialect: sqltext.DialectStandard},
		{system: "microsoft.sql_server", dialect: sqltext.DialectStandard},
		{system: "oracle.db", dialect: sqltext.DialectStandard},
		{system: "PostgreSQL", dialect: sqltext.DialectStandard},
	} {
		t.Run(tc.system, func(t *testing.T) {
			in := newInstrumenter(newConfig(tc.system, nil))
			if in.dialect != tc.dialect {
				t.Errorf("dialect = %v, want %v", in.dialect, tc.dialect)
			}
			if in.queryText != tc.queryText {
				t.Errorf("queryText = %v, want %v", in.queryText, tc.queryText)
			}
		})
	}
}

func TestWithoutQueryTextWinsOverAKnownDialect(t *testing.T) {
	in := newInstrumenter(newConfig("postgresql", []Option{WithoutQueryText()}))
	if in.queryText {
		t.Error("queryText = true under WithoutQueryText")
	}
}

func TestTruncate(t *testing.T) {
	for _, tc := range []struct {
		name, in string
		n        int
		want     string
	}{
		{name: "short", in: "abc", n: 4, want: "abc"},
		{name: "exact", in: "abcd", n: 4, want: "abcd"},
		{name: "one over", in: "abcde", n: 4, want: "abcd"},
		{name: "two-byte rune at the cut", in: "abcé", n: 4, want: "abc"},
		{name: "three-byte rune at the cut", in: "ab€", n: 4, want: "ab"},
		{name: "three-byte rune ends at the cut", in: "a€b", n: 4, want: "a€"},
		{name: "four-byte rune at the cut", in: "a😀", n: 4, want: "a"},
		{name: "empty", in: "", n: 4, want: ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := truncate(tc.in, tc.n); got != tc.want {
				t.Errorf("truncate(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
			}
		})
	}
}

// TestDescribeKeepsTextValidUTF8 pins that bytes that are not UTF-8, which
// the lexer keeps as part of a name, never reach an attribute: OTLP
// encodes strings as protobuf strings, which must be valid UTF-8, so one
// such value fails the whole export batch.
func TestDescribeKeepsTextValidUTF8(t *testing.T) {
	in := newInstrumenter(newConfig("postgresql", nil))
	st := in.describe("SELECT a\xff FROM t\xfe WHERE b = 'x'")
	if !utf8.ValidString(st.text) {
		t.Errorf("db.query.text %q is not valid UTF-8", st.text)
	}
	for _, kv := range st.attrs {
		if !utf8.ValidString(kv.Value.AsString()) {
			t.Errorf("%s = %q is not valid UTF-8", kv.Key, kv.Value.AsString())
		}
	}
	if st.name != "SELECT t\uFFFD" {
		t.Errorf("span name = %q, want %q", st.name, "SELECT t\uFFFD")
	}
}
