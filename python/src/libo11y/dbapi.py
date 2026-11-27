"""DB-API 2 connection/cursor wrapper with SQL sanitization and pool metrics."""

from __future__ import annotations

import threading
import time
from collections.abc import Iterable, Iterator, Sequence
from types import TracebackType
from typing import TYPE_CHECKING, Any, Final

from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Histogram, Observation
from opentelemetry.trace import SpanKind, StatusCode, Tracer

from libo11y._internal.http_common import error_type_for_exception
from libo11y._internal.sqltext import (
    MAX_QUERY_TEXT_BYTES,
    Dialect,
    sanitize,
    summarize,
    truncate_utf8,
)

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

_SCOPE_NAME: Final[str] = "libo11y.dbapi"
_OTHER_SQL: Final[str] = "other_sql"

DB_DURATION_BUCKETS: Final[tuple[float, ...]] = (
    0.001,
    0.005,
    0.01,
    0.05,
    0.1,
    0.5,
    1.0,
    5.0,
    10.0,
)


def _dialect_for(system: str) -> tuple[Dialect, bool]:
    if system == "postgresql":
        return Dialect.STANDARD, True
    if system == "sqlite":
        return Dialect.SQLITE, True
    if system in ("mysql", "mariadb"):
        return Dialect.MYSQL, True
    return Dialect.STANDARD, False


def _infer_system(conn: Any) -> str:
    mod = type(conn).__module__.lower()
    if mod.startswith("sqlite3") or "sqlite" in mod:
        return "sqlite"
    if mod.startswith("psycopg") or "postgres" in mod or "asyncpg" in mod:
        return "postgresql"
    if mod.startswith("mariadb"):
        return "mariadb"
    if "mysql" in mod or "pymysql" in mod:
        return "mysql"
    return _OTHER_SQL


def _db_error_type(exc: BaseException) -> str:
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and sqlstate:
        return sqlstate
    pgcode = getattr(exc, "pgcode", None)
    if isinstance(pgcode, str) and pgcode:
        return pgcode
    return error_type_for_exception(exc)


