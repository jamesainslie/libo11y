package o11ysql_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/jamesainslie/libo11y/go/o11ysql"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// openFake opens a database over connector, instrumented against rec as
// sqlite.
func openFake(t *testing.T, rec *o11ytest.Recorder, connector driver.Connector, opts ...o11ysql.Option) *sql.DB {
	t.Helper()
	all := append([]o11ysql.Option{o11ysql.WithSDK(rec.SDK), o11ysql.WithSystem("sqlite")}, opts...)
	db := sql.OpenDB(o11ysql.Wrap(connector, all...))
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return db
}

// inSpan returns a context holding a fresh "handler" span.
func inSpan(rec *o11ytest.Recorder) (context.Context, trace.Span) {
	return rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "handler")
}

func spanNamed(t *testing.T, spans []sdktrace.ReadOnlySpan, name string) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, s := range spans {
		if s.Name() == name {
			return s
		}
	}
	t.Fatalf("no span named %q among %v", name, spanNames(spans))
	return nil
}

func spanNames(spans []sdktrace.ReadOnlySpan) []string {
	names := make([]string, len(spans))
	for i, s := range spans {
		names[i] = s.Name()
	}
	return names
}

// durationPoints returns the db.client.operation.duration data points.
func durationPoints(t *testing.T, rec *o11ytest.Recorder) []metricdata.HistogramDataPoint[float64] {
	t.Helper()
	var out []metricdata.HistogramDataPoint[float64]
	for _, sm := range rec.Metrics().ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "db.client.operation.duration" {
				continue
			}
			h, ok := m.Data.(metricdata.Histogram[float64])
			if !ok {
				t.Fatalf("db.client.operation.duration is %T, want a float64 histogram", m.Data)
			}
			out = append(out, h.DataPoints...)
		}
	}
	return out
}

func attrString(set attribute.Set, key attribute.Key) string {
	v, _ := set.Value(key) // a missing key reads as the empty string
	return v.AsString()
}

func TestQueryInsideASpanRecordsAClientSpan(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	rows, err := db.QueryContext(ctx, "SELECT id FROM users WHERE email = 'a@example.com' AND age > 30")
	if err != nil {
		t.Fatalf("QueryContext: %v", err)
	}
	var id int64
	for rows.Next() {
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("Scan: %v", err)
		}
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("rows.Close: %v", err)
	}
	parent.End()

	span := spanNamed(t, rec.Spans(), "SELECT users")
	if span.SpanKind() != trace.SpanKindClient {
		t.Errorf("span kind = %v, want client", span.SpanKind())
	}
	if span.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Error("query span is not a child of the handler span")
	}
	attrs := attribute.NewSet(span.Attributes()...)
	for key, want := range map[attribute.Key]string{
		"db.system.name":     "sqlite",
		"db.operation.name":  "SELECT",
		"db.collection.name": "users",
		"db.query.text":      "SELECT id FROM users WHERE email = ? AND age > ?",
	} {
		if got := attrString(attrs, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}

	points := durationPoints(t, rec)
	if len(points) != 1 || points[0].Count != 1 {
		t.Fatalf("duration points = %+v, want one point with count 1", points)
	}
	if got := attrString(points[0].Attributes, "db.collection.name"); got != "users" {
		t.Errorf("metric db.collection.name = %q, want users", got)
	}
	if _, ok := points[0].Attributes.Value("db.query.text"); ok {
		t.Error("db.query.text is a metric attribute, want it on spans only")
	}
	rec.AssertConforms(t)
}

func TestNoParentMeansNoSpanButAMetric(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	if _, err := db.ExecContext(context.Background(), "UPDATE users SET n = 1"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	if spans := rec.Spans(); len(spans) != 0 {
		t.Errorf("spans %v without a parent, want none", spanNames(spans))
	}
	if points := durationPoints(t, rec); len(points) != 1 {
		t.Errorf("got %d duration points, want 1", len(points))
	}
}

func TestPingNeverCreatesASpan(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("PingContext: %v", err)
	}
	parent.End()
	if got := spanNames(rec.Spans()); !slices.Equal(got, []string{"handler"}) {
		t.Errorf("spans = %v, want only the handler span", got)
	}
}

