"""Lifecycle and effective configuration through the public SDK API."""

from __future__ import annotations

import io
import logging
import subprocess
import sys
import threading
from collections.abc import Sequence
from typing import Any

import pytest
from opentelemetry import _logs as logs
from opentelemetry import baggage, metrics, propagate, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import SpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

import libo11y
from libo11y import telemetry as telemetry_module
from libo11y.spec import EVENT_REQUEST_SUMMARY, METRIC_SCHEMA_VIOLATIONS


def _options(**kwargs: Any) -> libo11y.Options:
    options: dict[str, Any] = {
        "env": libo11y.HERMETIC,
        "service_name": "checkout",
        "environment": "production",
        "console_enabled": False,
        "runtime_metrics": False,
    }
    options.update(kwargs)
    return libo11y.Options(**options)


async def test_cached_global_instruments_follow_each_setup() -> None:
    tracer = trace.get_tracer("cached")
    meter = metrics.get_meter("cached")
    counter = meter.create_counter("cached.counter")
    logger = logs.get_logger("cached")
    previous = propagate.get_global_textmap()

    @tracer.start_as_current_span("decorated")
    async def decorated() -> None:
        assert trace.get_current_span().is_recording()

    for index in range(2):
        spans = InMemorySpanExporter()
        records = InMemoryLogRecordExporter()
        reader = InMemoryMetricReader()
        with libo11y.setup(
            _options(span_exporter=spans, log_exporter=records, metric_reader=reader)
        ) as telemetry:
            current = (
                trace.get_tracer_provider(),
                metrics.get_meter_provider(),
                logs.get_logger_provider(),
            )
            assert current[0] is not telemetry.tracer_provider
            assert current[1] is not telemetry.meter_provider
            assert current[2] is not telemetry.logger_provider
            assert propagate.get_global_textmap() is telemetry.propagator
            with tracer.start_as_current_span(f"span-{index}"):
                counter.add(index + 1)
                logger.emit(body=f"log-{index}")
            await decorated()
            assert telemetry.force_flush()
            assert [span.name for span in spans.get_finished_spans()] == [
                f"span-{index}",
                "decorated",
            ]
            assert f"log-{index}" in [
                entry.log_record.body for entry in records.get_finished_logs()
            ]
            data = reader.get_metrics_data()
            assert data is not None
            points = [
                point
                for resource in data.resource_metrics
                for scope in resource.scope_metrics
                for metric in scope.metrics
                if metric.name == "cached.counter"
                for point in metric.data.data_points
            ]
            assert [getattr(point, "value", None) for point in points] == [index + 1]
        assert not tracer.start_span("between").is_recording()
        counter.add(100)
        logger.emit(body="between")
        assert propagate.get_global_textmap() is previous


