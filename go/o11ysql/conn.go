package o11ysql

import (
	"context"
	"database/sql/driver"
	"fmt"
)

// conn instruments one driver connection. It implements the optional
// interfaces database/sql looks for and delegates each to the inner
// connection, falling back to what database/sql itself would do when the
// inner connection lacks it. driver.SessionResetter and driver.Validator
// are the exception: database/sql reads their presence, not only their
// answers, so [newConn] adds them only when the inner connection has them.
type conn struct {
	inner driver.Conn
	ins   *instrumenter
}

var (
	_ driver.Conn               = (*conn)(nil)
	_ driver.ConnBeginTx        = (*conn)(nil)
	_ driver.ConnPrepareContext = (*conn)(nil)
	_ driver.ExecerContext      = (*conn)(nil)
	_ driver.QueryerContext     = (*conn)(nil)
	_ driver.Pinger             = (*conn)(nil)
	_ driver.NamedValueChecker  = (*conn)(nil)
)

// newConn wraps inner, implementing driver.SessionResetter and
// driver.Validator exactly when inner does. database/sql keeps a
// connection after a transaction's context ends only when it implements
// both, and closes it otherwise because it may be mid-protocol, so always
// implementing them would return such connections to the pool.
func newConn(inner driver.Conn, ins *instrumenter) driver.Conn {
	c := &conn{inner: inner, ins: ins}
	resetter, hasResetter := inner.(driver.SessionResetter)
	validator, hasValidator := inner.(driver.Validator)
	switch {
	case hasResetter && hasValidator:
		return &resetValidConn{conn: c, resetter: resetter, validator: validator}
	case hasResetter:
		return &resetConn{conn: c, resetter: resetter}
	case hasValidator:
		return &validConn{conn: c, validator: validator}
	default:
		return c
	}
}

// resetConn is a conn whose inner connection resets its session.
type resetConn struct {
	*conn
	resetter driver.SessionResetter
}

func (c *resetConn) ResetSession(ctx context.Context) error { return c.resetter.ResetSession(ctx) }

// validConn is a conn whose inner connection reports its validity.
type validConn struct {
	*conn
	validator driver.Validator
}

func (c *validConn) IsValid() bool { return c.validator.IsValid() }

// resetValidConn is a conn whose inner connection does both.
type resetValidConn struct {
	*conn
	resetter  driver.SessionResetter
	validator driver.Validator
}

func (c *resetValidConn) ResetSession(ctx context.Context) error {
	return c.resetter.ResetSession(ctx)
}

func (c *resetValidConn) IsValid() bool { return c.validator.IsValid() }

var (
	_ driver.SessionResetter = (*resetConn)(nil)
	_ driver.Validator       = (*validConn)(nil)
	_ driver.SessionResetter = (*resetValidConn)(nil)
	_ driver.Validator       = (*resetValidConn)(nil)
)

func (c *conn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *conn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	var s driver.Stmt
	var err error
	if p, ok := c.inner.(driver.ConnPrepareContext); ok {
		s, err = p.PrepareContext(ctx, query)
	} else {
		s, err = c.inner.Prepare(query)
		if err == nil && ctx.Err() != nil {
			// database/sql's own fallback: honour a context that ended while
			// a driver without PrepareContext was preparing.
			_ = s.Close() // the context error is what the caller needs
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, err
	}
	return &stmt{inner: s, conn: c, st: c.ins.describe(query)}, nil
}

func (c *conn) Close() error { return c.inner.Close() }

// Begin implements driver.Conn. database/sql calls BeginTx instead.
func (c *conn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *conn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	b, ok := c.inner.(driver.ConnBeginTx)
	if !ok {
		return nil, fmt.Errorf("%w: the connection does not implement driver.ConnBeginTx", ErrLegacyDriver)
	}
	op := c.ins.begin(c.ins.named("BEGIN", ""))
	tx, err := b.BeginTx(ctx, opts)
	op.finish(ctx, err)
	if err != nil {
		return nil, err
	}
	return &wrappedTx{inner: tx, ins: c.ins, ctx: ctx}, nil
}

func (c *conn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	e, ok := c.inner.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip // database/sql prepares the statement instead
	}
	op := c.ins.begin(c.ins.describe(query))
	res, err := e.ExecContext(ctx, query, args)
	op.finish(ctx, err)
	return res, err
}

func (c *conn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	q, ok := c.inner.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip // database/sql prepares the statement instead
	}
	op := c.ins.begin(c.ins.describe(query))
	rows, err := q.QueryContext(ctx, query, args)
	op.finish(ctx, err)
	return rows, err
}

func (c *conn) Ping(ctx context.Context) error {
	if p, ok := c.inner.(driver.Pinger); ok {
		return p.Ping(ctx)
	}
	return nil
}

func (c *conn) CheckNamedValue(nv *driver.NamedValue) error {
	if checker, ok := c.inner.(driver.NamedValueChecker); ok {
		return checker.CheckNamedValue(nv)
	}
	return driver.ErrSkip // database/sql applies its default conversion
}

// wrappedTx instruments commit and rollback. It keeps the context BeginTx
// received because driver.Tx methods take none, and the begin context is
// the one database/sql ties the transaction to.
type wrappedTx struct {
	inner driver.Tx
	ins   *instrumenter
	ctx   context.Context
}

func (t *wrappedTx) Commit() error {
	op := t.ins.begin(t.ins.named("COMMIT", ""))
	err := t.inner.Commit()
	op.finish(t.ctx, err)
	return err
}

func (t *wrappedTx) Rollback() error {
	op := t.ins.begin(t.ins.named("ROLLBACK", ""))
	err := t.inner.Rollback()
	op.finish(t.ctx, err)
	return err
}
