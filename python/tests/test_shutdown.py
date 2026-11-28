"""Shutdown and force-flush results, exporter failures, and deadlines."""

from __future__ import annotations

import io
import json
import threading
import time
from collections.abc import Callable, Sequence
from typing import Any, Literal

import pytest
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk._logs import ReadableLogRecord
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, LogRecordExportResult
from opentelemetry.sdk.metrics.export import MetricExportResult, MetricsData
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import libo11y
from libo11y.spec import EVENT_NAME_KEY, EVENT_TELEMETRY_DROPPED


def _init(**kwargs: Any) -> libo11y.Telemetry:
    options: dict[str, Any] = {
        "env": libo11y.HERMETIC,
        "service_name": "checkout",
        "environment": "production",
        "runtime_metrics": False,
        "console_enabled": False,
    }
    options.update(kwargs)
    return libo11y.init(**options)


def _run(
    telemetry: libo11y.Telemetry, operation: str, timeout: float | None = None
) -> libo11y.ShutdownReport:
    if operation == "shutdown":
        return telemetry.shutdown(timeout)
    return telemetry.force_flush(timeout)


@pytest.mark.parametrize("operation", ["shutdown", "force_flush"])
@pytest.mark.parametrize("signal", ["traces", "metrics", "logs"])
@pytest.mark.parametrize("outcome", ["result", "exception", "in_flight"])
def test_reports_export_failure(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    signal: Literal["traces", "metrics", "logs"],
    outcome: str,
) -> None:
    entered = threading.Event()
    release = threading.Event()
    failure = RuntimeError("collector disconnected")
    console = io.StringIO()

    def fail() -> bool:
        if entered.is_set():
            return False
        entered.set()
        if outcome == "in_flight" and not release.wait(5):
            raise RuntimeError("test did not release exporter")
        if outcome == "exception":
            raise failure
        return True

    class Spans(InMemorySpanExporter):
        def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
            return SpanExportResult.FAILURE if fail() else SpanExportResult.SUCCESS

    class Logs(InMemoryLogRecordExporter):
        def export(self, batch: Sequence[ReadableLogRecord]) -> LogRecordExportResult:
            return LogRecordExportResult.FAILURE if fail() else LogRecordExportResult.SUCCESS

    def export_metrics(
        self: OTLPMetricExporter, data: MetricsData, timeout_millis: float = 10_000
    ) -> MetricExportResult:
        return MetricExportResult.FAILURE if fail() else MetricExportResult.SUCCESS

    env: dict[str, str] = dict.fromkeys(
        ("OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"), "none"
    )
    interval = "10" if outcome == "in_flight" else "60000"
    env.update(
        OTEL_BSP_SCHEDULE_DELAY=interval,
        OTEL_BLRP_SCHEDULE_DELAY=interval,
        OTEL_METRIC_EXPORT_INTERVAL=interval,
    )
    opts: dict[str, Any] = {}
    match signal:
        case "traces":
            opts["span_exporter"] = Spans()
        case "logs":
            opts["log_exporter"] = Logs()
        case "metrics":
            env["OTEL_METRICS_EXPORTER"] = "otlp"
            monkeypatch.setattr(OTLPMetricExporter, "export", export_metrics)

    telemetry = _init(env=env, console_enabled=True, console_writer=console, **opts)
    results: list[libo11y.ShutdownReport] = []
    worker = threading.Thread(target=lambda: results.append(_run(telemetry, operation)))
    try:
        with telemetry.tracer_provider.get_tracer("test").start_as_current_span("request"):
            telemetry.meter_provider.get_meter("test").create_counter("requests").add(1)
            telemetry.event("test.event")

        if outcome == "in_flight":
            assert entered.wait(5)
            # Returning from another signal's step proves the operation started
            # while the failing batch was still in flight.
            other_done = threading.Event()
            other = telemetry.tracer_provider if signal == "logs" else telemetry.logger_provider
            method = getattr(other, operation)

            def finish_other(*args: Any, **kwargs: Any) -> Any:
                try:
                    return method(*args, **kwargs)
                finally:
                    other_done.set()

            monkeypatch.setattr(other, operation, finish_other)
            worker.start()
            assert other_done.wait(2)
            release.set()
            worker.join(5)
            assert not worker.is_alive()
            assert len(results) == 1
            report = results[0]
        else:
            report = _run(telemetry, operation)

        assert not report.ok
        assert report.timed_out == ()
        assert set(report.errors) == {signal}
        if outcome == "exception":
            assert report.errors[signal] is failure
        else:
            assert isinstance(report.errors[signal], libo11y.ExportFailed)
        dropped = [
            entry
            for line in console.getvalue().splitlines()
            if (entry := json.loads(line)).get(EVENT_NAME_KEY) == EVENT_TELEMETRY_DROPPED
        ]
        assert len(dropped) == 1
        assert dropped[0]["level"] == "INFO"
        assert dropped[0]["o11y.signal"] == signal
        assert dropped[0]["error.type"] == type(report.errors[signal]).__name__
    finally:
        release.set()
        if worker.ident is not None:
            worker.join(5)
        telemetry.shutdown()


