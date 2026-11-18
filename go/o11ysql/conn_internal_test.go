package o11ysql

import (
	"context"
	"database/sql/driver"
	"testing"
)

// bareConn implements only driver.Conn.
type bareConn struct{}

func (bareConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (bareConn) Close() error { return nil }

func (bareConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

type resettingConn struct {
	bareConn
	reset *bool
}

func (c resettingConn) ResetSession(context.Context) error {
	*c.reset = true
	return nil
}

type validatingConn struct{ bareConn }

func (validatingConn) IsValid() bool { return false }

type resettingValidatingConn struct {
	resettingConn
	validatingConn
}

// Prepare, Close, and Begin are ambiguous between the two embedded
// bareConns, so resettingValidatingConn names them.
func (c resettingValidatingConn) Prepare(q string) (driver.Stmt, error) {
	return c.resettingConn.Prepare(q)
}

func (c resettingValidatingConn) Close() error { return c.resettingConn.Close() }

func (c resettingValidatingConn) Begin() (driver.Tx, error) { return c.resettingConn.Begin() }

func TestNewConnMirrorsTheSessionHooks(t *testing.T) {
	var reset bool
	for _, tc := range []struct {
		name                        string
		inner                       driver.Conn
		wantResetter, wantValidator bool
	}{
		{name: "neither", inner: bareConn{}},
		{name: "resetter", inner: resettingConn{reset: &reset}, wantResetter: true},
		{name: "validator", inner: validatingConn{}, wantValidator: true},
		{
			name:          "both",
			inner:         resettingValidatingConn{resettingConn: resettingConn{reset: &reset}},
			wantResetter:  true,
			wantValidator: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reset = false
			c := newConn(tc.inner, newInstrumenter(newConfig("", nil)))
			resetter, hasResetter := c.(driver.SessionResetter)
			validator, hasValidator := c.(driver.Validator)
			if hasResetter != tc.wantResetter || hasValidator != tc.wantValidator {
				t.Fatalf("SessionResetter %v, Validator %v, want %v, %v",
					hasResetter, hasValidator, tc.wantResetter, tc.wantValidator)
			}
			if hasResetter {
				if err := resetter.ResetSession(context.Background()); err != nil {
					t.Errorf("ResetSession: %v", err)
				}
				if !reset {
					t.Error("ResetSession was not delegated")
				}
			}
			if hasValidator && validator.IsValid() {
				t.Error("IsValid = true, want the inner connection's false")
			}
			for name, ok := range map[string]bool{
				"driver.ConnBeginTx":       is[driver.ConnBeginTx](c),
				"driver.ExecerContext":     is[driver.ExecerContext](c),
				"driver.QueryerContext":    is[driver.QueryerContext](c),
				"driver.Pinger":            is[driver.Pinger](c),
				"driver.NamedValueChecker": is[driver.NamedValueChecker](c),
			} {
				if !ok {
					t.Errorf("%T lacks %s", c, name)
				}
			}
		})
	}
}

func is[I any](v any) bool {
	_, ok := v.(I)
	return ok
}
