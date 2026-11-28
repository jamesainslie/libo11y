"""DB-API wrapper contract: chaining, pool metrics, psycopg composables, dialects."""

from __future__ import annotations

import gc
import sqlite3
import weakref
from collections.abc import Iterator

import pytest
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind

from libo11y import dbapi
from libo11y._internal.sqltext import Dialect, sanitize
from libo11y.testing import Recorder, start_recorder


@pytest.fixture
def rec() -> Iterator[Recorder]:
    with start_recorder(service_name="dbapi-contract") as recorder:
        yield recorder


def _client_spans(rec: Recorder) -> list[ReadableSpan]:
    return [s for s in rec.spans() if s.kind == SpanKind.CLIENT]


def _client_span_names(rec: Recorder) -> list[str]:
    return [s.name for s in _client_spans(rec)]


@pytest.fixture
def conn(rec: Recorder) -> Iterator[dbapi.WrappedConnection]:
    wrapped = dbapi.wrap(sqlite3.connect(":memory:"), telemetry=rec.telemetry)
    wrapped.raw.execute("CREATE TABLE users (id INTEGER, email TEXT)")
    wrapped.raw.execute("CREATE TABLE orders (id INTEGER)")
    try:
        yield wrapped
    finally:
        wrapped.close()


# Finding 1: methods that return a cursor keep returning the wrapper.


