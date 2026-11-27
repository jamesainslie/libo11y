"""Process-boundary trace propagation via environment variables and framed maps.

Environment carriers use TRACEPARENT and TRACESTATE only; baggage is never
written to process environments because other tools on the host can read
environment blocks and baggage is not classified by the sensitivity policy.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, MutableMapping
from typing import TYPE_CHECKING, Final

from opentelemetry import context, propagate, trace
from opentelemetry.context import Context
from opentelemetry.propagators.textmap import Setter
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

ENV_TRACEPARENT: Final[str] = "TRACEPARENT"
ENV_TRACESTATE: Final[str] = "TRACESTATE"

_TRACE_PROPAGATOR = TraceContextTextMapPropagator()


def env_carrier(ctx: Context | None = None) -> dict[str, str]:
    """Return TRACEPARENT and TRACESTATE entries for the active span context.

    Returns an empty dict when ctx holds no valid span context. When valid,
    always includes TRACESTATE (empty string if unset) so merging over a
    parent environment replaces any inherited TRACESTATE.
    """
    active = context.get_current() if ctx is None else ctx
    if not trace.get_current_span(active).get_span_context().is_valid:
        return {}
    carrier: dict[str, str] = {}
    _TRACE_PROPAGATOR.inject(carrier, context=active)
    return {
        ENV_TRACEPARENT: carrier.get("traceparent", ""),
        ENV_TRACESTATE: carrier.get("tracestate", ""),
    }


def child_env(
    base: Mapping[str, str] | None = None,
    *,
    ctx: Context | None = None,
) -> dict[str, str]:
    """Return a child process environment mapping with trace context injected.

    Copies os.environ (or base if provided) and overlays env_carrier(ctx).
    """
    out = dict(os.environ if base is None else base)
    out.update(env_carrier(ctx))
    return out


def extract_env(
    environ: Mapping[str, str] | None = None,
    *,
    ctx: Context | None = None,
) -> Context:
    """Extract remote span context from TRACEPARENT and TRACESTATE variables.

    Returns ctx (or the current context) unchanged when TRACEPARENT is missing,
    empty, or invalid.
    """
    base = context.get_current() if ctx is None else ctx
    src = os.environ if environ is None else environ
    parent = src.get(ENV_TRACEPARENT, "")
    if not parent:
        return base
    carrier: dict[str, str] = {"traceparent": parent}
    state = src.get(ENV_TRACESTATE, "")
    if state:
        carrier["tracestate"] = state
    return _TRACE_PROPAGATOR.extract(carrier, context=base)


class _StrMapSetter(Setter[MutableMapping[str, str]]):
    def set(self, carrier: MutableMapping[str, str], key: str, value: str) -> None:
        carrier[key] = value


_STR_MAP_SETTER = _StrMapSetter()


def inject_frame(
    frame: MutableMapping[str, str],
    *,
    ctx: Context | None = None,
    telemetry: Telemetry | None = None,
) -> None:
    """Inject trace context and egress-filtered baggage into a string map frame."""
    active = context.get_current() if ctx is None else ctx
    prop = telemetry.propagator if telemetry is not None else propagate.get_global_textmap()
    prop.inject(frame, context=active, setter=_STR_MAP_SETTER)


def extract_frame(
    frame: Mapping[str, str],
    *,
    ctx: Context | None = None,
    telemetry: Telemetry | None = None,
) -> Context:
    """Extract trace context and baggage from a string map frame."""
    base = context.get_current() if ctx is None else ctx
    prop = telemetry.propagator if telemetry is not None else propagate.get_global_textmap()
    return prop.extract(frame, context=base)


__all__ = [
    "ENV_TRACEPARENT",
    "ENV_TRACESTATE",
    "child_env",
    "env_carrier",
    "extract_env",
    "extract_frame",
    "inject_frame",
]