func TestWithoutQueryText(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{}, o11ysql.WithoutQueryText())
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "DELETE FROM sessions WHERE id = 7"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "DELETE sessions").Attributes()...)
	if _, ok := attrs.Value("db.query.text"); ok {
		t.Error("span carries db.query.text under WithoutQueryText")
	}
}

// TestQueryTextIsBounded pins that db.query.text stops at 4096 bytes, on
// a UTF-8 rune boundary, so a bulk statement cannot mint a huge attribute.
func TestQueryTextIsBounded(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	// The 2-byte é spans bytes 4095 and 4096, so a byte cut would split it.
	head := "SELECT " + strings.Repeat("a", 4088)
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, head+"é FROM t WHERE x IN ("+strings.Repeat("1, ", 2000)+"2)"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "SELECT t").Attributes()...)
	got := attrString(attrs, "db.query.text")
	if got != head {
		t.Errorf("db.query.text has %d bytes (valid UTF-8 %v), want the %d-byte prefix before the split rune",
			len(got), utf8.ValidString(got), len(head))
	}

	// All ASCII, the text is cut at exactly 4096 bytes.
	ctx, parent = inSpan(rec)
	if _, err := db.ExecContext(ctx, "UPDATE u SET a = b WHERE c IN ("+strings.Repeat("d, ", 2000)+"e)"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	attrs = attribute.NewSet(spanNamed(t, rec.Spans(), "UPDATE u").Attributes()...)
	if got := attrString(attrs, "db.query.text"); len(got) != 4096 {
		t.Errorf("db.query.text has %d bytes, want 4096", len(got))
	}
}

func TestErrorsSetStatusWithoutTheMessage(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "INSERT INTO audit (note) VALUES ('fail')"); !errors.Is(err, errFake) {
		t.Fatalf("ExecContext error = %v, want errFake", err)
	}
	parent.End()

	span := spanNamed(t, rec.Spans(), "INSERT audit")
	if span.Status().Code != codes.Error {
		t.Errorf("status = %v, want Error", span.Status())
	}
	if span.Status().Description != "" {
		t.Errorf("status description = %q, want empty: error messages may quote statement values", span.Status().Description)
	}
	if events := span.Events(); len(events) != 0 {
		t.Errorf("span events = %v, want none: error messages may quote statement values", events)
	}
	if attrString(attribute.NewSet(span.Attributes()...), "error.type") == "" {
		t.Error("span lacks error.type")
	}
	points := durationPoints(t, rec)
	if len(points) != 1 {
		t.Fatalf("got %d duration points, want 1", len(points))
	}
	if attrString(points[0].Attributes, "error.type") == "" {
		t.Error("duration point lacks error.type")
	}
}

func TestErrSkipFallsBackWithOneSpan(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "DELETE FROM jobs WHERE note = 'skip'"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	if got := spanNames(rec.Spans()); !slices.Equal(got, []string{"DELETE jobs", "handler"}) {
		t.Errorf("spans = %v, want one statement span and the handler", got)
	}
	var count uint64
	for _, p := range durationPoints(t, rec) {
		count += p.Count
	}
	if count != 1 {
		t.Errorf("duration count = %d, want 1", count)
	}
}

func TestTransactionSpans(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO orders (id) VALUES (1)"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	parent.End()

	spans := rec.Spans()
	if got := spanNames(spans); !slices.Equal(got, []string{"BEGIN", "INSERT orders", "COMMIT", "handler"}) {
		t.Fatalf("spans = %v", got)
	}
	for _, s := range spans[:3] {
		if s.Parent().SpanID() != parent.SpanContext().SpanID() {
			t.Errorf("%s is not a child of the handler span", s.Name())
		}
	}
}

