"""Contract tests for the hermetic Recorder: isolation, fixed wiring and assertions."""

from __future__ import annotations

import logging
import threading
from typing import Any

import pytest
from opentelemetry import trace
from opentelemetry._logs import LogRecord
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import INVALID_SPAN, NonRecordingSpan, SpanContext, TraceFlags

from libo11y.options import PIIMode
from libo11y.spec import (
    ATTR_OUTCOME,
    EVENT_REQUEST_SUMMARY,
    EVENT_TELEMETRY_CONFIGURED,
    Outcome,
)
from libo11y.testing import Recorder, start_recorder

# The logging leg in these tests is the harness's standard-library capture,
# which receives classified and correlated copies from O11yLoggingHandler.


def _logger_tree_snapshot() -> dict[str, tuple[int, bool, tuple[logging.Handler, ...]]]:
    out: dict[str, tuple[int, bool, tuple[logging.Handler, ...]]] = {
        "": (logging.root.level, logging.root.propagate, tuple(logging.root.handlers))
    }
    for name, node in logging.root.manager.loggerDict.items():
        if isinstance(node, logging.Logger):
            out[name] = (node.level, node.propagate, tuple(node.handlers))
    return out


def test_recorder_logger_is_not_the_process_wide_logger() -> None:
    with start_recorder(service_name="logger-isolated") as rec:
        own = rec.logger("isolation.check")
        assert own is not logging.getLogger("isolation.check")
        assert rec.logger("isolation.check") is own


def test_recorder_logger_leaves_the_logging_tree_unchanged() -> None:
    shared = logging.getLogger("libo11y.contract.shared")
    shared.setLevel(logging.WARNING)
    shared.propagate = True
    before = _logger_tree_snapshot()

    with start_recorder(service_name="tree-unchanged") as rec:
        rec.logger("libo11y.contract.shared").info("captured")
        rec.logger().info("default name")
        assert _logger_tree_snapshot() == before

    assert _logger_tree_snapshot() == before
    assert shared.level == logging.WARNING
    assert shared.propagate is True


