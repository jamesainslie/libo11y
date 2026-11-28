"""Context propagators with inject-only baggage egress filtering."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from importlib.metadata import entry_points

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

from libo11y._internal.env import EnvView
from libo11y.errors import UnknownPropagator
from libo11y.options import BaggagePredicate
from libo11y.spec._goquote import go_quote

# The standard variable that names the propagators.
ENV_PROPAGATORS = "OTEL_PROPAGATORS"

# The name OTEL_PROPAGATORS gives the propagator that carries nothing.
_NO_PROPAGATION = "none"

# What the effective configuration reports for configured propagators that
# name no fields, such as a custom propagator. An empty value would be easy
# to misread.
_FIELDLESS_PROPAGATION = "custom"

# The entry point group OpenTelemetry Python registers propagators under.
# opentelemetry-api registers tracecontext and baggage there, and the b3,
# jaeger, xray and ottrace packages register theirs when installed.
_ENTRY_POINT_GROUP = "opentelemetry_propagator"


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


@dataclass(frozen=True, slots=True)
class BuiltPropagator:
    """The propagator the configuration selects and what the effective configuration says of it."""

    # The selected propagator, wrapped by the baggage egress filter.
    propagator: TextMapPropagator
    # The propagators' fields in configured order, each once, "none" for the
    # propagator that carries nothing, or "custom" for ones that name no fields.
    fields: str


def _named_propagator(name: str) -> TextMapPropagator:
    """Resolve one OTEL_PROPAGATORS name. Names are case-sensitive."""
    if name == "tracecontext":
        return TraceContextTextMapPropagator()
    if name == "baggage":
        return W3CBaggagePropagator()
    if name == _NO_PROPAGATION:
        return CompositePropagator([])
    prefix = f"o11y: building propagator: {go_quote(name)}"
    registered = entry_points(group=_ENTRY_POINT_GROUP, name=name)
    if not registered:
        raise UnknownPropagator(f"{prefix}: unknown propagator: {name}")
    try:
        propagator: object = next(iter(registered)).load()()
    except Exception as exc:
        raise UnknownPropagator(f"{prefix}: {exc}") from exc
    if not isinstance(propagator, TextMapPropagator):
        raise UnknownPropagator(f"{prefix}: not a text map propagator")
    return propagator


def _compose_in_order(propagators: Sequence[TextMapPropagator]) -> tuple[TextMapPropagator, str]:
    """Compose propagators and list their fields in order, each field once."""
    fields: list[str] = []
    for propagator in propagators:
        for name in sorted(str(f) for f in propagator.fields):
            if name not in fields:
                fields.append(name)
    composed = propagators[0] if len(propagators) == 1 else CompositePropagator(propagators)
    return composed, ",".join(fields) or _FIELDLESS_PROPAGATION


def _select(
    propagators: Sequence[TextMapPropagator] | None, env: EnvView
) -> tuple[TextMapPropagator, str]:
    if propagators:
        return _compose_in_order(propagators)
    names = [name for entry in env.get(ENV_PROPAGATORS).split(",") if (name := entry.strip())]
    if not names:
        return _compose_in_order([TraceContextTextMapPropagator(), W3CBaggagePropagator()])
    # Every name is resolved before none is honoured, so an unknown name is
    # an error even next to none.
    named = [_named_propagator(name) for name in names]
    if _NO_PROPAGATION in names:
        return CompositePropagator([]), _NO_PROPAGATION
    return _compose_in_order(named)


def build_propagator(
    propagators: Sequence[TextMapPropagator] | None,
    baggage_allow: BaggagePredicate | None,
    env: EnvView,
) -> BuiltPropagator:
    """Resolve the propagator and wrap it with the baggage egress filter.

    A non-empty ``propagators`` option wins. Otherwise OTEL_PROPAGATORS is
    read as a comma-separated list: each entry is trimmed and empty entries
    are dropped, so a value with no names is unset. tracecontext, baggage
    and none are built in. Any other name is looked up among the propagators
    installed packages register with OpenTelemetry (b3, b3multi, jaeger,
    xray, ottrace), and a name that resolves to nothing raises
    UnknownPropagator, even next to a known name or next to none. A list
    that names none carries nothing. With no names the default composite of
    W3C Trace Context and W3C Baggage applies.

    The egress filter wraps whichever propagator is selected, so the baggage
    choke point cannot be bypassed by the option or the variable.
    """
    selected, fields = _select(propagators, env)
    return BuiltPropagator(BaggageEgressFilterPropagator(selected, allow=baggage_allow), fields)
