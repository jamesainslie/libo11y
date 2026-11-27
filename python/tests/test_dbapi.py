"""Tests for P7 DB-API 2 integration: SQL sanitization, sqlite3, pool metrics, and Postgres."""

from __future__ import annotations

import os
import sqlite3
from typing import Any

import pytest
from opentelemetry.trace import SpanKind, StatusCode

from libo11y import dbapi
from libo11y._internal.sqltext import Dialect, sanitize, summarize, truncate_utf8
from libo11y.testing import start_recorder


def test_sqltext_sanitize_and_summarize_dialects() -> None:
    # PostgreSQL: standard strings, E'...', dollar-quoted, nested block comments, $1 kept.
    q_pg = (
        '/* outer /* inner */ */ SELECT * FROM public."Users" '
        "WHERE email = 'alice@example.com' AND bio = E'it\\'s ok' "
        "AND note = $tag$secret 'value'$tag$ AND id = $1 AND age > 42 -- comment\n"
    )
    san = sanitize(q_pg, Dialect.STANDARD)
    assert "alice@example.com" not in san
    assert "secret" not in san
    assert "42" not in san
    assert "comment" not in san
    assert "inner" not in san
    assert "$1" in san
    assert summarize(san) == ("SELECT", "public.Users")

    # SQLite: double-quoted identifiers treated as literals, ?1 and :name kept.
    q_sq = 'SELECT name FROM orders WHERE secret = "val" AND id = ?1 AND k = :user_id AND n = 0x1F'
    san_sq = sanitize(q_sq, Dialect.SQLITE)
    assert '"val"' not in san_sq
    assert "0x1F" not in san_sq
    assert "?1" in san_sq
    assert ":user_id" in san_sq
    assert summarize(san_sq) == ("SELECT", "orders")

    # Multi-table join yields empty collection; WITH yields empty operation; SHOW yields empty col.
    assert summarize(sanitize("SELECT * FROM a JOIN b ON a.id = b.id")) == ("SELECT", "")
    assert summarize(sanitize("WITH cte AS (SELECT 1) SELECT * FROM cte")) == ("", "")
    assert summarize(sanitize("SHOW TABLES FROM mydb")) == ("SHOW", "")
    assert summarize(sanitize("UPDATE ONLY accounts SET balance = 0 WHERE id = 1")) == (
        "UPDATE",
        "accounts",
    )
    assert summarize(sanitize("CREATE TABLE IF NOT EXISTS items (id INT)")) == ("CREATE", "items")

    # UTF-8 truncation cuts cleanly on character boundaries.
    long_text = "é" * 3000  # 6000 UTF-8 bytes
    cut = truncate_utf8(long_text, 4096)
    assert len(cut.encode("utf-8")) <= 4096
    assert cut == "é" * 2048


def test_dbapi_sqlite_parent_span_only_sanitization_errors_and_exemplars() -> None:
    with start_recorder(service_name="dbapi-sqlite") as rec:
        raw_conn = sqlite3.connect(":memory:")
        conn = dbapi.wrap(raw_conn, namespace="main", telemetry=rec.telemetry)
        try:
            # 1. Queries WITHOUT an active parent span emit NO spans, ONLY duration metrics!
            conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE)")
            conn.commit()
            assert len(rec.spans()) == 0
            pts_bg = rec.metric_points("db.client.operation.duration")
            assert len(pts_bg) >= 2

            # 2. Queries WITH an active parent span emit CLIENT spans + sanitized query text.
            tracer = rec.telemetry.tracer_provider.get_tracer("app")
            with tracer.start_as_current_span("handle-signup") as parent_sp:
                parent_sc = parent_sp.get_span_context()
                with conn.cursor() as cur:
                    cur.execute("INSERT INTO users (id, email) VALUES (1, 'alice@example.com')")
                    cur.execute("SELECT email FROM users WHERE id = ?", (1,))
                    row = cur.fetchone()
                    assert row == ("alice@example.com",)

                    # Error: duplicate primary key -> StatusCode.ERROR with EMPTY description!
                    with pytest.raises(sqlite3.IntegrityError):
                        cur.execute(
                            "INSERT INTO users (id, email) VALUES (1, 'secret-value@example.com')"
                        )
                conn.rollback()
        finally:
            conn.close()

        rec.assert_conforms()
        client_spans = [s for s in rec.spans() if s.kind == SpanKind.CLIENT]
        names = [s.name for s in client_spans]
        assert "INSERT users" in names
        assert "SELECT users" in names
        assert "ROLLBACK" in names

        # Check sanitized query text & no leaked literals
        for sp in client_spans:
            attrs = sp.attributes or {}
            assert attrs["db.system.name"] == "sqlite"
            assert attrs["db.namespace"] == "main"
            qtext = str(attrs.get("db.query.text", ""))
            assert "alice@example.com" not in qtext
            assert "secret-value@example.com" not in qtext

        err_sp = next(s for s in client_spans if s.status.status_code == StatusCode.ERROR)
        assert err_sp.status.description in (None, "")
        assert (err_sp.attributes or {}).get("error.type") == "sqlite3.IntegrityError"

        exemplars = rec.exemplars("db.client.operation.duration")
        assert len(exemplars) >= 1
        assert any(ex.trace_id == parent_sc.trace_id for ex in exemplars)


