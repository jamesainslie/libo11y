"""Instrumented requests.HTTPAdapter without global monkey-patching.

Mount HTTPAdapter onto explicit requests.Session instances so the OTLP/HTTP
exporter's own sessions are never instrumented.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import urlsplit

import requests
import requests.adapters
from opentelemetry import trace

from libo11y._internal.http_common import (
    ClientExchange,
    InstrumentResolver,
    Origin,
    origin_of,
    sanitize_url_full,
    should_propagate,
)

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

type RequestsFilter = Callable[[requests.PreparedRequest], bool]
type RequestsPropagateFn = Callable[[str], bool]

_SCOPE_NAME: Final[str] = "libo11y.requests"
# Redirect responses whose follow-up hop has not arrived yet. A session that
# does not follow redirects leaves its entries behind, so the table is bounded.
_MAX_PENDING_REDIRECTS: Final[int] = 1024
# urllib3 reports the response's HTTP version as an int.
_HTTP_VERSIONS: Final[Mapping[int, str]] = {9: "0.9", 10: "1.0", 11: "1.1", 20: "2", 30: "3"}

type _Carried = tuple[tuple[str, str], ...]


class _PendingRedirects:
    """Remembers the trace context sent on hops answered with a redirect.

    requests follows a redirect by copying the previous hop's headers onto a
    new PreparedRequest and sending it through the adapter again, with nothing
    else to tie the two together. The propagated headers this adapter injected
    identify the follow-up hop, so a redirect to another origin can be sent
    without them.
    """

    __slots__ = ("_lock", "_origins")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._origins: OrderedDict[_Carried, Origin] = OrderedDict()

    def remember(self, carried: _Carried, first_origin: Origin) -> None:
        if not carried:
            return
        with self._lock:
            self._origins[carried] = first_origin
            while len(self._origins) > _MAX_PENDING_REDIRECTS:
                self._origins.popitem(last=False)

    def take(self, carried: _Carried) -> Origin | None:
        if not carried:
            return None
        with self._lock:
            return self._origins.pop(carried, None)


def _carried(fields: Sequence[str], request: requests.PreparedRequest) -> _Carried:
    headers = request.headers
    return tuple((name, value) for name in fields if (value := headers.get(name)) is not None)


def _protocol_version(response: requests.Response) -> str | None:
    version: object = getattr(response.raw, "version", None)
    return _HTTP_VERSIONS.get(version) if isinstance(version, int) else None


class HTTPAdapter(requests.adapters.HTTPAdapter):
    """requests HTTPAdapter recording client spans, metrics, and context injection.

    ``propagate_fn`` decides per destination URL whether the trace context and
    baggage are injected (default: always). ``peer_service`` sets
    ``peer.service``, the logical name of the service called. ``filter``
    excludes whole requests from instrumentation. A redirect the session
    follows to another origin is sent without the trace context.
    """

    def __init__(
        self,
        *args: Any,
        telemetry: Telemetry | None = None,
        filter: RequestsFilter | None = None,
        propagate_fn: RequestsPropagateFn | None = None,
        peer_service: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._filter = filter
        self._propagate_fn = propagate_fn
        self._peer_service = peer_service
        self._pending_redirects = _PendingRedirects()
        self._instruments = InstrumentResolver(
            telemetry,
            scope=_SCOPE_NAME,
            metric_name="http.client.request.duration",
            description="Duration of HTTP client requests.",
        )

    def send(
        self,
        request: requests.PreparedRequest,
        stream: bool = False,
        timeout: float | tuple[float, float] | tuple[float, None] | None = None,
        verify: bool | str = True,
        cert: bytes | str | tuple[bytes | str, bytes | str] | None = None,
        proxies: Mapping[str, str] | None = None,
    ) -> requests.Response:
        if self._filter is not None and not self._filter(request):
            return super().send(
                request, stream=stream, timeout=timeout, verify=verify, cert=cert, proxies=proxies
            )

        instruments = self._instruments.resolve()
        fields = sorted(instruments.propagator.fields)
        raw_url = request.url or ""
        parsed = urlsplit(raw_url)
        exchange = ClientExchange(
            instruments,
            method_raw=request.method or "",
            url_full=sanitize_url_full(raw_url),
            host=parsed.hostname or "",
            port=parsed.port,
            peer_service=self._peer_service,
        )
        origin = origin_of(parsed.scheme, parsed.hostname or "", parsed.port)
        first_origin = self._pending_redirects.take(_carried(fields, request))
        redirected = first_origin is not None
        if (not redirected or first_origin == origin) and should_propagate(
            self._propagate_fn, raw_url
        ):
            exchange.inject(request.headers)
        elif redirected:
            exchange.strip(request.headers)

        with trace.use_span(exchange.span, record_exception=False, set_status_on_exception=False):
            try:
                response = super().send(
                    request,
                    stream=stream,
                    timeout=timeout,
                    verify=verify,
                    cert=cert,
                    proxies=proxies,
                )
            except Exception as exc:
                exchange.finish(error=exc)
                raise
            if response.is_redirect:
                self._pending_redirects.remember(
                    _carried(fields, request), first_origin if first_origin is not None else origin
                )
            exchange.finish(
                status_code=response.status_code, protocol_version=_protocol_version(response)
            )
            return response


def mount(
    session: requests.Session,
    *,
    telemetry: Telemetry | None = None,
    filter: RequestsFilter | None = None,
    propagate_fn: RequestsPropagateFn | None = None,
    peer_service: str | None = None,
    prefixes: Sequence[str] = ("http://", "https://"),
    **adapter_kwargs: Any,
) -> HTTPAdapter:
    """Mount an instrumented HTTPAdapter on session for the given URL prefixes."""
    adapter = HTTPAdapter(
        telemetry=telemetry,
        filter=filter,
        propagate_fn=propagate_fn,
        peer_service=peer_service,
        **adapter_kwargs,
    )
    for prefix in prefixes:
        session.mount(prefix, adapter)
    return adapter


__all__ = [
    "HTTPAdapter",
    "RequestsFilter",
    "RequestsPropagateFn",
    "mount",
]