class _Instrumenter:
    def __init__(
        self,
        *,
        system: str,
        namespace: str | None,
        telemetry: Telemetry | None,
        query_text: bool,
    ) -> None:
        tp = telemetry.tracer_provider if telemetry is not None else trace.get_tracer_provider()
        mp = telemetry.meter_provider if telemetry is not None else metrics.get_meter_provider()
        self.tracer: Tracer = tp.get_tracer(_SCOPE_NAME)
        meter = mp.get_meter(_SCOPE_NAME)
        self.duration: Histogram = meter.create_histogram(
            "db.client.operation.duration",
            unit="s",
            description="Duration of database client operations.",
            explicit_bucket_boundaries_advisory=list(DB_DURATION_BUCKETS),
        )
        self.system = system
        self.namespace = namespace
        dialect, known = _dialect_for(system)
        self.dialect = dialect
        self.record_query_text = query_text and known

    def describe_query(self, query: Any) -> tuple[str, dict[str, Any], str]:
        raw = query.decode("utf-8", errors="replace") if isinstance(query, bytes) else str(query)
        sanitized = sanitize(raw, self.dialect)
        sanitized_utf8 = sanitized.encode("utf-8", errors="replace").decode("utf-8")
        operation, collection = summarize(sanitized_utf8)
        name, attrs = self.describe_named(operation, collection)
        qtext = (
            truncate_utf8(sanitized_utf8, MAX_QUERY_TEXT_BYTES) if self.record_query_text else ""
        )
        return name, attrs, qtext

    def describe_named(self, operation: str, collection: str = "") -> tuple[str, dict[str, Any]]:
        attrs: dict[str, Any] = {"db.system.name": self.system}
        if self.namespace:
            attrs["db.namespace"] = self.namespace
        name = self.system
        if operation:
            attrs["db.operation.name"] = operation
            name = operation
        if collection:
            attrs["db.collection.name"] = collection
            name = f"{operation} {collection}" if operation else collection
        return name, attrs

    def run(
        self,
        span_name: str,
        base_attrs: dict[str, Any],
        qtext: str,
        fn: Any,
    ) -> Any:
        has_parent = trace.get_current_span().get_span_context().is_valid
        start_ns = time.perf_counter_ns()
        raised: BaseException | None = None
        if not has_parent:
            try:
                return fn()
            except Exception as exc:
                raised = exc
                raise
            finally:
                elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                m_attrs = dict(base_attrs)
                if raised is not None:
                    m_attrs["error.type"] = _db_error_type(raised)
                self.duration.record(elapsed_s, m_attrs)

        span_attrs = dict(base_attrs)
        if qtext:
            span_attrs["db.query.text"] = qtext
        with self.tracer.start_as_current_span(
            span_name,
            kind=SpanKind.CLIENT,
            attributes=span_attrs,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                return fn()
            except Exception as exc:
                raised = exc
                raise
            finally:
                elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                m_attrs = dict(base_attrs)
                if raised is not None:
                    err_type = _db_error_type(raised)
                    span.set_attribute("error.type", err_type)
                    # Leave status description empty: DB error messages often quote query values.
                    span.set_status(StatusCode.ERROR)
                    m_attrs["error.type"] = err_type
                self.duration.record(elapsed_s, m_attrs)


class WrappedCursor:
    """DB-API 2 cursor wrapper recording client spans and operation durations."""

    def __init__(self, cursor: Any, ins: _Instrumenter) -> None:
        self._cursor = cursor
        self._ins = ins

    def execute(self, operation: Any, *args: Any, **kwargs: Any) -> Any:
        name, attrs, qtext = self._ins.describe_query(operation)
        return self._ins.run(
            name,
            attrs,
            qtext,
            lambda: self._cursor.execute(operation, *args, **kwargs),
        )

    def executemany(
        self, operation: Any, seq_of_parameters: Iterable[Any], *args: Any, **kwargs: Any
    ) -> Any:
        name, attrs, qtext = self._ins.describe_query(operation)
        return self._ins.run(
            name,
            attrs,
            qtext,
            lambda: self._cursor.executemany(operation, seq_of_parameters, *args, **kwargs),
        )

    def callproc(self, procname: str, *args: Any, **kwargs: Any) -> Any:
        name, attrs = self._ins.describe_named("CALL", procname)
        return self._ins.run(
            name,
            attrs,
            "",
            lambda: self._cursor.callproc(procname, *args, **kwargs),
        )

    def fetchone(self) -> Any:
        return self._cursor.fetchone()

    def fetchmany(self, size: int | None = None) -> Sequence[Any]:
        if size is None:
            return self._cursor.fetchmany()
        return self._cursor.fetchmany(size)

    def fetchall(self) -> Sequence[Any]:
        return self._cursor.fetchall()

    def close(self) -> None:
        self._cursor.close()

    def __iter__(self) -> Iterator[Any]:
        return iter(self._cursor)

    def __enter__(self) -> WrappedCursor:
        enter = getattr(self._cursor, "__enter__", None)
        if callable(enter):
            enter()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> Any:
        exit_fn = getattr(self._cursor, "__exit__", None)
        if callable(exit_fn):
            return exit_fn(exc_type, exc_val, exc_tb)
        self.close()
        return None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._cursor, name)


