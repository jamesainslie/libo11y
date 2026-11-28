"""Contract tests for the libo11y.asgi and libo11y.wsgi server middleware.

The reference is go/o11yhttp: route-template span names, one exception event
per failure, Server-Timing on HTML responses only, Go path.Match ignore globs,
and a request span that is current only while the application runs.
"""

from __future__ import annotations

import importlib
import threading
import time
from collections.abc import Callable, Generator, Iterable, Iterator, Mapping
from types import ModuleType
from typing import Any
from wsgiref.types import StartResponse, WSGIApplication, WSGIEnvironment

import fastapi
import httpx
import pytest
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON
from opentelemetry.trace import SpanKind, StatusCode
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, PlainTextResponse
from starlette.routing import Mount, Route

import libo11y
from libo11y import asgi as o11y_asgi
from libo11y import wsgi as o11y_wsgi
from libo11y._internal.http_common import compile_ignore_patterns, is_path_ignored
from libo11y.spec import EVENT_NAME_KEY, EVENT_REQUEST_SUMMARY
from libo11y.testing import Recorder, start_recorder

TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


# ---------------------------------------------------------------- helpers


def _exception_events(span: ReadableSpan) -> list[str]:
    return [e.name for e in span.events if e.name == "exception"]


def _assert_no_current_span() -> None:
    assert not trace.get_current_span().get_span_context().is_valid


def _server_spans(rec: Recorder) -> list[ReadableSpan]:
    return [s for s in rec.spans() if s.kind == SpanKind.SERVER]


def _attrs(span: ReadableSpan) -> Mapping[str, Any]:
    return span.attributes or {}


def _route_series(rec: Recorder) -> list[Any]:
    return [
        pt["attributes"].get("http.route")
        for pt in rec.metric_points("http.server.request.duration")
    ]


def _summaries(rec: Recorder) -> list[Mapping[str, Any]]:
    return [
        attrs
        for lr in rec.otel_logs()
        if (attrs := lr.log_record.attributes or {}).get(EVENT_NAME_KEY) == EVENT_REQUEST_SUMMARY
    ]


def _environ(path: str = "/", method: str = "GET", **extra: Any) -> WSGIEnvironment:
    environ: WSGIEnvironment = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": "",
        "SERVER_NAME": "localhost",
        "SERVER_PORT": "8000",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "wsgi.url_scheme": "http",
        "wsgi.version": (1, 0),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    environ.update(extra)
    return environ


class _StartResponse:
    """A start_response that records what the application sent."""

    def __init__(self) -> None:
        self.status = ""
        self.headers: list[tuple[str, str]] = []

    def __call__(
        self,
        status: str,
        headers: list[tuple[str, str]],
        exc_info: Any = None,
        /,
    ) -> Callable[[bytes], object]:
        del exc_info
        self.status = status
        self.headers = headers
        return lambda _data: None

    def header(self, name: str) -> str | None:
        return next((v for k, v in self.headers if k.lower() == name.lower()), None)


class _TrackedBody:
    """A WSGI response iterable that records how the server drove it."""

    def __init__(
        self,
        chunks: Iterable[bytes],
        *,
        fail_at: int | None = None,
        close_error: Exception | None = None,
    ) -> None:
        self._chunks = list(chunks)
        self._fail_at = fail_at
        self._close_error = close_error
        self._index = 0
        self.closed = 0
        self.span_ids_seen: list[int] = []
        self.last_next_ns = 0

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        self.span_ids_seen.append(trace.get_current_span().get_span_context().span_id)
        self.last_next_ns = time.time_ns()
        if self._fail_at is not None and self._index == self._fail_at:
            raise RuntimeError("body failed")
        if self._index >= len(self._chunks):
            raise StopIteration
        chunk = self._chunks[self._index]
        self._index += 1
        return chunk

    def close(self) -> None:
        self.closed += 1
        if self._close_error is not None:
            raise self._close_error


