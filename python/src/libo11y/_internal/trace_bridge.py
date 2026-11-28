"""Trace provider construction, explicit samplers/limits, span redaction, and the global tracer."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import suppress
from dataclasses import dataclass
from types import MappingProxyType

from opentelemetry import trace as trace_api
from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import (
    Event,
    ReadableSpan,
    Span,
    SpanLimits,
    SpanProcessor,
    SynchronousMultiSpanProcessor,
    TracerProvider,
)
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.sdk.trace.sampling import (
    ALWAYS_OFF,
    ALWAYS_ON,
    ParentBased,
    Sampler,
    TraceIdRatioBased,
)
from opentelemetry.trace import Link, SpanKind
from opentelemetry.util.types import Attributes

from libo11y._internal.env import EnvView
from libo11y._internal.exporters import (
    ExportFailures,
    ObservedSpanExporter,
    attribute_limits,
    batch_settings,
    build_span_exporter,
    shutdown_exporter,
)
from libo11y._internal.logs_bridge import span_contextmanager
from libo11y._internal.policy import SensitivityPolicy
from libo11y.options import Options
from libo11y.spec import Signal


def _redact_span(span: ReadableSpan, policy: SensitivityPolicy) -> tuple[ReadableSpan, bool]:
    """Return a ReadableSpan view with policy applied to span, event, and link attributes."""
    attrs, attrs_changed = policy.classify_flat(Signal.TRACES, span.attributes)

    events_changed = False
    new_events: list[Event] = []
    for ev in span.events:
        ev_attrs, ev_ch = policy.classify_flat(Signal.TRACES, ev.attributes)
        if ev_ch:
            events_changed = True
            new_events.append(
                Event(
                    name=ev.name,
                    attributes=ev_attrs,
                    timestamp=ev.timestamp,
                )
            )
        else:
            new_events.append(ev)

    links_changed = False
    new_links: list[Link] = []
    for lk in span.links:
        lk_attrs, lk_ch = policy.classify_flat(Signal.TRACES, lk.attributes)
        if lk_ch:
            links_changed = True
            new_links.append(Link(context=lk.context, attributes=lk_attrs))
        else:
            new_links.append(lk)

    if not (attrs_changed or events_changed or links_changed):
        return span, False

    redacted = ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=MappingProxyType(attrs),
        events=tuple(new_events),
        links=tuple(new_links),
        kind=span.kind,
        instrumentation_scope=span.instrumentation_scope,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
    )
    return redacted, True


class RedactingSpanExporter(SpanExporter):
    """Wraps a SpanExporter to enforce SensitivityPolicy before spans leave the process."""

    def __init__(self, inner: SpanExporter, policy: SensitivityPolicy) -> None:
        self._inner = inner
        self._policy = policy

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        redacted: list[ReadableSpan] | None = None
        for idx, sp in enumerate(spans):
            new_sp, changed = _redact_span(sp, self._policy)
            if not changed:
                continue
            if redacted is None:
                redacted = list(spans)
            redacted[idx] = new_sp
        return self._inner.export(spans if redacted is None else redacted)

    def shutdown(self, timeout_millis: float = 30_000) -> None:
        shutdown_exporter(self._inner.shutdown, timeout_millis)

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


class RedactingSpanProcessor(SpanProcessor):
    """Wraps a caller-supplied SpanProcessor so on_end sees redacted spans.

    on_start and the SDK's ending hook receive the live span, before
    redaction, as the processor would without the wrapper.
    """

    def __init__(self, inner: SpanProcessor, policy: SensitivityPolicy) -> None:
        self._inner = inner
        self._policy = policy

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        self._inner.on_start(span, parent_context)

    def _on_ending(self, span: Span) -> None:
        # The SDK calls this hook on every processor just before on_end. A
        # wrapper that did not forward it would silently switch it off.
        self._inner._on_ending(span)  # pyright: ignore[reportPrivateUsage]

    def on_end(self, span: ReadableSpan) -> None:
        redacted, _ = _redact_span(span, self._policy)
        self._inner.on_end(redacted)

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


class DisabledTracerProvider(TracerProvider):
    """The tracer provider of an SDK that OTEL_SDK_DISABLED switched off.

    Its tracers are OpenTelemetry's no-op tracers: no span records, and a
    span they start carries its parent's span context, so context still
    propagates and logs stay correlated with an inbound trace.
    """

    def get_tracer(
        self,
        instrumenting_module_name: str,
        instrumenting_library_version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes = None,
    ) -> trace_api.Tracer:
        del instrumenting_module_name, instrumenting_library_version, schema_url, attributes
        return trace_api.NoOpTracer()


class _ShutdownSafeSpanProcessors(SynchronousMultiSpanProcessor):
    """Stop every processor even if an injected processor raises."""

    def shutdown(self) -> None:
        errors: list[Exception] = []
        for processor in self._span_processors:
            try:
                processor.shutdown()
            except Exception as exc:
                errors.append(exc)
        if len(errors) == 1:
            raise errors[0]
        if errors:
            raise ExceptionGroup("o11y: stopping trace processors", errors)


def _sampler_ratio(env: EnvView) -> float:
    """Read OTEL_TRACES_SAMPLER_ARG. A value outside [0, 1] samples everything, as in Go."""
    return env.get_float("OTEL_TRACES_SAMPLER_ARG", 1.0, minimum=0.0, maximum=1.0)


def resolve_sampler(opts: Options, env: EnvView) -> tuple[Sampler, str]:
    """Resolve Sampler from Options.sampler or OTEL_TRACES_SAMPLER / _ARG."""
    if opts.sampler is not None:
        return opts.sampler, opts.sampler.get_description()

    name = env.get("OTEL_TRACES_SAMPLER", "parentbased_always_on").lower()
    ratio = _sampler_ratio(env)

    if name == "always_on":
        return ALWAYS_ON, "always_on"
    if name == "always_off":
        return ALWAYS_OFF, "always_off"
    if name == "traceidratio":
        return TraceIdRatioBased(ratio), "traceidratio"
    if name == "parentbased_always_off":
        return ParentBased(root=ALWAYS_OFF), "parentbased_always_off"
    if name == "parentbased_traceidratio":
        return ParentBased(root=TraceIdRatioBased(ratio)), "parentbased_traceidratio"
    return ParentBased(root=ALWAYS_ON), "parentbased_always_on"


def _build_span_limits(env: EnvView) -> SpanLimits:
    general_count = env.get_int("OTEL_ATTRIBUTE_COUNT_LIMIT", 128, minimum=0)
    general_length = env.get_int("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", -1, minimum=0)
    span_count, span_length = attribute_limits(
        env, "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT"
    )
    limits = SpanLimits(
        max_attributes=general_count,
        max_events=env.get_int("OTEL_SPAN_EVENT_COUNT_LIMIT", 128, minimum=0),
        max_links=env.get_int("OTEL_SPAN_LINK_COUNT_LIMIT", 128, minimum=0),
        max_span_attributes=span_count,
        max_event_attributes=env.get_int(
            "OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT", general_count, minimum=0
        ),
        max_link_attributes=env.get_int(
            "OTEL_LINK_ATTRIBUTE_COUNT_LIMIT", general_count, minimum=0
        ),
        max_attribute_length=max(general_length, 0),
        max_span_attribute_length=span_length if span_length is not None else 0,
    )
    # SpanLimits reads the process environment for a limit given as None, so
    # the unlimited lengths are set after construction.
    if general_length < 0:
        limits.max_attribute_length = None
    if span_length is None:
        limits.max_span_attribute_length = None
    return limits


@dataclass(frozen=True, slots=True)
class TracePipeline:
    """The tracer provider of one SDK and what the effective configuration says of it."""

    provider: TracerProvider
    exporter_kind: str
    sampler: str
    failures: ExportFailures


def _batch_processor(
    exporter: SpanExporter,
    env: EnvView,
    policy: SensitivityPolicy,
    failures: ExportFailures,
) -> BatchSpanProcessor:
    """Batch spans into exporter, redacted, with failed exports reported to failures."""
    settings = batch_settings(env, "BSP", default_delay_millis=5000)
    return BatchSpanProcessor(
        ObservedSpanExporter(RedactingSpanExporter(exporter, policy), failures),
        max_queue_size=settings.max_queue_size,
        schedule_delay_millis=settings.schedule_delay_millis,
        max_export_batch_size=settings.max_export_batch_size,
        export_timeout_millis=settings.export_timeout_millis,
    )


def _span_processors(
    opts: Options,
    env: EnvView,
    policy: SensitivityPolicy,
    failures: ExportFailures,
) -> tuple[list[SpanProcessor], str]:
    """Build the span processors in registration order, and name the export path.

    An injected processor and an injected exporter both run when both are
    given. The exporter path then counts each span's policy violations, so
    the processor's redaction counts none. With a processor and no injected
    exporter, the processor owns the export path and no exporter is built
    from the environment.
    """
    processors: list[SpanProcessor] = []
    if opts.span_processor is not None:
        processor_policy = policy.silent() if opts.span_exporter is not None else policy
        processors.append(RedactingSpanProcessor(opts.span_processor, processor_policy))
    if opts.span_exporter is not None:
        processors.append(_batch_processor(opts.span_exporter, env, policy, failures))
        return processors, "injected"
    if opts.span_processor is not None:
        return processors, "injected"
    exporter, kind = build_span_exporter(env)
    if exporter is not None:
        try:
            processors.append(_batch_processor(exporter, env, policy, failures))
        except Exception:
            with suppress(Exception):
                shutdown_exporter(exporter.shutdown, 0)
            raise
    return processors, kind


def build_tracer_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> TracePipeline:
    """Build a local TracerProvider with explicit limits, sampler, and redaction.

    While the SDK is disabled the provider has no processor and hands out
    no-op tracers, so nothing injected receives a span.
    """
    sampler, sampler_desc = resolve_sampler(opts, env)
    failures = ExportFailures("traces")
    if disabled:
        provider: TracerProvider = DisabledTracerProvider(
            sampler=sampler, resource=resource, shutdown_on_exit=False
        )
        return TracePipeline(provider, "none", sampler_desc, failures)

    provider = TracerProvider(
        sampler=sampler,
        resource=resource,
        shutdown_on_exit=False,
        span_limits=_build_span_limits(env),
        active_span_processor=_ShutdownSafeSpanProcessors(),
    )
    processors, kind = _span_processors(opts, env, policy, failures)
    for processor in processors:
        provider.add_span_processor(processor)
    return TracePipeline(provider, kind, sampler_desc, failures)


_NOOP_TRACER = trace_api.NoOpTracer()


class _GlobalTracer(trace_api.Tracer):
    """A tracer of the global provider. Each span goes to the SDK that is set up then."""

    def __init__(
        self,
        provider: GlobalTracerProvider,
        name: str,
        version: str | None,
        schema_url: str | None,
        attributes: Attributes,
    ) -> None:
        self._provider = provider
        self._name = name
        self._version = version
        self._schema_url = schema_url
        self._attributes = attributes

    def _tracer(self) -> trace_api.Tracer:
        target = self._provider.target
        if target is None:
            return _NOOP_TRACER
        return target.get_tracer(self._name, self._version, self._schema_url, self._attributes)

    def start_span(
        self,
        name: str,
        context: Context | None = None,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        start_time: int | None = None,
        record_exception: bool = True,
        set_status_on_exception: bool = True,
    ) -> trace_api.Span:
        return self._tracer().start_span(
            name,
            context=context,
            kind=kind,
            attributes=attributes,
            links=links,
            start_time=start_time,
            record_exception=record_exception,
            set_status_on_exception=set_status_on_exception,
        )

    @span_contextmanager
    def start_as_current_span(
        self,
        name: str,
        context: Context | None = None,
        kind: SpanKind = SpanKind.INTERNAL,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        start_time: int | None = None,
        record_exception: bool = True,
        set_status_on_exception: bool = True,
        end_on_exit: bool = True,
    ) -> Iterator[trace_api.Span]:
        # A generator, so a function decorated at import time resolves the
        # tracer on each call, not once before any SDK is set up.
        with self._tracer().start_as_current_span(
            name,
            context=context,
            kind=kind,
            attributes=attributes,
            links=links,
            start_time=start_time,
            record_exception=record_exception,
            set_status_on_exception=set_status_on_exception,
            end_on_exit=end_on_exit,
        ) as span:
            yield span


class GlobalTracerProvider(trace_api.TracerProvider):
    """The tracer provider setup() installs as the process global, once per process.

    OpenTelemetry lets the global tracer provider be set once. This provider
    is that one value. It hands each span to the tracer provider of the
    Telemetry that is set up at the time, and to a no-op tracer when none
    is, so a tracer obtained from the global API before, between or after
    setups keeps working and never reaches an SDK that was shut down.
    """

    def __init__(self) -> None:
        self._target: trace_api.TracerProvider | None = None

    @property
    def target(self) -> trace_api.TracerProvider | None:
        """The tracer provider spans currently go to, or None when no SDK is set up."""
        return self._target

    def bind(self, target: trace_api.TracerProvider) -> None:
        """Send spans to target from now on."""
        self._target = target

    def unbind(self, target: trace_api.TracerProvider) -> None:
        """Stop sending spans to target, if it is the current target."""
        if self._target is target:
            self._target = None

    def get_tracer(
        self,
        instrumenting_module_name: str,
        instrumenting_library_version: str | None = None,
        schema_url: str | None = None,
        attributes: Attributes = None,
    ) -> trace_api.Tracer:
        return _GlobalTracer(
            self, instrumenting_module_name, instrumenting_library_version, schema_url, attributes
        )
