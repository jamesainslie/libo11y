package o11ysql

import (
	"context"
	"database/sql/driver"
	"fmt"
)

// stmt instruments a prepared statement. The statement's telemetry
// description is computed once, when it is prepared.
type stmt struct {
	inner driver.Stmt
	conn  *conn
	st    statement
}

var (
	_ driver.Stmt              = (*stmt)(nil)
	_ driver.StmtExecContext   = (*stmt)(nil)
	_ driver.StmtQueryContext  = (*stmt)(nil)
	_ driver.NamedValueChecker = (*stmt)(nil)
)

func (s *stmt) Close() error { return s.inner.Close() }

func (s *stmt) NumInput() int { return s.inner.NumInput() }

// Exec implements driver.Stmt. database/sql calls ExecContext instead.
func (s *stmt) Exec(args []driver.Value) (driver.Result, error) {
	return s.ExecContext(context.Background(), namedValues(args))
}

// Query implements driver.Stmt. database/sql calls QueryContext instead.
func (s *stmt) Query(args []driver.Value) (driver.Rows, error) {
	return s.QueryContext(context.Background(), namedValues(args))
}

func (s *stmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	e, ok := s.inner.(driver.StmtExecContext)
	if !ok {
		return nil, fmt.Errorf("%w: the statement does not implement driver.StmtExecContext", ErrLegacyDriver)
	}
	op := s.conn.ins.begin(s.st)
	res, err := e.ExecContext(ctx, args)
	op.finish(ctx, err)
	return res, err
}

func (s *stmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	q, ok := s.inner.(driver.StmtQueryContext)
	if !ok {
		return nil, fmt.Errorf("%w: the statement does not implement driver.StmtQueryContext", ErrLegacyDriver)
	}
	op := s.conn.ins.begin(s.st)
	rows, err := q.QueryContext(ctx, args)
	op.finish(ctx, err)
	return rows, err
}

// CheckNamedValue prefers the statement's checker and then the
// connection's, the order database/sql uses for an unwrapped driver.
func (s *stmt) CheckNamedValue(nv *driver.NamedValue) error {
	if checker, ok := s.inner.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(nv)
	}
	return s.conn.CheckNamedValue(nv)
}

func namedValues(args []driver.Value) []driver.NamedValue {
	named := make([]driver.NamedValue, len(args))
	for i, v := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	return named
}
