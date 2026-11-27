"""ASGI 3 middleware with stable HTTP semantic conventions and route templates."""

from __future__ import annotations

import importlib
import sys
import time
from collections.abc import Awaitable, Callable, MutableMapping, Sequence
from typing import TYPE_CHECKING, Any, cast

from opentelemetry import context, trace
from opentelemetry.trace import INVALID_SPAN, Link, SpanKind, StatusCode

from libo11y._internal.http_common import (
    compile_ignore_patterns,
    emit_http_summary,
    error_type_for_exception,
    error_type_for_status,
    extract_inbound_context,
    is_path_ignored,
    normalize_method,
    resolve_http_primitives,
    server_status_code,
    server_timing_header,
    span_method_name,
)
from libo11y.record import start_record

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

type ASGIScope = MutableMapping[str, Any]
type ASGIReceive = Callable[[], Awaitable[MutableMapping[str, Any]]]
type ASGISend = Callable[[MutableMapping[str, Any]], Awaitable[None]]
type ASGIApp = Callable[[ASGIScope, ASGIReceive, ASGISend], Awaitable[None]]
type ASGIFilter = Callable[[ASGIScope], bool]
type ASGISpanNameFormatter = Callable[[ASGIScope, str | None], str]

_SCOPE_NAME = "libo11y.asgi"


def _extract_asgi_headers(scope: ASGIScope) -> dict[str, str]:
    headers: dict[str, str] = {}
    raw_headers = scope.get("headers") or ()
    for k_bytes, v_bytes in raw_headers:
        k = k_bytes.decode("latin1").lower()
        v = v_bytes.decode("latin1")
        if k in headers:
            headers[k] = f"{headers[k]},{v}"
        else:
            headers[k] = v
    return headers


def _extract_asgi_route(scope: ASGIScope, path: str) -> str | None:
    explicit = scope.get("http.route")
    if isinstance(explicit, str) and explicit:
        return explicit

    # Starlette / FastAPI attach the matched route object to scope["route"].
    route_obj = scope.get("route")
    if route_obj is not None:
        route_path = getattr(route_obj, "path", None)
        if isinstance(route_path, str) and route_path:
            root_path = scope.get("root_path", "")
            if isinstance(root_path, str) and root_path:
                return root_path.rstrip("/") + route_path
            return route_path

    # Django ASGI resolver_match (either placed on scope or resolved via django.urls).
    resolver_match = scope.get("resolver_match")
    if resolver_match is not None:
        dj_route = getattr(resolver_match, "route", None)
        if isinstance(dj_route, str) and dj_route:
            return dj_route if dj_route.startswith("/") else "/" + dj_route

    if "django.urls" in sys.modules:
        try:
            dj_conf = importlib.import_module("django.conf")
            dj_urls = importlib.import_module("django.urls")
            if getattr(getattr(dj_conf, "settings", None), "configured", False):
                match = dj_urls.resolve(path)
                dj_route = getattr(match, "route", None)
                if isinstance(dj_route, str) and dj_route:
                    return dj_route if dj_route.startswith("/") else "/" + dj_route
        except Exception:
            return None
    return None


