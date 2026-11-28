"""Isolated bridge to OpenTelemetry Python's private _logs API and SDK (P-D1).

Every import of opentelemetry._logs and opentelemetry.sdk._logs in libo11y's
runtime lives behind this module so SDK 1.45.* changes are contained in one place.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from opentelemetry import _logs as logs_api
from opentelemetry import metrics, trace
from opentelemetry._logs import LogRecord, SeverityNumber
from opentelemetry._logs._internal import ProxyLoggerProvider
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter as HttpLogExporter
from opentelemetry.metrics._internal import _ProxyMeterProvider  # pyright: ignore[reportPrivateUsage]
from opentelemetry.sdk._logs import (
    LoggerProvider,
    LogRecordLimits,
    LogRecordProcessor,
    ReadableLogRecord,
    ReadWriteLogRecord,
)
from opentelemetry.sdk._logs.export import (
    BatchLogRecordProcessor,
    ConsoleLogRecordExporter,
    LogRecordExporter,
    LogRecordExportResult,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import SpanContext
from opentelemetry.util._decorator import _agnosticcontextmanager  # pyright: ignore[reportPrivateUsage]
from opentelemetry.util.types import AnyValue, Attributes

from libo11y._internal.env import SDK_DISABLED, EnvView
from libo11y._internal.exporters import (
    ExportFailures,
    attribute_limits,
    batch_settings,
    build_grpc_exporter,
    build_http_exporter,
    select_exporter_kind,
    select_otlp_protocol,
    shutdown_exporter,
)
from libo11y._internal.policy import SensitivityPolicy
from libo11y.errors import ForeignProvider, O11yError
from libo11y.options import Options

__all__ = [
    "GlobalLoggerProvider",
    "LogPipeline",
    "LogRecordExporter",
    "LoggerProvider",
    "ObservedLogExporter",
    "PolicyLogRecordProcessor",
    "build_log_exporter",
    "build_logger_provider",
    "emit_otel_log",
    "register_global_providers",
    "severity_for_level",
    "span_contextmanager",
]

_ALREADY_CLASSIFIED: ContextVar[bool] = ContextVar("libo11y_log_already_classified", default=False)
span_contextmanager = _agnosticcontextmanager

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
    general_count = env.get_int("OTEL_ATTRIBUTE_COUNT_LIMIT", 128, minimum=0)
    general_length = env.get_int("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", -1, minimum=0)
    log_count, log_length = attribute_limits(
        env, "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT"
    )
    limits = LogRecordLimits(
        max_attributes=general_count,
        max_attribute_length=max(general_length, 0),
        max_log_record_attributes=log_count,
        max_log_record_attribute_length=log_length if log_length is not None else 0,
    )
    # LogRecordLimits reads the process environment for a limit given as None,
    # so the unlimited lengths are set after construction.
    if general_length < 0:
        limits.max_attribute_length = None
    if log_length is None:
        limits.max_log_record_attribute_length = None
    return limits


def build_log_exporter(env: EnvView) -> tuple[LogRecordExporter | None, str]:
    """Build the log record exporter the environment selects, and name its kind."""
    kind = select_exporter_kind(env, "LOGS")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return ConsoleLogRecordExporter(), "console"
    if select_otlp_protocol(env, "LOGS") == "grpc":
        exporter = build_grpc_exporter(
            env, "LOGS", exporter_type=LogRecordExporter, result=LogRecordExportResult
        )
        return exporter, "otlp"
    return build_http_exporter(HttpLogExporter, env, "LOGS", "v1/logs"), "otlp"


class ObservedLogExporter(LogRecordExporter):
    """Reports every failed log export to an ExportFailures, changing nothing else."""

    def __init__(self, inner: LogRecordExporter, failures: ExportFailures) -> None:
        self._inner = inner
        self._failures = failures

    def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
        if self._failures.abandoned:
            return LogRecordExportResult.SUCCESS
        try:
            result = self._inner.export(batch)
        except Exception as exc:
            self._failures.record(exc)
            raise
        if result is not LogRecordExportResult.SUCCESS:
            self._failures.rejected()
        return result

    def shutdown(self, timeout_millis: float = 30_000) -> None:
        shutdown_exporter(self._inner.shutdown, timeout_millis)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._inner.force_flush(timeout_millis)


@dataclass(frozen=True, slots=True)
class LogPipeline:
    """The logger provider of one SDK and what the effective configuration says of it."""

    provider: LoggerProvider
    exporter_kind: str
    failures: ExportFailures


def build_logger_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> LogPipeline:
    """Build a local LoggerProvider with explicit limits and policy processor.

    While the SDK is disabled, or with log export switched off, the provider
    has no processor, so an injected exporter receives nothing.
    """
    failures = ExportFailures("logs")
    provider = LoggerProvider(
        resource=resource,
        shutdown_on_exit=False,
        log_record_limits=_build_log_limits(env),
    )

    # Upstream gap check: LoggerProvider always reads os.environ["OTEL_SDK_DISABLED"]
    # directly. In hermetic mode, fail fast if ambient OTEL_SDK_DISABLED turned it off.
    if env.hermetic and getattr(provider, "_disabled", False):
        raise O11yError(f"o11y: hermetic LoggerProvider was disabled by ambient {SDK_DISABLED}")

    if disabled or not opts.log_export:
        return LogPipeline(provider, "none", failures)

    exporter: LogRecordExporter | None
    if opts.log_exporter is not None:
        exporter = opts.log_exporter
        kind = "injected"
    else:
        exporter, kind = build_log_exporter(env)

    if exporter is not None:
        settings = batch_settings(env, "BLRP", default_delay_millis=1000)
        # The logging handler already ran the counting policy once on records
        # that came through Python logging. Records from direct OpenTelemetry
        # logger callers are classified and counted by this processor.
        processor = PolicyLogRecordProcessor(
            BatchLogRecordProcessor(
                ObservedLogExporter(exporter, failures),
                schedule_delay_millis=settings.schedule_delay_millis,
                max_export_batch_size=settings.max_export_batch_size,
                export_timeout_millis=settings.export_timeout_millis,
                max_queue_size=settings.max_queue_size,
            ),
            policy,
        )
        provider.add_log_record_processor(processor)

    return LogPipeline(provider, kind, failures)


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


class _GlobalLogger(logs_api.Logger):
    """A logger of the global provider. Each record goes to the SDK that is set up then."""

    def __init__(
        self,
        provider: GlobalLoggerProvider,
        name: str,
        version: str | None,
        schema_url: str | None,
        attributes: Attributes,
    ) -> None:
        super().__init__(name, version, schema_url, attributes)
        self._provider = provider
        self._noop = logs_api.NoOpLogger(name, version, schema_url, attributes)

    def _logger(self) -> logs_api.Logger:
        target = self._provider.target
        if target is None:
            return self._noop
        return target.get_logger(self._name, self._version, self._schema_url, self._attributes)

    def emit(
        self,
        record: LogRecord | None = None,
        *,
        timestamp: int | None = None,
        observed_timestamp: int | None = None,
        context: Context | None = None,
        severity_number: SeverityNumber | None = None,
        severity_text: str | None = None,
        body: AnyValue | None = None,
        attributes: Attributes = None,
        event_name: str | None = None,
        exception: BaseException | None = None,
    ) -> None:
        logger = self._logger()
        if record is not None:
            logger.emit(record)
            return
        logger.emit(
            timestamp=timestamp,
            observed_timestamp=observed_timestamp,
            context=context,
            severity_number=severity_number,
            severity_text=severity_text,
            body=body,
            attributes=attributes,
            event_name=event_name,
            exception=exception,
        )

    def enabled(
        self,
        *,
        context: Context | None = None,
        severity_number: SeverityNumber | None = None,
        event_name: str | None = None,
    ) -> bool:
        return self._logger().enabled(
            context=context, severity_number=severity_number, event_name=event_name
        )


class GlobalLoggerProvider(logs_api.LoggerProvider):
    """The logger provider setup() installs as the process global, once per process.

    OpenTelemetry lets the global logger provider be set once. This provider
    is that one value. It hands each record to the logger provider of the
    Telemetry that is set up at the time, and to a no-op logger when none
    is, so a logger obtained from the global API before, between or after
    setups keeps working and never reaches an SDK that was shut down.
    """

    def __init__(self) -> None:
        self._target: logs_api.LoggerProvider | None = None

    @property
    def target(self) -> logs_api.LoggerProvider | None:
        """The logger provider records currently go to, or None when no SDK is set up."""
        return self._target

    def bind(self, target: logs_api.LoggerProvider) -> None:
        """Send records to target from now on."""
        self._target = target

    def unbind(self, target: logs_api.LoggerProvider) -> None:
        """Stop sending records to target, if it is the current target."""
        if self._target is target:
            self._target = None

    def get_logger(
        self,
        name: str,
        version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes = None,
    ) -> logs_api.Logger:
        return _GlobalLogger(self, name, version, schema_url, attributes)


def register_global_providers(
    tracer: trace.TracerProvider,
    meter: metrics.MeterProvider,
    logger: GlobalLoggerProvider,
    *,
    install: bool,
) -> None:
    """Check ownership of all providers before registering through the public setters."""
    current_trace = trace.get_tracer_provider()
    current_meter = metrics.get_meter_provider()
    current_logs = logs_api.get_logger_provider()
    if current_trace is not tracer and not isinstance(current_trace, trace.ProxyTracerProvider):
        raise ForeignProvider("traces")
    if current_meter is not meter and not isinstance(current_meter, _ProxyMeterProvider):
        raise ForeignProvider("metrics")
    if current_logs is not logger and not isinstance(current_logs, ProxyLoggerProvider):
        raise ForeignProvider("logs")
    if not install:
        return

    if current_meter is not meter:
        metrics.set_meter_provider(meter)
        if metrics.get_meter_provider() is not meter:
            raise ForeignProvider("metrics")
    if current_trace is not tracer:
        trace.set_tracer_provider(tracer)
        if trace.get_tracer_provider() is not tracer:
            raise ForeignProvider("traces")
    if current_logs is not logger:
        logs_api.set_logger_provider(logger)
        if logs_api.get_logger_provider() is not logger:
            raise ForeignProvider("logs")
