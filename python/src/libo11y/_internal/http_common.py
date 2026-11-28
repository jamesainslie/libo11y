"""Shared HTTP semantic-convention helpers for asgi, wsgi, httpx, and requests."""

from __future__ import annotations

import importlib
import time
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final
from urllib.parse import urlsplit, urlunsplit

from opentelemetry import metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Histogram, MeterProvider
from opentelemetry.propagators.textmap import Getter, Setter, TextMapPropagator
from opentelemetry.trace import (
    INVALID_SPAN,
    Link,
    Span,
    SpanContext,
    SpanKind,
    StatusCode,
    Tracer,
    TracerProvider,
)
from opentelemetry.util.types import AttributeValue

from libo11y._internal.logging_handler import default_error_handler
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


class BadPatternError(ValueError):
    """A path pattern is malformed, as Go's path.ErrBadPattern."""

    def __init__(self) -> None:
        super().__init__("syntax error in pattern")


def path_match(pattern: str, name: str) -> bool:
    """Report whether name matches the shell pattern, as Go's path.Match.

    '*' matches any run of non-'/' characters, '?' one non-'/' character,
    '[...]' a character class (negated with '^', ranges with '-'), and '\\'
    escapes the next character. The pattern must match all of name. Raises
    BadPatternError for a malformed pattern, even when the match already failed.
    """
    while pattern:
        star, chunk, pattern = _scan_chunk(pattern)
        if star and not chunk:
            # A trailing star matches the rest of name unless it has a '/'.
            return "/" not in name
        rest = _match_chunk(chunk, name)
        # The last chunk must exhaust name, or the star may still find a later match.
        if rest is not None and (not rest or pattern):
            name = rest
            continue
        if star and (skipped := _match_after_star(chunk, name, last=not pattern)) is not None:
            name = skipped
            continue
        # Before reporting no match, check that the rest of the pattern is well formed.
        while pattern:
            _, chunk, pattern = _scan_chunk(pattern)
            _match_chunk(chunk, "")
        return False
    return not name


def _match_after_star(chunk: str, name: str, *, last: bool) -> str | None:
    """Match chunk after skipping i+1 characters of name, never skipping a '/'."""
    for i, ch in enumerate(name):
        if ch == "/":
            break
        rest = _match_chunk(chunk, name[i + 1 :])
        if rest is not None and not (last and rest):
            return rest
    return None


def _scan_chunk(pattern: str) -> tuple[bool, str, str]:
    """Split off the next run of non-star pattern characters, with any stars before it."""
    stripped = pattern.lstrip("*")
    star = len(stripped) != len(pattern)
    in_range = False
    i = 0
    while i < len(stripped):
        ch = stripped[i]
        if ch == "\\":
            # A trailing backslash is reported by _match_chunk.
            if i + 1 < len(stripped):
                i += 1
        elif ch == "[":
            in_range = True
        elif ch == "]":
            in_range = False
        elif ch == "*" and not in_range:
            return star, stripped[:i], stripped[i:]
        i += 1
    return star, stripped, ""


def _match_chunk(chunk: str, s: str) -> str | None:
    """Match a star-free chunk against the start of s and return what is left of s.

    Returns None on a mismatch. After a mismatch it keeps reading the chunk,
    so a malformed chunk raises BadPatternError whatever s is.
    """
    failed = False
    while chunk:
        failed = failed or not s
        ch = chunk[0]
        if ch == "[":
            r = ""
            if not failed:
                r, s = s[0], s[1:]
            chunk = chunk[1:]
            negated = chunk.startswith("^")
            if negated:
                chunk = chunk[1:]
            matched = False
            ranges = 0
            while True:
                if chunk.startswith("]") and ranges > 0:
                    chunk = chunk[1:]
                    break
                lo, chunk = _get_esc(chunk)
                hi = lo
                if chunk[0] == "-":
                    hi, chunk = _get_esc(chunk[1:])
                matched = matched or lo <= r <= hi
                ranges += 1
            failed = failed or matched == negated
            continue
        if ch == "?":
            if not failed:
                failed = s[0] == "/"
                s = s[1:]
            chunk = chunk[1:]
            continue
        if ch == "\\":
            chunk = chunk[1:]
            if not chunk:
                raise BadPatternError
        if not failed:
            failed = chunk[0] != s[0]
            s = s[1:]
        chunk = chunk[1:]
    return None if failed else s


