package o11ysql_test

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/jamesainslie/libo11y/go/o11ysql"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

func TestOpenWrapsARegisteredDriver(t *testing.T) {
	for _, name := range []string{"o11ysql-fake", "o11ysql-fake-ctx"} {
		t.Run(name, func(t *testing.T) {
			rec := o11ytest.Start(t)
			db, err := o11ysql.Open(name, "fake", o11ysql.WithSDK(rec.SDK))
			if err != nil {
				t.Fatalf("Open: %v", err)
			}
			t.Cleanup(func() {
				if err := db.Close(); err != nil {
					t.Errorf("Close: %v", err)
				}
			})
			ctx, parent := inSpan(rec)
			if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1"); err != nil {
				t.Fatalf("ExecContext: %v", err)
			}
			parent.End()
			span := spanNamed(t, rec.Spans(), "UPDATE users")
			if got := attrString(attribute.NewSet(span.Attributes()...), "db.system.name"); got != "other_sql" {
				t.Errorf("db.system.name = %q, want other_sql for an unknown driver name", got)
			}
		})
	}
}

func TestOpenRejectsAnUnknownDriver(t *testing.T) {
	if _, err := o11ysql.Open("no-such-driver", "x"); err == nil {
		t.Error("Open of an unregistered driver succeeded")
	}
}

func TestSystemForDriver(t *testing.T) {
	for name, want := range map[string]string{
		"postgres": "postgresql", "pgx": "postgresql", "pgx/v5": "postgresql",
		"sqlite": "sqlite", "sqlite3": "sqlite", "mysql": "mysql",
		"sqlserver": "microsoft.sql_server", "mssql": "microsoft.sql_server",
		"o11ysql-fake": "other_sql",
	} {
		if got := o11ysql.SystemForDriver(name); got != want {
			t.Errorf("SystemForDriver(%q) = %q, want %q", name, got, want)
		}
	}
}

// poolPoint returns the value of the named pool metric for pool, in state
// when state is non-empty.
func poolPoint(t *testing.T, rec *o11ytest.Recorder, name, pool, state string) (int64, bool) {
	t.Helper()
	for _, sm := range rec.Metrics().ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != name {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("%s is %T, want an int64 sum", name, m.Data)
			}
			for _, p := range sum.DataPoints {
				if attrString(p.Attributes, "db.client.connection.pool.name") != pool {
					continue
				}
				if state != "" && attrString(p.Attributes, "db.client.connection.state") != state {
					continue
				}
				return p.Value, true
			}
		}
	}
	return 0, false
}

func TestOpenRegistersPoolMetrics(t *testing.T) {
	rec := o11ytest.Start(t)
	db, err := o11ysql.Open("o11ysql-fake", "fake", o11ysql.WithSDK(rec.SDK), o11ysql.WithPoolName("primary"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	db.SetMaxOpenConns(4)
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("Conn: %v", err)
	}

	assertPool := func(idle, used int64) {
		t.Helper()
		for state, want := range map[string]int64{"idle": idle, "used": used} {
			if got, ok := poolPoint(t, rec, "db.client.connection.count", "primary", state); !ok || got != want {
				t.Errorf("count{state=%s} = %d (present %v), want %d", state, got, ok, want)
			}
		}
		if got, ok := poolPoint(t, rec, "db.client.connection.max", "primary", ""); !ok || got != 4 {
			t.Errorf("max = %d (present %v), want 4", got, ok)
		}
	}
	assertPool(0, 1)
	if err := conn.Close(); err != nil {
		t.Fatalf("conn.Close: %v", err)
	}
	assertPool(1, 0)
}

func TestRegisterPoolMetricsForAWrappedConnector(t *testing.T) {
	rec := o11ytest.Start(t)
	db := openFake(t, rec, fakeConnector{})
	reg, err := o11ysql.RegisterPoolMetrics(db, o11ysql.WithSDK(rec.SDK), o11ysql.WithSystem("sqlite"))
	if err != nil {
		t.Fatalf("RegisterPoolMetrics: %v", err)
	}
	t.Cleanup(func() {
		if err := reg.Unregister(); err != nil {
			t.Errorf("Unregister: %v", err)
		}
	})
	if _, ok := poolPoint(t, rec, "db.client.connection.count", "sqlite", "idle"); !ok {
		t.Error("no idle count for the default pool name, which is the db.system.name value")
	}
	if _, ok := poolPoint(t, rec, "db.client.connection.max", "sqlite", ""); ok {
		t.Error("max reported for an unlimited pool, want it omitted")
	}
}

func TestOpenUnregistersPoolMetricsOnClose(t *testing.T) {
	rec := o11ytest.Start(t)
	for range 2 {
		db, err := o11ysql.Open("o11ysql-fake", "fake", o11ysql.WithSDK(rec.SDK))
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		db.SetMaxOpenConns(4)
		if err := db.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
	if got, ok := poolPoint(t, rec, "db.client.connection.max", "other_sql", ""); ok {
		t.Errorf("max = %d after every pool closed, want no point", got)
	}
	if got, ok := poolPoint(t, rec, "db.client.connection.count", "other_sql", "idle"); ok {
		t.Errorf("idle count = %d after every pool closed, want no point", got)
	}
}

func TestOpenWithSystemOverridesTheDriverName(t *testing.T) {
	rec := o11ytest.Start(t)
	db, err := o11ysql.Open("o11ysql-fake", "fake", o11ysql.WithSDK(rec.SDK), o11ysql.WithSystem("postgresql"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	ctx, parent := inSpan(rec)
	if _, err := db.ExecContext(ctx, "UPDATE users SET n = 1"); err != nil {
		t.Fatalf("ExecContext: %v", err)
	}
	parent.End()
	attrs := attribute.NewSet(spanNamed(t, rec.Spans(), "UPDATE users").Attributes()...)
	if got := attrString(attrs, "db.system.name"); got != "postgresql" {
		t.Errorf("db.system.name = %q, want postgresql", got)
	}
	if got := attrString(attrs, "db.query.text"); got != "UPDATE users SET n = ?" {
		t.Errorf("db.query.text = %q, want the sanitized text", got)
	}
	if _, ok := poolPoint(t, rec, "db.client.connection.count", "postgresql", "idle"); !ok {
		t.Error("no idle count for the pool named after the overriding system")
	}
}
