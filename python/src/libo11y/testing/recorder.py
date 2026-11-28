"""Hermetic in-memory Recorder and specification conformance assertions."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Final, cast

from opentelemetry import trace
from opentelemetry.sdk._logs import LogRecordProcessor, ReadableLogRecord, ReadWriteLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics import Exemplar, TraceBasedExemplarFilter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, MetricsData
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON
from opentelemetry.trace import INVALID_SPAN_CONTEXT, SpanContext

from libo11y._internal.logging_handler import (
    _STANDARD_LOG_ATTRS,  # pyright: ignore[reportPrivateUsage]
    SPAN_ID_KEY,
    TRACE_ID_KEY,
)
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

# Options start_recorder owns. Passing one would make the recorder read the
# environment or stop its queries from seeing what was recorded.
_FIXED_OPTIONS: Final[tuple[str, ...]] = (
    "env",
    "span_exporter",
    "span_processor",
    "metric_reader",
    "log_exporter",
)

_LOGGING_LEG: Final = "logging leg"
_OTLP_LEG: Final = "OTLP leg"


@dataclass(frozen=True, slots=True)
class CapturedLog:
    """One log record captured on the logging leg.

    ``trace_id`` and ``span_id`` are the correlation ids the record carries,
    as lowercase hex, or None outside a span. ``attributes`` holds every other
    classified attribute. ``span_context`` is the span context that was active
    when the record reached the harness, invalid when no span was active, as
    Go's ``o11ytest.LogRecord.SpanContext`` is.
    """

    level: int
    message: str
    attributes: Mapping[str, Any]
    trace_id: str | None
    span_id: str | None
    record: logging.LogRecord
    span_context: SpanContext = INVALID_SPAN_CONTEXT

    def attr(self, key: str) -> Any | None:
        return self.attributes.get(key)


@dataclass(frozen=True, slots=True)
class _Emission:
    """A log record as one leg carries it, with the span context active when it was emitted."""

    body: str
    trace_id: int
    span_id: int
    active_trace_id: int
    active_span_id: int


def _ids_of_current_span() -> tuple[int, int]:
    sc = trace.get_current_span().get_span_context()
    return (sc.trace_id, sc.span_id) if sc.is_valid else (0, 0)


def _carried_id(record: logging.LogRecord, key: str) -> str | None:
    value = record.__dict__.get(key)
    return value if isinstance(value, str) and value else None


def _hex_id(value: str | None) -> int:
    if value is None:
        return 0
    try:
        return int(value, 16)
    except ValueError:
        return 0


class _LogCaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.NOTSET)
        self._lock = threading.Lock()
        self._records: list[CapturedLog] = []

    def emit(self, record: logging.LogRecord) -> None:
        sc = trace.get_current_span().get_span_context()
        attrs: dict[str, Any] = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _STANDARD_LOG_ATTRS
            and k not in (TRACE_ID_KEY, SPAN_ID_KEY)
            and not k.startswith("_o11y_")
        }
        entry = CapturedLog(
            level=record.levelno,
            message=record.getMessage(),
            attributes=attrs,
            trace_id=_carried_id(record, TRACE_ID_KEY),
            span_id=_carried_id(record, SPAN_ID_KEY),
            record=record,
            span_context=sc if sc.is_valid else INVALID_SPAN_CONTEXT,
        )
        with self._lock:
            self._records.append(entry)

    def snapshot(self) -> list[CapturedLog]:
        with self._lock:
            return list(self._records)


class _EmissionProcessor(LogRecordProcessor):
    """Notes, at emit time, the span ids each SDK log record carries and the active span's."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._emissions: list[_Emission] = []

    def on_emit(self, log_record: ReadWriteLogRecord) -> None:
        active_trace_id, active_span_id = _ids_of_current_span()
        lr = log_record.log_record
        entry = _Emission(
            body=str(lr.body),
            trace_id=lr.trace_id or 0,
            span_id=lr.span_id or 0,
            active_trace_id=active_trace_id,
            active_span_id=active_span_id,
        )
        with self._lock:
            self._emissions.append(entry)

    def snapshot(self) -> list[_Emission]:
        with self._lock:
            return list(self._emissions)

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        del timeout_millis
        return True


