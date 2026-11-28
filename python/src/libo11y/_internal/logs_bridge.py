"""Isolated bridge to OpenTelemetry Python's private _logs API and SDK (P-D1).

Every import of opentelemetry._logs and opentelemetry.sdk._logs in libo11y's
runtime lives behind this module so SDK 1.45.* changes are contained in one place.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any

from opentelemetry._logs import LogRecord, SeverityNumber
from opentelemetry.sdk._logs import (
    LoggerProvider,
    LogRecordLimits,
    LogRecordProcessor,
    ReadWriteLogRecord,
)
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor, LogRecordExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import SpanContext

from libo11y._internal.env import EnvView
from libo11y._internal.exporters import build_log_exporter
from libo11y._internal.policy import SensitivityPolicy
from libo11y.errors import O11yError
from libo11y.options import Options

_ALREADY_CLASSIFIED: ContextVar[bool] = ContextVar("libo11y_log_already_classified", default=False)

_SEVERITY_MAP: dict[int, tuple[SeverityNumber, str]] = {
    logging.DEBUG: (SeverityNumber.DEBUG, "DEBUG"),
    logging.INFO: (SeverityNumber.INFO, "INFO"),
    logging.WARNING: (SeverityNumber.WARN, "WARN"),
    logging.ERROR: (SeverityNumber.ERROR, "ERROR"),
    logging.CRITICAL: (SeverityNumber.FATAL, "FATAL"),
}


def severity_for_level(levelno: int) -> tuple[SeverityNumber, str]:
    """Map Python logging level number to OpenTelemetry SeverityNumber and text."""
    if levelno >= logging.CRITICAL:
        return _SEVERITY_MAP[logging.CRITICAL]
    if levelno >= logging.ERROR:
        return _SEVERITY_MAP[logging.ERROR]
    if levelno >= logging.WARNING:
        return _SEVERITY_MAP[logging.WARNING]
    if levelno >= logging.INFO:
        return _SEVERITY_MAP[logging.INFO]
    return _SEVERITY_MAP[logging.DEBUG]


class PolicyLogRecordProcessor(LogRecordProcessor):
    """Wraps a LogRecordProcessor to classify log record attributes via SensitivityPolicy.

    A record emitted directly to an OpenTelemetry logger is classified and
    its violations counted here, once. A record from the libo11y logging
    handler arrives through emit_otel_log already classified and counted, and
    passes through untouched.
    """

    def __init__(self, inner: LogRecordProcessor, policy: SensitivityPolicy) -> None:
        self._inner = inner
        self._policy = policy

    def on_emit(self, log_record: ReadWriteLogRecord) -> None:
        if not _ALREADY_CLASSIFIED.get():
            rec = log_record.log_record
            if rec.attributes:
                classified = self._policy.classify_log_attributes(rec.attributes)
                rec.attributes = classified
        self._inner.on_emit(log_record)

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


def _build_log_limits(env: EnvView) -> LogRecordLimits:
    global_attr = env.get_int("OTEL_ATTRIBUTE_COUNT_LIMIT", 128)
    log_attr = env.get_int("OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", global_attr)
    global_len = env.get_int("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", -1)
    log_len = env.get_int("OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", global_len)
    limits = LogRecordLimits(
        max_attributes=global_attr,
        max_attribute_length=global_len if global_len >= 0 else 0,
        max_log_record_attributes=log_attr,
        max_log_record_attribute_length=log_len if log_len >= 0 else 0,
    )
    if global_len < 0:
        limits.max_attribute_length = None
    if log_len < 0:
        limits.max_log_record_attribute_length = None
    return limits


def build_logger_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> tuple[LoggerProvider, str]:
    """Build a local LoggerProvider with explicit limits and policy processor."""
    limits = _build_log_limits(env)
    provider = LoggerProvider(
        resource=resource,
        shutdown_on_exit=False,
        log_record_limits=limits,
    )

    # Upstream gap check: LoggerProvider always reads os.environ["OTEL_SDK_DISABLED"]
    # directly. In hermetic mode, fail fast if ambient OTEL_SDK_DISABLED turned it off.
    if env.hermetic and getattr(provider, "_disabled", False):
        raise O11yError("o11y: hermetic LoggerProvider was disabled by ambient OTEL_SDK_DISABLED")

    if disabled or not opts.log_export:
        return provider, "none"

    blrp_kwargs: dict[str, Any] = {
        "schedule_delay_millis": float(env.get_int("OTEL_BLRP_SCHEDULE_DELAY", 1000)),
        "max_export_batch_size": env.get_int("OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", 512),
        "export_timeout_millis": float(env.get_int("OTEL_BLRP_EXPORT_TIMEOUT", 30000)),
        "max_queue_size": env.get_int("OTEL_BLRP_MAX_QUEUE_SIZE", 2048),
    }

    exporter: LogRecordExporter | None
    if opts.log_exporter is not None:
        exporter = opts.log_exporter
        kind = "injected"
    else:
        exporter, kind = build_log_exporter(env)

    if exporter is not None:
        # Use silent policy on the processor because the logging handler already
        # ran the counting policy once on records coming through Python logging.
        # Direct OTel logger callers still get classified and counted via policy!
        processor = PolicyLogRecordProcessor(
            BatchLogRecordProcessor(exporter, **blrp_kwargs),
            policy,
        )
        provider.add_log_record_processor(processor)

    return provider, kind


def emit_otel_log(
    provider: LoggerProvider,
    *,
    timestamp_ns: int,
    observed_timestamp_ns: int,
    levelno: int,
    body: str,
    attributes: Mapping[str, Any],
    span_context: SpanContext | None,
    logger_name: str,
) -> None:
    """Emit a classified log record into LoggerProvider without double-counting.

    timestamp_ns is when the event happened and observed_timestamp_ns is when
    the pipeline captured it. The record is marked as classified so
    PolicyLogRecordProcessor does not classify or count it a second time.
    """
    sev_num, sev_text = severity_for_level(levelno)
    otel_logger = provider.get_logger(logger_name or "libo11y")
    kwargs: dict[str, Any] = {
        "timestamp": timestamp_ns,
        "observed_timestamp": observed_timestamp_ns,
        "severity_number": sev_num,
        "severity_text": sev_text,
        "body": body,
        "attributes": dict(attributes),
    }
    if span_context is not None and span_context.is_valid:
        kwargs["trace_id"] = span_context.trace_id
        kwargs["span_id"] = span_context.span_id
        kwargs["trace_flags"] = span_context.trace_flags
    token = _ALREADY_CLASSIFIED.set(True)
    try:
        otel_logger.emit(LogRecord(**kwargs))
    finally:
        _ALREADY_CLASSIFIED.reset(token)