func TestLegacyDriver(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{legacy: true})
	ctx, parent := inSpan(rec)
	// No ExecerContext: the wrapper answers ErrSkip and database/sql prepares.
	if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	if _, err := db.BeginTx(ctx, nil); !errors.Is(err, o11ysql.ErrLegacyDriver) {
		t.Errorf("BeginTx error = %v, want ErrLegacyDriver", err)
	}
	parent.End()
	spanNamed(t, rec.Spans(), "UPDATE users")
}

// TestCorrelationTriangle pins that a statement's span, a log written in
// the same request, and the exemplar on the statement's duration share one
// trace, and that the exemplar points at the statement span.
func TestCorrelationTriangle(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "UPDATE carts SET n = 2"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	rec.SDK.Logger().InfoContext(ctx, "cart updated")
	parent.End()

	statement := spanNamed(t, rec.Spans(), "UPDATE carts").SpanContext()
	logs := rec.Logs()
	if len(logs) != 1 || logs[0].SpanContext.TraceID() != statement.TraceID() {
		t.Errorf("log trace does not match the statement's trace %v", statement.TraceID())
	}
	exemplars := rec.Exemplars("db.client.operation.duration")
	if len(exemplars) != 1 {
		t.Fatalf("got %d exemplars, want 1", len(exemplars))
	}
	if exemplars[0].TraceID != statement.TraceID() || exemplars[0].SpanID != statement.SpanID() {
		t.Errorf("exemplar %v/%v, want the statement span %v/%v",
			exemplars[0].TraceID, exemplars[0].SpanID, statement.TraceID(), statement.SpanID())
	}
}

// TestQueryTextFollowsTheSystemDialect pins which lexer each db.system.name
// gets, and that a system with no lexer known to be correct for it records
// no db.query.text but keeps its span name. The query lexes differently
// under each dialect without any server-mode ambiguity: PostgreSQL keeps
// "name" as an identifier and # as an operator, SQLite removes "name" like
// a string and keeps # as an operator, and MySQL removes "name" as a string
// and removes # to end of line as a comment.
func TestQueryTextFollowsTheSystemDialect(t *testing.T) {
	const query = `SELECT id FROM users WHERE "name" = 'x' # tail`
	for _, tc := range []struct {
		system string
		want   string // the db.query.text, empty when it must be absent
	}{
		{system: "postgresql", want: `SELECT id FROM users WHERE "name" = ? # tail`},
		{system: "sqlite", want: `SELECT id FROM users WHERE ? = ? # tail`},
		{system: "mysql", want: `SELECT id FROM users WHERE ? = ?  `},
		{system: "mariadb", want: `SELECT id FROM users WHERE ? = ?  `},
		{system: ""},
		{system: "other_sql"},
		{system: "microsoft.sql_server"},
		{system: "oracle.db"},
	} {
		name := tc.system
		if name == "" {
			name = "default"
		}
		t.Run(name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			opts := []o11ysql.Option{o11ysql.WithSDK(rec.SDK)}
			if tc.system != "" {
				opts = append(opts, o11ysql.WithSystem(tc.system))
			}
			db := sql.OpenDB(o11ysql.Wrap(fakeConnector{}, opts...))
			t.Cleanup(func() {
				if err := db.Close(); err != nil {
					t.Errorf("Close: %v", err)
				}
			})
			ctx, parent := inSpan(rec)
			rows, err := db.QueryContext(ctx, query)
			if err != nil {
				t.Fatalf("QueryContext: %v", err)
			}
			if err := rows.Close(); err != nil {
				t.Fatalf("rows.Close: %v", err)
			}
			parent.End()

			attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "SELECT users").Attributes()...)
			wantSystem := tc.system
			if wantSystem == "" {
				wantSystem = "other_sql"
			}
			if got := attrString(attrs, "db.system.name"); got != wantSystem {
				t.Errorf("db.system.name = %q, want %q", got, wantSystem)
			}
			got, ok := attrs.Value("db.query.text")
			switch {
			case tc.want == "" && ok:
				t.Errorf("db.query.text = %q, want none: no lexer is known to be correct for %s", got.AsString(), wantSystem)
			case tc.want != "" && got.AsString() != tc.want:
				t.Errorf("db.query.text = %q, want %q", got.AsString(), tc.want)
			}
		})
	}
}

