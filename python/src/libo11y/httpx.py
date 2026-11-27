"""Instrumented sync and async httpx transports with stable HTTP semantic conventions."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

import httpx
from opentelemetry.trace import SpanKind, StatusCode

from libo11y._internal.http_common import (
    HEADER_SETTER,
    client_status_code,
    error_type_for_exception,
    error_type_for_status,
    normalize_method,
    resolve_http_primitives,
    sanitize_url_full,
    span_method_name,
)

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

type HTTPXFilter = Callable[[httpx.Request], bool]

_SCOPE_NAME = "libo11y.httpx"


def _request_attrs(request: httpx.Request) -> tuple[str, str, dict[str, Any]]:
    method_raw = request.method
    method, exact = normalize_method(method_raw)
    sp_method = span_method_name(method)
    attrs: dict[str, Any] = {
        "http.request.method": method,
        "url.full": sanitize_url_full(str(request.url)),
        "server.address": request.url.host,
    }
    if not exact:
        attrs["http.request.method_original"] = method_raw
    if request.url.port is not None:
        attrs["server.port"] = request.url.port
    return method, sp_method, attrs


class SyncTransport(httpx.BaseTransport):
    """Synchronous httpx transport recording client spans, metrics, and propagation."""

    def __init__(
        self,
        transport: httpx.BaseTransport | None = None,
        *,
        telemetry: Telemetry | None = None,
        filter: HTTPXFilter | None = None,
    ) -> None:
        self._inner = transport if transport is not None else httpx.HTTPTransport()
        self._telemetry = telemetry
        self._filter = filter

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if self._filter is not None and not self._filter(request):
            return self._inner.handle_request(request)

        tracer, duration_hist, propagator = resolve_http_primitives(
            self._telemetry,
            _SCOPE_NAME,
            "http.client.request.duration",
            "Duration of HTTP client requests.",
        )
        method, sp_method, initial_attrs = _request_attrs(request)
        start_ns = time.perf_counter_ns()
        status_code: int | None = None
        raised: BaseException | None = None

        with tracer.start_as_current_span(
            sp_method,
            kind=SpanKind.CLIENT,
            attributes=initial_attrs,
        ) as span:
            propagator.inject(request.headers, setter=HEADER_SETTER)
            try:
                response = self._inner.handle_request(request)
                status_code = response.status_code
                return response
            except Exception as exc:
                raised = exc
                span.record_exception(exc)
                raise
            finally:
                elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                if status_code is not None:
                    span.set_attribute("http.response.status_code", status_code)
                err_type: str | None = None
                if raised is not None:
                    err_type = error_type_for_exception(raised)
                elif status_code is not None and status_code >= 400:
                    err_type = error_type_for_status(status_code)
                if err_type is not None:
                    span.set_attribute("error.type", err_type)
                if client_status_code(status_code, raised) is StatusCode.ERROR:
                    span.set_status(StatusCode.ERROR)

                metric_attrs: dict[str, Any] = {
                    "http.request.method": method,
                    "server.address": request.url.host,
                }
                if request.url.port is not None:
                    metric_attrs["server.port"] = request.url.port
                if status_code is not None:
                    metric_attrs["http.response.status_code"] = status_code
                if err_type is not None:
                    metric_attrs["error.type"] = err_type
                duration_hist.record(elapsed_s, metric_attrs)

    def close(self) -> None:
        self._inner.close()


class AsyncTransport(httpx.AsyncBaseTransport):
    """Asynchronous httpx transport recording client spans, metrics, and propagation."""

    def __init__(
        self,
        transport: httpx.AsyncBaseTransport | None = None,
        *,
        telemetry: Telemetry | None = None,
        filter: HTTPXFilter | None = None,
    ) -> None:
        self._inner = transport if transport is not None else httpx.AsyncHTTPTransport()
        self._telemetry = telemetry
        self._filter = filter

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._filter is not None and not self._filter(request):
            return await self._inner.handle_async_request(request)

        tracer, duration_hist, propagator = resolve_http_primitives(
            self._telemetry,
            _SCOPE_NAME,
            "http.client.request.duration",
            "Duration of HTTP client requests.",
        )
        method, sp_method, initial_attrs = _request_attrs(request)
        start_ns = time.perf_counter_ns()
        status_code: int | None = None
        raised: BaseException | None = None

        with tracer.start_as_current_span(
            sp_method,
            kind=SpanKind.CLIENT,
            attributes=initial_attrs,
        ) as span:
            propagator.inject(request.headers, setter=HEADER_SETTER)
            try:
                response = await self._inner.handle_async_request(request)
                status_code = response.status_code
                return response
            except Exception as exc:
                raised = exc
                span.record_exception(exc)
                raise
            finally:
                elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                if status_code is not None:
                    span.set_attribute("http.response.status_code", status_code)
                err_type: str | None = None
                if raised is not None:
                    err_type = error_type_for_exception(raised)
                elif status_code is not None and status_code >= 400:
                    err_type = error_type_for_status(status_code)
                if err_type is not None:
                    span.set_attribute("error.type", err_type)
                if client_status_code(status_code, raised) is StatusCode.ERROR:
                    span.set_status(StatusCode.ERROR)

                metric_attrs: dict[str, Any] = {
                    "http.request.method": method,
                    "server.address": request.url.host,
                }
                if request.url.port is not None:
                    metric_attrs["server.port"] = request.url.port
                if status_code is not None:
                    metric_attrs["http.response.status_code"] = status_code
                if err_type is not None:
                    metric_attrs["error.type"] = err_type
                duration_hist.record(elapsed_s, metric_attrs)

    async def aclose(self) -> None:
        await self._inner.aclose()


__all__ = [
    "AsyncTransport",
    "HTTPXFilter",
    "SyncTransport",
]