@pytest.mark.parametrize("operation", ["shutdown", "force_flush"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1.0])
def test_invalid_timeout_does_not_claim_shutdown(operation: str, value: float) -> None:
    telemetry = _init()
    with pytest.raises(ValueError):
        _run(telemetry, operation, value)
    assert telemetry.shutdown(0.2).ok


def test_shutdown_follower_respects_its_own_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    telemetry = _init()
    entered = threading.Event()
    release = threading.Event()
    reports: list[libo11y.ShutdownReport] = []
    original = telemetry.tracer_provider.shutdown

    def stop() -> None:
        entered.set()
        release.wait(2)
        original()

    monkeypatch.setattr(telemetry.tracer_provider, "shutdown", stop)
    leader = threading.Thread(target=lambda: reports.append(telemetry.shutdown()))
    leader.start()
    try:
        assert entered.wait(2)
        start = time.monotonic()
        report = telemetry.shutdown(0.01)
        assert time.monotonic() - start < 0.5
        assert not report.ok
        assert isinstance(report.errors["shutdown"], TimeoutError)
    finally:
        release.set()
        leader.join(5)
    assert len(reports) == 1
    assert telemetry.shutdown(0) is reports[0]


@pytest.mark.parametrize("operation", ["force_flush", "shutdown"])
def test_signals_run_concurrently_under_one_deadline(
    monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    telemetry = _init()
    release = threading.Event()
    entered = [threading.Event() for _ in range(3)]
    providers = (telemetry.tracer_provider, telemetry.meter_provider, telemetry.logger_provider)

    def block(event: threading.Event) -> Callable[..., bool]:
        def run(*args: object, **kwargs: object) -> bool:
            event.set()
            release.wait(2)
            return True

        return run

    try:
        with monkeypatch.context() as patch:
            for provider, event in zip(providers, entered, strict=True):
                patch.setattr(provider, operation, block(event))
            start = time.monotonic()
            report = _run(telemetry, operation, 0.1)
            assert time.monotonic() - start < 0.3
            assert all(event.is_set() for event in entered)
            assert set(report.timed_out) == {"traces", "metrics", "logs"}
    finally:
        release.set()
        telemetry.shutdown()


def test_slow_dropped_event_sink_does_not_extend_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class Writer(io.StringIO):
        def write(self, s: str) -> int:
            entered.set()
            release.wait(2)
            return super().write(s)

    telemetry = _init(console_enabled=True, console_writer=Writer())

    def fail() -> None:
        raise RuntimeError("shutdown rejected")

    monkeypatch.setattr(telemetry.tracer_provider, "shutdown", fail)
    try:
        start = time.monotonic()
        report = telemetry.shutdown(0.02)
        assert time.monotonic() - start < 0.3
        assert isinstance(report.errors["traces"], RuntimeError)
        assert entered.wait(1)
    finally:
        release.set()