def _wsgi_app(
    body: Iterable[bytes],
    *,
    status: str = "200 OK",
    content_type: str | None = "text/plain",
) -> WSGIApplication:
    def app(environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        del environ
        headers = [] if content_type is None else [("Content-Type", content_type)]
        start_response(status, headers)
        return body

    return app


def _asgi_app(
    *,
    status: int = 200,
    content_type: bytes | None = b"text/plain",
    on_call: Callable[[], None] | None = None,
) -> o11y_asgi.ASGIApp:
    async def app(
        scope: o11y_asgi.ASGIScope, receive: o11y_asgi.ASGIReceive, send: o11y_asgi.ASGISend
    ) -> None:
        del scope, receive
        if on_call is not None:
            on_call()
        headers: list[tuple[bytes, bytes]] = []
        if content_type is not None:
            headers.append((b"content-type", content_type))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": b"ok"})

    return app


async def _asgi_get(
    app: o11y_asgi.ASGIApp,
    *paths: str,
    method: str = "GET",
    headers: Mapping[str, str] | None = None,
) -> list[httpx.Response]:
    transport = httpx.ASGITransport(app=app)
    out: list[httpx.Response] = []
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        for path in paths:
            out.append(await client.request(method, path, headers=headers))
    return out


def _configure_django() -> tuple[ModuleType, ModuleType]:
    """Configure Django once per process and return (django.urls, django.http)."""
    dj_conf = importlib.import_module("django.conf")
    if not dj_conf.settings.configured:
        dj_conf.settings.configure(
            DEBUG=True,
            SECRET_KEY="test-secret-key",
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
        )
        importlib.import_module("django").setup()
    return importlib.import_module("django.urls"), importlib.import_module("django.http")


# ---------------------------------------------------------------- 1. WSGI lifecycle


def test_wsgi_call_does_not_leave_the_request_span_current() -> None:
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"a"]), telemetry=rec.telemetry)
        body = mw(_environ(), _StartResponse())
        _assert_no_current_span()
        list(body)
        _assert_no_current_span()


def test_wsgi_close_before_iteration_ends_one_span() -> None:
    tracked = _TrackedBody([b"a", b"b"])
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = mw(_environ(), _StartResponse())
        getattr(body, "close")()  # noqa: B009 - PEP 3333 close is optional on the type
        _assert_no_current_span()
        spans = rec.spans()
        assert len(spans) == 1
        assert tracked.closed == 1
        assert tracked.span_ids_seen == []


def test_wsgi_exhaustion_ends_one_span_and_closes_the_body_once() -> None:
    tracked = _TrackedBody([b"a", b"b"])
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = mw(_environ(), _StartResponse())
        assert b"".join(body) == b"ab"
        getattr(body, "close")()  # noqa: B009
        getattr(body, "close")()  # noqa: B009
        assert len(rec.spans()) == 1
        assert tracked.closed == 1
        _assert_no_current_span()


def test_wsgi_early_close_after_first_chunk_ends_one_span() -> None:
    tracked = _TrackedBody([b"a", b"b", b"c"])
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = iter(mw(_environ(), _StartResponse()))
        assert next(body) == b"a"
        _assert_no_current_span()
        getattr(body, "close")()  # noqa: B009
        spans = rec.spans()
        assert len(spans) == 1
        assert spans[0].status.status_code != StatusCode.ERROR
        assert tracked.closed == 1
        _assert_no_current_span()


def test_wsgi_iteration_error_ends_one_failed_span() -> None:
    tracked = _TrackedBody([b"a", b"b"], fail_at=1)
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = mw(_environ(), _StartResponse())
        with pytest.raises(RuntimeError, match="body failed"):
            list(body)
        getattr(body, "close")()  # noqa: B009
        spans = rec.spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.status.status_code == StatusCode.ERROR
        assert span.status.description is None
        assert _attrs(span)["error.type"] == "RuntimeError"
        assert _exception_events(span) == ["exception"]
        assert tracked.closed == 1
        _assert_no_current_span()


def test_wsgi_close_error_ends_one_failed_span() -> None:
    tracked = _TrackedBody([b"a"], close_error=OSError("close failed"))
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = iter(mw(_environ(), _StartResponse()))
        assert next(body) == b"a"
        with pytest.raises(OSError, match="close failed"):
            getattr(body, "close")()  # noqa: B009
        spans = rec.spans()
        assert len(spans) == 1
        assert spans[0].status.status_code == StatusCode.ERROR
        assert _attrs(spans[0])["error.type"] == "OSError"
        assert _exception_events(spans[0]) == ["exception"]
        _assert_no_current_span()


