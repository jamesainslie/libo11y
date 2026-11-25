// Package o11ysql instruments database/sql with OpenTelemetry spans and
// metrics that follow the database semantic conventions. It wraps a
// driver.Connector, so it works with any database/sql driver, and records:
//
//   - a client span for each statement and for each transaction begin,
//     commit, and rollback, named "{db.operation.name} {db.collection.name}"
//     (the one that is known, or db.system.name when neither is) and
//     carrying db.system.name, db.operation.name, db.collection.name when
//     the statement names exactly one table, and db.query.text with every
//     literal replaced by ?, every comment removed, and cut to at most 4096
//     bytes on a UTF-8 character boundary (turn it off with
//     [WithoutQueryText]). Bytes that are not UTF-8 are replaced by U+FFFD
//     in the span name and in every attribute taken from the statement. A
//     span is created only when the context already holds a span, so pool
//     maintenance and other background statements never create root
//     spans. Pings never create spans;
//   - db.client.operation.duration, a histogram in seconds, for every
//     statement whether or not it was traced, with an exemplar pointing at
//     the statement's span when there is one. The duration covers the
//     driver call, not the iteration of returned rows;
//   - db.client.connection.count by state (idle, used) and
//     db.client.connection.max, read from sql.DB.Stats and named by
//     db.client.connection.pool.name (see [WithPoolName]). [Open] registers
//     them until the database is closed; with [Wrap], register them with
//     [RegisterPoolMetrics].
//
// The client span is started after the driver call returns and backdated
// to when the call began, so the driver receives the caller's context:
// any spans the driver makes, and any context it propagates to the
// database, hang off the caller's span, not the database span.
//
// An error sets the span status to Error and adds error.type to the span
// and the metric. The error message is not recorded, because database
// errors often quote the values a statement carried.
//
// Removing every literal needs the lexical rules of the database that runs
// the statement, which [WithSystem] names. db.query.text is recorded for
// postgresql, sqlite, mysql and mariadb. For any other system, including
// the default other_sql, no rules are known to be correct, so the span
// carries db.operation.name and db.collection.name but no db.query.text.
// [Open] infers the system from well-known driver names, so a database
// opened with the postgres or pgx driver records db.query.text, while one
// opened with the sqlserver driver does not.
//
// It lives in its own Go module, so applications that do not use it never
// download it:
//
//	go get github.com/jamesainslie/libo11y/go/o11ysql
//
//	db, err := o11ysql.Open("sqlite", "file:app.db")
//
// To instrument a driver.Connector instead, wrap it and register the pool
// metrics for the *sql.DB it opens. [RegisterPoolMetrics] starts from the
// options given to Wrap, so they need not be repeated:
//
//	db := sql.OpenDB(o11ysql.Wrap(connector, o11ysql.WithSystem("postgresql")))
//	reg, err := o11ysql.RegisterPoolMetrics(db)
//	if err != nil {
//		return err
//	}
//	// Unregister when db is closed.
//
// The wrapper needs the context interfaces database/sql has preferred
// since Go 1.8: a connection that begins transactions must implement
// driver.ConnBeginTx, and a prepared statement must implement
// driver.StmtExecContext and driver.StmtQueryContext. Without them the
// call fails with [ErrLegacyDriver]. Every maintained driver implements
// them. A statement's deprecated driver.ColumnConverter is not consulted:
// arguments go through the driver's driver.NamedValueChecker, if it has
// one, and then database/sql's default conversion. A connection without
// driver.ExecerContext or driver.QueryerContext runs every statement
// through a prepared statement, even when it implements the deprecated
// driver.Execer or driver.Queryer.
//
// sql.Conn.Raw passes its function the o11ysql connection, not the
// driver's own, so driver-specific methods such as pgx's CopyFrom or a
// SQLite backup are not reachable through a wrapped database.
package o11ysql

import (
	"database/sql/driver"
	"errors"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	o11y "github.com/jamesainslie/libo11y/go"
)

// ErrLegacyDriver reports a driver that lacks a context interface the
// wrapper needs: driver.ConnBeginTx, driver.StmtExecContext, or
// driver.StmtQueryContext.
var ErrLegacyDriver = errors.New("o11ysql: driver lacks the Go 1.8 context interfaces")

// otherSQL is the db.system.name value for a database the wrapper cannot
// name.
const otherSQL = "other_sql"

// Option configures [Wrap], [Open], and [RegisterPoolMetrics]. An option
// that does not apply to a call, such as [WithoutQueryText] given to
// RegisterPoolMetrics, is ignored by that call.
type Option func(*config)

type config struct {
	sdk       *o11y.SDK
	system    string
	poolName  string
	queryText bool
}

// WithSDK binds the instrumentation to sdk's tracer and meter providers
// instead of the process globals. Use it with SDKs built by o11y.New;
// after o11y.Setup the globals already point at the SDK.
// A nil sdk is the same as not giving the option: the process globals
// are used.
func WithSDK(sdk *o11y.SDK) Option {
	return func(c *config) { c.sdk = sdk }
}

// WithSystem sets db.system.name to name, which should be the semantic
// conventions' value for the database, such as postgresql, sqlite, mysql,
// mariadb, or microsoft.sql_server. The default is other_sql, or for [Open]
// the system its driver name implies. The system also picks the lexical
// rules that remove literals from the query text: db.query.text is
// recorded for postgresql, sqlite, mysql and mariadb, and left off spans
// for every other system.
func WithSystem(name string) Option {
	return func(c *config) { c.system = name }
}

// WithPoolName sets db.client.connection.pool.name on the pool metrics. The
// default is the db.system.name value; give each pool a distinct name when
// an application opens several.
func WithPoolName(name string) Option {
	return func(c *config) { c.poolName = name }
}

// WithoutQueryText leaves db.query.text off spans. The sanitized text is
// recorded by default for the systems [WithSystem] lists.
func WithoutQueryText() Option {
	return func(c *config) { c.queryText = false }
}

// newConfig applies opts over the defaults. system is the db.system.name
// inferred by the caller, or empty.
func newConfig(system string, opts []Option) *config {
	return config{system: system, queryText: true}.with(opts)
}

// with returns a copy of c with opts applied, defaulting an empty system to
// other_sql.
func (c config) with(opts []Option) *config {
	for _, opt := range opts {
		if opt != nil {
			opt(&c)
		}
	}
	if c.system == "" {
		c.system = otherSQL
	}
	return &c
}

// providers returns the tracer and meter providers cfg binds to.
func providers(cfg *config) (trace.TracerProvider, metric.MeterProvider) {
	if cfg.sdk != nil {
		return cfg.sdk.TracerProvider(), cfg.sdk.MeterProvider()
	}
	return otel.GetTracerProvider(), otel.GetMeterProvider()
}

// Wrap returns a connector that instruments every connection c opens.
// Open a database over it with sql.OpenDB. Pool metrics need the
// *sql.DB, so register them separately with [RegisterPoolMetrics], or use
// [Open], which does both. db.query.text is recorded for postgresql,
// sqlite, mysql and mariadb, so name the database with [WithSystem].
//
// c must not be nil: a nil connector is a programming error, and the
// first connection opened through the result panics. Wrap has no error
// to report it with.
func Wrap(c driver.Connector, opts ...Option) driver.Connector {
	return newConnector(c, newInstrumenter(newConfig("", opts)))
}
