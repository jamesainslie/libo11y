package o11ysql

import (
	"testing"

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