def _walk_attr_keys(prefix: str, attrs: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    for k, v in attrs.items():
        full = f"{prefix}.{k}" if prefix else str(k)
        out.append(full)
        if isinstance(v, Mapping):
            out.extend(_walk_attr_keys(full, cast(Mapping[str, Any], v)))
    return out


def _check_event(name: str, keys: Sequence[str]) -> list[str]:
    """Every way a record for event name, carrying keys, breaks its registered contract.

    It matches Go's conformance.CheckEvent. An unregistered name has no contract.
    """
    contract = EVENTS.get(name)
    if contract is None:
        return []
    present = set(keys)
    problems = [
        f"event {name}: missing required attribute {req}"
        for req in contract.required
        if req not in present
    ]
    for tmpl in contract.required_templates:
        prefix = f"{tmpl}."
        # A bare "<template>." carries no key, so it does not satisfy the template.
        if not any(len(k) > len(prefix) and k.startswith(prefix) for k in keys):
            problems.append(f"event {name}: missing required template attribute {prefix}<key>")
    return problems


def _log_problems(leg: str, body: object, attrs: Mapping[str, Any]) -> list[str]:
    keys = _walk_attr_keys("", attrs)
    problems = [
        f"{leg}: log record {body!r} carries secret-classified attribute {k!r} in the clear"
        for k in keys
        if SENSITIVITY_OF.get(k) is Sensitivity.SECRET
    ]
    event_name = attrs.get(EVENT_NAME_KEY)
    if isinstance(event_name, str):
        problems.extend(f"{leg}: {p}" for p in _check_event(event_name, keys))
    return problems


def _correlation_problems(leg: str, emissions: Iterable[_Emission]) -> list[str]:
    problems: list[str] = []
    for e in emissions:
        if not e.active_trace_id:
            continue
        if not e.trace_id:
            problems.append(f"{leg}: correlated record {e.body!r} has no trace_id")
            continue
        if e.trace_id != e.active_trace_id:
            problems.append(
                f"{leg}: record {e.body!r} trace_id '{e.trace_id:032x}'"
                f" does not match its span '{e.active_trace_id:032x}'"
            )
        if not e.span_id:
            problems.append(f"{leg}: correlated record {e.body!r} has no span_id")
        elif e.span_id != e.active_span_id:
            problems.append(
                f"{leg}: record {e.body!r} span_id '{e.span_id:016x}'"
                f" does not match its span '{e.active_span_id:016x}'"
            )
    return problems


def _fail(title: str, problems: Sequence[str]) -> None:
    if problems:
        raise AssertionError(f"{title}:\n  - " + "\n  - ".join(problems))


class _CapturingMetricReader(InMemoryMetricReader):
    """InMemoryMetricReader that preserves exemplars across force_flush() and collect()."""

    def __init__(self) -> None:
        super().__init__()
        self._exemplars: dict[str, list[Exemplar]] = {}

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

    def captured_exemplars(self, metric_name: str) -> list[Exemplar]:
        with self._lock:
            self.collect()
            return list(self._exemplars.get(metric_name, ()))


class Recorder:
    """Hermetic in-memory telemetry recorder for unit and integration tests.

    Log records reach the recorder on two legs: the logging leg, the standard
    library records its logging handler receives (``logs()``), and the OTLP
    leg, the SDK log records sent to the OTLP pipeline (``otel_logs()``).
    """

    def __init__(
        self,
        *,
        telemetry: Telemetry,
        span_exporter: InMemorySpanExporter,
        metric_reader: _CapturingMetricReader,
        log_exporter: InMemoryLogRecordExporter,
        log_capture: _LogCaptureHandler,
        log_emissions: _EmissionProcessor,
    ) -> None:
        self.telemetry = telemetry
        self._span_exporter = span_exporter
        self._metric_reader = metric_reader
        self._log_exporter = log_exporter
        self._log_capture = log_capture
        self._log_emissions = log_emissions
        self._loggers_lock = threading.Lock()
        self._loggers: dict[str, logging.Logger] = {}

    def logger(self, name: str = "libo11y.test") -> logging.Logger:
        """Return a stdlib logger owned by this Recorder and wired to its handler.

        The logger is not registered in the process-wide logging tree, so
        ``logging.getLogger(name)`` returns a different logger and no other
        recorder or library sees its records. Repeated calls with the same name
        return the same logger. Code under test that logs through
        ``logging.getLogger`` needs ``telemetry.logging_handler()`` attached by
        the test itself.
        """
        with self._loggers_lock:
            lg = self._loggers.get(name)
            if lg is None:
                # Built directly rather than through logging.getLogger so that
                # its level, handlers and propagation belong to this recorder.
                lg = logging.Logger(name, logging.DEBUG)
                lg.propagate = False
                lg.addHandler(self.telemetry.logging_handler())
                self._loggers[name] = lg
            return lg

    def spans(self) -> list[ReadableSpan]:
        """Return all finished spans recorded so far."""
        return list(self._span_exporter.get_finished_spans())

    def logs(self) -> list[CapturedLog]:
        """Return all log records captured on the logging leg."""
        return self._log_capture.snapshot()

    def otel_logs(self) -> list[ReadableLogRecord]:
        """Flush and return all SDK log records exported in memory on the OTLP leg."""
        self.telemetry.force_flush()
        return list(self._log_exporter.get_finished_logs())

    def metrics(self) -> MetricsData:
        """Collect and return the current state of every instrument."""
        data = self._metric_reader.get_metrics_data()
        return data if data is not None else MetricsData(resource_metrics=[])

    def metric_names(self) -> list[str]:
        """Collect metrics and return the sorted names of all recorded instruments."""
        names: set[str] = set()
        for rm in self.metrics().resource_metrics:
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    names.add(m.name)
        return sorted(names)

    def metric_points(self, name: str) -> list[dict[str, Any]]:
        """Collect and return all data points recorded for metric name."""
        out: list[dict[str, Any]] = []
        for rm in self.metrics().resource_metrics:
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

    def exemplars(self, metric_name: str) -> list[Exemplar]:
        """Return all exemplars recorded on data points of metric_name."""
        return self._metric_reader.captured_exemplars(metric_name)

    def assert_conforms(self) -> None:
        """Assert recorded telemetry conforms to the libo11y specification.

        It checks the tier-0 resource attributes, the secret_attribute
        violations the policy counted, secret-classified attributes in the
        clear on both log legs and on spans, and every registered event on
        both log legs against its contract in ``libo11y.spec.EVENTS``.

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

        # 3. Both log legs: secret keys in the clear and registered event contracts.
        for captured in self.logs():
            problems.extend(_log_problems(_LOGGING_LEG, captured.message, captured.attributes))
        for rec in self.otel_logs():
            lr = rec.log_record
            problems.extend(_log_problems(_OTLP_LEG, lr.body, lr.attributes or {}))

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

        _fail("libo11y conformance check failed", problems)

    def _correlation_problems(self) -> list[str]:
        logging_leg = [
            _Emission(
                body=c.message,
                trace_id=_hex_id(c.trace_id),
                span_id=_hex_id(c.span_id),
                active_trace_id=c.span_context.trace_id,
                active_span_id=c.span_context.span_id,
            )
            for c in self.logs()
        ]
        return [
            *_correlation_problems(_LOGGING_LEG, logging_leg),
            *_correlation_problems(_OTLP_LEG, self._log_emissions.snapshot()),
        ]

    def assert_correlated(self) -> None:
        """Assert every log record emitted inside a span carries that span's ids.

        A record emitted while a span was active must carry that span's exact
        trace id and span id on every log leg. Records emitted outside any span
        are ignored. On the logging leg the ids are the ``trace_id`` and
        ``span_id`` attributes the pipeline adds to the record, compared with
        ``CapturedLog.span_context``. On the OTLP leg they are the ids the SDK
        log record carries, compared with the span active when it was emitted,
        so a log bridge that stamps the wrong context fails here.

        Raises AssertionError naming each record and what it is missing.
        """
        _fail("libo11y correlation check failed", self._correlation_problems())

    def assert_triangle(self, metric: str) -> None:
        """Assert the correlation triangle holds for the instrument named metric.

        It runs ``assert_correlated`` and then requires a recorded span, a log
        record on the OTLP leg carrying that span's trace and span ids, and an
        exemplar on a data point of metric carrying the same span's ids.

        Raises AssertionError naming the missing leg.
        """
        problems = self._correlation_problems()
        problems.extend(self._triangle_problems(metric))
        _fail("libo11y triangle check failed", problems)

    def _triangle_problems(self, metric: str) -> list[str]:
        spans = self.spans()
        if not spans:
            return ["triangle: no span was recorded"]
        recorded: set[tuple[int, int]] = set()
        for sp in spans:
            sc = sp.get_span_context()
            if sc is not None and sc.is_valid:
                recorded.add((sc.trace_id, sc.span_id))
        emissions = self._log_emissions.snapshot()
        correlated = {(e.trace_id, e.span_id) for e in emissions} & recorded
        if not correlated:
            return [
                f"triangle: none of {len(emissions)} log record(s) carries the trace and span "
                f"IDs of one of {len(spans)} recorded span(s)"
            ]
        exemplars = self.exemplars(metric)
        if not exemplars:
            return [f"triangle: no exemplar recorded on {metric!r}"]
        if not any((ex.trace_id, ex.span_id) in correlated for ex in exemplars):
            return [
                f"triangle: none of {len(exemplars)} exemplar(s) on {metric!r} carries the "
                "trace and span IDs of a span with a correlated log record"
            ]
        return []

    def shutdown(self, timeout: float | None = None) -> ShutdownReport:
        """Detach the recorder's loggers and shut its telemetry down."""
        handler = self.telemetry.logging_handler()
        with self._loggers_lock:
            for lg in self._loggers.values():
                lg.removeHandler(handler)
            self._loggers.clear()
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
    """Create a hermetic in-memory Recorder without touching process globals.

    The recorder always runs with ``env=HERMETIC`` and owns its span
    processor, metric reader and log exporter, so ``env``, ``span_exporter``,
    ``span_processor``, ``metric_reader`` and ``log_exporter`` raise
    TypeError. Every other ``libo11y.init`` option passes through and
    overrides the recorder's defaults. ``extra_log_handlers`` are added
    alongside the recorder's own capture handler.
    """
    fixed = [name for name in _FIXED_OPTIONS if name in kwargs]
    if fixed:
        raise TypeError(
            f"start_recorder() does not accept {', '.join(fixed)}: the recorder is always "
            "hermetic and owns the exporters and readers its queries read"
        )

    span_exporter = InMemorySpanExporter()
    metric_reader = _CapturingMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    log_capture = _LogCaptureHandler()
    log_emissions = _EmissionProcessor()

    extra_handlers: tuple[logging.Handler, ...] = kwargs.pop("extra_log_handlers", ())
    options: dict[str, Any] = {
        "service_name": service_name,
        "version": "0.0.0-test",
        "environment": str(Environment.TEST),
        "log_level": logging.DEBUG,
        "console_enabled": False,
        "runtime_metrics": False,
        "sampler": ALWAYS_ON,
        "exemplar_filter": TraceBasedExemplarFilter(),
    }
    options.update(kwargs)
    options.update(
        env=HERMETIC,
        span_processor=SimpleSpanProcessor(span_exporter),
        metric_reader=metric_reader,
        log_exporter=log_exporter,
        extra_log_handlers=(*extra_handlers, log_capture),
    )
    tel = init(**options)
    tel.logger_provider.add_log_record_processor(log_emissions)
    return Recorder(
        telemetry=tel,
        span_exporter=span_exporter,
        metric_reader=metric_reader,
        log_exporter=log_exporter,
        log_capture=log_capture,
        log_emissions=log_emissions,
    )