class WrappedConnection:
    """DB-API 2 connection wrapper instrumenting cursors, execute, commit, and rollback."""

    def __init__(self, conn: Any, ins: _Instrumenter) -> None:
        self._conn = conn
        self._ins = ins

    @property
    def raw(self) -> Any:
        """Return the underlying unwrapped DB-API 2 connection."""
        return self._conn

    def cursor(self, *args: Any, **kwargs: Any) -> WrappedCursor:
        return WrappedCursor(self._conn.cursor(*args, **kwargs), self._ins)

    def execute(self, operation: Any, *args: Any, **kwargs: Any) -> WrappedCursor:
        name, attrs, qtext = self._ins.describe_query(operation)
        res = self._ins.run(
            name,
            attrs,
            qtext,
            lambda: self._conn.execute(operation, *args, **kwargs),
        )
        return WrappedCursor(res, self._ins)

    def executemany(
        self, operation: Any, seq_of_parameters: Iterable[Any], *args: Any, **kwargs: Any
    ) -> WrappedCursor:
        name, attrs, qtext = self._ins.describe_query(operation)
        res = self._ins.run(
            name,
            attrs,
            qtext,
            lambda: self._conn.executemany(operation, seq_of_parameters, *args, **kwargs),
        )
        return WrappedCursor(res, self._ins)

    def commit(self) -> None:
        name, attrs = self._ins.describe_named("COMMIT")
        self._ins.run(name, attrs, "", self._conn.commit)

    def rollback(self) -> None:
        name, attrs = self._ins.describe_named("ROLLBACK")
        self._ins.run(name, attrs, "", self._conn.rollback)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> WrappedConnection:
        enter = getattr(self._conn, "__enter__", None)
        if callable(enter):
            enter()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> Any:
        exit_fn = getattr(self._conn, "__exit__", None)
        if callable(exit_fn):
            return exit_fn(exc_type, exc_val, exc_tb)
        self.close()
        return None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._conn, name)


def wrap(
    conn: Any,
    *,
    system: str | None = None,
    namespace: str | None = None,
    telemetry: Telemetry | None = None,
    query_text: bool = True,
) -> WrappedConnection:
    """Wrap a DB-API 2 connection with libo11y tracing and duration metrics."""
    resolved_system = system if system else _infer_system(conn)
    ins = _Instrumenter(
        system=resolved_system,
        namespace=namespace,
        telemetry=telemetry,
        query_text=query_text,
    )
    return WrappedConnection(conn, ins)


class PoolMetricsRegistration:
    """Handle returned by register_pool_metrics; call unregister() when closing the pool."""

    def __init__(self, stop_event: threading.Event) -> None:
        self._stop = stop_event

    def unregister(self) -> None:
        """Stop reporting metrics for the registered pool."""
        self._stop.set()

    def __enter__(self) -> PoolMetricsRegistration:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        self.unregister()


def register_pool_metrics(
    pool: Any,
    *,
    pool_name: str | None = None,
    system: str = "postgresql",
    telemetry: Telemetry | None = None,
) -> PoolMetricsRegistration:
    """Register db.client.connection.count and db.client.connection.max for a psycopg_pool."""
    mp = telemetry.meter_provider if telemetry is not None else metrics.get_meter_provider()
    meter = mp.get_meter(_SCOPE_NAME)
    name = pool_name or getattr(pool, "name", None) or system
    stop = threading.Event()

    def _observe_count(_options: CallbackOptions) -> list[Observation]:
        if stop.is_set() or getattr(pool, "closed", False):
            return []
        stats = pool.get_stats()
        size = int(stats.get("pool_size", 0))
        available = int(stats.get("pool_available", 0))
        used = max(0, size - available)
        return [
            Observation(
                available,
                {
                    "db.client.connection.pool.name": str(name),
                    "db.client.connection.state": "idle",
                },
            ),
            Observation(
                used,
                {
                    "db.client.connection.pool.name": str(name),
                    "db.client.connection.state": "used",
                },
            ),
        ]

    def _observe_max(_options: CallbackOptions) -> list[Observation]:
        if stop.is_set() or getattr(pool, "closed", False):
            return []
        stats = pool.get_stats()
        max_conns = int(stats.get("pool_max", 0))
        if max_conns <= 0:
            return []
        return [
            Observation(
                max_conns,
                {"db.client.connection.pool.name": str(name)},
            )
        ]

    meter.create_observable_up_down_counter(
        "db.client.connection.count",
        callbacks=[_observe_count],
        unit="{connection}",
        description="The number of connections currently in each state.",
    )
    meter.create_observable_up_down_counter(
        "db.client.connection.max",
        callbacks=[_observe_max],
        unit="{connection}",
        description="The maximum number of open connections allowed.",
    )
    return PoolMetricsRegistration(stop)


__all__ = [
    "DB_DURATION_BUCKETS",
    "PoolMetricsRegistration",
    "WrappedConnection",
    "WrappedCursor",
    "register_pool_metrics",
    "wrap",
]
