package o11ysql_test

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
)

// errFake is the error the fake driver returns for a statement whose text
// contains "fail".
var errFake = errors.New("fake: statement failed")

// result is the outcome the fake gives a statement.
func result(query string) error {
	if strings.Contains(query, "fail") {
		return errFake
	}
	return nil
}

// fakeDriver opens fakeConn connections.
type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) { return &fakeConn{}, nil }

// fakeConnector connects to the fake database. With legacy set, its
// connections implement only driver.Conn, as drivers written before Go 1.8
// do.
type fakeConnector struct{ legacy bool }

func (c fakeConnector) Connect(context.Context) (driver.Conn, error) {
	if c.legacy {
		return &legacyConn{}, nil
	}
	return &fakeConn{}, nil
}

func (fakeConnector) Driver() driver.Driver { return fakeDriver{} }

// fakeConn implements every optional context interface. ExecContext and
// QueryContext answer driver.ErrSkip for a statement containing "skip", so
// database/sql retries through a prepared statement.
type fakeConn struct{}

func (*fakeConn) Prepare(query string) (driver.Stmt, error) { return &fakeStmt{query: query}, nil }

func (*fakeConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	return &fakeStmt{query: query}, nil
}

func (*fakeConn) Close() error { return nil }

func (*fakeConn) Begin() (driver.Tx, error) { return fakeTx{}, nil }

func (*fakeConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) { return fakeTx{}, nil }

func (*fakeConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if strings.Contains(query, "skip") {
		return nil, driver.ErrSkip
	}
	if err := result(query); err != nil {
		return nil, err
	}
	return driver.RowsAffected(1), nil
}

func (*fakeConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(query, "skip") {
		return nil, driver.ErrSkip
	}
	if err := result(query); err != nil {
		return nil, err
	}
	return &fakeRows{}, nil
}

// legacyConn implements only driver.Conn.
type legacyConn struct{}

func (*legacyConn) Prepare(query string) (driver.Stmt, error) { return &fakeStmt{query: query}, nil }

func (*legacyConn) Close() error { return nil }

func (*legacyConn) Begin() (driver.Tx, error) { return fakeTx{}, nil }

// fakeStmt implements the statement context interfaces.
type fakeStmt struct{ query string }

func (*fakeStmt) Close() error { return nil }

func (*fakeStmt) NumInput() int { return -1 }

func (s *fakeStmt) Exec([]driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), nil)
}

func (s *fakeStmt) Query([]driver.Value) (driver.Rows, error) {
	return s.QueryContext(context.Background(), nil)
}

func (s *fakeStmt) ExecContext(context.Context, []driver.NamedValue) (driver.Result, error) {
	if err := result(s.query); err != nil {
		return nil, err
	}
	return driver.RowsAffected(1), nil
}

func (s *fakeStmt) QueryContext(context.Context, []driver.NamedValue) (driver.Rows, error) {
	if err := result(s.query); err != nil {
		return nil, err
	}
	return &fakeRows{}, nil
}

type fakeTx struct{}

func (fakeTx) Commit() error { return nil }

func (fakeTx) Rollback() error { return nil }

// fakeRows yields one row with one column, id = 1.
type fakeRows struct{ done bool }

func (*fakeRows) Columns() []string { return []string{"id"} }

func (*fakeRows) Close() error { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = int64(1)
	return nil
}

// countingConn is a fakeConn that counts its closes. Like fakeConn, it
// implements neither driver.SessionResetter nor driver.Validator.
type countingConn struct {
	fakeConn
	closes *atomic.Int64
}

func (c *countingConn) Close() error {
	c.closes.Add(1)
	return nil
}

// countingConnector opens countingConn connections that share one count.
type countingConnector struct{ closes *atomic.Int64 }

func (c countingConnector) Connect(context.Context) (driver.Conn, error) {
	return &countingConn{closes: c.closes}, nil
}

func (countingConnector) Driver() driver.Driver { return fakeDriver{} }

// sessionConn is a fakeConn that implements driver.Pinger,
// driver.SessionResetter, and driver.Validator, and counts each call.
type sessionConn struct {
	fakeConn
	pings, resets, validations *atomic.Int64
}

func (c *sessionConn) Ping(context.Context) error {
	c.pings.Add(1)
	return nil
}

