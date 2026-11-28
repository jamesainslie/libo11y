"""Trace processor lifecycle, exporter fan-out, and policy accounting."""

from __future__ import annotations

from opentelemetry.sdk.metrics.export import InMemoryMetricReader, Sum
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import libo11y
from libo11y.spec import METRIC_SCHEMA_VIOLATIONS


class Processor(SpanProcessor):
    def __init__(self) -> None:
        self.ending: list[Span] = []
        self.ended: list[ReadableSpan] = []

    def _on_ending(self, span: Span) -> None:
        self.ending.append(span)

    def on_end(self, span: ReadableSpan) -> None:
        self.ended.append(span)


def test_injected_span_processor_and_exporter_both_receive_redacted_spans() -> None:
    processor = Processor()
    exporter = InMemorySpanExporter()
    reader = InMemoryMetricReader()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
        span_processor=processor,
        span_exporter=exporter,
        metric_reader=reader,
    ) as telemetry:
        tracer = telemetry.tracer_provider.get_tracer("test")
        with tracer.start_as_current_span("checkout", attributes={"device.id": "private@test"}):
            pass
        assert telemetry.force_flush()
        assert len(processor.ended) == 1
        assert len(exporter.get_finished_spans()) == 1
        for span in (processor.ended[0], exporter.get_finished_spans()[0]):
            assert span.attributes is not None
            assert "device.id" not in span.attributes
        data = reader.get_metrics_data()
        assert data is not None
        counts = [
            point.value
            for resource in data.resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
            if metric.name == METRIC_SCHEMA_VIOLATIONS and isinstance(metric.data, Sum)
            for point in metric.data.data_points
            if (point.attributes or {}).get("o11y.signal") == "traces"
        ]
        assert counts == [1]


def test_injected_span_processor_receives_ending_hook() -> None:
    processor = Processor()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
        span_processor=processor,
    ) as telemetry:
        with telemetry.tracer_provider.get_tracer("test").start_as_current_span("checkout") as span:
            assert processor.ending == []
        assert processor.ending == [span]
        assert len(processor.ended) == 1


def test_failing_processor_shutdown_still_stops_the_injected_exporter() -> None:
    failure = RuntimeError("processor shutdown failed")
    stopped: list[bool] = []

    class FailingProcessor(Processor):
        def shutdown(self) -> None:
            raise failure

    class Exporter(InMemorySpanExporter):
        def shutdown(self) -> None:
            stopped.append(True)
            super().shutdown()

    telemetry = libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
        span_processor=FailingProcessor(),
        span_exporter=Exporter(),
    )
    assert telemetry.shutdown().errors["traces"] is failure
    assert stopped == [True]
