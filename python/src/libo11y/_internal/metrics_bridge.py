"""Policy-wrapping MeterProvider enforcing sensitivity before SDK recording."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from typing import Any

from opentelemetry.context import Context
from opentelemetry.metrics import (
    CallbackOptions,
    Counter,
    Histogram,
    Meter,
    MeterProvider,
    ObservableCounter,
    ObservableGauge,
    ObservableUpDownCounter,
    Observation,
    UpDownCounter,
    _Gauge,
)
from opentelemetry.sdk.metrics import (
    AlwaysOffExemplarFilter,
    AlwaysOnExemplarFilter,
    ExemplarFilter,
    TraceBasedExemplarFilter,
)
from opentelemetry.sdk.metrics import (
    Counter as SDKCounter,
)
from opentelemetry.sdk.metrics import (
    Histogram as SDKHistogram,
)
from opentelemetry.sdk.metrics import (
    MeterProvider as SDKMeterProvider,
)
from opentelemetry.sdk.metrics import (
    ObservableCounter as SDKObservableCounter,
)
from opentelemetry.sdk.metrics import (
    ObservableGauge as SDKObservableGauge,
)
from opentelemetry.sdk.metrics import (
    ObservableUpDownCounter as SDKObservableUpDownCounter,
)
from opentelemetry.sdk.metrics import (
    UpDownCounter as SDKUpDownCounter,
)
from opentelemetry.sdk.metrics import (
    _Gauge as SDKGauge,  # pyright: ignore[reportPrivateUsage]
)
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.util.types import Attributes

from libo11y._internal.env import EnvView
from libo11y._internal.exporters import build_metric_exporter
from libo11y._internal.policy import SensitivityPolicy
from libo11y.options import Options

DEFAULT_CARDINALITY_LIMIT = 2000


def _filter_attrs(policy: SensitivityPolicy, attributes: Attributes) -> Attributes:
    if not attributes:
        return attributes
    changed = False
    for k in attributes:
        if not policy.metric_keep(k):
            changed = True
            break
    if not changed:
        return attributes
    return {k: v for k, v in attributes.items() if policy.metric_keep(k)}


def _wrap_callback(
    policy: SensitivityPolicy,
    cb: Callable[[CallbackOptions], Iterable[Observation]],
) -> Callable[[CallbackOptions], Iterable[Observation]]:
    def _wrapped(options: CallbackOptions) -> Iterable[Observation]:
        out: list[Observation] = []
        for obs in cb(options):
            filtered = _filter_attrs(policy, obs.attributes)
            if filtered is obs.attributes:
                out.append(obs)
            else:
                out.append(Observation(obs.value, filtered, obs.context))
        return out

    return _wrapped


def _wrap_callbacks(policy: SensitivityPolicy, callbacks: Any) -> Any:
    if callbacks is None:
        return None
    return [_wrap_callback(policy, cb) for cb in callbacks]


class _PolicyCounter(Counter):
    def __init__(
        self, inner: Counter, policy: SensitivityPolicy, name: str, unit: str, description: str
    ) -> None:
        super().__init__(name, unit, description)
        self._inner = inner
        self._policy = policy

    def add(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        self._inner.add(amount, _filter_attrs(self._policy, attributes), context)


class _PolicyUpDownCounter(UpDownCounter):
    def __init__(
        self,
        inner: UpDownCounter,
        policy: SensitivityPolicy,
        name: str,
        unit: str,
        description: str,
    ) -> None:
        super().__init__(name, unit, description)
        self._inner = inner
        self._policy = policy

    def add(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        self._inner.add(amount, _filter_attrs(self._policy, attributes), context)


class _PolicyHistogram(Histogram):
    def __init__(
        self, inner: Histogram, policy: SensitivityPolicy, name: str, unit: str, description: str
    ) -> None:
        super().__init__(name, unit, description)
        self._inner = inner
        self._policy = policy

    def record(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        self._inner.record(amount, _filter_attrs(self._policy, attributes), context)


class _PolicyGauge(_Gauge):
    def __init__(
        self, inner: _Gauge, policy: SensitivityPolicy, name: str, unit: str, description: str
    ) -> None:
        super().__init__(name, unit, description)
        self._inner = inner
        self._policy = policy

    def set(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        self._inner.set(amount, _filter_attrs(self._policy, attributes), context)


class _PolicyMeter(Meter):
    def __init__(self, inner: Meter, policy: SensitivityPolicy) -> None:
        super().__init__(inner.name, inner.version, inner.schema_url)
        self._inner = inner
        self._policy = policy

    def create_counter(self, name: str, unit: str = "", description: str = "") -> Counter:
        return _PolicyCounter(
            self._inner.create_counter(name, unit, description),
            self._policy,
            name,
            unit,
            description,
        )

    def create_up_down_counter(
        self, name: str, unit: str = "", description: str = ""
    ) -> UpDownCounter:
        return _PolicyUpDownCounter(
            self._inner.create_up_down_counter(name, unit, description),
            self._policy,
            name,
            unit,
            description,
        )

    def create_histogram(
        self,
        name: str,
        unit: str = "",
        description: str = "",
        *,
        explicit_bucket_boundaries_advisory: Sequence[float] | None = None,
    ) -> Histogram:
        return _PolicyHistogram(
            self._inner.create_histogram(
                name,
                unit,
                description,
                explicit_bucket_boundaries_advisory=explicit_bucket_boundaries_advisory,
            ),
            self._policy,
            name,
            unit,
            description,
        )

    def create_gauge(self, name: str, unit: str = "", description: str = "") -> _Gauge:
        return _PolicyGauge(
            self._inner.create_gauge(name, unit, description), self._policy, name, unit, description
        )

    def create_observable_counter(
        self, name: str, callbacks: Any = None, unit: str = "", description: str = ""
    ) -> ObservableCounter:
        return self._inner.create_observable_counter(
            name, _wrap_callbacks(self._policy, callbacks), unit, description
        )

    def create_observable_up_down_counter(
        self, name: str, callbacks: Any = None, unit: str = "", description: str = ""
    ) -> ObservableUpDownCounter:
        return self._inner.create_observable_up_down_counter(
            name, _wrap_callbacks(self._policy, callbacks), unit, description
        )

    def create_observable_gauge(
        self, name: str, callbacks: Any = None, unit: str = "", description: str = ""
    ) -> ObservableGauge:
        return self._inner.create_observable_gauge(
            name, _wrap_callbacks(self._policy, callbacks), unit, description
        )


class PolicyMeterProvider(MeterProvider):
    """MeterProvider wrapper that filters measurement and callback attributes via policy."""

    def __init__(self, inner: SDKMeterProvider, policy: SensitivityPolicy) -> None:
        self._inner = inner
        self._policy = policy

    @property
    def sdk_provider(self) -> SDKMeterProvider:
        return self._inner

    def get_meter(
        self,
        name: str,
        version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes | None = None,
    ) -> Meter:
        return _PolicyMeter(
            self._inner.get_meter(name, version, schema_url, attributes),
            self._policy,
        )

    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        return self._inner.force_flush(timeout_millis=timeout_millis)

    def shutdown(self, timeout_millis: float = 30_000) -> None:
        self._inner.shutdown(timeout_millis=timeout_millis)


def resolve_exemplar_filter(opts: Options, env: EnvView) -> ExemplarFilter:
    if opts.exemplar_filter is not None:
        return opts.exemplar_filter
    raw = env.get("OTEL_METRICS_EXEMPLAR_FILTER", "trace_based").strip().lower()
    if raw == "always_on":
        return AlwaysOnExemplarFilter()
    if raw == "always_off":
        return AlwaysOffExemplarFilter()
    return TraceBasedExemplarFilter()


def _default_cardinality_limits() -> dict[type, int]:
    return {
        SDKCounter: DEFAULT_CARDINALITY_LIMIT,
        SDKUpDownCounter: DEFAULT_CARDINALITY_LIMIT,
        SDKHistogram: DEFAULT_CARDINALITY_LIMIT,
        SDKGauge: DEFAULT_CARDINALITY_LIMIT,
        SDKObservableCounter: DEFAULT_CARDINALITY_LIMIT,
        SDKObservableUpDownCounter: DEFAULT_CARDINALITY_LIMIT,
        SDKObservableGauge: DEFAULT_CARDINALITY_LIMIT,
    }


def build_meter_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> tuple[PolicyMeterProvider, str]:
    """Build a policy-wrapping MeterProvider with explicit exemplar filter and limits."""
    exemplar_filter = resolve_exemplar_filter(opts, env)
    readers: list[MetricReader] = []
    kind = "none"

    if not disabled:
        if opts.metric_reader is not None:
            readers.append(opts.metric_reader)
            kind = "injected"
        else:
            exporter, kind = build_metric_exporter(env)
            if exporter is not None:
                interval = float(env.get_int("OTEL_METRIC_EXPORT_INTERVAL", 60000))
                timeout = float(env.get_int("OTEL_METRIC_EXPORT_TIMEOUT", 30000))
                readers.append(
                    PeriodicExportingMetricReader(
                        exporter=exporter,
                        export_interval_millis=interval,
                        export_timeout_millis=timeout,
                        cardinality_limits=dict(_default_cardinality_limits()),  # pyright: ignore[reportArgumentType]
                    )
                )

    sdk_mp = SDKMeterProvider(
        metric_readers=readers,
        resource=resource,
        exemplar_filter=exemplar_filter,
        shutdown_on_exit=False,
        views=list(opts.views),
    )
    return PolicyMeterProvider(sdk_mp, policy), kind