def _get_esc(chunk: str) -> tuple[str, str]:
    """Read one possibly escaped character of a character class."""
    if not chunk or chunk[0] in "-]":
        raise BadPatternError
    if chunk[0] == "\\":
        chunk = chunk[1:]
        if not chunk:
            raise BadPatternError
    rest = chunk[1:]
    if not rest:
        raise BadPatternError
    return chunk[0], rest


@dataclass(frozen=True, slots=True)
class PathPattern:
    """A well-formed Go path.Match pattern."""

    pattern: str

    def matches(self, path: str) -> bool:
        """Report whether path matches the whole pattern."""
        return path_match(self.pattern, path)


def compile_path_pattern(pattern: str) -> PathPattern | None:
    """Validate a Go path.Match pattern, returning None when it is malformed.

    A malformed pattern never matches, as in Go's WithIgnorePaths. Matching
    the empty name reads the whole pattern, so it detects every syntax error.
    """
    try:
        path_match(pattern, "")
    except BadPatternError:
        return None
    return PathPattern(pattern)


def compile_ignore_patterns(patterns: Sequence[str]) -> tuple[PathPattern, ...]:
    """Compile ignore_paths glob patterns, dropping malformed ones."""
    return tuple(p for p in map(compile_path_pattern, patterns) if p is not None)


def is_path_ignored(path: str, patterns: Sequence[PathPattern]) -> bool:
    """Return True if the decoded path matches any ignore pattern."""
    return any(p.matches(path) for p in patterns)


def server_timing_header(sc: SpanContext) -> str | None:
    """Render a W3C Server-Timing traceparent entry for a valid SpanContext."""
    if not sc.is_valid:
        return None
    flags = int(sc.trace_flags)
    return f'traceparent;desc="00-{sc.trace_id:032x}-{sc.span_id:016x}-{flags:02x}"'


def is_html(content_type: str | None) -> bool:
    """Report whether a Content-Type value names text/html, as Go's servertiming.IsHTML.

    Only the media type before any parameters counts, trimmed and compared
    case-insensitively. A response without a Content-Type is not HTML.
    """
    if content_type is None:
        return False
    media = content_type.split(";", 1)[0]
    return media.strip().lower() == "text/html"


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


# ---------------------------------------------------------------- instruments


@dataclass(frozen=True, slots=True)
class HTTPInstruments:
    """The tracer, duration histogram and propagator one request uses."""

    tracer: Tracer
    duration: Histogram
    propagator: TextMapPropagator


@dataclass(frozen=True, slots=True)
class _GlobalInstruments:
    tracer_provider: TracerProvider
    meter_provider: MeterProvider
    tracer: Tracer
    duration: Histogram


class InstrumentResolver:
    """Resolves the instruments of one middleware or transport.

    With telemetry, the tracer and histogram are built once, at construction.
    Without it, they come from the global providers, rebuilt only when a global
    provider changes, so setup after construction takes effect on the next
    request.
    """

    __slots__ = ("_cached", "_description", "_fixed", "_metric_name", "_scope")

    def __init__(
        self,
        telemetry: Telemetry | None,
        *,
        scope: str,
        metric_name: str,
        description: str,
    ) -> None:
        self._scope = scope
        self._metric_name = metric_name
        self._description = description
        self._cached: _GlobalInstruments | None = None
        self._fixed: HTTPInstruments | None = None
        if telemetry is not None:
            self._fixed = HTTPInstruments(
                tracer=telemetry.tracer_provider.get_tracer(scope),
                duration=self._histogram(telemetry.meter_provider),
                propagator=telemetry.propagator,
            )

    def resolve(self) -> HTTPInstruments:
        """Return the instruments for the next request."""
        if self._fixed is not None:
            return self._fixed
        tracer_provider = trace.get_tracer_provider()
        meter_provider = metrics.get_meter_provider()
        cached = self._cached
        if (
            cached is None
            or cached.tracer_provider is not tracer_provider
            or cached.meter_provider is not meter_provider
        ):
            cached = _GlobalInstruments(
                tracer_provider=tracer_provider,
                meter_provider=meter_provider,
                tracer=tracer_provider.get_tracer(self._scope),
                duration=self._histogram(meter_provider),
            )
            self._cached = cached
        return HTTPInstruments(
            tracer=cached.tracer,
            duration=cached.duration,
            propagator=propagate.get_global_textmap(),
        )

    def _histogram(self, meter_provider: MeterProvider) -> Histogram:
        return meter_provider.get_meter(self._scope).create_histogram(
            self._metric_name,
            unit="s",
            description=self._description,
            explicit_bucket_boundaries_advisory=list(HTTP_DURATION_BUCKETS),
        )


