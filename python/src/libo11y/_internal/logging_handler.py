"""Standard-library logging.Handler with console JSON/text fan-out and OTLP bridge."""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
import traceback
from collections.abc import Generator, Mapping
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from datetime import UTC, datetime
from types import TracebackType
from typing import Any, Final, TextIO

from opentelemetry import trace
from opentelemetry.sdk._logs import LoggerProvider

from libo11y._internal.logs_bridge import emit_otel_log
from libo11y._internal.policy import SensitivityPolicy
from libo11y.options import AttrReplacer, ConsoleFormat, ErrorHandler

_FORCE_EMIT: ContextVar[bool] = ContextVar("libo11y_force_emit", default=False)
_IN_HANDLER: ContextVar[bool] = ContextVar("libo11y_in_log_handler", default=False)

# Standard attributes present on every Python LogRecord (not user extra fields).
_STANDARD_LOG_ATTRS: Final[frozenset[str]] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "message",
        "module",
        "msecs",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)


# Correlation keys only the pipeline writes, at the top level of every record
# emitted inside a valid span (go/internal/fanout/fanout.go).
TRACE_ID_KEY: Final[str] = "trace_id"
SPAN_ID_KEY: Final[str] = "span_id"
_RESERVED_ATTR_KEYS: Final[frozenset[str]] = frozenset({TRACE_ID_KEY, SPAN_ID_KEY})

# Top-level console keys the formatter writes itself; user attributes never duplicate them.
_CONSOLE_KEYS: Final[frozenset[str]] = frozenset(
    {"time", "level", "msg", TRACE_ID_KEY, SPAN_ID_KEY}
)

_EXCEPTION_TYPE: Final[str] = "exception.type"
_EXCEPTION_MESSAGE: Final[str] = "exception.message"
_EXCEPTION_STACKTRACE: Final[str] = "exception.stacktrace"

type _ExcInfo = (
    tuple[type[BaseException], BaseException, TracebackType | None] | tuple[None, None, None]
)


@contextmanager
def force_emit() -> Generator[None]:
    """Context manager whose log records bypass the libo11y handler's level gates.

    Inside the block the libo11y logging handler accepts a record at any
    level and delivers it to every leg (console, OTLP and each extra log
    handler) whatever that leg's own level. Filters, attribute replacement,
    sensitivity classification and correlation still apply.

    The gate it bypasses is the handler's, not the standard library's. A
    record the originating logger's own level rejects (for example a DEBUG
    call on a logger that inherits the root INFO level) is dropped by
    logging before any handler runs, so force_emit cannot deliver it. Lower
    that logger's level, or use Telemetry.event, which builds the record
    itself and is the structural always-emit path.
    """
    token = _FORCE_EMIT.set(True)
    try:
        yield
    finally:
        _FORCE_EMIT.reset(token)


def default_error_handler(exc: Exception) -> None:
    """Write internal telemetry errors directly to sys.stderr, never via logging."""
    with suppress(OSError):
        sys.stderr.write(f"libo11y: internal error: {exc}\n")


def _level_name(levelno: int) -> str:
    if levelno >= logging.CRITICAL:
        return "FATAL"
    if levelno >= logging.ERROR:
        return "ERROR"
    if levelno >= logging.WARNING:
        return "WARN"
    if levelno >= logging.INFO:
        return "INFO"
    return "DEBUG"


def _json_default(obj: Any) -> Any:
    if isinstance(obj, (bytes, bytearray)):
        return obj.decode("utf-8", errors="replace")
    return str(obj)


def _format_logfmt_value(val: Any) -> str:
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, (int, float)):
        return str(val)
    s = val if isinstance(val, str) else json.dumps(val, default=_json_default)
    if not s or any(ch in s for ch in (" ", '"', "=", "\n", "\r", "\t")):
        return json.dumps(s)
    return s


