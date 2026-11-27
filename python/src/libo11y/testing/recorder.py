"""Hermetic in-memory Recorder and specification conformance assertions."""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from types import TracebackType
from typing import Any, cast

from opentelemetry import trace
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics import TraceBasedExemplarFilter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON

from libo11y._internal.logging_handler import _STANDARD_LOG_ATTRS  # pyright: ignore[reportPrivateUsage]
from libo11y._internal.policy import RULE_SECRET
from libo11y.options import HERMETIC
from libo11y.spec import (
    ATTR_RULE,
    ATTR_SIGNAL,
    EVENT_NAME_KEY,
    EVENTS,
    METRIC_SCHEMA_VIOLATIONS,
    REQUIRED_TIER0,
    SENSITIVITY_OF,
    Environment,
    Sensitivity,
)
from libo11y.telemetry import ShutdownReport, Telemetry, init


@dataclass(frozen=True, slots=True)
class CapturedLog:
    """One captured log record together with the active span context at emission."""

    level: int
    message: str
    attributes: Mapping[str, Any]
    trace_id: str | None
    span_id: str | None
    record: logging.LogRecord

    def attr(self, key: str) -> Any | None:
        return self.attributes.get(key)


class _LogCaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.NOTSET)
        self._lock = threading.Lock()
        self._records: list[CapturedLog] = []

    def emit(self, record: logging.LogRecord) -> None:
        sc = trace.get_current_span().get_span_context()
        trace_id = f"{sc.trace_id:032x}" if sc.is_valid else None
        span_id = f"{sc.span_id:016x}" if sc.is_valid else None
        attrs: dict[str, Any] = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _STANDARD_LOG_ATTRS and not k.startswith("_o11y_")
        }
        entry = CapturedLog(
            level=record.levelno,
            message=record.getMessage(),
            attributes=attrs,
            trace_id=trace_id,
            span_id=span_id,
            record=record,
        )
        with self._lock:
            self._records.append(entry)

    def snapshot(self) -> list[CapturedLog]:
        with self._lock:
            return list(self._records)


