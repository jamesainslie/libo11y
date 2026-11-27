"""Detached context propagation: copy_context, text Carrier, and linked root spans."""

from __future__ import annotations

import contextvars
import re
from collections.abc import Callable, Generator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import parse_qsl, urlencode

from opentelemetry import baggage, context, propagate, trace
from opentelemetry.context import Context
from opentelemetry.trace import INVALID_SPAN, Link, Span, SpanContext, SpanKind
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.util.types import Attributes

from libo11y.errors import InvalidCarrier

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

MAX_CARRIER_TEXT: Final[int] = 32 * 1024
MAX_BAGGAGE_MEMBERS: Final[int] = 64
MAX_BAGGAGE_BYTES: Final[int] = 8192

_CARRIER_TRACEPARENT: Final[str] = "traceparent"
_CARRIER_TRACESTATE: Final[str] = "tracestate"
_CARRIER_BAGGAGE: Final[str] = "baggage"
_SCOPE_NAME: Final[str] = "libo11y.detached"

_TRACE_PROPAGATOR = TraceContextTextMapPropagator()

# W3C Baggage key (RFC 7230 token) and value (baggage-octet) patterns.
_BAGGAGE_KEY_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_BAGGAGE_VAL_RE = re.compile(r"^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$")
_BAD_PCT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _parse_baggage_member(raw: str) -> tuple[str, str] | None:
    """Parse one raw W3C baggage list-member; return (key, raw_segment) if valid."""
    parts = raw.split(";")
    kv = parts[0]
    if "=" not in kv:
        return None
    key_raw, val_raw = kv.split("=", 1)
    key = key_raw.strip(" \t")
    val = val_raw.strip(" \t")
    if not key or not _BAGGAGE_KEY_RE.match(key):
        return None
    if not _BAGGAGE_VAL_RE.match(val):
        return None
    if _BAD_PCT_RE.search(val):
        return None
    # Validate optional properties (`;prop` or `;prop=val`).
    for prop in parts[1:]:
        p = prop.strip(" \t")
        if not p:
            return None
        if "=" in p:
            pk, pv = p.split("=", 1)
            pk_s = pk.strip(" \t")
            pv_s = pv.strip(" \t")
            if not pk_s or not _BAGGAGE_KEY_RE.match(pk_s):
                return None
            if not _BAGGAGE_VAL_RE.match(pv_s):
                return None
        elif not _BAGGAGE_KEY_RE.match(p):
            return None
    return key, raw


def _valid_baggage(bag: str) -> str:
    """Return valid W3C baggage members within limits, preserving original order.

    Matches Go's validBaggage: text over 8192 bytes is dropped whole, invalid
    members are skipped, duplicate keys keep the last valid occurrence, and
    at most 64 members / 8192 encoded bytes are kept.
    """
    if not bag:
        return ""
    if len(bag.encode("utf-8")) > MAX_BAGGAGE_BYTES:
        return ""

    # First pass: parse members; duplicate keys keep the last valid occurrence.
    parsed: list[tuple[str, str]] = []
    last_idx: dict[str, int] = {}
    for raw in bag.split(","):
        item = _parse_baggage_member(raw)
        if item is None:
            continue
        key, seg = item
        last_idx[key] = len(parsed)
        parsed.append((key, seg))

    kept: list[str] = []
    total_bytes = 0
    for idx, (key, seg) in enumerate(parsed):
        if last_idx[key] != idx:
            continue
        if len(kept) >= MAX_BAGGAGE_MEMBERS:
            break
        seg_bytes = len(seg.encode("utf-8")) + (1 if kept else 0)
        if total_bytes + seg_bytes > MAX_BAGGAGE_BYTES:
            break
        kept.append(seg)
        total_bytes += seg_bytes
    return ",".join(kept)


