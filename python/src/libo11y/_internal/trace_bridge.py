"""Trace provider construction, explicit samplers/limits, and span redaction."""

from __future__ import annotations

from collections.abc import Sequence
from types import MappingProxyType
from typing import Any

from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import (
    Event,
    ReadableSpan,
    Span,
    SpanLimits,
    SpanProcessor,
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
from opentelemetry.trace import Link

from libo11y._internal.env import EnvView
from libo11y._internal.exporters import build_span_exporter
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

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


class RedactingSpanProcessor(SpanProcessor):
    """Wraps a caller-supplied SpanProcessor so on_end sees redacted spans."""

    def __init__(self, inner: SpanProcessor, policy: SensitivityPolicy) -> None:
        self._inner = inner
        self._policy = policy

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        self._inner.on_start(span, parent_context)

    def on_end(self, span: ReadableSpan) -> None:
        redacted, _ = _redact_span(span, self._policy)
        self._inner.on_end(redacted)

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


def resolve_sampler(opts: Options, env: EnvView) -> tuple[Sampler, str]:
    """Resolve Sampler from Options.sampler or OTEL_TRACES_SAMPLER / _ARG."""
    if opts.sampler is not None:
        return opts.sampler, opts.sampler.get_description()

    name = env.get("OTEL_TRACES_SAMPLER", "parentbased_always_on").strip().lower()
    arg_raw = env.get_opt("OTEL_TRACES_SAMPLER_ARG")
    ratio = 1.0
    if arg_raw is not None:
        try:
            ratio = float(arg_raw.strip())
        except ValueError:
            ratio = 1.0
    ratio = max(0.0, min(1.0, ratio))

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
    global_attr = env.get_int("OTEL_ATTRIBUTE_COUNT_LIMIT", 128)
    max_span_attr = env.get_int("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", global_attr)
    global_len = env.get_int("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", -1)
    span_len = env.get_int("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", global_len)
    limits = SpanLimits(
        max_attributes=global_attr,
        max_events=env.get_int("OTEL_SPAN_EVENT_COUNT_LIMIT", 128),
        max_links=env.get_int("OTEL_SPAN_LINK_COUNT_LIMIT", 128),
        max_span_attributes=max_span_attr,
        max_event_attributes=env.get_int("OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT", global_attr),
        max_link_attributes=env.get_int("OTEL_LINK_ATTRIBUTE_COUNT_LIMIT", global_attr),
        max_attribute_length=global_len if global_len >= 0 else 0,
        max_span_attribute_length=span_len if span_len >= 0 else 0,
    )
    if global_len < 0:
        limits.max_attribute_length = None
    if span_len < 0:
        limits.max_span_attribute_length = None
    return limits


def build_tracer_provider(
    opts: Options,
    env: EnvView,
    resource: Resource,
    policy: SensitivityPolicy,
    disabled: bool,
) -> tuple[TracerProvider, str, str]:
    """Build a local TracerProvider with explicit limits, sampler, and redaction.

    Returns (provider, exporter_summary, sampler_summary).
    """
    sampler, sampler_desc = resolve_sampler(opts, env)
    limits = _build_span_limits(env)
    provider = TracerProvider(
        sampler=sampler,
        resource=resource,
        shutdown_on_exit=False,
        span_limits=limits,
    )

    if disabled:
        return provider, "none", sampler_desc

    bsp_kwargs: dict[str, Any] = {
        "max_queue_size": env.get_int("OTEL_BSP_MAX_QUEUE_SIZE", 2048),
        "schedule_delay_millis": float(env.get_int("OTEL_BSP_SCHEDULE_DELAY", 5000)),
        "max_export_batch_size": env.get_int("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512),
        "export_timeout_millis": float(env.get_int("OTEL_BSP_EXPORT_TIMEOUT", 30000)),
    }

    if opts.span_processor is not None:
        provider.add_span_processor(RedactingSpanProcessor(opts.span_processor, policy))
        return provider, "injected", sampler_desc

    if opts.span_exporter is not None:
        wrapped = RedactingSpanExporter(opts.span_exporter, policy)
        provider.add_span_processor(BatchSpanProcessor(wrapped, **bsp_kwargs))
        return provider, "injected", sampler_desc

    exporter, kind = build_span_exporter(env)
    if exporter is not None:
        wrapped = RedactingSpanExporter(exporter, policy)
        provider.add_span_processor(BatchSpanProcessor(wrapped, **bsp_kwargs))
    return provider, kind, sampler_desc
