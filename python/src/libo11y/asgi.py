"""ASGI 3 middleware with stable HTTP semantic conventions and route templates."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Protocol, cast

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
    reset_route_slot,
    set_current_route,
)
from libo11y.record import start_record

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

# ASGI scopes and messages are dicts whose value types depend on the key. The
# value type is Any, as in Starlette's and asgiref's aliases, so Starlette,
# FastAPI and Django applications type-check when passed in. The middleware
# checks the type of every value it reads.
type ASGIScope = MutableMapping[str, Any]
type ASGIMessage = MutableMapping[str, Any]
type ASGIReceive = Callable[[], Awaitable[ASGIMessage]]
type ASGISend = Callable[[ASGIMessage], Awaitable[None]]
type ASGIApp = Callable[[ASGIScope, ASGIReceive, ASGISend], Awaitable[None]]
type ASGIFilter = Callable[[ASGIScope], bool]
type ASGISpanNameFormatter = Callable[[ASGIScope, str | None], str]

_SCOPE_NAME: Final[str] = "libo11y.asgi"
# Mounts nest only as deep as an application's routing tree; this bounds the
# walk over a router that does not behave like Starlette's.
_MAX_MOUNT_DEPTH: Final[int] = 32


def set_route(route: str) -> None:
    """Set the route template of the ASGI request being handled.

    For applications that route inside their own handler, where the middleware
    cannot read a matched route from the scope. Pass the low-cardinality
    template, such as ``"/projects/{id}"``, never the raw path. When the request
    ends, the route set last names the span (``"<METHOD> <route>"``) and is the
    ``http.route`` of the span, the ``http.server.request.duration`` metric and
    the canonical line, in place of any route the framework matched. A route
    that starts with a method and a space, such as ``"POST /rpc/{name}"``,
    names the span verbatim and contributes only the part after the space to
    ``http.route``.

    It finds the request through the current context, so call it from the
    handler's task or a task it started. Outside an instrumented request, after
    the request has ended, or with an empty route, it does nothing.
    """
    set_current_route(route)


def _header_pairs(raw: object) -> list[tuple[bytes, bytes]]:
    """Return the well-formed (name, value) byte pairs of an ASGI header list."""
    pairs: list[tuple[bytes, bytes]] = []
    if not isinstance(raw, Iterable):
        return pairs
    for pair in cast(Iterable[object], raw):
        if isinstance(pair, bytes | str) or not isinstance(pair, Sequence):
            continue
        items = cast(Sequence[object], pair)
        if len(items) == 2:
            name, value = items
            if isinstance(name, bytes) and isinstance(value, bytes):
                pairs.append((name, value))
    return pairs


def _decode_headers(scope: ASGIScope) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name, value in _header_pairs(scope.get("headers")):
        key = name.decode("latin1").lower()
        text = value.decode("latin1")
        headers[key] = f"{headers[key]},{text}" if key in headers else text
    return headers


def _response_content_type(raw_headers: object) -> str | None:
    for name, value in _header_pairs(raw_headers):
        if name.lower() == b"content-type":
            return value.decode("latin1")
    return None


@dataclass(frozen=True, slots=True)
class _RequestStart:
    """The parts of the scope as the server sent them, before any router changed it."""

    path: str
    root_path: str
    method: str
    headers: object


class _Route(Protocol):
    def matches(self, scope: ASGIScope) -> tuple[object, Mapping[str, object]]: ...


def _routes_of(router: object) -> Sequence[object]:
    routes: object = getattr(router, "routes", None)
    if isinstance(routes, list | tuple):
        return cast(Sequence[object], routes)
    return ()


def _mount_child_scope(route: object, scratch: ASGIScope, final_root: str) -> ASGIScope | None:
    """Return the child scope route gives scratch when it is a mount on the way to final_root."""
    if not callable(getattr(route, "matches", None)) or not isinstance(
        getattr(route, "path", None), str
    ):
        return None
    try:
        match, child = cast(_Route, route).matches(scratch)
    except Exception:
        return None
    if getattr(match, "name", None) != "FULL":
        return None
    child_root = child.get("root_path")
    current_root = scratch.get("root_path", "")
    if not isinstance(child_root, str) or not isinstance(current_root, str):
        return None
    if len(child_root) <= len(current_root) or not final_root.startswith(child_root):
        return None
    if len(final_root) > len(child_root) and final_root[len(child_root)] != "/":
        return None
    return {**scratch, **child}


def _mount_templates(
    router: object, start: _RequestStart, final_root: str
) -> tuple[str, object] | None:
    """Find the mounts a Starlette-style router took to reach final_root.

    Returns their joined path templates, such as "/org/{org}", and the last
    mount, or None when the router's mounts do not account for final_root.
    """
    scratch: ASGIScope = {
        "type": "http",
        "path": start.path,
        "root_path": start.root_path,
        "method": start.method,
        "headers": start.headers,
    }
    routes = _routes_of(router)
    template = ""
    last: object = None
    for _ in range(_MAX_MOUNT_DEPTH):
        if scratch.get("root_path") == final_root:
            return template, last
        for route in routes:
            child = _mount_child_scope(route, scratch, final_root)
            if child is not None:
                template += cast(str, getattr(route, "path", ""))
                last = route
                scratch = child
                routes = _routes_of(route)
                break
        else:
            return None
    return None


def _leaf_template(scope: ASGIScope, route_obj: object) -> str | None:
    """Return the matched route's template, relative to the innermost application."""
    # FastAPI keeps the include_router prefix out of the route's own path and
    # records the full template on the route context it selected.
    fastapi_state: object = scope.get("fastapi")
    if isinstance(fastapi_state, Mapping):
        selected: object = cast(Mapping[str, object], fastapi_state).get("effective_route_context")
        if selected is not None and getattr(selected, "original_route", None) is route_obj:
            full: object = getattr(selected, "path", None)
            if isinstance(full, str) and full.startswith("/"):
                return full
    path: object = getattr(route_obj, "path", None)
    return path if isinstance(path, str) and path else None


