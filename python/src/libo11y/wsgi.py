"""WSGI middleware with stable HTTP semantic conventions and route templates."""

from __future__ import annotations

import importlib
import sys
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from typing import TYPE_CHECKING, Any

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

type WSGIEnviron = dict[str, Any]
type StartResponse = Callable[..., Any]
type WSGIApp = Callable[[WSGIEnviron, StartResponse], Iterable[bytes]]
type WSGIFilter = Callable[[WSGIEnviron], bool]
type WSGISpanNameFormatter = Callable[[WSGIEnviron, str | None], str]

_SCOPE_NAME = "libo11y.wsgi"


def _extract_wsgi_headers(environ: WSGIEnviron) -> dict[str, str]:
    headers: dict[str, str] = {}
    for k, v in environ.items():
        if not isinstance(v, str):
            continue
        if k.startswith("HTTP_"):
            name = k[5:].replace("_", "-").lower()
            headers[name] = v
        elif k in ("CONTENT_TYPE", "CONTENT_LENGTH") and v:
            headers[k.replace("_", "-").lower()] = v
    return headers


def _extract_wsgi_route(app: Any, environ: WSGIEnviron, path: str) -> str | None:
    explicit = environ.get("http.route")
    if isinstance(explicit, str) and explicit:
        return explicit

    # Flask / Werkzeug apps expose url_map on the application object.
    url_map = getattr(app, "url_map", None)
    if url_map is not None and hasattr(url_map, "bind_to_environ"):
        try:
            adapter = url_map.bind_to_environ(environ)
            rule, _ = adapter.match(return_rule=True)
            rule_str = getattr(rule, "rule", None)
            if isinstance(rule_str, str) and rule_str:
                return rule_str
        except Exception:
            pass

    # Django WSGI applications resolve routes via django.urls.resolve.
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


def _parse_status_code(status_str: str) -> int | None:
    head = status_str.split(" ", 1)[0]
    try:
        return int(head)
    except ValueError:
        return None


class WSGIMiddleware:
    """WSGI middleware recording server spans, metrics, and optional canonical lines."""

    def __init__(
        self,
        app: WSGIApp,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_paths: Sequence[str] = (),
        filter: WSGIFilter | None = None,
        canonical_line: bool = False,
        server_timing: bool = False,
        span_name_formatter: WSGISpanNameFormatter | None = None,
    ) -> None:
        self._app = app
        self._telemetry = telemetry
        self._public_endpoint = public_endpoint
        self._ignore_patterns = compile_ignore_patterns(ignore_paths)
        self._filter = filter
        self._canonical_line = canonical_line
        self._server_timing = server_timing
        self._span_name_formatter = span_name_formatter

    def __call__(self, environ: WSGIEnviron, start_response: StartResponse) -> Iterable[bytes]:
        path = str(environ.get("PATH_INFO", "") or "")
        if is_path_ignored(path, self._ignore_patterns):
            return self._app(environ, start_response)
        if self._filter is not None and not self._filter(environ):
            return self._app(environ, start_response)

        tracer, duration_hist, propagator = resolve_http_primitives(
            self._telemetry,
            _SCOPE_NAME,
            "http.server.request.duration",
            "Duration of HTTP server requests.",
        )

        method_raw = str(environ.get("REQUEST_METHOD", "") or "")
        method, exact = normalize_method(method_raw)
        sp_method = span_method_name(method)
        scheme = str(environ.get("wsgi.url_scheme", "http") or "http")
        headers = _extract_wsgi_headers(environ)
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
        qs = environ.get("QUERY_STRING")
        if isinstance(qs, str) and qs:
            initial_attrs["url.query"] = qs
        proto = environ.get("SERVER_PROTOCOL")
        http_ver: str | None = None
        if isinstance(proto, str) and proto.startswith("HTTP/"):
            http_ver = proto[5:]
            initial_attrs["network.protocol.version"] = http_ver
        server_name = environ.get("SERVER_NAME")
        if isinstance(server_name, str) and server_name:
            initial_attrs["server.address"] = server_name
        server_port = environ.get("SERVER_PORT")
        if isinstance(server_port, str) and server_port.isdigit():
            initial_attrs["server.port"] = int(server_port)
        remote_addr = environ.get("REMOTE_ADDR")
        if isinstance(remote_addr, str) and remote_addr:
            initial_attrs["client.address"] = remote_addr
        ua = headers.get("user-agent")
        if ua:
            initial_attrs["user_agent.original"] = ua

        start_ns = time.perf_counter_ns()
        status_code: int | None = None
        raised: BaseException | None = None

        parent_token = context.attach(parent_ctx)
        span = tracer.start_span(
            sp_method,
            context=parent_ctx,
            kind=SpanKind.SERVER,
            attributes=initial_attrs,
            links=links,
        )
        span_ctx = trace.set_span_in_context(span, parent_ctx)
        span_token = context.attach(span_ctx)
        rec_cm = start_record()
        record = rec_cm.__enter__()
        st_header = server_timing_header(span.get_span_context())
        finished = False

        def _wrapped_start_response(
            status: str,
            response_headers: list[tuple[str, str]],
            exc_info: Any = None,
        ) -> Any:
            nonlocal status_code
            parsed = _parse_status_code(status)
            if parsed is not None:
                status_code = parsed
            if self._server_timing and st_header is not None:
                response_headers = [*response_headers, ("Server-Timing", st_header)]
            if exc_info is not None:
                return start_response(status, response_headers, exc_info)
            return start_response(status, response_headers)

        def _finish() -> None:
            nonlocal finished
            if finished:
                return
            finished = True
            try:
                elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
                route = _extract_wsgi_route(self._app, environ, path)
                if self._span_name_formatter is not None:
                    span.update_name(self._span_name_formatter(environ, route))
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
                if http_ver:
                    metric_attrs["network.protocol.version"] = http_ver
                duration_hist.record(elapsed_s, metric_attrs)

                if self._canonical_line and self._telemetry is not None:
                    emit_http_summary(
                        record,
                        self._telemetry,
                        method_raw=method_raw,
                        status_code=effective_status if effective_status is not None else 200,
                        duration_s=elapsed_s,
                        route=route,
                        failed=raised is not None,
                    )
            finally:
                rec_cm.__exit__(None, None, None)
                span.end()
                context.detach(span_token)
                context.detach(parent_token)

        try:
            app_iter = self._app(environ, _wrapped_start_response)
        except Exception as exc:
            raised = exc
            span.record_exception(exc)
            _finish()
            raise

        def _body_generator() -> Iterator[bytes]:
            nonlocal raised
            try:
                yield from app_iter
            except Exception as exc:
                raised = exc
                span.record_exception(exc)
                raise
            finally:
                close_fn = getattr(app_iter, "close", None)
                if callable(close_fn):
                    close_fn()
                _finish()

        return _body_generator()


def instrument_wsgi(
    app: WSGIApp,
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_paths: Sequence[str] = (),
    filter: WSGIFilter | None = None,
    canonical_line: bool = False,
    server_timing: bool = False,
    span_name_formatter: WSGISpanNameFormatter | None = None,
) -> WSGIMiddleware:
    """Wrap a WSGI application with libo11y HTTP server instrumentation."""
    return WSGIMiddleware(
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
    "StartResponse",
    "WSGIApp",
    "WSGIEnviron",
    "WSGIFilter",
    "WSGIMiddleware",
    "WSGISpanNameFormatter",
    "instrument_wsgi",
]