# ---------------------------------------------------------------- routes


class RouteSlot:
    """Where set_route leaves the route of the server request being handled."""

    __slots__ = ("open", "route")

    def __init__(self) -> None:
        self.open = True
        self.route: str | None = None


_ROUTE_SLOT: ContextVar[RouteSlot | None] = ContextVar("libo11y_http_route_slot", default=None)


def bind_route_slot(slot: RouteSlot) -> Token[RouteSlot | None]:
    """Make slot the one set_route writes to in the current context."""
    return _ROUTE_SLOT.set(slot)


def reset_route_slot(token: Token[RouteSlot | None]) -> None:
    """Undo bind_route_slot."""
    _ROUTE_SLOT.reset(token)


def set_current_route(route: str) -> None:
    """Set the route of the server request being handled; see asgi.set_route."""
    if not route:
        return
    slot = _ROUTE_SLOT.get()
    if slot is not None and slot.open:
        slot.route = route


def is_django_handler(app: object) -> bool:
    """Report whether app is Django's own ASGI or WSGI handler."""
    return any(cls.__module__.startswith("django.core.handlers.") for cls in type(app).__mro__)


def django_route(path: str) -> str | None:
    """Return the route template Django's URL resolver matches for path."""
    try:
        match = importlib.import_module("django.urls").resolve(path)
    except Exception:
        return None
    route: object = getattr(match, "route", None)
    if isinstance(route, str) and route:
        return route if route.startswith("/") else "/" + route
    return None


def route_only(route: str) -> str:
    """Strip a leading method from a route ("GET /users/{id}" -> "/users/{id}")."""
    _, sep, rest = route.partition(" ")
    return rest if sep else route


def server_span_name(span_method: str, route: str | None) -> str:
    """Name a server span "<METHOD> <route>", the route verbatim when it has a method."""
    if not route:
        return span_method
    if " " in route:
        return route
    return f"{span_method} {route}"


# ---------------------------------------------------------------- errors


def error_type_for_status(status_code: int) -> str:
    """Return the OTel error.type string for an HTTP error status code."""
    return str(status_code)


def error_type_for_exception(exc: BaseException) -> str:
    """Return the OTel error.type string for a raised exception."""
    cls = type(exc)
    if cls.__module__ and cls.__module__ != "builtins":
        return f"{cls.__module__}.{cls.__qualname__}"
    return cls.__qualname__


def _mark_failed(span: Span, error: Exception | None, error_type: str) -> None:
    """Record error once: one exception event, error.type, and an ERROR status.

    The status has no description. Exception text is free text the
    sensitivity policy does not cover (SPEC section 5), so it never goes there.
    """
    if error is not None:
        span.record_exception(error)
    span.set_attribute("error.type", error_type)
    span.set_status(StatusCode.ERROR)


