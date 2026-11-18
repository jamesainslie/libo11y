package o11ysql

import (
	"database/sql"
	"fmt"
)

// driverSystems maps well-known database/sql driver names to the
// db.system.name value of the database they reach.
var driverSystems = map[string]string{
	"postgres": "postgresql", "pgx": "postgresql", "pgx/v5": "postgresql",
	"sqlite": "sqlite", "sqlite3": "sqlite",
	"mysql":     "mysql",
	"sqlserver": "microsoft.sql_server", "mssql": "microsoft.sql_server",
}

// systemForDriver infers db.system.name from a registered driver name.
func systemForDriver(driverName string) string {
	if system, ok := driverSystems[driverName]; ok {
		return system
	}
	return otherSQL
}

// Open is sql.Open with instrumentation: it opens the database registered
// as driverName at dsn through a wrapped connector (see [Wrap]) and
// registers its pool metrics (see [RegisterPoolMetrics]). db.system.name is
// inferred from well-known driver names: postgres, pgx and pgx/v5 give
// postgresql, sqlite and sqlite3 give sqlite, mysql gives mysql, and
// sqlserver and mssql give microsoft.sql_server. Any other name gives
// other_sql. [WithSystem] overrides the inference. As with [Wrap],
// db.query.text is recorded only for postgresql, sqlite, mysql and
// mariadb, so a SQL Server database gets spans without it. The pool
// metrics stay registered until the returned database is closed.
func Open(driverName, dsn string, opts ...Option) (*sql.DB, error) {
	// sql.Open is the only way to reach a registered driver by name. It
	// opens no connection; the probe is closed straight away. database/sql
	// answers Driver from the connector, which for a driver.DriverContext
	// means the DSN is parsed twice: once for the probe, once below.
	probe, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("o11ysql: %w", err)
	}
	inner := probe.Driver()
	if err := probe.Close(); err != nil {
		return nil, fmt.Errorf("o11ysql: %w", err)
	}

	cfg := newConfig(systemForDriver(driverName), opts)
	drv := &wrappedDriver{inner: inner, ins: newInstrumenter(cfg)}
	c, err := drv.openConnector(dsn)
	if err != nil {
		return nil, fmt.Errorf("o11ysql: %w", err)
	}
	db := sql.OpenDB(c)
	reg, err := registerPoolMetrics(db, cfg)
	if err != nil {
		_ = db.Close() // the registration error is what the caller needs
		return nil, err
	}
	// db is not yet shared, so nothing can be closing c concurrently.
	c.unregister = reg.Unregister
	return db, nil
}