def _walk_attr_keys(prefix: str, attrs: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    for k, v in attrs.items():
        full = f"{prefix}.{k}" if prefix else str(k)
        out.append(full)
        if isinstance(v, Mapping):
            out.extend(_walk_attr_keys(full, cast(Mapping[str, Any], v)))
    return out


class _CapturingMetricReader(InMemoryMetricReader):
    """InMemoryMetricReader that preserves exemplars across force_flush() and collect()."""

    def __init__(self) -> None:
        super().__init__()
        self._exemplars: dict[str, list[Any]] = {}

    def _receive_metrics(
        self,
        metrics_data: Any,
        timeout_millis: float = 10_000,
        **kwargs: Any,
    ) -> None:
        super()._receive_metrics(  # pyright: ignore[reportUnknownMemberType]
            metrics_data, timeout_millis=timeout_millis, **kwargs
        )
        with self._lock:
            for rm in metrics_data.resource_metrics:
                for sm in rm.scope_metrics:
                    for m in sm.metrics:
                        for dp in m.data.data_points:
                            exs = getattr(dp, "exemplars", None)
                            if exs:
                                self._exemplars.setdefault(m.name, []).extend(exs)

    def captured_exemplars(self, metric_name: str) -> list[Any]:
        with self._lock:
            self.collect()
            return list(self._exemplars.get(metric_name, ()))


class Recorder:
    """Hermetic in-memory telemetry recorder for unit and integration tests."""

    def __init__(
        self,
        *,
        telemetry: Telemetry,
        span_exporter: InMemorySpanExporter,
        metric_reader: _CapturingMetricReader,
        log_exporter: InMemoryLogRecordExporter,
        log_capture: _LogCaptureHandler,
    ) -> None:
        self.telemetry = telemetry
        self._span_exporter = span_exporter
        self._metric_reader = metric_reader
        self._log_exporter = log_exporter
        self._log_capture = log_capture
        self._attached_loggers: list[logging.Logger] = []

    def logger(self, name: str = "libo11y.test") -> logging.Logger:
        """Return a non-propagating stdlib logger wired to this Recorder's handler."""
        lg = logging.getLogger(name)
        lg.setLevel(logging.DEBUG)
        lg.propagate = False
        handler = self.telemetry.logging_handler()
        if handler not in lg.handlers:
            lg.addHandler(handler)
            self._attached_loggers.append(lg)
        return lg

    def spans(self) -> list[ReadableSpan]:
        """Return all finished spans recorded so far."""
        return list(self._span_exporter.get_finished_spans())

    def logs(self) -> list[CapturedLog]:
        """Return all log records captured by the harness handler."""
        return self._log_capture.snapshot()

    def otel_logs(self) -> list[ReadableLogRecord]:
        """Flush and return all OTLP SDK log records exported in memory."""
        self.telemetry.force_flush()
        return list(self._log_exporter.get_finished_logs())

    def metric_names(self) -> list[str]:
        """Collect metrics and return the sorted names of all recorded instruments."""
        data = self._metric_reader.get_metrics_data()
        if data is None:
            return []
        names: set[str] = set()
        for rm in data.resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    names.add(m.name)
        return sorted(names)

    def metric_points(self, name: str) -> list[dict[str, Any]]:
        """Collect and return all data points recorded for metric name."""
        data = self._metric_reader.get_metrics_data()
        if data is None:
            return []
        out: list[dict[str, Any]] = []
        for rm in data.resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    if m.name != name:
                        continue
                    for dp in m.data.data_points:
                        out.append(
                            {
                                "attributes": dict(dp.attributes) if dp.attributes else {},
                                "value": getattr(dp, "value", getattr(dp, "sum", None)),
                                "count": getattr(dp, "count", None),
                                "exemplars": list(getattr(dp, "exemplars", ()) or ()),
                            }
                        )
        return out

    def exemplars(self, metric_name: str) -> list[Any]:
        """Return all exemplars recorded on data points of metric_name."""
        return self._metric_reader.captured_exemplars(metric_name)

    def assert_conforms(self) -> None:
        """Assert recorded telemetry conforms to the libo11y specification.

        Raises AssertionError listing every violation found.
        """
        problems: list[str] = []

        # 1. Tier-0 required resource attributes.
        res_attrs = self.telemetry.resource.attributes
        for req_key in REQUIRED_TIER0:
            if req_key not in res_attrs or not str(res_attrs[req_key]).strip():
                problems.append(f"resource missing required tier-0 attribute {req_key!r}")

        # 2. Flush and check secret_attribute violations counted by the policy.
        self.telemetry.force_flush()
        for pt in self.metric_points(METRIC_SCHEMA_VIOLATIONS):
            attrs = pt["attributes"]
            if attrs.get(ATTR_RULE) == RULE_SECRET:
                sig = attrs.get(ATTR_SIGNAL, "unknown")
                val = pt["value"]
                problems.append(
                    f"secret-classified attribute emitted on {sig} ({val} redaction(s) counted)"
                )

        # 3. Check captured OTLP logs for secret keys in the clear and event contracts.
        for rec in self.otel_logs():
            lr = rec.log_record
            attrs_map: Mapping[str, Any] = lr.attributes or {}
            keys = _walk_attr_keys("", attrs_map)
            for k in keys:
                if SENSITIVITY_OF.get(k) is Sensitivity.SECRET:
                    problems.append(
                        f"log record {lr.body!r} carries secret attribute {k!r} in the clear"
                    )
            ev_name = attrs_map.get(EVENT_NAME_KEY)
            if isinstance(ev_name, str) and ev_name in EVENTS:
                contract = EVENTS[ev_name]
                key_set = set(keys)
                for req in contract.required:
                    if req not in key_set:
                        problems.append(f"event {ev_name!r} missing required attribute {req!r}")
                for tpl in contract.required_templates:
                    prefix = f"{tpl}."
                    if not any(k.startswith(prefix) for k in key_set):
                        problems.append(f"event {ev_name!r} missing template attribute '{tpl}.*'")

        # 4. Check finished spans, events, and links for secret keys in the clear.
        for sp in self.spans():
            if sp.attributes:
                for k in sp.attributes:
                    if SENSITIVITY_OF.get(k) is Sensitivity.SECRET:
                        problems.append(
                            f"span {sp.name!r} carries secret attribute {k!r} in the clear"
                        )
            for ev in sp.events:
                if ev.attributes:
                    for k in ev.attributes:
                        if SENSITIVITY_OF.get(k) is Sensitivity.SECRET:
                            problems.append(
                                f"span {sp.name!r} event {ev.name!r} carries secret-classified "
                                f"attribute {k!r} in the clear"
                            )
            for lk in sp.links:
                if lk.attributes:
                    for k in lk.attributes:
                        if SENSITIVITY_OF.get(k) is Sensitivity.SECRET:
                            problems.append(
                                f"span {sp.name!r} link carries secret-classified "
                                f"attribute {k!r} in the clear"
                            )

        if problems:
            raise AssertionError(
                "libo11y conformance check failed:\n  - " + "\n  - ".join(problems)
            )

    def shutdown(self, timeout: float | None = None) -> ShutdownReport:
        handler = self.telemetry.logging_handler()
        for lg in self._attached_loggers:
            lg.removeHandler(handler)
        self._attached_loggers.clear()
        return self.telemetry.shutdown(timeout=timeout)

    def __enter__(self) -> Recorder:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        self.shutdown()


def start_recorder(
    service_name: str = "libo11y-test",
    **kwargs: Any,
) -> Recorder:
    """Create a hermetic in-memory Recorder without touching process globals."""
    span_exporter = InMemorySpanExporter()
    metric_reader = _CapturingMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    log_capture = _LogCaptureHandler()

    extra_handlers: tuple[logging.Handler, ...] = kwargs.pop("extra_log_handlers", ())
    defaults: dict[str, Any] = {
        "service_name": service_name,
        "version": "0.0.0-test",
        "environment": str(Environment.TEST),
        "env": HERMETIC,
        "log_level": logging.DEBUG,
        "console_enabled": False,
        "runtime_metrics": False,
        "sampler": ALWAYS_ON,
        "exemplar_filter": TraceBasedExemplarFilter(),
        "span_processor": SimpleSpanProcessor(span_exporter),
        "metric_reader": metric_reader,
        "log_exporter": log_exporter,
        "extra_log_handlers": (*extra_handlers, log_capture),
    }
    defaults.update(kwargs)
    tel = init(**defaults)
    return Recorder(
        telemetry=tel,
        span_exporter=span_exporter,
        metric_reader=metric_reader,
        log_exporter=log_exporter,
        log_capture=log_capture,
    )
