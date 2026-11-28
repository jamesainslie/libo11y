"""Observable callbacks and per-instrument histogram views."""

from __future__ import annotations

from collections.abc import Generator, Iterable

import pytest
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics.export import Gauge, Histogram, InMemoryMetricReader
from opentelemetry.sdk.metrics.view import View

import libo11y


@pytest.mark.parametrize("as_generator", [False, True])
def test_observable_callback_forms_export_classified_measurements(as_generator: bool) -> None:
    reader = InMemoryMetricReader()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
        metric_reader=reader,
    ) as telemetry:

        def observe(options: CallbackOptions) -> Iterable[Observation]:
            return [Observation(5, {"device.id": "private@test", "http.request.method": "GET"})]

        def generate() -> Generator[Iterable[Observation], CallbackOptions, None]:
            options = yield ()
            while True:
                options = yield observe(options)

        telemetry.meter_provider.get_meter("test").create_observable_gauge(
            "checkout.depth", [generate() if as_generator else observe]
        )
        data = reader.get_metrics_data()
        assert data is not None
        points = [
            point
            for resource in data.resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
            if metric.name == "checkout.depth" and isinstance(metric.data, Gauge)
            for point in metric.data.data_points
        ]
        assert [point.value for point in points] == [5]
        assert points[0].attributes == {"http.request.method": "GET"}


def test_histogram_bucket_view_exports_named_bounds_and_keeps_user_views() -> None:
    reader = InMemoryMetricReader()
    with libo11y.init(
        env=libo11y.HERMETIC,
        service_name="checkout",
        environment="production",
        console_enabled=False,
        runtime_metrics=False,
        metric_reader=reader,
        histogram_buckets={"checkout.*": [1.0, 5.0]},
        views=(View(instrument_name="other", name="renamed"),),
    ) as telemetry:
        meter = telemetry.meter_provider.get_meter("test")
        duration = meter.create_histogram("checkout.duration")
        for value in (1, 3, 9):
            duration.record(value)
        meter.create_counter("other").add(1)
        data = reader.get_metrics_data()
        assert data is not None
        instruments = {
            metric.name: metric.data
            for resource in data.resource_metrics
            for scope in resource.scope_metrics
            for metric in scope.metrics
        }
        assert "renamed" in instruments
        histogram = instruments["checkout.duration"]
        assert isinstance(histogram, Histogram)
        point = histogram.data_points[0]
        assert tuple(point.explicit_bounds) == (1.0, 5.0)
        assert tuple(point.bucket_counts) == (1, 1, 1)