// TestOtherSQLStillNamesTheSpan pins that a system without a known lexer
// keeps the operation and collection on the span and the metric.
func TestOtherSQLStillNamesTheSpan(t *testing.T) {
	rec := o11ytest.Start(t)
	db := sql.OpenDB(o11ysql.Wrap(fakeConnector{}, o11ysql.WithSDK(rec.SDK)))
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1 WHERE id = 7"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "UPDATE users").Attributes()...)
	if got := attrString(attrs, "db.operation.name"); got != "UPDATE" {
		t.Errorf("db.operation.name = %q, want UPDATE", got)
	}
	if got := attrString(attrs, "db.collection.name"); got != "users" {
		t.Errorf("db.collection.name = %q, want users", got)
	}
	points := durationPoints(t, rec)
	if len(points) != 1 || attrString(points[0].Attributes, "db.collection.name") != "users" {
		t.Errorf("duration points = %+v, want one point for users", points)
	}
}

// TestCancelledTransactionClosesAConnectionWithoutSessionHooks pins that
// the wrapper leaves database/sql's choice intact: after a transaction's
// context ends, it keeps the connection only when the driver connection
// implements both driver.SessionResetter and driver.Validator, and
// otherwise closes it, because the connection may be mid-protocol.
func TestCancelledTransactionClosesAConnectionWithoutSessionHooks(t *testing.T) {
	rec := o11ytest.Start(t)
	closed := make(chan struct{}, 1)
	db := openFake(t, rec, signalConnector{closed: closed})
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := db.BeginTx(ctx, nil); err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	cancel()
	// database/sql rolls back on its own goroutine once ctx ends.
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the connection was kept after its transaction was cancelled, want it closed")
	}
}

func TestSessionHooksAndPingAreDelegated(t *testing.T) {
	rec := o11ytest.Start(t)
	var pings, resets, validations atomic.Int64
	db := openFake(t, rec, sessionConnector{pings: &pings, resets: &resets, validations: &validations})
	db.SetMaxOpenConns(1)
	ctx := context.Background()
	// The first statement opens the connection and returns it to the pool,
	// which validates it; the second reuses it, which resets its session.
	for range 2 {
		if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1"); err != nil {
			t.Fatalf("ExecContext: %v", err)
		}
	}
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("PingContext: %v", err)
	}
	if validations.Load() == 0 {
		t.Error("IsValid was not delegated")
	}
	if resets.Load() == 0 {
		t.Error("ResetSession was not delegated")
	}
	if pings.Load() != 1 {
		t.Errorf("Ping delegated %d times, want 1", pings.Load())
	}
}