def _format_console_line(
    fmt: ConsoleFormat,
    timestamp_s: float,
    level: str,
    msg: str,
    trace_id: str | None,
    span_id: str | None,
    attrs: Mapping[str, Any],
) -> str:
    iso_time = datetime.fromtimestamp(timestamp_s, tz=UTC).isoformat().replace("+00:00", "Z")
    if fmt is ConsoleFormat.TEXT:
        parts = [f"time={iso_time}", f"level={level}", f"msg={_format_logfmt_value(msg)}"]
        if trace_id:
            parts.append(f"trace_id={trace_id}")
        if span_id:
            parts.append(f"span_id={span_id}")
        for k, v in attrs.items():
            if k not in _CONSOLE_KEYS:
                parts.append(f"{k}={_format_logfmt_value(v)}")
        return " ".join(parts) + "\n"

    payload: dict[str, Any] = {
        "time": iso_time,
        "level": level,
        "msg": msg,
    }
    if trace_id:
        payload["trace_id"] = trace_id
    if span_id:
        payload["span_id"] = span_id
    for k, v in attrs.items():
        if k not in _CONSOLE_KEYS:
            payload[k] = v
    return json.dumps(payload, separators=(",", ":"), default=_json_default) + "\n"


def _extract_extra(record: logging.LogRecord) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in record.__dict__.items():
        if k in _STANDARD_LOG_ATTRS or k.startswith("_o11y_"):
            continue
        out[k] = v
    return out


def _without_reserved(attrs: Mapping[str, Any]) -> dict[str, Any]:
    """Drop top-level trace_id and span_id, which only the pipeline writes (SPEC section 4)."""
    return {k: v for k, v in attrs.items() if k not in _RESERVED_ATTR_KEYS}


def _exception_type_name(exc_type: type[BaseException]) -> str:
    """Qualified class name, rendered as the OpenTelemetry Python SDK renders it."""
    module = exc_type.__module__
    qualname = exc_type.__qualname__
    return f"{module}.{qualname}" if module and module != "builtins" else qualname


def _add_exception_attributes(attrs: dict[str, Any], exc_info: _ExcInfo | None) -> None:
    """Map a record's exc_info to the semconv exception attributes the caller did not set."""
    if not exc_info:
        return
    exc_type, exc, tb = exc_info
    if exc_type is None or exc is None:
        return
    attrs.setdefault(_EXCEPTION_TYPE, _exception_type_name(exc_type))
    attrs.setdefault(_EXCEPTION_MESSAGE, str(exc))
    attrs.setdefault(_EXCEPTION_STACKTRACE, "".join(traceback.format_exception(exc_type, exc, tb)))


def _sink_record(
    record: logging.LogRecord,
    attrs: Mapping[str, Any],
    trace_id: str | None,
    span_id: str | None,
) -> logging.LogRecord:
    """Build the record an extra log handler receives.

    It keeps the standard fields of the application's record and carries only
    the classified attributes, prefixed with the correlation ids inside a
    valid span as Go's fanout.Correlate does. The application's record is
    never mutated.
    """
    fields: dict[str, Any] = {k: v for k, v in record.__dict__.items() if k in _STANDARD_LOG_ATTRS}
    if trace_id is not None and span_id is not None:
        fields[TRACE_ID_KEY] = trace_id
        fields[SPAN_ID_KEY] = span_id
    for k, v in attrs.items():
        if k not in _STANDARD_LOG_ATTRS:
            fields.setdefault(k, v)
    return logging.makeLogRecord(fields)