def _starlette_route(scope: ASGIScope, route_obj: object, start: _RequestStart) -> str | None:
    prefix = start.root_path.rstrip("/")
    final_root: object = scope.get("root_path", "")
    if not isinstance(final_root, str):
        return None
    if final_root == start.root_path:
        leaf = _leaf_template(scope, route_obj)
        return prefix + leaf if leaf else None
    mounts = _mount_templates(scope.get("router"), start, final_root)
    if mounts is None:
        # The concrete root_path holds mount parameters; never report it.
        return None
    template, last_mount = mounts
    if route_obj is last_mount:
        # A mounted application with no routes of its own.
        return f"{prefix}{template}/{{path}}"
    leaf = _leaf_template(scope, route_obj)
    return prefix + template + leaf if leaf else None


def _resolve_route(scope: ASGIScope, start: _RequestStart, django: bool) -> str | None:
    explicit: object = scope.get("http.route")
    if isinstance(explicit, str) and explicit:
        return explicit
    route_obj: object = scope.get("route")
    if route_obj is not None:
        return _starlette_route(scope, route_obj, start)
    resolver_match: object = scope.get("resolver_match")
    matched: object = getattr(resolver_match, "route", None)
    if isinstance(matched, str) and matched:
        return matched if matched.startswith("/") else "/" + matched
    if django:
        return django_route(start.path)
    return None


