package o11ysql_test

import (
	"context"
	"database/sql"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ysql"
)

func TestNilArgumentsDoNotPanic(t *testing.T) {
	for name, opts := range map[string][]o11ysql.Option{
		"nil option":       {nil},
		"WithSDK nil":      {o11ysql.WithSDK(nil)},
		"WithSDK zero":     {o11ysql.WithSDK(&o11y.SDK{})},
		"WithSystem empty": {o11ysql.WithSystem("")},
		"WithPoolName ''":  {o11ysql.WithPoolName("")},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			db, err := o11ysql.Open("o11ysql-fake", "", opts...)
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			defer func() { _ = db.Close() }()
			if _, err := db.ExecContext(context.Background(), "SELECT 1"); err != nil {
				t.Errorf("Exec: %v", err)
			}
			wrapped := sql.OpenDB(o11ysql.Wrap(fakeConnector{}, opts...))
			defer func() { _ = wrapped.Close() }()
			if _, err := wrapped.ExecContext(context.Background(), "SELECT 1"); err != nil {
				t.Errorf("Exec through Wrap: %v", err)
			}
			reg, err := o11ysql.RegisterPoolMetrics(wrapped, opts...)
			if err != nil {
				t.Fatalf("RegisterPoolMetrics: %v", err)
			}
			_ = reg.Unregister()
		})
	}
}

// TestRegisterPoolMetricsNilDB pins that a nil *sql.DB is an error, not a
// panic.
func TestRegisterPoolMetricsNilDB(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("RegisterPoolMetrics(nil) panicked: %v", r)
		}
	}()
	if _, err := o11ysql.RegisterPoolMetrics(nil); err == nil {
		t.Error("RegisterPoolMetrics(nil) succeeded, want an error")
	}
}