# ---------------------------------------------------------------- server requests


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
    attrs: dict[str, AttributeValue] = {
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


class ServerExchange:
    """One instrumented server request: its span, route slot and outcome.

    The ASGI and WSGI middleware drive it the same way: start it, run the
    application with ``context`` current and ``route_slot`` bound, note the
    status and any error, then call finish once, still with ``context`` current
    so the duration measurement carries the span as its exemplar.
    """

    __slots__ = (
        "_canonical_line",
        "_instruments",
        "_method_raw",
        "_protocol_version",
        "_scheme",
        "_start_ns",
        "_telemetry",
        "context",
        "error",
        "record",
        "route_slot",
        "span",
        "span_method",
        "status_code",
    )

    def __init__(
        self,
        instruments: HTTPInstruments,
        *,
        telemetry: Telemetry | None,
        canonical_line: bool,
        public_endpoint: bool,
        method_raw: str,
        scheme: str,
        protocol_version: str | None,
        headers: Mapping[str, str],
        attributes: Mapping[str, AttributeValue],
    ) -> None:
        self._instruments = instruments
        self._telemetry = telemetry
        self._canonical_line = canonical_line
        self._method_raw = method_raw
        self._scheme = scheme
        self._protocol_version = protocol_version
        method, exact = normalize_method(method_raw)
        self.span_method = span_method_name(method)
        attrs: dict[str, AttributeValue] = {"http.request.method": method, "url.scheme": scheme}
        if not exact:
            attrs["http.request.method_original"] = method_raw
        if protocol_version:
            attrs["network.protocol.version"] = protocol_version
        attrs.update(attributes)

        extracted = extract_inbound_context(instruments.propagator, headers)
        links: list[Link] = []
        parent = extracted
        if public_endpoint:
            # Link the untrusted caller's context rather than adopting it as parent.
            remote = trace.get_current_span(extracted).get_span_context()
            if remote.is_valid:
                links.append(Link(remote))
            parent = trace.set_span_in_context(INVALID_SPAN, extracted)
        self.span: Span = instruments.tracer.start_span(
            self.span_method,
            context=parent,
            kind=SpanKind.SERVER,
            attributes=attrs,
            links=links,
        )
        self.context: Context = trace.set_span_in_context(self.span, parent)
        self.route_slot = RouteSlot()
        self.record: Record | None = None
        self.status_code: int | None = None
        self.error: Exception | None = None
        self._start_ns = time.perf_counter_ns()

    def server_timing(self, content_type: str | None) -> str | None:
        """Return the Server-Timing entry for a response, or None when it gets none."""
        if not is_html(content_type):
            return None
        return server_timing_header(self.span.get_span_context())

    def fail(self, error: Exception) -> None:
        """Note an error the application raised; the first one is the one recorded."""
        if self.error is None:
            self.error = error

    def chosen_route(self, detect: Callable[[], str | None]) -> str | None:
        """Return the route set with set_route, or else the one detect finds."""
        return self.route_slot.route if self.route_slot.route is not None else detect()

    def finish(self, route: str | None, span_name: str | None = None) -> None:
        """Name, measure and end the span, and emit the canonical line.

        route is the low-cardinality route, possibly with a leading method.
        span_name, when given, replaces the default "<METHOD> <route>" name.
        Later set_route calls change nothing.
        """
        self.route_slot.open = False
        elapsed_s = (time.perf_counter_ns() - self._start_ns) / 1e9
        http_route = route_only(route) if route else None
        span = self.span
        try:
            span.update_name(
                span_name if span_name is not None else server_span_name(self.span_method, route)
            )
            if http_route:
                span.set_attribute("http.route", http_route)
            status = self.status_code
            if status is None and self.error is not None:
                status = 500
            if status is not None:
                span.set_attribute("http.response.status_code", status)
            error_type: str | None = None
            if self.error is not None:
                error_type = error_type_for_exception(self.error)
            elif status is not None and status >= 500:
                error_type = error_type_for_status(status)
            if error_type is not None:
                _mark_failed(span, self.error, error_type)

            metric_attrs: dict[str, AttributeValue] = {
                "http.request.method": normalize_method(self._method_raw)[0],
                "url.scheme": self._scheme,
            }
            if http_route:
                metric_attrs["http.route"] = http_route
            if status is not None:
                metric_attrs["http.response.status_code"] = status
            if error_type is not None:
                metric_attrs["error.type"] = error_type
            if self._protocol_version:
                metric_attrs["network.protocol.version"] = self._protocol_version
            self._instruments.duration.record(elapsed_s, metric_attrs, context=self.context)

            if self._canonical_line and self._telemetry is not None and self.record is not None:
                emit_http_summary(
                    self.record,
                    self._telemetry,
                    method_raw=self._method_raw,
                    status_code=status if status is not None else 200,
                    duration_s=elapsed_s,
                    route=http_route,
                    failed=self.error is not None,
                )
        finally:
            span.end()


# ---------------------------------------------------------------- client requests


type Origin = tuple[str, str, int | None]

_DEFAULT_PORTS: Final[Mapping[str, int]] = {"http": 80, "https": 443}


def origin_of(scheme: str, host: str, port: int | None) -> Origin:
    """Return the (scheme, host, port) origin of a URL, with default ports filled in."""
    scheme = scheme.lower()
    return scheme, host.lower(), port if port is not None else _DEFAULT_PORTS.get(scheme)


def protocol_version(http_version: str) -> str | None:
    """Map "HTTP/1.1" or "HTTP/2" onto network.protocol.version ("1.1", "2")."""
    version = http_version.strip().upper().removeprefix("HTTP/")
    return version or None


def should_propagate[T](propagate_fn: Callable[[T], bool] | None, destination: T) -> bool:
    """Apply a propagate_fn; one that raises is taken as False and reported by class only.

    The report never carries the error's message, which can quote the URL.
    """
    if propagate_fn is None:
        return True
    try:
        return bool(propagate_fn(destination))
    except Exception as exc:
        default_error_handler(
            RuntimeError(f"propagate_fn raised {type(exc).__name__}, the trace context is not sent")
        )
        return False


class ClientExchange:
    """One instrumented client request: its span and its outcome.

    The httpx transports and the requests adapter start it, send the request
    with ``context`` current, and call finish once with the response status or
    the error.
    """

    __slots__ = ("_instruments", "_metric_attrs", "_start_ns", "context", "span")

    def __init__(
        self,
        instruments: HTTPInstruments,
        *,
        method_raw: str,
        url_full: str,
        host: str,
        port: int | None,
        peer_service: str | None,
    ) -> None:
        self._instruments = instruments
        method, exact = normalize_method(method_raw)
        attrs: dict[str, AttributeValue] = {"http.request.method": method, "url.full": url_full}
        metric_attrs: dict[str, AttributeValue] = {"http.request.method": method}
        if not exact:
            attrs["http.request.method_original"] = method_raw
        if host:
            attrs["server.address"] = metric_attrs["server.address"] = host
        if port is not None:
            attrs["server.port"] = metric_attrs["server.port"] = port
        if peer_service:
            attrs["peer.service"] = peer_service
        self._metric_attrs = metric_attrs
        self.span: Span = instruments.tracer.start_span(
            span_method_name(method), kind=SpanKind.CLIENT, attributes=attrs
        )
        self.context: Context = trace.set_span_in_context(self.span)
        self._start_ns = time.perf_counter_ns()

    def inject(self, headers: MutableMapping[str, str]) -> None:
        """Inject the client span's trace context and baggage into headers."""
        self._instruments.propagator.inject(headers, context=self.context, setter=HEADER_SETTER)

    def strip(self, headers: MutableMapping[str, str]) -> None:
        """Remove every header the propagator injects, such as traceparent and baggage."""
        for name in self._instruments.propagator.fields:
            headers.pop(name, None)

    def finish(
        self,
        *,
        status_code: int | None = None,
        protocol_version: str | None = None,
        error: Exception | None = None,
    ) -> None:
        """Record the outcome, measure the duration and end the span."""
        elapsed_s = (time.perf_counter_ns() - self._start_ns) / 1e9
        span = self.span
        metric_attrs = dict(self._metric_attrs)
        try:
            if status_code is not None:
                span.set_attribute("http.response.status_code", status_code)
                metric_attrs["http.response.status_code"] = status_code
            if protocol_version:
                span.set_attribute("network.protocol.version", protocol_version)
                metric_attrs["network.protocol.version"] = protocol_version
            error_type: str | None = None
            if error is not None:
                error_type = error_type_for_exception(error)
            elif status_code is not None and status_code >= 400:
                error_type = error_type_for_status(status_code)
            if error_type is not None:
                _mark_failed(span, error, error_type)
                metric_attrs["error.type"] = error_type
            self._instruments.duration.record(elapsed_s, metric_attrs, context=self.context)
        finally:
            span.end()


# ---------------------------------------------------------------- propagation carriers


class CaseInsensitiveDictGetter(Getter[Mapping[str, str]]):
    """OTel Getter for case-insensitive lookup in a lowercased header mapping."""

    def get(self, carrier: Mapping[str, str], key: str) -> list[str] | None:
        val = carrier.get(key.lower())
        return [val] if val is not None else None

    def keys(self, carrier: Mapping[str, str]) -> list[str]:
        return list(carrier.keys())


class MutableHeaderSetter(Setter[MutableMapping[str, str]]):
    """OTel Setter for mutable header mappings (httpx.Headers, CaseInsensitiveDict)."""

    def set(self, carrier: MutableMapping[str, str], key: str, value: str) -> None:
        carrier[key] = value


HEADER_GETTER: Final[CaseInsensitiveDictGetter] = CaseInsensitiveDictGetter()
HEADER_SETTER: Final[MutableHeaderSetter] = MutableHeaderSetter()


def extract_inbound_context(
    prop: TextMapPropagator,
    headers: Mapping[str, str],
) -> Context:
    """Extract inbound trace context and baggage into a clean Context."""
    return prop.extract(headers, context=Context(), getter=HEADER_GETTER)