def test_cursor_execute_returns_the_wrapper_when_the_driver_returns_its_cursor(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    cur = conn.cursor()
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        assert cur.execute("SELECT id FROM users") is cur


def test_chained_cursor_execute_instruments_every_statement(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    cur = conn.cursor()
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        cur.execute("SELECT id FROM users").execute("SELECT id FROM orders")
    assert _client_span_names(rec) == ["SELECT users", "SELECT orders"]


def test_cursor_executemany_returns_the_wrapper(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    cur = conn.cursor()
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        chained = cur.executemany("INSERT INTO users (id) VALUES (?)", [(1,), (2,)])
        assert chained is cur
        chained.execute("SELECT id FROM orders")
    assert _client_span_names(rec) == ["INSERT users", "SELECT orders"]


def test_connection_execute_returns_a_wrapped_cursor_that_instruments_chained_calls(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        cur = conn.execute("INSERT INTO users (id, email) VALUES (1, 'a@example.com')")
        assert isinstance(cur, dbapi.WrappedCursor)
        rows = cur.execute("SELECT id FROM users").fetchall()
    assert rows == [(1,)]
    assert _client_span_names(rec) == ["INSERT users", "SELECT users"]


def test_connection_executemany_returns_a_wrapped_cursor(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        cur = conn.executemany("INSERT INTO users (id) VALUES (?)", [(1,)])
        assert isinstance(cur, dbapi.WrappedCursor)
        cur.execute("SELECT id FROM orders")
    assert _client_span_names(rec) == ["INSERT users", "SELECT orders"]


def test_cursor_context_manager_yields_the_wrapper(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    with (
        rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"),
        conn.cursor() as cur,
    ):
        assert isinstance(cur, dbapi.WrappedCursor)
        cur.execute("SELECT id FROM users").execute("SELECT id FROM orders")
    assert _client_span_names(rec) == ["SELECT users", "SELECT orders"]


class _RowcountCursor:
    """A driver cursor whose execute returns a row count, as PyMySQL's does."""

    def execute(self, operation: str, *args: object) -> int:
        del operation, args
        return 3


class _RowcountConnection:
    def cursor(self) -> _RowcountCursor:
        return _RowcountCursor()


def test_cursor_execute_passes_through_a_driver_result_that_is_not_its_cursor(
    rec: Recorder,
) -> None:
    conn = dbapi.wrap(_RowcountConnection(), system="mysql", telemetry=rec.telemetry)
    assert conn.cursor().execute("DELETE FROM t") == 3


# Finding 2: pool metrics for several pools on one meter provider.


class _FakePool:
    def __init__(self, name: str, size: int, available: int, max_size: int) -> None:
        self.name = name
        self.closed = False
        self._stats = {"pool_size": size, "pool_available": available, "pool_max": max_size}

    def get_stats(self) -> dict[str, int]:
        return dict(self._stats)


def _counts(rec: Recorder) -> dict[tuple[str, str], int]:
    return {
        (
            str(pt["attributes"]["db.client.connection.pool.name"]),
            str(pt["attributes"]["db.client.connection.state"]),
        ): int(pt["value"])
        for pt in rec.metric_points("db.client.connection.count")
    }


def _maxes(rec: Recorder) -> dict[str, int]:
    return {
        str(pt["attributes"]["db.client.connection.pool.name"]): int(pt["value"])
        for pt in rec.metric_points("db.client.connection.max")
    }


def test_pool_metrics_report_every_registered_pool(rec: Recorder) -> None:
    with (
        dbapi.register_pool_metrics(_FakePool("orders", 6, 4, 10), telemetry=rec.telemetry),
        dbapi.register_pool_metrics(_FakePool("billing", 3, 1, 5), telemetry=rec.telemetry),
    ):
        assert _counts(rec) == {
            ("orders", "idle"): 4,
            ("orders", "used"): 2,
            ("billing", "idle"): 1,
            ("billing", "used"): 2,
        }
        assert _maxes(rec) == {"orders": 10, "billing": 5}


def test_pool_metrics_reregistration_after_unregister_reports_again(rec: Recorder) -> None:
    first = dbapi.register_pool_metrics(_FakePool("orders", 2, 2, 4), telemetry=rec.telemetry)
    rec.metric_points("db.client.connection.count")
    first.unregister()
    with dbapi.register_pool_metrics(_FakePool("orders", 5, 1, 8), telemetry=rec.telemetry):
        assert _counts(rec) == {("orders", "idle"): 1, ("orders", "used"): 4}
        assert _maxes(rec) == {"orders": 8}


def test_pool_metrics_unregister_stops_reading_the_pool(rec: Recorder) -> None:
    pool = _FakePool("orders", 2, 2, 4)
    reads = 0
    original = pool.get_stats

    def counting_get_stats() -> dict[str, int]:
        nonlocal reads
        reads += 1
        return original()

    pool.get_stats = counting_get_stats
    reg = dbapi.register_pool_metrics(pool, telemetry=rec.telemetry)
    rec.metric_points("db.client.connection.count")
    assert reads > 0
    reg.unregister()
    before = reads
    rec.metric_points("db.client.connection.count")
    assert reads == before


def test_pool_metrics_unregister_releases_the_pool(rec: Recorder) -> None:
    pool = _FakePool("orders", 2, 2, 4)
    ref = weakref.ref(pool)
    reg = dbapi.register_pool_metrics(pool, telemetry=rec.telemetry)
    rec.metric_points("db.client.connection.count")
    reg.unregister()
    del pool
    gc.collect()
    assert ref() is None


def test_pool_metrics_name_defaults_to_the_system(rec: Recorder) -> None:
    class _Unnamed:
        closed = False

        def get_stats(self) -> dict[str, int]:
            return {"pool_size": 1, "pool_available": 1, "pool_max": 2}

    with dbapi.register_pool_metrics(_Unnamed(), system="postgresql", telemetry=rec.telemetry):
        assert _maxes(rec) == {"postgresql": 2}


# Finding 3: psycopg composables render through the driver.


class _ComposableCursor:
    """A cursor that is a valid psycopg adaptation context, as a real one is."""

    def __init__(self) -> None:
        psycopg = pytest.importorskip("psycopg")
        self.adapters = psycopg.adapters
        self.connection = None
        self.executed: list[object] = []

    def execute(self, operation: object, *args: object) -> _ComposableCursor:
        del args
        self.executed.append(operation)
        return self


class _ComposableConnection:
    def __init__(self) -> None:
        self.cur = _ComposableCursor()

    def cursor(self) -> _ComposableCursor:
        return self.cur


def test_psycopg_composable_query_is_rendered_before_sanitizing(rec: Recorder) -> None:
    sql = pytest.importorskip("psycopg.sql")
    query = sql.SQL("SELECT email FROM {} WHERE email = {}").format(
        sql.Identifier("users"), sql.Literal("alice@example.com")
    )
    raw = _ComposableConnection()
    conn = dbapi.wrap(raw, system="postgresql", telemetry=rec.telemetry)
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        conn.cursor().execute(query)

    (span,) = _client_spans(rec)
    attrs = span.attributes or {}
    assert span.name == "SELECT users"
    assert attrs["db.query.text"] == 'SELECT email FROM "users" WHERE email = ?'
    assert raw.cur.executed == [query]


# Finding 4: sanitization per dialect, against go/o11ysql/internal/sqltext.

_PG = Dialect.STANDARD
_MY = Dialect.MYSQL
_SQ = Dialect.SQLITE

# (name, input, want, dialect), copied from TestSanitize and
# TestSanitizeEdgeCases in go/o11ysql/internal/sqltext/sqltext_test.go.
_GO_SANITIZE_CASES: list[tuple[str, str, str, Dialect]] = [
    (
        "strings and numbers",
        "SELECT * FROM users WHERE email = 'a@example.com' AND age > 30",
        "SELECT * FROM users WHERE email = ? AND age > ?",
        _PG,
    ),
    (
        "doubled quote and exponent",
        "INSERT INTO t (a, b) VALUES ('it''s', 3.5e-2)",
        "INSERT INTO t (a, b) VALUES (?, ?)",
        _PG,
    ),
    (
        "quoted identifiers and placeholders kept",
        'SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?',
        'SELECT "Name" FROM "Users" WHERE id = $1 AND x = ?',
        _PG,
    ),
    (
        "mysql double quotes are strings",
        "SELECT * FROM t WHERE a = \"secret\" AND b = 'x\\'y'",
        "SELECT * FROM t WHERE a = ? AND b = ?",
        _MY,
    ),
    ("mysql backticks kept", "SELECT `order` FROM `t`", "SELECT `order` FROM `t`", _MY),
    ("comments removed", "SELECT 1 -- token=abc\nFROM t /* pw */", "SELECT ?  \nFROM t  ", _PG),
    ("mysql hash comment", "SELECT 1 # pw\nFROM t", "SELECT ?  \nFROM t", _MY),
    ("dollar quoting", "SELECT $tag$ secret $tag$, $$x$$, $2", "SELECT ?, ?, $2", _PG),
    ("hex and leading dot", "SELECT 0xFF, .5, t1.c2 FROM t1", "SELECT ?, ?, t1.c2 FROM t1", _PG),
    ("unterminated string", "SELECT 'abc", "SELECT ?", _PG),
    ("unterminated comment", "SELECT a /* secret", "SELECT a  ", _PG),
    (
        "named placeholders kept, colon digits are numbers",
        "SELECT * FROM t WHERE id = :1 AND name = :name AND p = @p1",
        "SELECT * FROM t WHERE id = :? AND name = :name AND p = @p1",
        _PG,
    ),
    (
        "array slices and times",
        "SELECT data[1:5], data[:5] FROM t WHERE a = 12:34",
        "SELECT data[?:?], data[:?] FROM t WHERE a = ?:?",
        _PG,
    ),
    (
        "mysql colon digits are numbers",
        "SELECT * FROM t WHERE a = 12:34 AND b = :5",
        "SELECT * FROM t WHERE a = ?:? AND b = :?",
        _MY,
    ),
    (
        "sqlite colon digits are parameters",
        "SELECT * FROM t WHERE b = :5",
        "SELECT * FROM t WHERE b = :5",
        _SQ,
    ),
    ("standard backslash is literal", "SELECT 'C:\\' FROM t", "SELECT ? FROM t", _PG),
    (
        "unicode identifier",
        "SELECT * FROM café WHERE x = 'é'",
        "SELECT * FROM café WHERE x = ?",
        _PG,
    ),
    (
        "escape string with backslash quote",
        "SELECT E'it\\'s secret', e'a\\\\' FROM t",
        "SELECT ?, ? FROM t",
        _PG,
    ),
    ("escape string with doubled quote", "SELECT E'it''s secret' FROM t", "SELECT ? FROM t", _PG),
    ("unterminated escape string", "SELECT E'secret\\'", "SELECT ?", _PG),
    ("e prefix only escapes in standard", "SELECT e'a\\'b'", "SELECT e?", _MY),
    ("nested block comment", "SELECT a /* x /* y */ secret */ FROM t", "SELECT a   FROM t", _PG),
    ("unterminated nested comment", "SELECT a /* x /* y */ secret", "SELECT a  ", _PG),
    ("mysql comments do not nest", "SELECT a /* x /* y */ FROM t", "SELECT a   FROM t", _MY),
    ("line comment at end", "SELECT a -- secret", "SELECT a  ", _PG),
    (
        "numeric forms",
        "SELECT 1_000_000, 0b1010, 0o17, 0x1F_FF, 1.5e+10, 12abc, 1., 1e5",
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?",
        _PG,
    ),
    ("negative number", "SELECT * FROM t WHERE a = -5", "SELECT * FROM t WHERE a = -?", _PG),
    ("casts kept", "SELECT '1'::int, $1::text", "SELECT ?::int, $1::text", _PG),
    ("unterminated quoted identifier", "SELECT \"abc 'secret'", "SELECT ?", _PG),
    ("unterminated backtick identifier", "SELECT `abc 'secret'", "SELECT ?", _MY),
    ("mysql escaped double quote", 'SELECT "a\\"secret" FROM t', "SELECT ? FROM t", _MY),
    ("mysql doubled quote", "SELECT 'it''s secret' FROM t", "SELECT ? FROM t", _MY),
    ("mysql trailing backslash", "SELECT 'abc\\", "SELECT ?", _MY),
    ("unterminated dollar quote", "SELECT $$secret", "SELECT ?", _PG),
    ("dollar tags must match", "SELECT $a$ x $b$ secret $a$ FROM t", "SELECT ? FROM t", _PG),
    (
        "string prefixes",
        "SELECT X'FF', B'01', N'abc', _utf8mb4'abc'",
        "SELECT X?, B?, N?, _utf8mb4?",
        _MY,
    ),
    (
        "comment markers inside strings",
        "SELECT '-- x', '/* y', $$ */ $$ FROM t",
        "SELECT ?, ?, ? FROM t",
        _PG,
    ),
    ("empty", "", "", _PG),
    ("dollar inside identifier", "SELECT a$b$, 'q', $b$ SECRET $b$", "SELECT a$b$, ?, ?", _PG),
    ("mysql has no dollar quoting", "SELECT a$t$b, 'x $t$ SECRET'", "SELECT a$t$b, ?", _MY),
    ("mysql dollar starts identifier", "SELECT $$x$$ FROM t", "SELECT $$x$$ FROM t", _MY),
    ("number before dollar quote", "SELECT 1$t$ SECRET $t$", "SELECT ??", _PG),
    ("number before escape string", "SELECT 1E'\\'SECRET'", "SELECT ??", _PG),
    ("hex digit e before string", "SELECT 0x1E'C:\\', 'SECRET'", "SELECT ??, ?", _PG),
    ("backtick is an operator in standard", "SELECT a ` 'SECRET' ` b", "SELECT a ` ? ` b", _PG),
    ("hash is an operator in standard", "SELECT a # 'SECRET'", "SELECT a # ?", _PG),
    ("nested comment ends after inner close", "SELECT /* /* */ ' */ 'SECRET'", "SELECT   ?", _PG),
    ("mysql double minus before string", "SELECT a--'x\nSECRET'", "SELECT a--?", _MY),
    ("mysql double minus tab comment", "SELECT a --\tx\nFROM t", "SELECT a  \nFROM t", _MY),
    ("mysql double minus at end", "SELECT a --", "SELECT a  ", _MY),
    ("mysql versioned comment", "SELECT /*!50000 'a*/SECRET' */ 1", "SELECT   ?   ?", _MY),
    ("mariadb versioned comment", "SELECT /*M!100100 'a*/SECRET' */ 1", "SELECT   ?   ?", _MY),
    ("mysql hint is a comment", "SELECT /*+ BKA(t) */ a FROM t", "SELECT   a FROM t", _MY),
    ("sqlite comments do not nest", "SELECT /* /* */ 'x */ SECRET'", "SELECT   ?", _SQ),
    (
        "sqlite bracket identifier",
        "SELECT [O'Brien] FROM t WHERE a = 'SECRET'",
        "SELECT [O'Brien] FROM t WHERE a = ?",
        _SQ,
    ),
    ("sqlite unterminated bracket", "SELECT [abc 'SECRET'", "SELECT ?", _SQ),
    ("sqlite has no escape strings", "SELECT e'C:\\', 'SECRET'", "SELECT e?, ?", _SQ),
    (
        "sqlite double quotes may be strings",
        'SELECT * FROM t WHERE name = "bob"',
        "SELECT * FROM t WHERE name = ?",
        _SQ,
    ),
    ("sqlite backticks kept", "SELECT `order` FROM t", "SELECT `order` FROM t", _SQ),
    (
        "sqlite parameters",
        "SELECT $p$, 'a $p$ SECRET', ?1, :a, @b, #c, $d::e, $f(SECRET)",
        "SELECT $p$, ?, ?1, :a, @b, #c, $d::e, ?",
        _SQ,
    ),
    ("sqlite numbers", "SELECT 1_000, 0x1F, .5e3", "SELECT ?, ?, ?", _SQ),
]


@pytest.mark.parametrize(
    ("query", "want", "dialect"),
    [pytest.param(q, w, d, id=name) for name, q, w, d in _GO_SANITIZE_CASES],
)
def test_sanitize_matches_go(query: str, want: str, dialect: Dialect) -> None:
    assert sanitize(query, dialect) == want


# One statement per system whose sanitized text differs between dialects.
_SYSTEM_CASES: list[tuple[str, str, str]] = [
    (
        "postgresql",
        "SELECT \"Name\" FROM t WHERE a = $tag$ x 'y' $tag$ AND b = E'\\'' AND c = $1",
        'SELECT "Name" FROM t WHERE a = ? AND b = ? AND c = $1',
    ),
    (
        "sqlite",
        'SELECT [O\'Brien] FROM t WHERE a = "bob" AND b = ?1 AND c = :name',
        "SELECT [O'Brien] FROM t WHERE a = ? AND b = ?1 AND c = :name",
    ),
    (
        "mysql",
        "SELECT `order` FROM t WHERE a = \"x\" AND b = 'it\\'s' # note\n AND c = %s",
        "SELECT `order` FROM t WHERE a = ? AND b = ?  \n AND c = %s",
    ),
    (
        "mariadb",
        "SELECT `order` FROM t WHERE a = \"x\" AND b = 'it\\'s' # note\n AND c = %s",
        "SELECT `order` FROM t WHERE a = ? AND b = ?  \n AND c = %s",
    ),
]


class _NullCursor:
    def execute(self, operation: object, *args: object) -> None:
        del operation, args


class _NullConnection:
    def cursor(self) -> _NullCursor:
        return _NullCursor()


@pytest.mark.parametrize(("system", "query", "want"), _SYSTEM_CASES)
def test_query_text_is_sanitized_under_the_system_dialect(
    rec: Recorder, system: str, query: str, want: str
) -> None:
    conn = dbapi.wrap(_NullConnection(), system=system, telemetry=rec.telemetry)
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        conn.cursor().execute(query)
    (span,) = _client_spans(rec)
    attrs = span.attributes or {}
    assert attrs["db.system.name"] == system
    assert attrs["db.query.text"] == want


def test_client_span_is_recorded_only_under_a_parent_span(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    conn.execute("SELECT id FROM users")
    assert _client_spans(rec) == []
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent") as p:
        conn.execute("SELECT id FROM users")
    (span,) = _client_spans(rec)
    assert span.parent is not None
    assert span.parent.span_id == p.get_span_context().span_id


def test_operation_duration_is_recorded_with_and_without_a_parent(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    conn.execute("SELECT id FROM users")
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        conn.execute("SELECT id FROM users")
    points = rec.metric_points("db.client.operation.duration")
    select = [p for p in points if p["attributes"].get("db.collection.name") == "users"]
    assert sum(int(p["count"]) for p in select) == 2


def test_operation_duration_carries_an_exemplar_of_the_client_span(
    rec: Recorder, conn: dbapi.WrappedConnection
) -> None:
    with rec.telemetry.tracer_provider.get_tracer("app").start_as_current_span("parent"):
        conn.execute("SELECT id FROM users")
    (span,) = _client_spans(rec)
    sc = span.get_span_context()
    assert sc is not None
    exemplars = rec.exemplars("db.client.operation.duration")
    assert any(ex.trace_id == sc.trace_id and ex.span_id == sc.span_id for ex in exemplars)