@pytest.mark.parametrize("foreign", ["traces", "metrics", "logs"])
def test_foreign_provider_leaves_all_globals_intact(foreign: str) -> None:
    code = """
import logging
import sys
import threading
from collections.abc import Sequence

from opentelemetry import metrics, propagate, trace
from opentelemetry import _logs as logs
from libo11y import ForeignProvider, HERMETIC, setup

providers = {
    "traces": (trace.get_tracer_provider, trace.set_tracer_provider, trace.NoOpTracerProvider),
    "metrics": (metrics.get_meter_provider, metrics.set_meter_provider, metrics.NoOpMeterProvider),
    "logs": (logs.get_logger_provider, logs.set_logger_provider, logs.NoOpLoggerProvider),
}
signal = sys.argv[1]
_, install, factory = providers[signal]
install(factory())

def snapshot():
    root = logging.getLogger()
    return (*[get() for get, _, _ in providers.values()], propagate.get_global_textmap(),
            tuple(root.handlers), root.level)

previous = snapshot()
for _ in range(2):
    try:
        setup(env=HERMETIC, service_name="checkout", environment="production")
    except ForeignProvider as exc:
        assert exc.signal == signal
    else:
        raise AssertionError("setup accepted a foreign provider")
    assert snapshot() == previous
"""
    result = subprocess.run(
        [sys.executable, "-c", code, foreign],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_rejected_canary_leaves_all_globals_intact() -> None:
    class RejectingWriter(io.StringIO):
        def write(self, s: str) -> int:
            raise OSError(s)

    def snapshot() -> tuple[object, ...]:
        root = logging.getLogger()
        return (
            trace.get_tracer_provider(),
            metrics.get_meter_provider(),
            logs.get_logger_provider(),
            propagate.get_global_textmap(),
            tuple(root.handlers),
            root.level,
        )

    previous = snapshot()
    with pytest.raises(libo11y.CanaryRejected):
        libo11y.setup(_options(console_enabled=True, console_writer=RejectingWriter()))
    assert snapshot() == previous
    with libo11y.setup(_options()):
        pass


@pytest.mark.parametrize(
    ("value", "fields"),
    [
        (" ", "traceparent,tracestate,baggage"),
        ("baggage, tracecontext, baggage", "baggage,traceparent,tracestate"),
        ("tracecontext,none", "none"),
    ],
)
def test_propagator_env_controls_injection(value: str, fields: str) -> None:
    env = {
        "OTEL_PROPAGATORS": value,
        "OTEL_TRACES_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
    }
    with libo11y.init(_options(env=env)) as telemetry:
        assert f"o11y.config.propagators={fields}" in telemetry.effective_config()
        carrier: dict[str, str] = {}
        telemetry.inject(carrier, baggage.set_baggage("key", "value"))
    assert ("baggage" in carrier) is ("baggage" in fields)


def test_unknown_propagator_is_rejected_even_with_none() -> None:
    with pytest.raises(libo11y.UnknownPropagator, match="invalid"):
        libo11y.init(_options(env={"OTEL_PROPAGATORS": "none,invalid"}))


def test_explicit_propagator_takes_precedence() -> None:
    with libo11y.init(
        _options(
            env={"OTEL_PROPAGATORS": "invalid", "OTEL_TRACES_EXPORTER": "none"},
            propagators=(TraceContextTextMapPropagator(),),
            log_export=False,
            metric_reader=InMemoryMetricReader(),
        )
    ) as telemetry:
        assert "o11y.config.propagators=traceparent,tracestate " in telemetry.effective_config()


def test_hermetic_propagator_ignores_ambient_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_PROPAGATORS", "invalid")
    with libo11y.init(_options()) as telemetry:
        assert "o11y.config.propagators=traceparent,tracestate,baggage" in (
            telemetry.effective_config()
        )


def test_custom_fieldless_propagator_is_reported() -> None:
    with libo11y.init(_options(propagators=(CompositePropagator([]),))) as telemetry:
        assert "o11y.config.propagators=custom " in telemetry.effective_config()


@pytest.mark.parametrize(
    ("level", "name"), [("WARNING", "WARN"), ("CRITICAL", "FATAL"), (25, "INFO+5")]
)
def test_effective_config_uses_console_level_names(level: str | int, name: str) -> None:
    with libo11y.init(_options(log_level=level)) as telemetry:
        assert f"o11y.config.level={name} " in telemetry.effective_config()


def test_invalid_exporter_is_rejected_before_any_worker_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started: list[str] = []
    start = threading.Thread.start

    def note_start(thread: threading.Thread) -> None:
        started.append(thread.name)
        start(thread)

    monkeypatch.setattr(threading.Thread, "start", note_start)
    with pytest.raises(libo11y.UnsupportedProtocol, match="prometheus"):
        libo11y.init(_options(env={"OTEL_METRICS_EXPORTER": "prometheus"}))
    assert started == []


def test_late_init_failure_stops_built_and_unattached_components(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stopped: list[str] = []

    class Spans(InMemorySpanExporter):
        def shutdown(self) -> None:
            stopped.append("traces")
            super().shutdown()

    def reject(*args: object, **kwargs: object) -> None:
        raise ValueError("logs construction rejected")

    def stop_metrics(self: OTLPMetricExporter, timeout_millis: float = 30_000) -> None:
        stopped.append("metrics")

    monkeypatch.setattr(OTLPMetricExporter, "shutdown", stop_metrics)
    monkeypatch.setattr(telemetry_module, "build_logger_provider", reject)
    with pytest.raises(libo11y.O11yError, match="logs construction rejected"):
        libo11y.init(_options(env={"OTEL_LOGS_EXPORTER": "none"}, span_exporter=Spans()))
    assert sorted(stopped) == ["metrics", "traces"]


def test_disabled_sdk_owns_injected_components_without_recording() -> None:
    stopped: list[str] = []

    class Spans(InMemorySpanExporter):
        def shutdown(self) -> None:
            stopped.append("exporter")
            super().shutdown()

    class Processor(SpanProcessor):
        def shutdown(self) -> None:
            stopped.append("processor")

    class Logs(InMemoryLogRecordExporter):
        def shutdown(self) -> None:
            stopped.append("logs")
            super().shutdown()

    class Reader(InMemoryMetricReader):
        def shutdown(self, timeout_millis: float = 30_000, **kwargs: object) -> None:
            stopped.append("metrics")

    spans, logs, reader = Spans(), Logs(), Reader()
    with libo11y.init(
        _options(
            env={"OTEL_SDK_DISABLED": "true"},
            span_exporter=spans,
            span_processor=Processor(),
            log_exporter=logs,
            metric_reader=reader,
        )
    ) as telemetry:
        assert not telemetry.tracer_provider.get_tracer("test").start_span("test").is_recording()
        assert stopped == ["metrics"]
        telemetry.meter_provider.get_meter("test").create_counter("requests").add(1)
        telemetry.logger_provider.get_logger("test").emit(body="disabled")
        carrier: dict[str, str] = {}
        telemetry.inject(carrier, baggage.set_baggage("key", "value"))
        assert carrier == {"baggage": "key=value"}
        assert telemetry.force_flush()
        assert spans.get_finished_spans() == ()
        assert logs.get_finished_logs() == ()
    assert sorted(stopped) == ["exporter", "logs", "metrics", "processor"]


def test_event_contract_validation_does_not_add_runtime_metric_labels() -> None:
    reader = InMemoryMetricReader()
    with libo11y.init(_options(metric_reader=reader)) as telemetry:
        telemetry.event(EVENT_REQUEST_SUMMARY)
        data = reader.get_metrics_data()
        if data is not None:
            assert all(
                metric.name != METRIC_SCHEMA_VIOLATIONS
                for resource in data.resource_metrics
                for scope in resource.scope_metrics
                for metric in scope.metrics
            )


def test_rejected_canary_never_exports_its_queued_otlp_record() -> None:
    class RejectingHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            raise OSError("sink rejected canary")

    class Logs(InMemoryLogRecordExporter):
        def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
            exported.extend(record.log_record.body for record in batch)
            return LogRecordExportResult.SUCCESS

    exported: list[object] = []
    with pytest.raises(libo11y.CanaryRejected):
        libo11y.setup(_options(log_exporter=Logs(), extra_log_handlers=(RejectingHandler(),)))
    assert exported == []
