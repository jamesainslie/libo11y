"""Context propagators with inject-only baggage egress filtering."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from opentelemetry import baggage
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.context import Context
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.propagators.textmap import (
    CarrierT,
    Getter,
    Setter,
    TextMapPropagator,
    default_getter,
    default_setter,
)
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from libo11y.options import BaggagePredicate


def _allow_all(_key: str) -> bool:
    return True


class BaggageEgressFilterPropagator(TextMapPropagator):
    """Wraps a TextMapPropagator and filters outgoing baggage keys on inject."""

    def __init__(
        self,
        inner: TextMapPropagator,
        allow: BaggagePredicate | None = None,
    ) -> None:
        self._inner = inner
        self._allow = allow if allow is not None else _allow_all

    def extract(
        self,
        carrier: CarrierT,
        context: Context | None = None,
        getter: Getter[CarrierT] = default_getter,
    ) -> Context:
        return self._inner.extract(carrier, context=context, getter=getter)

    def inject(
        self,
        carrier: CarrierT,
        context: Context | None = None,
        setter: Setter[CarrierT] = default_setter,
    ) -> None:
        entries = baggage.get_all(context=context)
        if entries:
            filtered_ctx = baggage.clear(context=context)
            for k, v in entries.items():
                if self._allow(k):
                    filtered_ctx = baggage.set_baggage(k, v, context=filtered_ctx)
            self._inner.inject(carrier, context=filtered_ctx, setter=setter)
        else:
            self._inner.inject(carrier, context=context, setter=setter)

    @property
    def fields(self) -> set[str]:
        return set(self._inner.fields)


def build_propagator(
    propagators: Iterable[TextMapPropagator] | None,
    baggage_allow: BaggagePredicate | None = None,
) -> TextMapPropagator:
    """Build the composite propagator wrapped with the baggage egress filter."""
    prop_list = (
        list(propagators)
        if propagators is not None
        else [TraceContextTextMapPropagator(), W3CBaggagePropagator()]
    )
    composite: TextMapPropagator = (
        prop_list[0] if len(prop_list) == 1 else CompositePropagator(prop_list)
    )
    return BaggageEgressFilterPropagator(composite, allow=baggage_allow)


def propagator_fields_str(prop: TextMapPropagator) -> str:
    """Comma-separated sorted list of header fields for EffectiveConfig."""
    fields: list[Any] = sorted(str(f) for f in prop.fields)
    return ",".join(fields)