def _request_attributes(
    scope: ASGIScope, path: str, headers: Mapping[str, str]
) -> dict[str, AttributeValue]:
    attrs: dict[str, AttributeValue] = {"url.path": path}
    query: object = scope.get("query_string")
    if isinstance(query, bytes | bytearray) and query:
        attrs["url.query"] = bytes(query).decode("latin1")
    server: object = scope.get("server")
    if isinstance(server, list | tuple):
        server_seq = cast(Sequence[object], server)
        if server_seq and isinstance(server_seq[0], str) and server_seq[0]:
            attrs["server.address"] = server_seq[0]
            if len(server_seq) >= 2 and isinstance(server_seq[1], int):
                attrs["server.port"] = server_seq[1]
    client: object = scope.get("client")
    if isinstance(client, list | tuple):
        client_seq = cast(Sequence[object], client)
        if client_seq and isinstance(client_seq[0], str) and client_seq[0]:
            attrs["client.address"] = client_seq[0]
    user_agent = headers.get("user-agent")
    if user_agent:
        attrs["user_agent.original"] = user_agent
    return attrs


class ASGIMiddleware:
    """ASGI 3 middleware recording server spans, metrics, and optional canonical lines.

    Routes come from, in order: ``set_route``, a ``"http.route"`` scope key, the
    route Starlette or FastAPI matched (with the templates of any mounts), and
    Django's URL resolver when the wrapped application is Django's ASGI handler.
    ``canonical_line`` requires ``telemetry``.
    """

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
        if canonical_line and telemetry is None:
            raise ValueError("o11yasgi: canonical_line requires telemetry")
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

    async def __call__(self, scope: ASGIScope, receive: ASGIReceive, send: ASGISend) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return
        raw_path: object = scope.get("path")
        path = raw_path if isinstance(raw_path, str) else ""
        if is_path_ignored(path, self._ignore_patterns) or (
            self._filter is not None and not self._filter(scope)
        ):
            await self._app(scope, receive, send)
            return

        headers = _decode_headers(scope)
        method: object = scope.get("method")
        scheme: object = scope.get("scheme")
        version: object = scope.get("http_version")
        root_path: object = scope.get("root_path")
        start = _RequestStart(
            path=path,
            root_path=root_path if isinstance(root_path, str) else "",
            method=method if isinstance(method, str) else "",
            headers=scope.get("headers"),
        )
        exchange = ServerExchange(
            self._instruments.resolve(),
            telemetry=self._telemetry,
            canonical_line=self._canonical_line,
            public_endpoint=self._public_endpoint,
            method_raw=start.method,
            scheme=scheme if isinstance(scheme, str) and scheme else "http",
            protocol_version=version if isinstance(version, str) and version else None,
            headers=headers,
            attributes=_request_attributes(scope, path, headers),
        )

        async def send_with_status(message: ASGIMessage) -> None:
            if message.get("type") == "http.response.start":
                status: object = message.get("status")
                if isinstance(status, int):
                    exchange.status_code = status
                if self._server_timing:
                    message = self._with_server_timing(message, exchange)
            await send(message)

        token = context.attach(exchange.context)
        slot_token = bind_route_slot(exchange.route_slot)
        try:
            with start_record() as record:
                exchange.record = record
                try:
                    await self._app(scope, receive, send_with_status)
                except Exception as exc:
                    exchange.fail(exc)
                    raise
                finally:
                    route = exchange.chosen_route(
                        lambda: _resolve_route(scope, start, self._django)
                    )
                    name = None
                    if self._span_name_formatter is not None:
                        name = self._span_name_formatter(scope, route)
                    exchange.finish(route, name)
        finally:
            reset_route_slot(slot_token)
            context.detach(token)

    @staticmethod
    def _with_server_timing(message: ASGIMessage, exchange: ServerExchange) -> ASGIMessage:
        raw: object = message.get("headers") or ()
        entry = exchange.server_timing(_response_content_type(raw))
        if entry is None or not isinstance(raw, Iterable):
            return message
        headers = [*cast(Iterable[object], raw), (b"server-timing", entry.encode("latin1"))]
        return {**message, "headers": headers}


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
    "ASGIMessage",
    "ASGIMiddleware",
    "ASGIReceive",
    "ASGIScope",
    "ASGISend",
    "ASGISpanNameFormatter",
    "instrument_asgi",
    "set_route",
]
