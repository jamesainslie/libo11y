package o11ysql

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11ysql/internal/sqltext"
)

// scopeName identifies the telemetry this package emits.
const scopeName = "github.com/jamesainslie/libo11y/go/o11ysql"

// durationBuckets are the boundaries the semantic conventions advise for
// db.client.operation.duration, in seconds.
var durationBuckets = []float64{0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10}

// maxQueryText bounds db.query.text in bytes. The SDK sets no attribute
// length limit by default, and the text of a bulk INSERT or a migration
// can run to megabytes, enough to break an OTLP export batch.
const maxQueryText = 4096

// instrumenter turns driver calls into spans and duration measurements.
type instrumenter struct {
	cfg       config // the configuration it was built from, for [RegisterPoolMetrics]
	tracer    trace.Tracer
	duration  metric.Float64Histogram
	system    attribute.KeyValue
	dialect   sqltext.Dialect
	queryText bool // record db.query.text: enabled, and the dialect is known
}

func newInstrumenter(cfg *config) *instrumenter {
	tp, mp := providers(cfg)
	duration, err := mp.Meter(scopeName).Float64Histogram("db.client.operation.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Duration of database client operations."),
		metric.WithExplicitBucketBoundaries(durationBuckets...),
	)
	if err != nil {
		// Only an invalid instrument definition fails, and this one is
		// fixed: report it and measure nothing rather than fail the driver.
		otel.Handle(fmt.Errorf("o11ysql: creating db.client.operation.duration: %w", err))
		duration = noop.Float64Histogram{}
	}
	dialect, known := dialectFor(cfg.system)
	return &instrumenter{
		cfg:       *cfg,
		tracer:    tp.Tracer(scopeName),
		duration:  duration,
		system:    semconv.DBSystemNameKey.String(cfg.system),
		dialect:   dialect,
		queryText: cfg.queryText && known,
	}
}

// dialectFor returns the lexer for the db.system.name value system, and
// whether that lexer is known to find every literal the database reads. An
// unknown system gets DialectStandard and false: its text is still
// summarized into db.operation.name and db.collection.name, but never
// recorded as db.query.text, because a lexer that misreads a string could
// keep part of a value. SQL Server, Oracle, and engines with other quoting
// or escaping rules are among the systems no dialect here is known to be
// correct for.
func dialectFor(system string) (sqltext.Dialect, bool) {
	switch system {
	case "postgresql":
		return sqltext.DialectStandard, true
	case "sqlite":
		return sqltext.DialectSQLite, true
	case "mysql", "mariadb":
		return sqltext.DialectMySQL, true
	default:
		return sqltext.DialectStandard, false
	}
}

// statement is what the telemetry records about one SQL statement.
type statement struct {
	name  string               // the span name
	text  string               // the sanitized db.query.text, empty when omitted
	attrs []attribute.KeyValue // db.system.name, db.operation.name, db.collection.name
}

// describe sanitizes and summarizes query. Bytes that are not UTF-8,
// which the lexer keeps as part of a name, become U+FFFD first: OTLP sends
// attribute values as protobuf strings, which must be valid UTF-8, and one
// invalid value fails the whole export batch. When Sanitize reports a
// lexical ambiguity that depends on server settings or version, db.query.text
// is omitted so no literal or comment can leak.
func (in *instrumenter) describe(query string) statement {
	raw, safe := sqltext.Sanitize(query, in.dialect)
	sanitized := strings.ToValidUTF8(raw, "\uFFFD")
	st := in.named(sqltext.Summarize(sanitized, in.dialect))
	if in.queryText && safe {
		st.text = truncate(sanitized, maxQueryText)
	}
	return st
}

// truncate returns the longest prefix of s that has at most n bytes and
// ends on a UTF-8 rune boundary. Cutting sanitized text cannot expose a
// literal, because every literal is already gone.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// named describes an operation from its parts, such as COMMIT, which has
// no statement text of its own.
func (in *instrumenter) named(operation, collection string) statement {
	attrs := []attribute.KeyValue{in.system}
	name := in.system.Value.AsString()
	if operation != "" {
		attrs = append(attrs, semconv.DBOperationName(operation))
		name = operation
	}
	if collection != "" {
		attrs = append(attrs, semconv.DBCollectionName(collection))
		if operation != "" {
			name = operation + " " + collection
		} else {
			name = collection
		}
	}
	return statement{name: name, attrs: attrs}
}

// operation is one driver call in flight.
type operation struct {
	in    *instrumenter
	st    statement
	start time.Time
}

func (in *instrumenter) begin(st statement) operation {
	return operation{in: in, st: st, start: time.Now()}
}

// finish records the call's telemetry once the driver has returned. The
// span is created here, backdated to the start, so a driver that answers
// driver.ErrSkip (database/sql then retries through a prepared statement,
// which records its own) leaves no telemetry at all.
func (op operation) finish(ctx context.Context, err error) {
	if errors.Is(err, driver.ErrSkip) {
		return
	}
	end := time.Now()
	attrs := op.st.attrs
	if err != nil {
		attrs = append(slices.Clone(attrs), semconv.ErrorType(err))
	}
	if trace.SpanContextFromContext(ctx).IsValid() {
		spanAttrs := attrs
		if op.st.text != "" {
			spanAttrs = append(slices.Clone(attrs), semconv.DBQueryText(op.st.text))
		}
		var span trace.Span
		ctx, span = op.in.tracer.Start(ctx, op.st.name,
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithTimestamp(op.start),
			trace.WithAttributes(spanAttrs...),
		)
		if err != nil {
			span.SetStatus(codes.Error, "") // no message: it may quote statement values
		}
		span.End(trace.WithTimestamp(end))
	}
	op.in.duration.Record(ctx, end.Sub(op.start).Seconds(), metric.WithAttributes(attrs...))
}