class O11yLoggingHandler(logging.Handler):
    """Logging handler correlating records to active spans and fanning out to console & OTLP."""

    def __init__(
        self,
        *,
        level: int,
        policy: SensitivityPolicy,
        logger_provider: LoggerProvider,
        console_enabled: bool,
        console_writer: TextIO | None,
        console_format: ConsoleFormat,
        log_export: bool,
        attr_replacer: AttrReplacer | None,
        extra_handlers: tuple[logging.Handler, ...],
        error_handler: ErrorHandler | None,
    ) -> None:
        super().__init__(level=logging.NOTSET)
        self._min_level = level
        self._policy = policy
        self._logger_provider = logger_provider
        self._console_enabled = console_enabled
        self._console_writer = console_writer
        self._console_format = console_format
        self._log_export = log_export
        self._attr_replacer = attr_replacer
        self._extra_handlers = extra_handlers
        self._error_handler = error_handler if error_handler is not None else default_error_handler
        self._write_lock = threading.Lock()

    @property
    def min_level(self) -> int:
        return self._min_level

    def set_min_level(self, level: int) -> None:
        self._min_level = level

    def emit(self, record: logging.LogRecord) -> None:
        self._emit_internal(record, raise_on_error=False)

    def emit_checked(
        self,
        *,
        level: int,
        message: str,
        attributes: Mapping[str, Any],
        logger_name: str = "libo11y",
        raise_on_error: bool = False,
    ) -> None:
        """Emit a structured event record directly, bypassing level gates."""
        rec = logging.LogRecord(
            name=logger_name,
            level=level,
            pathname="",
            lineno=0,
            msg=message,
            args=(),
            exc_info=None,
        )
        for k, v in attributes.items():
            if k not in _STANDARD_LOG_ATTRS:
                setattr(rec, k, v)
        with force_emit():
            self._emit_internal(rec, raise_on_error=raise_on_error, explicit_attrs=attributes)

    def _emit_internal(
        self,
        record: logging.LogRecord,
        *,
        raise_on_error: bool,
        explicit_attrs: Mapping[str, Any] | None = None,
    ) -> None:
        if _IN_HANDLER.get():
            return
        forced = _FORCE_EMIT.get()
        if not forced and record.levelno < self._min_level:
            return

        observed_ns = time.time_ns()
        token = _IN_HANDLER.set(True)
        try:
            source = explicit_attrs if explicit_attrs is not None else _extract_extra(record)
            raw_attrs = _without_reserved(source)
            _add_exception_attributes(raw_attrs, record.exc_info)
            # Filter again so a replacer cannot rename a key into a reserved one.
            classified = _without_reserved(
                self._policy.classify_log_attributes(raw_attrs, self._attr_replacer)
            )

            span = trace.get_current_span()
            sc = span.get_span_context()
            valid_sc = sc if sc.is_valid else None
            trace_id = f"{valid_sc.trace_id:032x}" if valid_sc is not None else None
            span_id = f"{valid_sc.span_id:016x}" if valid_sc is not None else None

            message = record.getMessage()
            level_str = _level_name(record.levelno)
            ts_ns = int(record.created * 1_000_000_000)

            if self._console_enabled:
                line = _format_console_line(
                    self._console_format,
                    record.created,
                    level_str,
                    message,
                    trace_id,
                    span_id,
                    classified,
                )
                writer = self._console_writer if self._console_writer is not None else sys.stdout
                try:
                    with self._write_lock:
                        writer.write(line)
                        writer.flush()
                except Exception as exc:
                    if raise_on_error:
                        raise
                    self._report_error(exc)

            if self._log_export:
                try:
                    emit_otel_log(
                        self._logger_provider,
                        timestamp_ns=ts_ns,
                        observed_timestamp_ns=observed_ns,
                        levelno=record.levelno,
                        body=message,
                        attributes=classified,
                        span_context=valid_sc,
                        logger_name=record.name,
                    )
                except Exception as exc:
                    if raise_on_error:
                        raise
                    self._report_error(exc)

            for extra_handler in self._extra_handlers:
                if not forced and record.levelno < extra_handler.level:
                    continue
                try:
                    # handle() applies the handler's filters and lock before emit().
                    extra_handler.handle(_sink_record(record, classified, trace_id, span_id))
                except Exception as exc:
                    if raise_on_error:
                        raise
                    self._report_error(exc)
        except Exception as exc:
            if raise_on_error:
                raise
            self._report_error(exc)
        finally:
            _IN_HANDLER.reset(token)

    def _report_error(self, exc: Exception) -> None:
        with suppress(Exception):
            self._error_handler(exc)
