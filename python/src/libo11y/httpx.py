"""Instrumented sync and async httpx transports with stable HTTP semantic conventions."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Final

import httpx
from opentelemetry import trace

from libo11y._internal.http_common import (
    ClientExchange,
    InstrumentResolver,
    Origin,
    origin_of,
    protocol_version,
    sanitize_url_full,
    should_propagate,
)

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

type HTTPXFilter = Callable[[httpx.Request], bool]
type HTTPXPropagateFn = Callable[[httpx.URL], bool]

_SCOPE_NAME: Final[str] = "libo11y.httpx"
# httpx copies a request's extensions onto the request it builds to follow a
# redirect, so this key carries the first hop's origin to every later hop.
_ORIGIN_EXTENSION: Final[str] = "libo11y.origin"


def _url_origin(url: httpx.URL) -> Origin:
    return origin_of(url.scheme, url.host, url.port)


class _Instrumentation:
    """What the sync and async transports share: options, instruments and hops."""

    __slots__ = ("_filter", "_instruments", "_peer_service", "_propagate_fn")

    def __init__(
        self,
        telemetry: Telemetry | None,
        filter: HTTPXFilter | None,
        propagate_fn: HTTPXPropagateFn | None,
        peer_service: str | None,
    ) -> None:
        self._filter = filter
        self._propagate_fn = propagate_fn
        self._peer_service = peer_service
        self._instruments = InstrumentResolver(
            telemetry,
            scope=_SCOPE_NAME,
            metric_name="http.client.request.duration",
            description="Duration of HTTP client requests.",
        )

    def admits(self, request: httpx.Request) -> bool:
        return self._filter is None or self._filter(request)

    def begin(self, request: httpx.Request) -> ClientExchange:
        """Start the client span and set the hop's trace context headers.

        The first hop of a request gets the trace context unless propagate_fn
        declines its URL. A redirect hop gets it only when it stays on the
        first hop's origin; otherwise any propagated headers httpx copied from
        the previous hop are removed.
        """
        url = request.url
        exchange = ClientExchange(
            self._instruments.resolve(),
            method_raw=request.method,
            url_full=sanitize_url_full(str(url)),
            host=url.host,
            port=url.port,
            peer_service=self._peer_service,
        )
        origin = _url_origin(url)
        first_origin: object = request.extensions.get(_ORIGIN_EXTENSION)
        redirected = first_origin is not None
        if not redirected:
            request.extensions[_ORIGIN_EXTENSION] = origin
        if (not redirected or first_origin == origin) and should_propagate(self._propagate_fn, url):
            exchange.inject(request.headers)
        elif redirected:
            exchange.strip(request.headers)
        return exchange


def _finish(exchange: ClientExchange, response: httpx.Response) -> None:
    raw_version: object = response.extensions.get("http_version")
    version = None
    if isinstance(raw_version, bytes):
        version = protocol_version(raw_version.decode("ascii", "replace"))
    exchange.finish(status_code=response.status_code, protocol_version=version)


class SyncTransport(httpx.BaseTransport):
    """Synchronous httpx transport recording client spans, metrics, and propagation.

    ``propagate_fn`` decides per destination URL whether the trace context and
    baggage are injected (default: always). ``peer_service`` sets
    ``peer.service``, the logical name of the service called. ``filter``
    excludes whole requests from instrumentation.
    """

    def __init__(
        self,
        transport: httpx.BaseTransport | None = None,
        *,
        telemetry: Telemetry | None = None,
        filter: HTTPXFilter | None = None,
        propagate_fn: HTTPXPropagateFn | None = None,
        peer_service: str | None = None,
    ) -> None:
        self._inner = transport if transport is not None else httpx.HTTPTransport()
        self._instrumentation = _Instrumentation(telemetry, filter, propagate_fn, peer_service)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if not self._instrumentation.admits(request):
            return self._inner.handle_request(request)
        exchange = self._instrumentation.begin(request)
        with trace.use_span(exchange.span, record_exception=False, set_status_on_exception=False):
            try:
                response = self._inner.handle_request(request)
            except Exception as exc:
                exchange.finish(error=exc)
                raise
            _finish(exchange, response)
            return response

    def close(self) -> None:
        self._inner.close()


class AsyncTransport(httpx.AsyncBaseTransport):
    """Asynchronous httpx transport recording client spans, metrics, and propagation.

    Takes the same options as :class:`SyncTransport`.
    """

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        *,
        telemetry: Telemetry | None = None,
        filter: HTTPXFilter | None = None,
        propagate_fn: HTTPXPropagateFn | None = None,
        peer_service: str | None = None,
    ) -> None:
        self._inner = transport if transport is not None else httpx.AsyncHTTPTransport()
        self._instrumentation = _Instrumentation(telemetry, filter, propagate_fn, peer_service)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if not self._instrumentation.admits(request):
            return await self._inner.handle_async_request(request)
        exchange = self._instrumentation.begin(request)
        with trace.use_span(exchange.span, record_exception=False, set_status_on_exception=False):
            try:
                response = await self._inner.handle_async_request(request)
            except Exception as exc:
                exchange.finish(error=exc)
                raise
            _finish(exchange, response)
            return response

    async def aclose(self) -> None:
        await self._inner.aclose()


__all__ = [
    "AsyncTransport",
    "HTTPXFilter",
    "HTTPXPropagateFn",
    "SyncTransport",
]
