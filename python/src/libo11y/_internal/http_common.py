"""Shared HTTP semantic-convention helpers for asgi, wsgi, httpx, and requests."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import urlsplit, urlunsplit

from opentelemetry import metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Histogram
from opentelemetry.propagators.textmap import Getter, Setter, TextMapPropagator
from opentelemetry.trace import SpanContext, StatusCode, Tracer

from libo11y.record import Record
from libo11y.spec import ATTR_DURATION, ATTR_OUTCOME, EVENT_REQUEST_SUMMARY, Outcome

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

METHOD_OTHER: Final[str] = "_OTHER"

KNOWN_HTTP_METHODS: Final[frozenset[str]] = frozenset(
    {
        "CONNECT",
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
        "TRACE",
    }
)

HTTP_DURATION_BUCKETS: Final[tuple[float, ...]] = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.075,
    0.1,
    0.25,
    0.5,
    0.75,
    1.0,
    2.5,
    5.0,
    7.5,
    10.0,
)


def normalize_method(method: str) -> tuple[str, bool]:
    """Map an HTTP method onto the bounded OTel semantic-convention set.

    Returns (normalized, exact). When exact is False, callers should also set
    http.request.method_original to the raw method string.
    """
    if not method:
        return METHOD_OTHER, True
    if method in KNOWN_HTTP_METHODS:
        return method, True
    upper = method.upper()
    if upper in KNOWN_HTTP_METHODS:
        return upper, False
    return METHOD_OTHER, False


def span_method_name(normalized: str) -> str:
    """Return the method prefix for HTTP span names ('HTTP' for _OTHER)."""
    return "HTTP" if normalized == METHOD_OTHER else normalized


def compile_path_pattern(pattern: str) -> re.Pattern[str] | None:
    """Compile a Go path.Match glob pattern (never crossing '/').

    Returns None for malformed patterns so callers treat them as non-matching.
    """
    out: list[str] = ["^"]
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            out.append("[^/]*")
            i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        elif ch == "\\":
            if i + 1 >= n:
                return None
            out.append(re.escape(pattern[i + 1]))
            i += 2
        elif ch == "[":
            j = i + 1
            if j < n and pattern[j] == "^":
                j += 1
            if j < n and pattern[j] == "]":
                j += 1
            while j < n and pattern[j] != "]":
                if pattern[j] == "\\" and j + 1 < n:
                    j += 2
                else:
                    j += 1
            if j >= n:
                return None
            body = pattern[i + 1 : j]
            if not body or body == "^":
                return None
            try:
                re.compile("[" + body + "]")
            except re.error:
                return None
            out.append("(?!/)[" + body + "]")
            i = j + 1
        else:
            out.append(re.escape(ch))
            i += 1
    out.append("$")
    try:
        return re.compile("".join(out))
    except re.error:
        return None


def compile_ignore_patterns(patterns: Sequence[str]) -> tuple[re.Pattern[str], ...]:
    """Compile ignore_paths glob patterns, dropping malformed ones safely."""
    compiled: list[re.Pattern[str]] = []
    for p in patterns:
        rx = compile_path_pattern(p)
        if rx is not None:
            compiled.append(rx)
    return tuple(compiled)


def is_path_ignored(path: str, patterns: Sequence[re.Pattern[str]]) -> bool:
    """Return True if path matches any compiled ignore pattern."""
    return any(rx.match(path) is not None for rx in patterns)


def server_timing_header(sc: SpanContext) -> str | None:
    """Render a W3C Server-Timing traceparent entry for a valid SpanContext."""
    if not sc.is_valid:
        return None
    flags = int(sc.trace_flags)
    return f'traceparent;desc="00-{sc.trace_id:032x}-{sc.span_id:016x}-{flags:02x}"'


def sanitize_url_full(raw_url: str) -> str:
    """Strip userinfo (user:pass@) from a URL before recording url.full."""
    try:
        parts = urlsplit(raw_url)
    except ValueError:
        return raw_url
    if parts.username is None and parts.password is None:
        return raw_url
    host = parts.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{parts.port}" if parts.port is not None else host
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def resolve_http_primitives(
    telemetry: Telemetry | None,
    scope: str,
    metric_name: str,
    metric_desc: str,
) -> tuple[Tracer, Histogram, TextMapPropagator]:
    """Resolve tracer, duration histogram, and propagator from telemetry or globals."""
    tp = telemetry.tracer_provider if telemetry is not None else trace.get_tracer_provider()
    mp = telemetry.meter_provider if telemetry is not None else metrics.get_meter_provider()
    prop = telemetry.propagator if telemetry is not None else propagate.get_global_textmap()
    tracer = tp.get_tracer(scope)
    meter = mp.get_meter(scope)
    duration = meter.create_histogram(
        metric_name,
        unit="s",
        description=metric_desc,
        explicit_bucket_boundaries_advisory=list(HTTP_DURATION_BUCKETS),
    )
    return tracer, duration, prop


def emit_http_summary(
    record: Record,
    telemetry: Telemetry,
    *,
    method_raw: str,
    status_code: int,
    duration_s: float,
    route: str | None,
    failed: bool,
) -> None:
    """Emit the canonical o11y.request.summary wide event."""
    method, exact = normalize_method(method_raw)
    outcome = Outcome.FAILURE if (failed or status_code >= 500) else Outcome.SUCCESS
    attrs: dict[str, Any] = {
        "http.request.method": method,
        "http.response.status_code": status_code,
        ATTR_OUTCOME: str(outcome),
        ATTR_DURATION: duration_s,
    }
    if not exact:
        attrs["http.request.method_original"] = method_raw
    if route:
        attrs["http.route"] = route
    record.emit_event(telemetry, EVENT_REQUEST_SUMMARY, attrs)


def error_type_for_status(status_code: int) -> str:
    """Return the OTel error.type string for an HTTP error status code."""
    return str(status_code)


def error_type_for_exception(exc: BaseException) -> str:
    """Return the OTel error.type string for a raised exception."""
    cls = type(exc)
    if cls.__module__ and cls.__module__ != "builtins":
        return f"{cls.__module__}.{cls.__qualname__}"
    return cls.__qualname__


def server_status_code(status_code: int | None, exc: BaseException | None) -> StatusCode:
    """Determine server span status per stable HTTP semantic conventions."""
    if exc is not None or (status_code is not None and status_code >= 500):
        return StatusCode.ERROR
    return StatusCode.UNSET


def client_status_code(status_code: int | None, exc: BaseException | None) -> StatusCode:
    """Determine client span status per stable HTTP semantic conventions."""
    if exc is not None or (status_code is not None and status_code >= 400):
        return StatusCode.ERROR
    return StatusCode.UNSET


class CaseInsensitiveDictGetter(Getter[Mapping[str, str]]):
    """OTel Getter for case-insensitive lookup in a lowercased header mapping."""

    def get(self, carrier: Mapping[str, str], key: str) -> list[str] | None:
        val = carrier.get(key.lower())
        return [val] if val is not None else None

    def keys(self, carrier: Mapping[str, str]) -> list[str]:
        return list(carrier.keys())


class MutableHeaderSetter(Setter[Any]):
    """OTel Setter for dict-like mutable header objects (httpx.Headers, CaseInsensitiveDict)."""

    def set(self, carrier: Any, key: str, value: str) -> None:
        carrier[key] = value


HEADER_GETTER: Final[CaseInsensitiveDictGetter] = CaseInsensitiveDictGetter()
HEADER_SETTER: Final[MutableHeaderSetter] = MutableHeaderSetter()


def extract_inbound_context(
    prop: TextMapPropagator,
    headers: Mapping[str, str],
) -> Context:
    """Extract inbound trace context and baggage into a clean Context."""
    return prop.extract(headers, context=Context(), getter=HEADER_GETTER)