def test_concurrent_recorders_capture_only_their_own_logs() -> None:
    barrier = threading.Barrier(2)
    seen: dict[str, tuple[list[str], list[str]]] = {}

    def run(tag: str) -> None:
        with start_recorder(service_name=f"concurrent-{tag}") as rec:
            barrier.wait(timeout=5.0)
            for i in range(20):
                rec.logger().info("%s-%d", tag, i)
            barrier.wait(timeout=5.0)
            otel = [str(r.log_record.body) for r in rec.otel_logs()]
            seen[tag] = ([c.message for c in rec.logs()], otel)

    threads = [threading.Thread(target=run, args=(tag,)) for tag in ("a", "b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10.0)

    for tag in ("a", "b"):
        captured, exported = seen[tag]
        want = [f"{tag}-{i}" for i in range(20)]
        assert captured == want
        assert exported == want


@pytest.mark.parametrize(
    ("option", "value"),
    [
        ("env", {}),
        ("span_exporter", InMemorySpanExporter()),
        ("span_processor", SimpleSpanProcessor(InMemorySpanExporter())),
        ("metric_reader", InMemoryMetricReader()),
        ("log_exporter", object()),
    ],
)
def test_start_recorder_rejects_options_that_replace_its_wiring(option: str, value: Any) -> None:
    with pytest.raises(TypeError, match=f"start_recorder.*{option}"):
        start_recorder(**{option: value})


def test_start_recorder_passes_other_options_through() -> None:
    with start_recorder(service_name="passthrough", version="9.9.9") as rec:
        assert rec.telemetry.resource.attributes["service.version"] == "9.9.9"


def test_assert_conforms_checks_event_contracts_on_both_log_legs() -> None:
    with start_recorder(service_name="event-both-legs") as rec:
        rec.telemetry.event(EVENT_REQUEST_SUMMARY, {"http.request.method": "GET"})
        with pytest.raises(AssertionError) as info:
            rec.assert_conforms()
    message = str(info.value)
    for leg in ("logging leg", "OTLP leg"):
        assert (
            f"{leg}: event o11y.request.summary: missing required attribute "
            "http.response.status_code"
        ) in message
        assert f"{leg}: event o11y.request.summary: missing required attribute o11y.outcome" in (
            message
        )


def test_assert_conforms_rejects_a_bare_template_prefix() -> None:
    with start_recorder(service_name="bare-template") as rec:
        rec.telemetry.event(EVENT_TELEMETRY_CONFIGURED, {"o11y.config.": "x"})
        with pytest.raises(
            AssertionError,
            match=r"event o11y\.telemetry\.configured: missing required template attribute "
            r"o11y\.config\.<key>",
        ):
            rec.assert_conforms()


def test_assert_conforms_accepts_a_complete_event() -> None:
    with start_recorder(service_name="event-complete") as rec:
        rec.telemetry.event(
            EVENT_REQUEST_SUMMARY,
            {
                "http.request.method": "GET",
                "http.response.status_code": 200,
                "o11y.duration": 1.5,
                ATTR_OUTCOME: str(Outcome.SUCCESS),
            },
        )
        rec.telemetry.event(EVENT_TELEMETRY_CONFIGURED, {"o11y.config.traces": "injected"})
        rec.assert_conforms()


def _emit_otel(rec: Recorder, body: str, span_context: SpanContext | None) -> None:
    """Emit an SDK log record that carries span_context, or no span when it is None."""
    span = NonRecordingSpan(span_context) if span_context is not None else INVALID_SPAN
    rec.telemetry.logger_provider.get_logger("bridge").emit(
        LogRecord(body=body, context=trace.set_span_in_context(span))
    )


def test_assert_correlated_passes_for_logs_inside_and_outside_spans() -> None:
    with start_recorder(service_name="correlated-ok") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        rec.logger().info("outside")
        with tracer.start_as_current_span("op"):
            rec.logger().info("inside")
            with tracer.start_as_current_span("child"):
                rec.logger().info("nested")
        rec.assert_correlated()


def test_assert_correlated_reports_an_otlp_record_without_trace_ids() -> None:
    with start_recorder(service_name="correlated-missing") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        with tracer.start_as_current_span("op"):
            _emit_otel(rec, "lost context", None)
        with pytest.raises(
            AssertionError,
            match=r"OTLP leg: correlated record 'lost context' has no trace_id",
        ):
            rec.assert_correlated()


def test_assert_correlated_reports_an_otlp_record_from_another_span() -> None:
    other = SpanContext(trace_id=0x1234, span_id=0x5678, is_remote=False, trace_flags=TraceFlags(1))
    with start_recorder(service_name="correlated-mismatch") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        with tracer.start_as_current_span("op") as sp:
            _emit_otel(rec, "wrong span", other)
            want = sp.get_span_context()
        with pytest.raises(AssertionError) as info:
            rec.assert_correlated()
    message = str(info.value)
    assert f"OTLP leg: record 'wrong span' trace_id '{other.trace_id:032x}'" in message
    assert f"does not match its span '{want.trace_id:032x}'" in message
    assert f"span_id '{other.span_id:016x}' does not match its span '{want.span_id:016x}'" in (
        message
    )


def test_assert_correlated_ignores_records_with_no_active_span() -> None:
    with start_recorder(service_name="correlated-none") as rec:
        _emit_otel(rec, "no span", None)
        with trace.use_span(NonRecordingSpan(SpanContext(0, 0, False))):
            rec.logger().info("invalid span")
        rec.assert_correlated()


def _record_triangle(rec: Recorder, *, log_inside: bool, metric_inside: bool) -> None:
    tracer = rec.telemetry.tracer_provider.get_tracer("t")
    hist = rec.telemetry.meter_provider.get_meter("t").create_histogram("tri.latency", unit="s")
    with tracer.start_as_current_span("tri-op"):
        if log_inside:
            rec.logger().info("tri-log")
        if metric_inside:
            hist.record(0.5)
    if not log_inside:
        rec.logger().info("tri-log")
    if not metric_inside:
        hist.record(0.5)


def test_assert_triangle_passes_when_span_log_and_exemplar_agree() -> None:
    with start_recorder(service_name="triangle-ok") as rec:
        _record_triangle(rec, log_inside=True, metric_inside=True)
        rec.assert_triangle("tri.latency")


def test_assert_triangle_reports_no_span() -> None:
    with start_recorder(service_name="triangle-nospan") as rec:
        rec.logger().info("alone")
        with pytest.raises(AssertionError, match="triangle: no span was recorded"):
            rec.assert_triangle("tri.latency")


def test_assert_triangle_reports_no_correlated_log() -> None:
    with start_recorder(service_name="triangle-nolog") as rec:
        _record_triangle(rec, log_inside=False, metric_inside=True)
        with pytest.raises(
            AssertionError,
            match=r"triangle: none of \d+ log record\(s\) carries the trace and span IDs "
            r"of one of 1 recorded span\(s\)",
        ):
            rec.assert_triangle("tri.latency")


def test_assert_triangle_reports_a_metric_without_exemplars() -> None:
    with start_recorder(service_name="triangle-noexemplar") as rec:
        _record_triangle(rec, log_inside=True, metric_inside=False)
        with pytest.raises(
            AssertionError, match=r"triangle: no exemplar recorded on 'tri\.latency'"
        ):
            rec.assert_triangle("tri.latency")


def test_assert_triangle_reports_an_exemplar_from_an_uncorrelated_span() -> None:
    with start_recorder(service_name="triangle-otherspan") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        hist = rec.telemetry.meter_provider.get_meter("t").create_histogram("tri.latency")
        with tracer.start_as_current_span("logged"):
            rec.logger().info("tri-log")
        with tracer.start_as_current_span("measured"):
            hist.record(0.5)
        with pytest.raises(
            AssertionError,
            match=r"triangle: none of 1 exemplar\(s\) on 'tri.latency' carries the trace and "
            r"span IDs of a span with a correlated log record",
        ):
            rec.assert_triangle("tri.latency")


def test_assert_triangle_includes_correlation_problems() -> None:
    with start_recorder(service_name="triangle-uncorrelated") as rec:
        _record_triangle(rec, log_inside=True, metric_inside=True)
        with rec.telemetry.tracer_provider.get_tracer("t").start_as_current_span("op"):
            _emit_otel(rec, "lost", None)
        with pytest.raises(AssertionError, match="correlated record 'lost' has no trace_id"):
            rec.assert_triangle("tri.latency")


def test_metrics_returns_the_collected_metrics_data() -> None:
    with start_recorder(service_name="metrics-query") as rec:
        rec.telemetry.meter_provider.get_meter("t").create_counter("q.count").add(2)
        data = rec.metrics()
        names = [
            m.name for rm in data.resource_metrics for sm in rm.scope_metrics for m in sm.metrics
        ]
        assert "q.count" in names


def test_captured_log_holds_correlation_ids_in_their_own_fields() -> None:
    with start_recorder(service_name="captured-ids") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        with tracer.start_as_current_span("op") as sp:
            rec.logger().info("inside", extra={"http.request.method": "GET"})
            sc = sp.get_span_context()
        rec.logger().info("outside")
        inside, outside = rec.logs()

    assert inside.trace_id == f"{sc.trace_id:032x}"
    assert inside.span_id == f"{sc.span_id:016x}"
    assert inside.span_context == sc
    assert inside.attributes == {"http.request.method": "GET"}

    assert outside.trace_id is None
    assert outside.span_id is None
    assert not outside.span_context.is_valid
    assert "trace_id" not in outside.attributes
    assert "span_id" not in outside.attributes


def test_logging_leg_receives_classified_and_replaced_attributes() -> None:
    def _replace(_groups: tuple[str, ...], key: str, value: Any) -> tuple[str, Any] | None:
        if key == "drop.me":
            return None
        if key == "http.request.method":
            return (key, str(value).lower())
        return (key, value)

    key = bytes(range(32))
    with start_recorder(
        service_name="logging-classified",
        pii_mode=PIIMode.HASH,
        pii_hash_key=key,
        attr_replacer=_replace,
    ) as rec:
        rec.logger().info(
            "classified",
            extra={
                "http.request.method": "GET",
                "http.request.header.authorization": "Bearer secret",
                "device.id": "dev-42",
                "drop.me": "gone",
            },
        )
        (entry,) = rec.logs()

    assert entry.attributes["http.request.method"] == "get"
    assert "http.request.header.authorization" not in entry.attributes
    assert "drop.me" not in entry.attributes
    assert str(entry.attributes["device.id"]).startswith("hmac-sha256:")


def test_assert_correlated_reports_logging_leg_missing_and_mismatched_ids() -> None:
    with start_recorder(service_name="logging-corr-missing") as rec:
        tracer = rec.telemetry.tracer_provider.get_tracer("t")
        with tracer.start_as_current_span("op") as sp:
            want = sp.get_span_context()
            missing = logging.makeLogRecord({"msg": "no-ids", "levelno": logging.INFO})
            wrong = logging.makeLogRecord(
                {
                    "msg": "wrong-ids",
                    "levelno": logging.INFO,
                    "trace_id": f"{0x1234:032x}",
                    "span_id": f"{0x5678:016x}",
                }
            )
            rec._log_capture.emit(missing)  # pyright: ignore[reportPrivateUsage]
            rec._log_capture.emit(wrong)  # pyright: ignore[reportPrivateUsage]
        with pytest.raises(AssertionError) as info:
            rec.assert_correlated()

    message = str(info.value)
    assert "logging leg: correlated record 'no-ids' has no trace_id" in message
    assert (
        f"logging leg: record 'wrong-ids' trace_id '{0x1234:032x}' "
        f"does not match its span '{want.trace_id:032x}'"
    ) in message
    assert (
        f"logging leg: record 'wrong-ids' span_id '{0x5678:016x}' "
        f"does not match its span '{want.span_id:016x}'"
    ) in message


def test_assert_conforms_reports_secret_in_the_clear_on_logging_leg() -> None:
    with start_recorder(service_name="logging-secret-clear") as rec:
        leaked = logging.makeLogRecord(
            {
                "msg": "leaked",
                "levelno": logging.INFO,
                "http.request.header.authorization": "Bearer raw",
            }
        )
        rec._log_capture.emit(leaked)  # pyright: ignore[reportPrivateUsage]
        with pytest.raises(
            AssertionError,
            match=r"logging leg: log record 'leaked' carries secret-classified attribute "
            r"'http\.request\.header\.authorization' in the clear",
        ):
            rec.assert_conforms()