def _restore_baggage(ctx: Context, bag: str) -> Context:
    """Merge valid W3C baggage members from bag into ctx."""
    cleaned = _valid_baggage(bag)
    if not cleaned:
        return ctx
    # Use OTel's W3C baggage propagator to parse into a fresh context, then merge
    # onto ctx so existing keys not in bag survive and matching keys are replaced.
    from opentelemetry.baggage.propagation import W3CBaggagePropagator

    extracted = W3CBaggagePropagator().extract({_CARRIER_BAGGAGE: cleaned}, context=Context())
    members = baggage.get_all(extracted)
    if not members:
        return ctx
    out = ctx
    for k, v in members.items():
        out = baggage.set_baggage(k, v, context=out)
    return out


def _encode_carrier(traceparent: str, tracestate: str, bag: str) -> str:
    if not traceparent:
        return ""
    items: list[tuple[str, str]] = []
    if bag:
        items.append((_CARRIER_BAGGAGE, bag))
    items.append((_CARRIER_TRACEPARENT, traceparent))
    if tracestate:
        items.append((_CARRIER_TRACESTATE, tracestate))
    return urlencode(items)


def _new_carrier(sc: SpanContext, bag: str) -> Carrier:
    """Construct a Carrier in canonical W3C form bounded to MAX_CARRIER_TEXT."""
    tc: dict[str, str] = {}
    _TRACE_PROPAGATOR.inject(tc, context=trace.set_span_in_context(trace.NonRecordingSpan(sc)))
    tp = tc.get(_CARRIER_TRACEPARENT, "")
    ts = tc.get(_CARRIER_TRACESTATE, "")
    if len(_encode_carrier(tp, ts, bag).encode("utf-8")) > MAX_CARRIER_TEXT:
        ts = ""
    if len(_encode_carrier(tp, ts, bag).encode("utf-8")) > MAX_CARRIER_TEXT:
        bag = ""
    return Carrier(traceparent=tp, tracestate=ts, baggage=bag)


@dataclass(frozen=True, slots=True)
class Carrier:
    """Serialized trace context + egress-filtered baggage for detached work.

    The zero Carrier has an empty traceparent and serializes to empty text.
    Serialized text is a URL-encoded query string never exceeding 32 KiB.
    """

    traceparent: str = ""
    tracestate: str = ""
    baggage: str = ""

    def is_zero(self) -> bool:
        """Return True when this carrier holds no captured trace context."""
        return self.traceparent == ""

    def span_context(self) -> SpanContext:
        """Return the captured remote SpanContext, or INVALID_SPAN_CONTEXT if zero."""
        if self.is_zero():
            return trace.INVALID_SPAN_CONTEXT
        carrier: dict[str, str] = {_CARRIER_TRACEPARENT: self.traceparent}
        if self.tracestate:
            carrier[_CARRIER_TRACESTATE] = self.tracestate
        extracted = _TRACE_PROPAGATOR.extract(carrier, context=Context())
        return trace.get_current_span(extracted).get_span_context()

    def to_text(self) -> str:
        """Serialize this carrier to compact URL-encoded text (<= 32 KiB)."""
        return _encode_carrier(self.traceparent, self.tracestate, self.baggage)

    def __str__(self) -> str:
        return self.to_text()

    @classmethod
    def from_text(cls, text: str | bytes | None) -> Carrier:
        """Parse serialized carrier text, raising InvalidCarrier on bad input."""
        if text is None:
            return cls()
        if isinstance(text, bytes):
            if len(text) == 0:
                return cls()
            if len(text) > MAX_CARRIER_TEXT:
                raise InvalidCarrier(
                    f"o11y: invalid carrier: {len(text)} bytes exceeds the "
                    f"{MAX_CARRIER_TEXT} byte limit"
                )
            try:
                raw = text.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise InvalidCarrier(f"o11y: invalid carrier: invalid UTF-8: {exc}") from exc
        else:
            if not text:
                return cls()
            encoded_len = len(text.encode("utf-8"))
            if encoded_len > MAX_CARRIER_TEXT:
                raise InvalidCarrier(
                    f"o11y: invalid carrier: {encoded_len} bytes exceeds the "
                    f"{MAX_CARRIER_TEXT} byte limit"
                )
            raw = text

        if ";" in raw:
            raise InvalidCarrier("o11y: invalid carrier: invalid semicolon separator in query")
        for part in raw.split("&"):
            if _BAD_PCT_RE.search(part):
                raise InvalidCarrier("o11y: invalid carrier: invalid percent escape")

        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=False)
        values: dict[str, str] = {}
        for k, v in pairs:
            if k not in values:
                values[k] = v

        tp = values.get(_CARRIER_TRACEPARENT, "")
        ts = values.get(_CARRIER_TRACESTATE, "")
        sc = cls(traceparent=tp, tracestate=ts).span_context()
        if not sc.is_valid:
            raise InvalidCarrier("o11y: invalid carrier: no valid traceparent")
        return _new_carrier(sc, _valid_baggage(values.get(_CARRIER_BAGGAGE, "")))


