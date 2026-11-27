"""Standard-library logging.Handler with console JSON/text fan-out and OTLP bridge."""

from __future__ import annotations

import json
import logging
import sys
import threading
from collections.abc import Generator, Mapping
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from datetime import UTC, datetime
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


@contextmanager
def force_emit() -> Generator[None]:
    """Context manager whose log records bypass configured level gates."""
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
        if k not in ("time", "level", "msg", "trace_id", "span_id"):
            payload[k] = v
    return json.dumps(payload, separators=(",", ":"), default=_json_default) + "\n"


def _extract_extra(record: logging.LogRecord) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in record.__dict__.items():
        if k in _STANDARD_LOG_ATTRS or k.startswith("_o11y_"):
            continue
        out[k] = v
    return out


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

        token = _IN_HANDLER.set(True)
        try:
            raw_attrs = (
                dict(explicit_attrs) if explicit_attrs is not None else _extract_extra(record)
            )
            classified = self._policy.classify_log_attributes(raw_attrs, self._attr_replacer)

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
                try:
                    if forced or record.levelno >= extra_handler.level:
                        extra_handler.emit(record)
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