class ASGIMiddleware:
    """ASGI 3 middleware recording server spans, metrics, and optional canonical lines."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_paths: Sequence[str] = (),
        filter: ASGIFilter | None = None,
        canonical_line: bool = False,
        server_timing: bool = False,
        span_name_formatter: ASGISpanNameFormatter | None = None,
    ) -> None:
        self._app = app
        self._telemetry = telemetry
        self._public_endpoint = public_endpoint
        self._ignore_patterns = compile_ignore_patterns(ignore_paths)
        self._filter = filter
        self._canonical_line = canonical_line
        self._server_timing = server_timing
        self._span_name_formatter = span_name_formatter

    async def __call__(self, scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return

        path = str(scope.get("path", "") or "")
        if is_path_ignored(path, self._ignore_patterns):
            await self._app(scope, receive, send)
            return
        if self._filter is not None and not self._filter(scope):
            await self._app(scope, receive, send)
            return

        tracer, duration_hist, propagator = resolve_http_primitives(
            self._telemetry,
            _SCOPE_NAME,
            "http.server.request.duration",
            "Duration of HTTP server requests.",
        )

        method_raw = str(scope.get("method", "") or "")
        method, exact = normalize_method(method_raw)
        sp_method = span_method_name(method)
        scheme = str(scope.get("scheme", "http") or "http")
        headers = _extract_asgi_headers(scope)
        extracted_ctx = extract_inbound_context(propagator, headers)

        links: list[Link] = []
        if self._public_endpoint:
            remote_sc = trace.get_current_span(extracted_ctx).get_span_context()
            if remote_sc.is_valid:
                links.append(Link(remote_sc))
            parent_ctx = trace.set_span_in_context(INVALID_SPAN, extracted_ctx)
        else:
            parent_ctx = extracted_ctx

        initial_attrs: dict[str, Any] = {
            "http.request.method": method,
            "url.path": path,
            "url.scheme": scheme,
        }
        if not exact:
            initial_attrs["http.request.method_original"] = method_raw
        query_bytes = scope.get("query_string")
        if isinstance(query_bytes, (bytes, bytearray)) and query_bytes:
            initial_attrs["url.query"] = query_bytes.decode("latin1")
        http_ver = scope.get("http_version")
        if isinstance(http_ver, str) and http_ver:
            initial_attrs["network.protocol.version"] = http_ver
        server_info = scope.get("server")
        if isinstance(server_info, (tuple, list)):
            srv_seq = cast(Sequence[Any], server_info)
            if len(srv_seq) >= 1 and srv_seq[0]:
                initial_attrs["server.address"] = str(srv_seq[0])
                if len(srv_seq) >= 2 and isinstance(srv_seq[1], int):
                    initial_attrs["server.port"] = srv_seq[1]
        client_info = scope.get("client")
        if isinstance(client_info, (tuple, list)):
            cli_seq = cast(Sequence[Any], client_info)
            if len(cli_seq) >= 1 and cli_seq[0]:
                initial_attrs["client.address"] = str(cli_seq[0])
        ua = headers.get("user-agent")
        if ua:
            initial_attrs["user_agent.original"] = ua

        start_ns = time.perf_counter_ns()
        status_code: int | None = None
        raised: BaseException | None = None

        token = context.attach(parent_ctx)
        try:
            with tracer.start_as_current_span(
                sp_method,
                context=parent_ctx,
                kind=SpanKind.SERVER,
                attributes=initial_attrs,
                links=links,
            ) as span:
                st_header = server_timing_header(span.get_span_context())

                async def _wrapped_send(message: MutableMapping[str, Any]) -> None:
                    nonlocal status_code
                    if message.get("type") == "http.response.start":
                        raw_status = message.get("status")
                        if isinstance(raw_status, int):
                            status_code = raw_status
                        if self._server_timing and st_header is not None:
                            raw_hdrs: list[tuple[bytes, bytes]] = list(message.get("headers") or ())
                            raw_hdrs.append((b"server-timing", st_header.encode("latin1")))
                            message = {**message, "headers": raw_hdrs}
                    await send(message)

                with start_record() as record:
                    try:
                        await self._app(scope, receive, _wrapped_send)
                    except Exception as exc:
                        raised = exc
                        span.record_exception(exc)
                        raise
                    finally:
                        elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                        route = _extract_asgi_route(scope, path)
                        if self._span_name_formatter is not None:
                            span.update_name(self._span_name_formatter(scope, route))
                        elif route:
                            span.update_name(f"{sp_method} {route}")
                        if route:
                            span.set_attribute("http.route", route)

                        effective_status = status_code
                        if effective_status is None and raised is not None:
                            effective_status = 500
                        if effective_status is not None:
                            span.set_attribute("http.response.status_code", effective_status)

                        err_type: str | None = None
                        if raised is not None:
                            err_type = error_type_for_exception(raised)
                        elif effective_status is not None and effective_status >= 500:
                            err_type = error_type_for_status(effective_status)
                        if err_type is not None:
                            span.set_attribute("error.type", err_type)

                        sp_status = server_status_code(effective_status, raised)
                        if sp_status is StatusCode.ERROR:
                            span.set_status(StatusCode.ERROR)

                        metric_attrs: dict[str, Any] = {
                            "http.request.method": method,
                            "url.scheme": scheme,
                        }
                        if route:
                            metric_attrs["http.route"] = route
                        if effective_status is not None:
                            metric_attrs["http.response.status_code"] = effective_status
                        if err_type is not None:
                            metric_attrs["error.type"] = err_type
                        if isinstance(http_ver, str) and http_ver:
                            metric_attrs["network.protocol.version"] = http_ver
                        duration_hist.record(elapsed_s, metric_attrs)

                        if self._canonical_line and self._telemetry is not None:
                            emit_http_summary(
                                record,
                                self._telemetry,
                                method_raw=method_raw,
                                status_code=effective_status
                                if effective_status is not None
                                else 200,
                                duration_s=elapsed_s,
                                route=route,
                                failed=raised is not None,
                            )
        finally:
            context.detach(token)


def instrument_asgi(
    app: ASGIApp,
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_paths: Sequence[str] = (),
    filter: ASGIFilter | None = None,
    canonical_line: bool = False,
    server_timing: bool = False,
    span_name_formatter: ASGISpanNameFormatter | None = None,
) -> ASGIMiddleware:
    """Wrap an ASGI 3 application with libo11y HTTP server instrumentation."""
    return ASGIMiddleware(
        app,
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_paths=ignore_paths,
        filter=filter,
        canonical_line=canonical_line,
        server_timing=server_timing,
        span_name_formatter=span_name_formatter,
    )


__all__ = [
    "ASGIApp",
    "ASGIFilter",
    "ASGIMiddleware",
    "ASGIScope",
    "ASGISpanNameFormatter",
    "instrument_asgi",
]
