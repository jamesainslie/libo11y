"""Sensitivity policy for metric instruments and rebinding of global meters."""

from __future__ import annotations

import threading
from collections.abc import Callable, Generator, Iterable, Mapping, Sequence
from dataclasses import dataclass

from opentelemetry.context import Context
from opentelemetry.metrics import (
    CallbackOptions,
    CallbackT,
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
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource
from opentelemetry.util.types import Attributes

from libo11y._internal.env import EnvView
from libo11y._internal.exporters import (
    ExportFailures,
    ObservedMetricExporter,
    build_metric_exporter,
)
from libo11y._internal.policy import SensitivityPolicy
from libo11y.options import Options

DEFAULT_CARDINALITY_LIMIT = 2000

type CallbackFunction = Callable[[CallbackOptions], Iterable[Observation]]


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


def _generator_function(
    generator: Generator[Iterable[Observation], CallbackOptions, None],
) -> CallbackFunction:
    """Adapt a generator callback to a function, driving it as the SDK would.

    OpenTelemetry accepts a callback written as a generator: it is advanced
    to its first yield once, then each collection sends it the options and
    takes the observations it yields. A finished generator observes nothing.
    """
    lock = threading.Lock()
    primed = False

    def observe(options: CallbackOptions) -> Iterable[Observation]:
        nonlocal primed
        with lock:
            try:
                if not primed:
                    primed = True
                    next(generator)
                return generator.send(options)
            except StopIteration:
                return ()

    return observe


def callback_function(callback: CallbackT) -> CallbackFunction:
    """Return callback as a function, whichever of the two forms it was given in."""
    if callable(callback):
        return callback
    return _generator_function(callback)


def _wrap_callback(policy: SensitivityPolicy, callback: CallbackT) -> CallbackFunction:
    """Wrap an observable callback so the policy filters its observations' attributes."""
    observe = callback_function(callback)

    def _wrapped(options: CallbackOptions) -> Iterable[Observation]:
        out: list[Observation] = []
        for obs in observe(options):
            filtered = _filter_attrs(policy, obs.attributes)
            if filtered is obs.attributes:
                out.append(obs)
            else:
                out.append(Observation(obs.value, filtered, obs.context))
        return out

    return _wrapped


def _wrap_callbacks(
    policy: SensitivityPolicy, callbacks: Sequence[CallbackT] | None
) -> list[CallbackT] | None:
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
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
    ) -> ObservableCounter:
        return self._inner.create_observable_counter(
            name, _wrap_callbacks(self._policy, callbacks), unit, description
        )

    def create_observable_up_down_counter(
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
    ) -> ObservableUpDownCounter:
        return self._inner.create_observable_up_down_counter(
            name, _wrap_callbacks(self._policy, callbacks), unit, description
        )

    def create_observable_gauge(
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
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


def histogram_bucket_views(buckets: Mapping[str, Sequence[float]]) -> list[View]:
    """Turn Options.histogram_buckets into one view per instrument name.

    Each view sets the explicit bucket boundaries of the histograms the name
    selects. The name may use the wildcards a view supports.
    """
    return [
        View(
            instrument_type=SDKHistogram,
            instrument_name=name,
            aggregation=ExplicitBucketHistogramAggregation(boundaries=list(boundaries)),
        )
        for name, boundaries in buckets.items()
    ]


@dataclass(frozen=True, slots=True)
class MetricPipeline:
    """The meter provider of one SDK and what the effective configuration says of it."""

    provider: PolicyMeterProvider
    exporter_kind: str
    failures: ExportFailures


def _periodic_reader(env: EnvView, failures: ExportFailures) -> tuple[MetricReader | None, str]:
    """Build the periodic reader the environment selects, if it selects an exporter."""
    built, kind = build_metric_exporter(env)
    if built is None:
        return None, kind
    reader = PeriodicExportingMetricReader(
        exporter=ObservedMetricExporter(built, failures),
        export_interval_millis=float(
            env.get_int(
                "OTEL_METRIC_EXPORT_INTERVAL",
                60000,
                minimum=1,
                maximum=int(threading.TIMEOUT_MAX * 1000),
            )
        ),
        export_timeout_millis=float(env.get_int("OTEL_METRIC_EXPORT_TIMEOUT", 30000, minimum=0)),
        cardinality_limits=dict(_default_cardinality_limits()),  # pyright: ignore[reportArgumentType]
    )
    return reader, kind


def build_meter_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> MetricPipeline:
    """Build a policy-wrapping MeterProvider with explicit exemplar filter and limits.

    While the SDK is disabled the provider has no reader, not even an
    injected one, so instruments can be created and nothing is collected.
    """
    failures = ExportFailures("metrics")
    readers: list[MetricReader] = []
    kind = "none"
    if disabled:
        pass
    elif opts.metric_reader is not None:
        readers.append(opts.metric_reader)
        kind = "injected"
    else:
        reader, kind = _periodic_reader(env, failures)
        if reader is not None:
            readers.append(reader)

    sdk_mp = SDKMeterProvider(
        metric_readers=readers,
        resource=resource,
        exemplar_filter=resolve_exemplar_filter(opts, env),
        shutdown_on_exit=False,
        views=[*opts.views, *histogram_bucket_views(opts.histogram_buckets)],
    )
    return MetricPipeline(PolicyMeterProvider(sdk_mp, policy), kind, failures)


class _Rebound[InstrumentT]:
    """Holds the instrument of the SDK that is set up, and remakes it for the next one."""

    def __init__(self, create: Callable[[Meter], InstrumentT]) -> None:
        self._create = create
        self._inner: InstrumentT | None = None

    def bind(self, meter: Meter | None) -> None:
        self._inner = None if meter is None else self._create(meter)


class _GlobalCounter(_Rebound[Counter], Counter):
    def add(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        if (inner := self._inner) is not None:
            inner.add(amount, attributes, context)


class _GlobalUpDownCounter(_Rebound[UpDownCounter], UpDownCounter):
    def add(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        if (inner := self._inner) is not None:
            inner.add(amount, attributes, context)


class _GlobalHistogram(_Rebound[Histogram], Histogram):
    def record(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        if (inner := self._inner) is not None:
            inner.record(amount, attributes, context)


class _GlobalGauge(_Rebound[_Gauge], _Gauge):
    def set(
        self,
        amount: int | float,
        attributes: Attributes = None,
        context: Context | None = None,
    ) -> None:
        if (inner := self._inner) is not None:
            inner.set(amount, attributes, context)


class _GlobalObservableCounter(_Rebound[ObservableCounter], ObservableCounter):
    """Registers its callbacks on each SDK that is set up."""


class _GlobalObservableUpDownCounter(_Rebound[ObservableUpDownCounter], ObservableUpDownCounter):
    """Registers its callbacks on each SDK that is set up."""


class _GlobalObservableGauge(_Rebound[ObservableGauge], ObservableGauge):
    """Registers its callbacks on each SDK that is set up."""


def _callback_functions(callbacks: Sequence[CallbackT] | None) -> list[CallbackT] | None:
    """Turn generator callbacks into functions, so each SDK in turn can register them."""
    if callbacks is None:
        return None
    return [callback_function(callback) for callback in callbacks]


class _GlobalMeter(Meter):
    """A meter of the global provider. Its instruments follow the SDK that is set up."""

    def __init__(
        self,
        lock: threading.RLock,
        name: str,
        version: str | None,
        schema_url: str | None,
        attributes: Attributes,
    ) -> None:
        super().__init__(name, version, schema_url)
        self._lock = lock
        self._attributes = attributes
        self._target: Meter | None = None
        self._instruments: dict[tuple[str, str, str, str], _Rebound[object]] = {}

    def bind(self, provider: MeterProvider | None) -> None:
        """Remake this meter and its instruments on provider, or detach them on None."""
        if provider is None:
            self._target = None
        else:
            self._target = provider.get_meter(
                self._name, self._version, self._schema_url, self._attributes
            )
        for instrument in self._instruments.values():
            instrument.bind(self._target)

    def _instrument[BoundT: _Rebound[object]](
        self,
        kind: type[BoundT],
        name: str,
        unit: str,
        description: str,
        make: Callable[[], BoundT],
    ) -> BoundT:
        """Return the one instrument of this identity, making and binding it on first use."""
        key = (kind.__name__, name, unit, description)
        with self._lock:
            existing = self._instruments.get(key)
            if isinstance(existing, kind):
                return existing
            instrument = make()
            instrument.bind(self._target)
            self._instruments[key] = instrument
            return instrument

    def create_counter(self, name: str, unit: str = "", description: str = "") -> Counter:
        return self._instrument(
            _GlobalCounter,
            name,
            unit,
            description,
            lambda: _GlobalCounter(lambda meter: meter.create_counter(name, unit, description)),
        )

    def create_up_down_counter(
        self, name: str, unit: str = "", description: str = ""
    ) -> UpDownCounter:
        return self._instrument(
            _GlobalUpDownCounter,
            name,
            unit,
            description,
            lambda: _GlobalUpDownCounter(
                lambda meter: meter.create_up_down_counter(name, unit, description)
            ),
        )

    def create_histogram(
        self,
        name: str,
        unit: str = "",
        description: str = "",
        *,
        explicit_bucket_boundaries_advisory: Sequence[float] | None = None,
    ) -> Histogram:
        return self._instrument(
            _GlobalHistogram,
            name,
            unit,
            description,
            lambda: _GlobalHistogram(
                lambda meter: meter.create_histogram(
                    name,
                    unit,
                    description,
                    explicit_bucket_boundaries_advisory=explicit_bucket_boundaries_advisory,
                )
            ),
        )

    def create_gauge(self, name: str, unit: str = "", description: str = "") -> _Gauge:
        return self._instrument(
            _GlobalGauge,
            name,
            unit,
            description,
            lambda: _GlobalGauge(lambda meter: meter.create_gauge(name, unit, description)),
        )

    def create_observable_counter(
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
    ) -> ObservableCounter:
        functions = _callback_functions(callbacks)
        return self._instrument(
            _GlobalObservableCounter,
            name,
            unit,
            description,
            lambda: _GlobalObservableCounter(
                lambda meter: meter.create_observable_counter(name, functions, unit, description)
            ),
        )

    def create_observable_up_down_counter(
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
    ) -> ObservableUpDownCounter:
        functions = _callback_functions(callbacks)
        return self._instrument(
            _GlobalObservableUpDownCounter,
            name,
            unit,
            description,
            lambda: _GlobalObservableUpDownCounter(
                lambda meter: meter.create_observable_up_down_counter(
                    name, functions, unit, description
                )
            ),
        )

    def create_observable_gauge(
        self,
        name: str,
        callbacks: Sequence[CallbackT] | None = None,
        unit: str = "",
        description: str = "",
    ) -> ObservableGauge:
        functions = _callback_functions(callbacks)
        return self._instrument(
            _GlobalObservableGauge,
            name,
            unit,
            description,
            lambda: _GlobalObservableGauge(
                lambda meter: meter.create_observable_gauge(name, functions, unit, description)
            ),
        )


class GlobalMeterProvider(MeterProvider):
    """The meter provider setup() installs as the process global, once per process.

    OpenTelemetry lets the global meter provider be set once. This provider
    is that one value. Its meters and instruments record into the meter
    provider of the Telemetry that is set up at the time, and nowhere when
    none is. An instrument made before, between or after setups is remade on
    each new SDK, observable callbacks included, so nothing obtained from
    the global API ever records into an SDK that was shut down.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._target: MeterProvider | None = None
        self._meters: dict[tuple[str, str | None, str | None, str], _GlobalMeter] = {}

    @property
    def target(self) -> MeterProvider | None:
        """The meter provider measurements currently go to, or None when no SDK is set up."""
        return self._target

    def bind(self, target: MeterProvider) -> None:
        """Record into target from now on."""
        with self._lock:
            self._target = target
            for meter in self._meters.values():
                meter.bind(target)

    def unbind(self, target: MeterProvider) -> None:
        """Stop recording into target, if it is the current target."""
        with self._lock:
            if self._target is not target:
                return
            self._target = None
            for meter in self._meters.values():
                meter.bind(None)

    def get_meter(
        self,
        name: str,
        version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes | None = None,
    ) -> Meter:
        key = (name, version, schema_url, repr(sorted((attributes or {}).items())))
        with self._lock:
            meter = self._meters.get(key)
            if meter is None:
                meter = _GlobalMeter(self._lock, name, version, schema_url, attributes)
                meter.bind(self._target)
                self._meters[key] = meter
            return meter
