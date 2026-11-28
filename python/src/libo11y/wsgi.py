"""WSGI middleware with stable HTTP semantic conventions and route templates."""

from __future__ import annotations

import contextvars
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import AbstractContextManager
from typing import TYPE_CHECKING, Final, Protocol, cast
from wsgiref.types import StartResponse, WSGIApplication, WSGIEnvironment

from opentelemetry import context
from opentelemetry.util.types import AttributeValue

from libo11y._internal.http_common import (
    InstrumentResolver,
    ServerExchange,
    bind_route_slot,
    compile_ignore_patterns,
    django_route,
    is_django_handler,
    is_path_ignored,
    set_current_route,
)
from libo11y.record import Record, start_record

if TYPE_CHECKING:
    from _typeshed import OptExcInfo

    from libo11y.telemetry import Telemetry

type WSGIEnviron = WSGIEnvironment
type WSGIApp = WSGIApplication
type WSGIFilter = Callable[[WSGIEnvironment], bool]
type WSGISpanNameFormatter = Callable[[WSGIEnvironment, str | None], str]

_SCOPE_NAME: Final[str] = "libo11y.wsgi"


def set_route(route: str) -> None:
    """Set the route template of the WSGI request being handled.

    For applications that route inside their own handler, where the middleware
    cannot match a route itself. Pass the low-cardinality template, such as
    ``"/projects/{id}"``, never the raw path. When the request ends, the route
    set last names the span (``"<METHOD> <route>"``) and is the ``http.route``
    of the span, the ``http.server.request.duration`` metric and the canonical
    line, in place of any route the middleware found. A route that starts with
    a method and a space, such as ``"POST /rpc/{name}"``, names the span
    verbatim and contributes only the part after the space to ``http.route``.

    Call it while the application runs or while its response body is being
    iterated. Outside an instrumented request, after the request has ended, or
    with an empty route, it does nothing.
    """
    set_current_route(route)


def _extract_wsgi_headers(environ: WSGIEnvironment) -> dict[str, str]:
    headers: dict[str, str] = {}
    for k, v in environ.items():
        if not isinstance(v, str):
            continue
        if k.startswith("HTTP_"):
            headers[k[5:].replace("_", "-").lower()] = v
        elif k in ("CONTENT_TYPE", "CONTENT_LENGTH") and v:
            headers[k.replace("_", "-").lower()] = v
    return headers


class _MapAdapter(Protocol):
    def match(self, *, return_rule: bool) -> tuple[object, object]: ...


def _flask_route(app: object, environ: WSGIEnvironment) -> str | None:
    url_map: object = getattr(app, "url_map", None)
    bind: object = getattr(url_map, "bind_to_environ", None)
    if not callable(bind):
        return None
    try:
        rule, _ = cast(_MapAdapter, bind(environ)).match(return_rule=True)
    except Exception:
        return None
    rule_str: object = getattr(rule, "rule", None)
    return rule_str if isinstance(rule_str, str) and rule_str else None


def _resolve_route(app: object, environ: WSGIEnvironment, path: str, django: bool) -> str | None:
    explicit: object = environ.get("http.route")
    if isinstance(explicit, str) and explicit:
        return explicit
    flask = _flask_route(app, environ)
    if flask is not None:
        return flask
    if django:
        return django_route(path)
    return None


def _parse_status_code(status: str) -> int | None:
    try:
        return int(status.split(" ", 1)[0])
    except ValueError:
        return None


def _request_attributes(
    environ: WSGIEnvironment, path: str, headers: dict[str, str]
) -> dict[str, AttributeValue]:
    attrs: dict[str, AttributeValue] = {"url.path": path}
    query: object = environ.get("QUERY_STRING")
    if isinstance(query, str) and query:
        attrs["url.query"] = query
    server_name: object = environ.get("SERVER_NAME")
    if isinstance(server_name, str) and server_name:
        attrs["server.address"] = server_name
    server_port: object = environ.get("SERVER_PORT")
    if isinstance(server_port, str) and server_port.isdigit():
        attrs["server.port"] = int(server_port)
    remote_addr: object = environ.get("REMOTE_ADDR")
    if isinstance(remote_addr, str) and remote_addr:
        attrs["client.address"] = remote_addr
    user_agent = headers.get("user-agent")
    if user_agent:
        attrs["user_agent.original"] = user_agent
    return attrs


class _Request:
    """One instrumented WSGI request, run in its own contextvars.Context.

    PEP 3333 lets a server iterate and close the response from another thread
    or context than the one that called the application. Each step therefore
    runs inside a private copy of the caller's context, where the request span,
    the route slot and the wide-event record are current. The caller's context
    never changes, and the span ends exactly once.
    """

    __slots__ = ("_ctx", "_exchange", "_finish_route", "_finished", "_record_cm")

    def __init__(self, exchange: ServerExchange, finish_route: Callable[[], None]) -> None:
        self._exchange = exchange
        self._finish_route = finish_route
        self._finished = False
        self._record_cm: AbstractContextManager[Record] = start_record()
        self._ctx = contextvars.copy_context()
        self._ctx.run(self._enter)

    def _enter(self) -> None:
        context.attach(self._exchange.context)
        bind_route_slot(self._exchange.route_slot)
        self._exchange.record = self._record_cm.__enter__()

    def run[**P, R](self, fn: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs) -> R:
        """Call fn with the request's context current."""
        return self._ctx.run(fn, *args, **kwargs)

    def finish(self, error: Exception | None = None) -> None:
        """End the request once; later calls do nothing."""
        if self._finished:
            return
        self._finished = True
        if error is not None:
            self._exchange.fail(error)
        # The private context is discarded afterwards, so nothing is detached.
        self._ctx.run(self._finish_in_context)

    def _finish_in_context(self) -> None:
        try:
            self._finish_route()
        finally:
            self._record_cm.__exit__(None, None, None)