def test_dbapi_query_text_disabled_and_unknown_system() -> None:
    with start_recorder(service_name="dbapi-opts") as rec:
        conn_no_text = dbapi.wrap(
            sqlite3.connect(":memory:"),
            telemetry=rec.telemetry,
            query_text=False,
        )
        conn_other = dbapi.wrap(
            sqlite3.connect(":memory:"),
            system="other_sql",
            telemetry=rec.telemetry,
        )
        try:
            tracer = rec.telemetry.tracer_provider.get_tracer("app")
            with tracer.start_as_current_span("parent"):
                conn_no_text.execute("SELECT 1")
                conn_other.execute("SELECT 1")
        finally:
            conn_no_text.close()
            conn_other.close()

        client_spans = [s for s in rec.spans() if s.kind == SpanKind.CLIENT]
        assert len(client_spans) == 2
        for sp in client_spans:
            assert "db.query.text" not in (sp.attributes or {})


def test_dbapi_pool_metrics_registration_and_unregister() -> None:
    class _FakePool:
        name = "orders-pg"
        closed = False

        def get_stats(self) -> dict[str, int]:
            return {
                "pool_min": 2,
                "pool_max": 10,
                "pool_size": 6,
                "pool_available": 4,
            }

    with start_recorder(service_name="dbapi-pool") as rec:
        pool = _FakePool()
        reg = dbapi.register_pool_metrics(pool, telemetry=rec.telemetry)
        count_pts = rec.metric_points("db.client.connection.count")
        max_pts = rec.metric_points("db.client.connection.max")

        by_state = {pt["attributes"]["db.client.connection.state"]: pt["value"] for pt in count_pts}
        assert by_state == {"idle": 4, "used": 2}
        assert all(
            pt["attributes"]["db.client.connection.pool.name"] == "orders-pg" for pt in count_pts
        )
        assert len(max_pts) == 1
        assert max_pts[0]["value"] == 10
        assert max_pts[0]["attributes"]["db.client.connection.pool.name"] == "orders-pg"

        # After unregister, callback returns no observations.
        reg.unregister()
        rec.assert_conforms()


def test_dbapi_postgres_integration_if_dsn_set() -> None:
    dsn = os.environ.get("O11Y_PG_TEST_DSN", "").strip()
    if not dsn:
        pytest.skip("O11Y_PG_TEST_DSN not set; skipping live PostgreSQL test")

    import psycopg
    import psycopg_pool

    with start_recorder(service_name="dbapi-pg-live") as rec:
        pool = psycopg_pool.ConnectionPool(dsn, min_size=1, max_size=4, name="ci-pg")
        try:
            with dbapi.register_pool_metrics(pool, telemetry=rec.telemetry):
                tracer = rec.telemetry.tracer_provider.get_tracer("pg-test")
                with pool.connection() as raw_conn:
                    conn = dbapi.wrap(raw_conn, telemetry=rec.telemetry)
                    with tracer.start_as_current_span("pg-op"):
                        cur = conn.execute("SELECT %s::text AS greeting", ("hello-secret",))
                        row: Any = cur.fetchone()
                        assert row is not None and row[0] == "hello-secret"

                pg_spans = [s for s in rec.spans() if s.kind == SpanKind.CLIENT]
                assert len(pg_spans) >= 1
                attrs = pg_spans[0].attributes or {}
                assert attrs["db.system.name"] == "postgresql"
                assert "hello-secret" not in str(attrs.get("db.query.text", ""))
                assert len(rec.metric_points("db.client.connection.count")) >= 1
                assert len(rec.metric_points("db.client.connection.max")) >= 1
        finally:
            pool.close()
        del psycopg
        rec.assert_conforms()
