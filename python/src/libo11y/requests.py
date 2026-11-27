"""Instrumented requests.HTTPAdapter without global monkey-patching.

Mount HTTPAdapter onto explicit requests.Session instances so the OTLP/HTTP
exporter's own sessions are never instrumented.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import requests
import requests.adapters
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

type RequestsFilter = Callable[[requests.PreparedRequest], bool]

_SCOPE_NAME = "libo11y.requests"


class HTTPAdapter(requests.adapters.HTTPAdapter):
    """requests HTTPAdapter recording client spans, metrics, and context injection."""

    def __init__(
        self,
        *args: Any,
        telemetry: Telemetry | None = None,
        filter: RequestsFilter | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._telemetry = telemetry
        self._filter = filter

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
                request,
                stream=stream,
                timeout=timeout,
                verify=verify,
                cert=cert,
                proxies=proxies,
            )

        tracer, duration_hist, propagator = resolve_http_primitives(
            self._telemetry,
            _SCOPE_NAME,
            "http.client.request.duration",
            "Duration of HTTP client requests.",
        )

        method_raw = request.method or ""
        method, exact = normalize_method(method_raw)
        sp_method = span_method_name(method)
        raw_url = request.url or ""
        parsed = urlsplit(raw_url)
        host = parsed.hostname or ""
        port = parsed.port

        initial_attrs: dict[str, Any] = {
            "http.request.method": method,
            "url.full": sanitize_url_full(raw_url),
        }
        if not exact:
            initial_attrs["http.request.method_original"] = method_raw
        if host:
            initial_attrs["server.address"] = host
        if port is not None:
            initial_attrs["server.port"] = port

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
                response = super().send(
                    request,
                    stream=stream,
                    timeout=timeout,
                    verify=verify,
                    cert=cert,
                    proxies=proxies,
                )
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
                }
                if host:
                    metric_attrs["server.address"] = host
                if port is not None:
                    metric_attrs["server.port"] = port
                if status_code is not None:
                    metric_attrs["http.response.status_code"] = status_code
                if err_type is not None:
                    metric_attrs["error.type"] = err_type
                duration_hist.record(elapsed_s, metric_attrs)


def mount(
    session: requests.Session,
    *,
    telemetry: Telemetry | None = None,
    filter: RequestsFilter | None = None,
    prefixes: Sequence[str] = ("http://", "https://"),
    **adapter_kwargs: Any,
) -> HTTPAdapter:
    """Mount an instrumented HTTPAdapter on session for the given URL prefixes."""
    adapter = HTTPAdapter(telemetry=telemetry, filter=filter, **adapter_kwargs)
    for prefix in prefixes:
        session.mount(prefix, adapter)
    return adapter


__all__ = [
    "HTTPAdapter",
    "RequestsFilter",
    "mount",
]