class _ResponseBody:
    """The PEP 3333 response iterable the middleware returns.

    close() works from construction, so a server that closes the response
    before iterating it still ends the request span.
    """

    __slots__ = ("_body", "_done", "_iterator", "_request")

    def __init__(self, request: _Request, body: Iterable[bytes]) -> None:
        self._request = request
        self._body = body
        self._iterator: Iterator[bytes] | None = None
        self._done = False

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        if self._done:
            raise StopIteration
        try:
            if self._iterator is None:
                self._iterator = self._request.run(iter, self._body)
            return self._request.run(next, self._iterator)
        except StopIteration:
            self._end(None)
            raise
        except Exception as exc:
            self._end(exc)
            raise

    def close(self) -> None:
        """Close the application's iterable and end the request span."""
        if not self._done:
            self._end(None)

    def _end(self, error: Exception | None) -> None:
        self._done = True
        close_error: Exception | None = None
        close = getattr(self._body, "close", None)
        if callable(close):
            try:
                self._request.run(cast(Callable[[], object], close))
            except Exception as exc:
                close_error = exc
        self._request.finish(error if error is not None else close_error)
        if close_error is not None:
            raise close_error


class WSGIMiddleware:
    """WSGI middleware recording server spans, metrics, and optional canonical lines.

    Routes come from, in order: ``set_route``, a ``"http.route"`` environ key,
    a Flask or Werkzeug ``url_map`` on the wrapped application, and Django's URL
    resolver when the wrapped application is Django's WSGI handler. The request
    span and duration cover the iteration of the response body.
    ``canonical_line`` requires ``telemetry``.
    """

    def __init__(
        self,
        app: WSGIApplication,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_paths: Sequence[str] = (),
        filter: WSGIFilter | None = None,
        canonical_line: bool = False,
        server_timing: bool = False,
        span_name_formatter: WSGISpanNameFormatter | None = None,
    ) -> None:
        if canonical_line and telemetry is None:
            raise ValueError("o11ywsgi: canonical_line requires telemetry")
        self._app = app
        self._telemetry = telemetry
        self._public_endpoint = public_endpoint
        self._ignore_patterns = compile_ignore_patterns(ignore_paths)
        self._filter = filter
        self._canonical_line = canonical_line
        self._server_timing = server_timing
        self._span_name_formatter = span_name_formatter
        self._django = is_django_handler(app)
        self._instruments = InstrumentResolver(
            telemetry,
            scope=_SCOPE_NAME,
            metric_name="http.server.request.duration",
            description="Duration of HTTP server requests.",
        )

    def __call__(self, environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        raw_path: object = environ.get("PATH_INFO")
        path = raw_path if isinstance(raw_path, str) else ""
        if is_path_ignored(path, self._ignore_patterns) or (
            self._filter is not None and not self._filter(environ)
        ):
            return self._app(environ, start_response)

        headers = _extract_wsgi_headers(environ)
        method: object = environ.get("REQUEST_METHOD")
        scheme: object = environ.get("wsgi.url_scheme")
        protocol: object = environ.get("SERVER_PROTOCOL")
        version = None
        if isinstance(protocol, str) and protocol.startswith("HTTP/"):
            version = protocol[5:] or None
        exchange = ServerExchange(
            self._instruments.resolve(),
            telemetry=self._telemetry,
            canonical_line=self._canonical_line,
            public_endpoint=self._public_endpoint,
            method_raw=method if isinstance(method, str) else "",
            scheme=scheme if isinstance(scheme, str) and scheme else "http",
            protocol_version=version,
            headers=headers,
            attributes=_request_attributes(environ, path, headers),
        )

        def finish_route() -> None:
            route = exchange.chosen_route(
                lambda: _resolve_route(self._app, environ, path, self._django)
            )
            name = None
            if self._span_name_formatter is not None:
                name = self._span_name_formatter(environ, route)
            exchange.finish(route, name)

        def start_response_with_status(
            status: str,
            response_headers: list[tuple[str, str]],
            exc_info: OptExcInfo | None = None,
            /,
        ) -> Callable[[bytes], object]:
            parsed = _parse_status_code(status)
            if parsed is not None:
                exchange.status_code = parsed
            if self._server_timing:
                content_type = next(
                    (v for k, v in response_headers if k.lower() == "content-type"), None
                )
                entry = exchange.server_timing(content_type)
                if entry is not None:
                    response_headers = [*response_headers, ("Server-Timing", entry)]
            if exc_info is not None:
                return start_response(status, response_headers, exc_info)
            return start_response(status, response_headers)

        request = _Request(exchange, finish_route)
        try:
            body = request.run(self._app, environ, start_response_with_status)
        except Exception as exc:
            request.finish(exc)
            raise
        return _ResponseBody(request, body)


def instrument_wsgi(
    app: WSGIApplication,
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
    "set_route",
]