def capture(
    ctx: Context | None = None,
    *,
    telemetry: Telemetry | None = None,
) -> Carrier:
    """Capture the active span context and egress-filtered baggage as a Carrier.

    Returns the zero Carrier when ctx holds no valid span context.
    """
    active = context.get_current() if ctx is None else ctx
    sc = trace.get_current_span(active).get_span_context()
    if not sc.is_valid:
        return Carrier()
    prop = telemetry.propagator if telemetry is not None else propagate.get_global_textmap()
    out: dict[str, Any] = {}
    prop.inject(out, context=active)
    bag = out.get(_CARRIER_BAGGAGE, "")
    return _new_carrier(sc, bag if isinstance(bag, str) else "")


def restore_baggage(carrier: Carrier, ctx: Context | None = None) -> Context:
    """Return ctx with carrier's valid baggage members merged in."""
    base = context.get_current() if ctx is None else ctx
    return _restore_baggage(base, carrier.baggage)


@contextmanager
def start_linked(
    carrier: Carrier,
    name: str,
    *,
    ctx: Context | None = None,
    telemetry: Telemetry | None = None,
    kind: SpanKind = SpanKind.INTERNAL,
    attributes: Attributes | None = None,
    links: Sequence[Link] | None = None,
) -> Generator[Span]:
    """Start a new root span linked to carrier and carrying merged baggage.

    A zero carrier starts an unlinked root span. Extra links are appended after
    the carrier link. The span and merged baggage are active for the duration
    of the context manager block.
    """
    base = context.get_current() if ctx is None else ctx
    merged = _restore_baggage(base, carrier.baggage)
    root_ctx = trace.set_span_in_context(INVALID_SPAN, merged)

    all_links: list[Link] = []
    sc = carrier.span_context()
    if sc.is_valid:
        all_links.append(Link(sc))
    if links:
        all_links.extend(links)

    tp = telemetry.tracer_provider if telemetry is not None else trace.get_tracer_provider()
    tracer = tp.get_tracer(_SCOPE_NAME)

    token = context.attach(root_ctx)
    try:
        with tracer.start_as_current_span(
            name,
            context=root_ctx,
            kind=kind,
            attributes=attributes,
            links=all_links,
        ) as span:
            yield span
    finally:
        context.detach(token)


def copy_context[**P, R](fn: Callable[P, R]) -> Callable[P, R]:
    """Wrap fn so it executes inside a copy of the caller's contextvars.Context.

    Safe to submit to a ThreadPoolExecutor, queue worker, or invoke repeatedly
    across concurrent threads because each invocation runs inside its own copy
    of the captured snapshot.
    """
    snapshot = contextvars.copy_context()

    def _wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
        return snapshot.copy().run(fn, *args, **kwargs)

    return _wrapped


__all__ = [
    "MAX_CARRIER_TEXT",
    "Carrier",
    "capture",
    "copy_context",
    "restore_baggage",
    "start_linked",
]