func TestNamedValueCheckers(t *testing.T) {
	for _, tc := range []struct {
		name                   string
		connChecks, stmtChecks bool
		prepare                bool
		want                   []string // the checkers that accepted the point, nil for an error
	}{
		{name: "conn checks a direct statement", connChecks: true, want: []string{"conn"}},
		{name: "conn checks a prepared statement", connChecks: true, prepare: true, want: []string{"conn"}},
		{name: "stmt checks before conn", connChecks: true, stmtChecks: true, prepare: true, want: []string{"stmt"}},
		{name: "stmt checks alone", stmtChecks: true, prepare: true, want: []string{"stmt"}},
		{name: "no checker", prepare: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			var seen []string
			db := openFake(t, rec, checkerConnector{connChecks: tc.connChecks, stmtChecks: tc.stmtChecks, seen: &seen})
			ctx := context.Background()
			var err error
			if tc.prepare {
				var stmt *sql.Stmt
				stmt, err = db.PrepareContext(ctx, "UPDATE shapes SET at = ?")
				if err != nil {
					t.Fatalf("PrepareContext: %v", err)
				}
				defer func() {
					if err := stmt.Close(); err != nil {
						t.Errorf("stmt.Close: %v", err)
					}
				}()
				_, err = stmt.ExecContext(ctx, point{1, 2})
			} else {
				_, err = db.ExecContext(ctx, "UPDATE shapes SET at = ?", point{1, 2})
			}
			if tc.want == nil {
				if err == nil || !strings.Contains(err.Error(), "converting argument") {
					t.Errorf("Exec error = %v, want database/sql's conversion error", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Exec: %v", err)
			}
			if !slices.Equal(seen, tc.want) {
				t.Errorf("checkers = %v, want %v", seen, tc.want)
			}
		})
	}
}

func TestPreparedQuery(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	stmt, err := db.PrepareContext(ctx, "SELECT id FROM users WHERE id = 3")
	if err != nil {
		t.Fatalf("PrepareContext: %v", err)
	}
	rows, err := stmt.QueryContext(ctx)
	if err != nil {
		t.Fatalf("QueryContext: %v", err)
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("rows.Close: %v", err)
	}
	if err := stmt.Close(); err != nil {
		t.Fatalf("stmt.Close: %v", err)
	}
	parent.End()
	attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "SELECT users").Attributes()...)
	if got := attrString(attrs, "db.query.text"); got != "SELECT id FROM users WHERE id = ?" {
		t.Errorf("db.query.text = %q", got)
	}
	if points := durationPoints(t, rec); len(points) != 1 || points[0].Count != 1 {
		t.Errorf("duration points = %+v, want one point with count 1", points)
	}
}

func TestRollbackSpan(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	ctx, parent := inSpan(rec)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	parent.End()
	if got := spanNames(rec.Spans()); !slices.Equal(got, []string{"BEGIN", "ROLLBACK", "handler"}) {
		t.Errorf("spans = %v", got)
	}
}

func TestLegacyStatement(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, legacyStmtConnector{})
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1"); !errors.Is(err, o11ysql.ErrLegacyDriver) {
		t.Errorf("ExecContext error = %v, want ErrLegacyDriver", err)
	}
	if _, err := db.QueryContext(ctx, "SELECT id FROM users"); !errors.Is(err, o11ysql.ErrLegacyDriver) {
		t.Errorf("QueryContext error = %v, want ErrLegacyDriver", err)
	}
}

func TestCloseClosesTheConnector(t *testing.T) {
	rec := o11ytest.Start(t)
	var closes atomic.Int64
	db := sql.OpenDB(o11ysql.Wrap(closingConnector{closes: &closes}, o11ysql.WithSDK(rec.SDK)))
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if closes.Load() != 1 {
		t.Errorf("connector closed %d times, want 1", closes.Load())
	}
}