def test_wsgi_body_iteration_runs_inside_the_request_span() -> None:
    tracked = _TrackedBody([b"a", b"b"])
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        list(mw(_environ(), _StartResponse()))
        span = rec.spans()[0]
        sc = span.get_span_context()
        assert sc is not None
        assert tracked.span_ids_seen == [sc.span_id] * 3
        assert span.end_time is not None
        assert span.end_time >= tracked.last_next_ns


def test_wsgi_body_iterated_on_another_thread_ends_one_span() -> None:
    tracked = _TrackedBody([b"a", b"b"])
    errors: list[BaseException] = []
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app(tracked), telemetry=rec.telemetry)
        body = mw(_environ(), _StartResponse())

        def drive() -> None:
            try:
                list(body)
                getattr(body, "close")()  # noqa: B009
                _assert_no_current_span()
            except BaseException as exc:
                errors.append(exc)

        worker = threading.Thread(target=drive)
        worker.start()
        worker.join(timeout=10)
        assert errors == []
        assert len(rec.spans()) == 1
        _assert_no_current_span()


def test_wsgi_record_is_shared_by_the_app_call_and_the_body() -> None:
    def body() -> Iterator[bytes]:
        libo11y.current_record().set("body.key", "from-body")
        yield b"x"

    def app(environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        del environ
        libo11y.current_record().set("call.key", "from-call")
        start_response("200 OK", [("Content-Type", "text/plain")])
        return body()

    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(app, telemetry=rec.telemetry, canonical_line=True)
        list(mw(_environ(), _StartResponse()))
        [summary] = _summaries(rec)
        assert summary["call.key"] == "from-call"
        assert summary["body.key"] == "from-body"


# ---------------------------------------------------------------- 2. ASGI route templates


async def _ok(_request: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


def _assert_one_route(rec: Recorder, span_name: str, route: str) -> None:
    spans = _server_spans(rec)
    assert {s.name for s in spans} == {span_name}
    assert {_attrs(s)["http.route"] for s in spans} == {route}
    assert _route_series(rec) == [route]


async def test_asgi_starlette_mount_parameters_yield_one_route() -> None:
    app = Starlette(routes=[Mount("/org/{org}", routes=[Route("/ok", _ok)])])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        responses = await _asgi_get(mw, "/org/one/ok", "/org/two/ok")
        assert [r.status_code for r in responses] == [200, 200]
        _assert_one_route(rec, "GET /org/{org}/ok", "/org/{org}/ok")


async def test_asgi_starlette_nested_mounts_yield_one_route() -> None:
    inner = Mount("/team/{team}", routes=[Route("/ok", _ok)])
    app = Starlette(routes=[Route("/other", _ok), Mount("/org/{org}", routes=[inner])])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        await _asgi_get(mw, "/org/a/team/x/ok", "/org/b/team/y/ok")
        _assert_one_route(rec, "GET /org/{org}/team/{team}/ok", "/org/{org}/team/{team}/ok")


async def test_asgi_starlette_mounted_app_uses_the_mount_template() -> None:
    app = Starlette(routes=[Mount("/files/{bucket}", app=PlainTextResponse("file"))])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        await _asgi_get(mw, "/files/one/a.txt", "/files/two/b/c.txt")
        _assert_one_route(rec, "GET /files/{bucket}/{path}", "/files/{bucket}/{path}")


async def test_asgi_fastapi_included_router_prefix_is_part_of_the_route() -> None:
    api = fastapi.FastAPI()
    router = fastapi.APIRouter()

    @router.get("/items/{item_id}")
    async def item(item_id: int) -> dict[str, int]:
        return {"item_id": item_id}

    api.include_router(router, prefix="/v1/{tenant}")
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(api, telemetry=rec.telemetry)
        responses = await _asgi_get(mw, "/v1/acme/items/1", "/v1/globex/items/2")
        assert [r.status_code for r in responses] == [200, 200]
        _assert_one_route(rec, "GET /v1/{tenant}/items/{item_id}", "/v1/{tenant}/items/{item_id}")


async def test_asgi_fastapi_mounted_sub_application_uses_the_mount_template() -> None:
    api = fastapi.FastAPI()
    sub = fastapi.FastAPI()

    @sub.get("/things/{thing_id}")
    async def thing(thing_id: int) -> dict[str, int]:
        return {"thing_id": thing_id}

    api.mount("/region/{region}", sub)
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(api, telemetry=rec.telemetry)
        responses = await _asgi_get(mw, "/region/eu/things/1", "/region/us/things/2")
        assert [r.status_code for r in responses] == [200, 200]
        _assert_one_route(
            rec, "GET /region/{region}/things/{thing_id}", "/region/{region}/things/{thing_id}"
        )


async def test_asgi_django_nested_include_uses_the_route_template() -> None:
    dj_urls, dj_http = _configure_django()
    dj_asgi = importlib.import_module("django.core.asgi")
    overrides = importlib.import_module("django.test.utils")

    def view(_request: Any, org: str) -> Any:
        return dj_http.HttpResponse(f"org:{org}".encode())

    globals()["urlpatterns"] = [
        dj_urls.path("org/<slug:org>/", dj_urls.include([dj_urls.path("ok/", view)])),
    ]
    with overrides.override_settings(ROOT_URLCONF=__name__), start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(dj_asgi.get_asgi_application(), telemetry=rec.telemetry)
        responses = await _asgi_get(mw, "/org/one/ok/", "/org/two/ok/")
        assert [r.status_code for r in responses] == [200, 200]
        _assert_one_route(rec, "GET /org/<slug:org>/ok/", "/org/<slug:org>/ok/")


# ---------------------------------------------------------------- 3. Server-Timing on HTML only

SERVER_TIMING_CASES = [
    ("text/html", True),
    ("text/html; charset=utf-8", True),
    ("TEXT/HTML", True),
    (" text/html ; q=1", True),
    ("text/plain", False),
    ("application/json", False),
    ("text/html-fragment", False),
    (None, False),
]


@pytest.mark.parametrize(("content_type", "expected"), SERVER_TIMING_CASES)
async def test_asgi_server_timing_only_on_html(content_type: str | None, expected: bool) -> None:
    ctype = None if content_type is None else content_type.encode("latin1")
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(
            _asgi_app(content_type=ctype), telemetry=rec.telemetry, server_timing=True
        )
        [resp] = await _asgi_get(mw, "/page")
        assert ("server-timing" in resp.headers) is expected


@pytest.mark.parametrize(("content_type", "expected"), SERVER_TIMING_CASES)
def test_wsgi_server_timing_only_on_html(content_type: str | None, expected: bool) -> None:
    sr = _StartResponse()
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(
            _wsgi_app([b"x"], content_type=content_type),
            telemetry=rec.telemetry,
            server_timing=True,
        )
        list(mw(_environ(), sr))
        assert (sr.header("Server-Timing") is not None) is expected


async def test_asgi_server_timing_names_the_server_span() -> None:
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(
            _asgi_app(content_type=b"text/html"), telemetry=rec.telemetry, server_timing=True
        )
        [resp] = await _asgi_get(mw, "/page")
        sc = _server_spans(rec)[0].get_span_context()
        assert sc is not None
        assert resp.headers["server-timing"] == (
            f'traceparent;desc="00-{sc.trace_id:032x}-{sc.span_id:016x}-{int(sc.trace_flags):02x}"'
        )


# ---------------------------------------------------------------- 4. one exception event


async def test_asgi_exception_is_recorded_once_without_a_status_description() -> None:
    async def boom(_request: Request) -> PlainTextResponse:
        raise ValueError("card 4111-1111-1111-1111 rejected")

    app = Starlette(routes=[Route("/pay", boom)])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        with pytest.raises(ValueError, match="rejected"):
            await _asgi_get(mw, "/pay")
        [span] = _server_spans(rec)
        assert _exception_events(span) == ["exception"]
        assert span.status.status_code == StatusCode.ERROR
        assert span.status.description is None
        assert _attrs(span)["error.type"] == "ValueError"
        assert _attrs(span)["http.response.status_code"] == 500


def test_wsgi_app_exception_is_recorded_once_without_a_status_description() -> None:
    def app(environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        del environ, start_response
        raise ValueError("card 4111-1111-1111-1111 rejected")

    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(app, telemetry=rec.telemetry)
        with pytest.raises(ValueError, match="rejected"):
            mw(_environ(), _StartResponse())
        [span] = rec.spans()
        assert _exception_events(span) == ["exception"]
        assert span.status.status_code == StatusCode.ERROR
        assert span.status.description is None
        assert _attrs(span)["error.type"] == "ValueError"
        _assert_no_current_span()


# ---------------------------------------------------------------- 5. Go path.Match ignore globs

PATH_MATCH_CASES = [
    # From Go's path/match_test.go.
    ("abc", "abc", True),
    ("*", "abc", True),
    ("*c", "abc", True),
    ("a*", "a", True),
    ("a*", "abc", True),
    ("a*", "ab/c", False),
    ("a*/b", "abc/b", True),
    ("a*/b", "a/c/b", False),
    ("a*b*c*d*e*/f", "axbxcxdxe/f", True),
    ("a*b*c*d*e*/f", "axbxcxdxexxx/f", True),
    ("a*b*c*d*e*/f", "axbxcxdxe/xxx/f", False),
    ("a*b*c*d*e*/f", "axbxcxdxexxx/fff", False),
    ("a*b?c*x", "abxbbxdbxebxczzx", True),
    ("a*b?c*x", "abxbbxdbxebxczzy", False),
    ("ab[c]", "abc", True),
    ("ab[b-d]", "abc", True),
    ("ab[e-g]", "abc", False),
    ("ab[^c]", "abc", False),
    ("ab[^b-d]", "abc", False),
    ("ab[^e-g]", "abc", True),
    ("a\\*b", "a*b", True),
    ("a\\*b", "ab", False),
    ("a?b", "a☺b", True),
    ("a[^a]b", "a☺b", True),
    ("a???b", "a☺b", False),
    ("a[^a][^a][^a]b", "a☺b", False),
    ("[a-ζ]*", "\u03b1", True),
    ("*[a-ζ]", "A", False),
    ("a?b", "a/b", False),
    ("a*b", "a/b", False),
    ("[\\]a]", "]", True),
    ("[\\-]", "-", True),
    ("[x\\-]", "x", True),
    ("[x\\-]", "-", True),
    ("[x\\-]", "z", False),
    ("[\\-x]", "x", True),
    ("[\\-x]", "-", True),
    ("[\\-x]", "a", False),
    ("*x", "xxx", True),
    # A character class may match '/', as in Go.
    ("a[^x]b", "a/b", True),
    # Malformed patterns never match.
    ("[]a]", "]", False),
    ("[-]", "-", False),
    ("[x-]", "x", False),
    ("[x-]", "-", False),
    ("[-x]", "x", False),
    ("\\", "\\", False),
    ("[a-b-c]", "a", False),
    ("[", "[", False),
    ("[^", "a", False),
    ("[^bc", "a", False),
    ("a[", "a", False),
    ("a/b[", "a/b", False),
    ("/health*[", "/health", False),
    # Full matches against the decoded path only.
    ("/health", "/health", True),
    ("/health", "/health\n", False),
    ("/health", "/healthz", False),
    ("/health", "/health/", False),
    ("/debug/*", "/debug/", True),
    ("/debug/*", "/debug/pprof", True),
    ("/debug/*", "/debug/a/b", False),
    ("", "", True),
    ("", "/", False),
]


@pytest.mark.parametrize(("pattern", "path", "expected"), PATH_MATCH_CASES)
def test_ignore_pattern_matches_like_go_path_match(pattern: str, path: str, expected: bool) -> None:
    assert is_path_ignored(path, compile_ignore_patterns([pattern])) is expected


async def test_asgi_ignore_paths_do_not_match_a_trailing_newline() -> None:
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(
            _asgi_app(), telemetry=rec.telemetry, ignore_paths=["/health"]
        )
        await _asgi_get(mw, "/health", "/health%0A")
        assert [_attrs(s)["url.path"] for s in _server_spans(rec)] == ["/health\n"]


# ---------------------------------------------------------------- 6. instruments built once


class _CallCounter:
    def __init__(self, target: object, name: str, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls = 0
        real: Callable[..., Any] = getattr(target, name)

        def counting(*args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(target, name, counting)


async def test_asgi_with_telemetry_builds_instruments_once(monkeypatch: pytest.MonkeyPatch) -> None:
    with start_recorder() as rec:
        tracers = _CallCounter(rec.telemetry.tracer_provider, "get_tracer", monkeypatch)
        meters = _CallCounter(rec.telemetry.meter_provider, "get_meter", monkeypatch)
        mw = o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry)
        await _asgi_get(mw, "/a", "/b", "/c")
        assert len(_server_spans(rec)) == 3
        assert (tracers.calls, meters.calls) == (1, 1)


def test_wsgi_with_telemetry_builds_instruments_once(monkeypatch: pytest.MonkeyPatch) -> None:
    with start_recorder() as rec:
        tracers = _CallCounter(rec.telemetry.tracer_provider, "get_tracer", monkeypatch)
        meters = _CallCounter(rec.telemetry.meter_provider, "get_meter", monkeypatch)
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"]), telemetry=rec.telemetry)
        for _ in range(3):
            list(mw(_environ(), _StartResponse()))
        assert len(rec.spans()) == 3
        assert (tracers.calls, meters.calls) == (1, 1)


@pytest.fixture
def global_setup() -> Generator[Callable[[], tuple[InMemorySpanExporter, InMemoryMetricReader]]]:
    """Install libo11y globals on demand; each call replaces the previous ones."""
    installed: list[libo11y.Telemetry] = []

    def install() -> tuple[InMemorySpanExporter, InMemoryMetricReader]:
        for tel in installed:
            tel.shutdown()
        exporter = InMemorySpanExporter()
        reader = InMemoryMetricReader()
        installed.append(
            libo11y.setup(
                env=libo11y.HERMETIC,
                service_name="global-http",
                environment="test",
                console_enabled=False,
                runtime_metrics=False,
                sampler=ALWAYS_ON,
                span_processor=SimpleSpanProcessor(exporter),
                metric_reader=reader,
            )
        )
        return exporter, reader

    yield install
    for tel in installed:
        tel.shutdown()


def test_wsgi_without_telemetry_follows_the_global_providers(
    global_setup: Callable[[], tuple[InMemorySpanExporter, InMemoryMetricReader]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"]))
    first, _ = global_setup()
    list(mw(_environ(), _StartResponse()))
    second, _ = global_setup()
    meters = _CallCounter(metrics.get_meter_provider(), "get_meter", monkeypatch)
    for _ in range(3):
        list(mw(_environ(), _StartResponse()))
    assert len(first.get_finished_spans()) == 1
    assert len(second.get_finished_spans()) == 3
    assert meters.calls == 1


async def test_asgi_without_telemetry_follows_the_global_providers(
    global_setup: Callable[[], tuple[InMemorySpanExporter, InMemoryMetricReader]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mw = o11y_asgi.ASGIMiddleware(_asgi_app())
    first, _ = global_setup()
    await _asgi_get(mw, "/a")
    second, _ = global_setup()
    meters = _CallCounter(metrics.get_meter_provider(), "get_meter", monkeypatch)
    await _asgi_get(mw, "/a", "/b", "/c")
    assert len(first.get_finished_spans()) == 1
    assert len(second.get_finished_spans()) == 3
    assert meters.calls == 1


# ---------------------------------------------------------------- 7. canonical_line needs telemetry


@pytest.mark.parametrize(
    "build",
    [
        lambda: o11y_asgi.ASGIMiddleware(_asgi_app(), canonical_line=True),
        lambda: o11y_asgi.instrument_asgi(_asgi_app(), canonical_line=True),
    ],
    ids=["ASGIMiddleware", "instrument_asgi"],
)
def test_asgi_canonical_line_without_telemetry_fails(build: Callable[[], object]) -> None:
    with pytest.raises(ValueError, match=r"^o11yasgi: canonical_line requires telemetry$"):
        build()


@pytest.mark.parametrize(
    "build",
    [
        lambda: o11y_wsgi.WSGIMiddleware(_wsgi_app([]), canonical_line=True),
        lambda: o11y_wsgi.instrument_wsgi(_wsgi_app([]), canonical_line=True),
    ],
    ids=["WSGIMiddleware", "instrument_wsgi"],
)
def test_wsgi_canonical_line_without_telemetry_fails(build: Callable[[], object]) -> None:
    with pytest.raises(ValueError, match=r"^o11ywsgi: canonical_line requires telemetry$"):
        build()


# ---------------------------------------------------------------- 8. Django only for Django apps


def _django_plain_urlconf() -> Any:
    dj_urls, dj_http = _configure_django()

    def view(_request: Any, n: int) -> Any:
        return dj_http.HttpResponse(b"django")

    globals()["urlpatterns"] = [dj_urls.path("plain/<int:n>/", view)]
    overrides = importlib.import_module("django.test.utils")
    return overrides.override_settings(ROOT_URLCONF=__name__)


async def test_asgi_does_not_resolve_routes_through_django_for_other_apps() -> None:
    with _django_plain_urlconf(), start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry)
        await _asgi_get(mw, "/plain/5/")
        [span] = _server_spans(rec)
        assert span.name == "GET"
        assert "http.route" not in _attrs(span)


def test_wsgi_does_not_resolve_routes_through_django_for_other_apps() -> None:
    with _django_plain_urlconf(), start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"]), telemetry=rec.telemetry)
        list(mw(_environ("/plain/5/"), _StartResponse()))
        [span] = rec.spans()
        assert span.name == "GET"
        assert "http.route" not in _attrs(span)


# ---------------------------------------------------------------- 9. set_route


async def test_asgi_set_route_names_the_span_and_labels_the_metric() -> None:
    app = _asgi_app(on_call=lambda: o11y_asgi.set_route("/custom/{id}"))
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry, canonical_line=True)
        await _asgi_get(mw, "/custom/1", "/custom/2")
        _assert_one_route(rec, "GET /custom/{id}", "/custom/{id}")
        assert {s["http.route"] for s in _summaries(rec)} == {"/custom/{id}"}


async def test_asgi_set_route_overrides_the_framework_route() -> None:
    async def handler(_request: Request) -> PlainTextResponse:
        o11y_asgi.set_route("/chosen")
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/framework/{x}", handler)])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        await _asgi_get(mw, "/framework/1")
        _assert_one_route(rec, "GET /chosen", "/chosen")


async def test_asgi_set_route_with_a_method_names_the_span_verbatim() -> None:
    app = _asgi_app(on_call=lambda: o11y_asgi.set_route("POST /rpc/{name}"))
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry)
        await _asgi_get(mw, "/rpc/x")
        _assert_one_route(rec, "POST /rpc/{name}", "/rpc/{name}")


def test_wsgi_set_route_names_the_span_and_labels_the_metric() -> None:
    def app(environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        del environ
        o11y_wsgi.set_route("/custom/{id}")
        start_response("200 OK", [])
        return [b"x"]

    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(app, telemetry=rec.telemetry)
        list(mw(_environ("/custom/1"), _StartResponse()))
        list(mw(_environ("/custom/2"), _StartResponse()))
        _assert_one_route(rec, "GET /custom/{id}", "/custom/{id}")


def test_wsgi_set_route_during_body_iteration_counts() -> None:
    def body() -> Iterator[bytes]:
        o11y_wsgi.set_route("/streamed/{id}")
        yield b"x"

    def app(environ: WSGIEnvironment, start_response: StartResponse) -> Iterable[bytes]:
        del environ
        start_response("200 OK", [])
        return body()

    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(app, telemetry=rec.telemetry)
        list(mw(_environ("/streamed/1"), _StartResponse()))
        _assert_one_route(rec, "GET /streamed/{id}", "/streamed/{id}")


@pytest.mark.parametrize("module", [o11y_asgi, o11y_wsgi], ids=["asgi", "wsgi"])
def test_set_route_outside_a_request_does_nothing(module: ModuleType) -> None:
    module.set_route("/nowhere")
    _assert_no_current_span()


# ---------------------------------------------------------------- 11 and 12. semantic conventions


async def test_asgi_server_span_records_the_protocol_version() -> None:
    with start_recorder() as rec:
        await _asgi_get(o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry), "/")
        assert _attrs(_server_spans(rec)[0])["network.protocol.version"] == "1.1"


def test_wsgi_server_span_records_the_protocol_version() -> None:
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"]), telemetry=rec.telemetry)
        list(mw(_environ(SERVER_PROTOCOL="HTTP/1.0"), _StartResponse()))
        assert _attrs(rec.spans()[0])["network.protocol.version"] == "1.0"


async def test_asgi_public_endpoint_links_instead_of_adopting_the_parent() -> None:
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry, public_endpoint=True)
        await _asgi_get(mw, "/", headers={"traceparent": TRACEPARENT})
        [span] = _server_spans(rec)
        assert span.parent is None
        sc = span.get_span_context()
        assert sc is not None
        assert f"{sc.trace_id:032x}" != TRACEPARENT.split("-")[1]
        assert [f"{link.context.span_id:016x}" for link in span.links] == ["b7ad6b7169203331"]


async def test_asgi_private_endpoint_adopts_the_inbound_parent() -> None:
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry)
        await _asgi_get(mw, "/", headers={"traceparent": TRACEPARENT})
        [span] = _server_spans(rec)
        assert span.parent is not None
        assert f"{span.parent.span_id:016x}" == "b7ad6b7169203331"
        assert list(span.links) == []


def test_wsgi_public_endpoint_links_instead_of_adopting_the_parent() -> None:
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(
            _wsgi_app([b"x"]), telemetry=rec.telemetry, public_endpoint=True
        )
        list(mw(_environ(HTTP_TRACEPARENT=TRACEPARENT), _StartResponse()))
        [span] = rec.spans()
        assert span.parent is None
        assert [f"{link.context.span_id:016x}" for link in span.links] == ["b7ad6b7169203331"]


async def test_asgi_unknown_method_is_recorded_as_other() -> None:
    with start_recorder() as rec:
        await _asgi_get(
            o11y_asgi.ASGIMiddleware(_asgi_app(), telemetry=rec.telemetry), "/", method="PURGE"
        )
        [span] = _server_spans(rec)
        assert span.name == "HTTP"
        assert _attrs(span)["http.request.method"] == "_OTHER"
        assert _attrs(span)["http.request.method_original"] == "PURGE"


def test_wsgi_unknown_method_is_recorded_as_other() -> None:
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"]), telemetry=rec.telemetry)
        list(mw(_environ(method="PURGE"), _StartResponse()))
        [span] = rec.spans()
        assert span.name == "HTTP"
        assert _attrs(span)["http.request.method"] == "_OTHER"
        assert _attrs(span)["http.request.method_original"] == "PURGE"


@pytest.mark.parametrize(
    ("status", "failed"), [(200, False), (404, False), (499, False), (500, True), (503, True)]
)
async def test_asgi_only_5xx_marks_the_server_span_failed(status: int, failed: bool) -> None:
    with start_recorder() as rec:
        await _asgi_get(
            o11y_asgi.ASGIMiddleware(_asgi_app(status=status), telemetry=rec.telemetry), "/"
        )
        [span] = _server_spans(rec)
        assert (span.status.status_code == StatusCode.ERROR) is failed
        assert span.status.description is None
        assert _attrs(span).get("error.type") == (str(status) if failed else None)


@pytest.mark.parametrize(
    ("status", "failed"), [("200 OK", False), ("404 Not Found", False), ("502 Bad Gateway", True)]
)
def test_wsgi_only_5xx_marks_the_server_span_failed(status: str, failed: bool) -> None:
    with start_recorder() as rec:
        mw = o11y_wsgi.WSGIMiddleware(_wsgi_app([b"x"], status=status), telemetry=rec.telemetry)
        list(mw(_environ(), _StartResponse()))
        [span] = rec.spans()
        assert (span.status.status_code == StatusCode.ERROR) is failed
        assert span.status.description is None


async def test_asgi_html_response_from_starlette_carries_server_timing() -> None:
    async def page(_request: Request) -> HTMLResponse:
        return HTMLResponse("<p>hi</p>")

    app = Starlette(routes=[Route("/page", page)])
    with start_recorder() as rec:
        mw = o11y_asgi.ASGIMiddleware(app, telemetry=rec.telemetry, server_timing=True)
        [resp] = await _asgi_get(mw, "/page")
        assert resp.headers["server-timing"].startswith('traceparent;desc="00-')