func (c *sessionConn) ResetSession(context.Context) error {
	c.resets.Add(1)
	return nil
}

func (c *sessionConn) IsValid() bool {
	c.validations.Add(1)
	return true
}

// sessionConnector opens sessionConn connections that share their counts.
type sessionConnector struct{ pings, resets, validations *atomic.Int64 }

func (c sessionConnector) Connect(context.Context) (driver.Conn, error) {
	return &sessionConn{pings: c.pings, resets: c.resets, validations: c.validations}, nil
}

func (sessionConnector) Driver() driver.Driver { return fakeDriver{} }

// point is an argument type database/sql's default conversion rejects, so
// a statement carrying one succeeds only through a driver.NamedValueChecker.
type point struct{ x, y int }

// checkPoint accepts a point, recording who accepted it, and passes every
// other value on with driver.ErrSkip.
func checkPoint(who string, seen *[]string, nv *driver.NamedValue) error {
	p, ok := nv.Value.(point)
	if !ok {
		return driver.ErrSkip
	}
	*seen = append(*seen, who)
	nv.Value = fmt.Sprintf("%d,%d", p.x, p.y)
	return nil
}

// checkerConnector opens checkerConn connections. Its connections check
// point arguments when connChecks is set, and its prepared statements do
// when stmtChecks is set. seen records which checker accepted each point.
type checkerConnector struct {
	connChecks, stmtChecks bool
	seen                   *[]string
}

func (c checkerConnector) Connect(context.Context) (driver.Conn, error) {
	if c.connChecks {
		return &checkerConn{stmtChecks: c.stmtChecks, seen: c.seen}, nil
	}
	return &plainPrepareConn{stmtChecks: c.stmtChecks, seen: c.seen}, nil
}

func (checkerConnector) Driver() driver.Driver { return fakeDriver{} }

// plainPrepareConn is a fakeConn whose prepared statements check point
// arguments when stmtChecks is set.
type plainPrepareConn struct {
	fakeConn
	stmtChecks bool
	seen       *[]string
}

func (c *plainPrepareConn) PrepareContext(_ context.Context, query string) (driver.Stmt, error) {
	if c.stmtChecks {
		return &checkerStmt{fakeStmt: fakeStmt{query: query}, seen: c.seen}, nil
	}
	return &fakeStmt{query: query}, nil
}

// checkerConn is a plainPrepareConn that checks point arguments itself.
type checkerConn plainPrepareConn

func (c *checkerConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	return (*plainPrepareConn)(c).PrepareContext(ctx, query)
}

func (c *checkerConn) CheckNamedValue(nv *driver.NamedValue) error {
	return checkPoint("conn", c.seen, nv)
}

// checkerStmt is a fakeStmt that checks point arguments.
type checkerStmt struct {
	fakeStmt
	seen *[]string
}

func (s *checkerStmt) CheckNamedValue(nv *driver.NamedValue) error {
	return checkPoint("stmt", s.seen, nv)
}

// legacyStmtConnector opens legacyStmtConn connections.
type legacyStmtConnector struct{}

func (legacyStmtConnector) Connect(context.Context) (driver.Conn, error) {
	return &legacyStmtConn{}, nil
}

func (legacyStmtConnector) Driver() driver.Driver { return fakeDriver{} }

// legacyStmtConn is a legacyConn whose statements implement only
// driver.Stmt.
type legacyStmtConn struct{ legacyConn }

func (*legacyStmtConn) Prepare(string) (driver.Stmt, error) { return legacyStmt{}, nil }

// legacyStmt implements only driver.Stmt, whose methods database/sql never
// reaches through the wrapper.
type legacyStmt struct{}

func (legacyStmt) Close() error { return nil }

func (legacyStmt) NumInput() int { return -1 }

func (legacyStmt) Exec([]driver.Value) (driver.Result, error) { return driver.RowsAffected(1), nil }

func (legacyStmt) Query([]driver.Value) (driver.Rows, error) { return &fakeRows{}, nil }

// closingConnector is a fakeConnector that is also an io.Closer.
type closingConnector struct {
	fakeConnector
	closes *atomic.Int64
}

func (c closingConnector) Close() error {
	c.closes.Add(1)
	return nil
}