// TestDriverIsInstrumented pins that sql.DB.Driver, and the connector it
// opens by name, instrument their connections too.
func TestDriverIsInstrumented(t *testing.T) {
	rec := o11ytest.Start(t)
	drv := openFake(t, rec, fakeConnector{}).Driver()
	ctx, parent := inSpan(rec)

	cn, err := drv.Open("")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	execer, ok := cn.(driver.ExecerContext)
	if !ok {
		t.Fatalf("%T does not implement driver.ExecerContext", cn)
	}
	if _, err := execer.ExecContext(ctx, "UPDATE carts SET n = 1", nil); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	if err := cn.Close(); err != nil {
		t.Fatalf("conn Close: %v", err)
	}

	dc, ok := drv.(driver.DriverContext)
	if !ok {
		t.Fatalf("%T does not implement driver.DriverContext", drv)
	}
	connector, err := dc.OpenConnector("")
	if err != nil {
		t.Fatalf("OpenConnector: %v", err)
	}
	db := sql.OpenDB(connector)
	if _, err := db.ExecContext(ctx, "DELETE FROM carts"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	parent.End()

	spanNamed(t, rec.Spans(), "UPDATE carts")
	spanNamed(t, rec.Spans(), "DELETE carts")
}

// TestAmbiguousQueryTextIsOmitted pins that o11ysql fails closed by omitting
// db.query.text whenever a statement contains a construct whose literal or
// comment boundaries depend on server settings or version the client cannot
// see (PostgreSQL standard_conforming_strings=off, MySQL NO_BACKSLASH_ESCAPES
// or ANSI_QUOTES, and MySQL/MariaDB versioned comments).
func TestAmbiguousQueryTextIsOmitted(t *testing.T) {
	cases := []struct {
		name     string
		system   string
		query    string
		wantSpan string
		wantText string // empty means db.query.text must be absent
	}{
		{
			name:     "pg backslash quote in plain string",
			system:   "postgresql",
			query:    `SELECT id FROM users WHERE x = 'it\'s secret' AND y = 'tail'`,
			wantSpan: "SELECT users",
		},
		{
			name:     "pg trailing backslash in plain string",
			system:   "postgresql",
			query:    `SELECT id FROM users WHERE x = 'C:\' AND y = 'secret'`,
			wantSpan: "SELECT users",
		},
		{
			name:     "pg explicit escape string is unambiguous",
			system:   "postgresql",
			query:    `SELECT id FROM users WHERE x = E'it\'s secret'`,
			wantSpan: "SELECT users",
			wantText: `SELECT id FROM users WHERE x = ?`,
		},
		{
			name:     "mysql backslash single quote",
			system:   "mysql",
			query:    `SELECT id FROM users WHERE x = 'C:\', 'secret'`,
			wantSpan: "SELECT users",
		},
		{
			name:     "mysql backslash double quote",
			system:   "mysql",
			query:    `SELECT id FROM users WHERE x = "a\"secret"`,
			wantSpan: "SELECT users",
		},
		{
			name:     "mysql versioned comment",
			system:   "mysql",
			query:    `SELECT /*!50000 secret_comment */ id FROM users`,
			wantSpan: "SELECT",
		},
		{
			name:     "mariadb versioned comment",
			system:   "mariadb",
			query:    `SELECT /*M!100100 'a*/secret' */ id FROM users`,
			wantSpan: "SELECT",
		},
		{
			name:     "sqlite backslash is never an escape",
			system:   "sqlite",
			query:    `SELECT id FROM users WHERE x = 'C:\' AND y = 'secret'`,
			wantSpan: "SELECT users",
			wantText: `SELECT id FROM users WHERE x = ? AND y = ?`,
		},
		{
			name:     "sqlite bracket table name",
			system:   "sqlite",
			query:    `SELECT id FROM [users] WHERE id = 1`,
			wantSpan: "SELECT users",
			wantText: `SELECT id FROM [users] WHERE id = ?`,
		},
		{
			name:     "aliased comma table list omits collection",
			system:   "postgresql",
			query:    `SELECT a.id FROM users a, orders b WHERE a.id = 1`,
			wantSpan: "SELECT",
			wantText: `SELECT a.id FROM users a, orders b WHERE a.id = ?`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			db := sql.OpenDB(o11ysql.Wrap(fakeConnector{}, o11ysql.WithSDK(rec.SDK), o11ysql.WithSystem(tc.system)))
			t.Cleanup(func() {
				if err := db.Close(); err != nil {
					t.Errorf("Close: %v", err)
				}
			})
			ctx, parent := inSpan(rec)
			rows, err := db.QueryContext(ctx, tc.query)
			if err != nil {
				t.Fatalf("QueryContext: %v", err)
			}
			if err := rows.Close(); err != nil {
				t.Fatalf("rows.Close: %v", err)
			}
			parent.End()

			span := spanNamed(t, rec.Spans(), tc.wantSpan)
			attrs := attribute.NewSet(span.Attributes()...)
			got, ok := attrs.Value("db.query.text")
			if tc.wantText == "" {
				if ok {
					t.Errorf("db.query.text = %q, want omitted", got.AsString())
				}
				return
			}
			if !ok || got.AsString() != tc.wantText {
				t.Errorf("db.query.text = %q (present %v), want %q", got.AsString(), ok, tc.wantText)
			}
		})
	}
}
