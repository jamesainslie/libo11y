package o11ysql

import (
	"context"
	"database/sql/driver"
	"errors"
	"io"
)

// Errors from the wrapped driver are returned unchanged throughout this
// package: database/sql compares driver.ErrBadConn, driver.ErrSkip, and
// driver.ErrRemoveArgument by identity, so wrapping them would break it.

// wrappedDriver is the driver.Driver behind a wrapped connector, so
// sql.DB.Driver and connections opened by name are instrumented too.
type wrappedDriver struct {
	inner driver.Driver
	ins   *instrumenter
}

var (
	_ driver.Driver        = (*wrappedDriver)(nil)
	_ driver.DriverContext = (*wrappedDriver)(nil)
)

func (d *wrappedDriver) Open(name string) (driver.Conn, error) {
	c, err := d.inner.Open(name)
	if err != nil {
		return nil, err
	}
	return newConn(c, d.ins), nil
}

func (d *wrappedDriver) OpenConnector(name string) (driver.Connector, error) {
	return d.openConnector(name)
}

// openConnector is OpenConnector returning the concrete connector, so
// [Open] can attach the pool metrics registration to it.
func (d *wrappedDriver) openConnector(name string) (*connector, error) {
	if dc, ok := d.inner.(driver.DriverContext); ok {
		c, err := dc.OpenConnector(name)
		if err != nil {
			return nil, err
		}
		return &connector{inner: c, ins: d.ins, drv: d}, nil
	}
	return &connector{inner: dsnConnector{name: name, driver: d.inner}, ins: d.ins, drv: d}, nil
}

// connector instruments the connections its inner connector opens.
type connector struct {
	inner driver.Connector
	ins   *instrumenter
	drv   *wrappedDriver
	// unregister ends the pool metrics registration [Open] made for the
	// database over this connector; nil for [Wrap].
	unregister func() error
}

var (
	_ driver.Connector = (*connector)(nil)
	_ io.Closer        = (*connector)(nil)
)

func newConnector(inner driver.Connector, ins *instrumenter) *connector {
	return &connector{inner: inner, ins: ins, drv: &wrappedDriver{inner: inner.Driver(), ins: ins}}
}

func (c *connector) Connect(ctx context.Context) (driver.Conn, error) {
	cn, err := c.inner.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return newConn(cn, c.ins), nil
}

func (c *connector) Driver() driver.Driver { return c.drv }

// Close ends the pool metrics registration [Open] made, and closes the
// inner connector when it is an io.Closer, as sql.DB.Close does for an
// unwrapped one. sql.DB.Close calls it once.
func (c *connector) Close() error {
	var errs []error
	if c.unregister != nil {
		errs = append(errs, c.unregister())
	}
	if closer, ok := c.inner.(io.Closer); ok {
		errs = append(errs, closer.Close())
	}
	return errors.Join(errs...)
}

// dsnConnector opens connections by name, for drivers without
// driver.DriverContext.
type dsnConnector struct {
	name   string
	driver driver.Driver
}

func (c dsnConnector) Connect(context.Context) (driver.Conn, error) { return c.driver.Open(c.name) }

func (c dsnConnector) Driver() driver.Driver { return c.driver }
