"""Tests for P5 HTTP integrations: asgi, wsgi, httpx, and requests."""

from __future__ import annotations

import http.server
import importlib
import threading
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from typing import Any, ClassVar, cast
from wsgiref.simple_server import WSGIRequestHandler, make_server

import fastapi
import flask
import httpx
import pytest
import requests
from opentelemetry import baggage, context, trace
from opentelemetry.trace import SpanKind, StatusCode
from starlette.applications import Starlette
from starlette.requests import Request as StarletteRequest
from starlette.responses import PlainTextResponse
from starlette.routing import Route

import libo11y
from libo11y import asgi as o11y_asgi
from libo11y import httpx as o11y_httpx
from libo11y import requests as o11y_requests
from libo11y import wsgi as o11y_wsgi
from libo11y.spec import EVENT_NAME_KEY, EVENT_REQUEST_SUMMARY, Outcome
from libo11y.testing import start_recorder


class _QuietHandler(http.server.BaseHTTPRequestHandler):
    seen_headers: ClassVar[list[dict[str, str]]] = []

    def log_message(self, format: str, *args: Any) -> None:
        del format, args

    def do_GET(self) -> None:
        hdrs = {k.lower(): v for k, v in self.headers.items()}
        type(self).seen_headers.append(hdrs)
        if self.path == "/fail":
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"unavailable")
            return
        if self.path == "/notfound":
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"missing")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"hello")


@contextmanager
def _loopback_http_server() -> Generator[tuple[str, list[dict[str, str]]]]:
    seen: list[dict[str, str]] = []

    class _Handler(_QuietHandler):
        seen_headers = seen

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    port = int(srv.server_address[1])
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", seen
    finally:
        srv.shutdown()
        srv.server_close()
        t.join(timeout=2.0)


@pytest.mark.asyncio
async def test_asgi_starlette_route_canonical_server_timing_and_exemplars() -> None:
    async def get_order(request: StarletteRequest) -> PlainTextResponse:
        order_id = request.path_params["order_id"]
        rec_cur = libo11y.current_record()
        assert rec_cur is not None
        rec_cur.set("order.id", order_id)
        return PlainTextResponse(f"order:{order_id}")

    async def health(_request: StarletteRequest) -> PlainTextResponse:
        return PlainTextResponse("ok")

    async def boom(_request: StarletteRequest) -> PlainTextResponse:
        raise RuntimeError("boom!")

    app = Starlette(
        routes=[
            Route("/orders/{order_id}", get_order),
            Route("/healthz", health),
            Route("/debug/pprof", health),
            Route("/debug/a/b", health),
            Route("/boom", boom),
        ]
    )

    with start_recorder(service_name="asgi-starlette") as rec:
        wrapped = o11y_asgi.instrument_asgi(
            app,
            telemetry=rec.telemetry,
            ignore_paths=("/healthz", "/debug/*"),
            canonical_line=True,
            server_timing=True,
        )
        transport = httpx.ASGITransport(app=wrapped, raise_app_exceptions=True)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            # Normal routed request
            resp = await client.get("/orders/99")
            assert resp.status_code == 200
            assert resp.text == "order:99"
            st_hdr = resp.headers.get("server-timing", "")
            assert st_hdr.startswith('traceparent;desc="00-')

            # Ignored paths emit nothing; /debug/a/b is NOT ignored because * doesn't cross /
            assert (await client.get("/healthz")).status_code == 200
            assert (await client.get("/debug/pprof")).status_code == 200
            assert (await client.get("/debug/a/b")).status_code == 200

            # Exception marks span error and re-raises
            with pytest.raises(RuntimeError, match="boom!"):
                await client.get("/boom")

        rec.assert_conforms()
        spans = rec.spans()
        names = [s.name for s in spans]
        assert "GET /orders/{order_id}" in names
        assert "GET /debug/a/b" in names
        assert "GET /boom" in names
        assert not any("healthz" in n or "pprof" in n for n in names)

        order_sp = next(s for s in spans if s.name == "GET /orders/{order_id}")
        assert order_sp.kind == SpanKind.SERVER
        assert order_sp.attributes is not None
        assert order_sp.attributes["http.route"] == "/orders/{order_id}"
        assert order_sp.attributes["http.response.status_code"] == 200
        assert order_sp.status.status_code != StatusCode.ERROR

        boom_sp = next(s for s in spans if s.name == "GET /boom")
        assert boom_sp.status.status_code == StatusCode.ERROR
        assert boom_sp.attributes is not None
        assert boom_sp.attributes["error.type"] == "RuntimeError"

        # Duration metric + exemplar linked to sampled server spans
        pts = rec.metric_points("http.server.request.duration")
        assert any(pt["attributes"].get("http.route") == "/orders/{order_id}" for pt in pts)
        exemplars = rec.exemplars("http.server.request.duration")
        span_trace_ids = {sc.trace_id for s in spans if (sc := s.get_span_context()) is not None}
        assert len(exemplars) >= 1
        assert any(ex.trace_id in span_trace_ids for ex in exemplars)

        # Canonical log lines emitted for orders & boom, NOT healthz
        summary_logs = [
            lr
            for lr in rec.otel_logs()
            if (lr.log_record.attributes or {}).get(EVENT_NAME_KEY) == EVENT_REQUEST_SUMMARY
        ]
        assert len(summary_logs) == 3
        order_log = next(
            lr
            for lr in summary_logs
            if (lr.log_record.attributes or {}).get("http.route") == "/orders/{order_id}"
        )
        attrs: Mapping[str, Any] = order_log.log_record.attributes or {}
        assert attrs["order.id"] == "99"
        assert attrs["o11y.outcome"] == str(Outcome.SUCCESS)

        boom_log = next(
            lr
            for lr in summary_logs
            if (lr.log_record.attributes or {}).get("http.route") == "/boom"
        )
        boom_attrs: Mapping[str, Any] = boom_log.log_record.attributes or {}
        assert boom_attrs["o11y.outcome"] == str(Outcome.FAILURE)
        assert boom_attrs["http.response.status_code"] == 500


@pytest.mark.asyncio
async def test_asgi_fastapi_public_endpoint_and_propagation() -> None:
    api = fastapi.FastAPI()

    @api.get("/users/{user_id}")
    async def read_user(user_id: int) -> dict[str, Any]:
        return {"user_id": user_id, "tenant": baggage.get_baggage("tenant")}

    with start_recorder(service_name="asgi-fastapi") as rec:
        wrapped = o11y_asgi.ASGIMiddleware(
            api,
            telemetry=rec.telemetry,
            public_endpoint=True,
        )
        caller_tracer = rec.telemetry.tracer_provider.get_tracer("caller")
        with caller_tracer.start_as_current_span("caller-op") as caller_sp:
            caller_sc = caller_sp.get_span_context()
            ctx = baggage.set_baggage("tenant", "acme")
            tok = context.attach(ctx)
            try:
                client_transport = o11y_httpx.AsyncTransport(
                    httpx.ASGITransport(app=wrapped),
                    telemetry=rec.telemetry,
                )
                async with httpx.AsyncClient(
                    transport=client_transport,
                    base_url="http://api.local",
                ) as client:
                    resp = await client.get("/users/7")
            finally:
                context.detach(tok)

        assert resp.status_code == 200
        assert resp.json() == {"user_id": 7, "tenant": "acme"}

        server_sp = next(s for s in rec.spans() if s.kind == SpanKind.SERVER)
        client_sp = next(s for s in rec.spans() if s.kind == SpanKind.CLIENT)
        assert server_sp.name == "GET /users/{user_id}"
        assert client_sp.parent is not None
        assert client_sp.parent.span_id == caller_sc.span_id
        # Public endpoint: server starts a new trace and links back to the client span!
        assert server_sp.parent is None
        server_sc = server_sp.get_span_context()
        client_sc = client_sp.get_span_context()
        assert server_sc is not None and client_sc is not None
        assert server_sc.trace_id != client_sc.trace_id
        assert len(server_sp.links) == 1
        assert server_sp.links[0].context.span_id == client_sc.span_id


def test_wsgi_flask_route_canonical_and_server_timing() -> None:
    app = flask.Flask("test_wsgi")

    @app.route("/items/<int:item_id>")
    def get_item(item_id: int) -> str:
        cur = libo11y.current_record()
        assert cur is not None
        cur.set("item.id", item_id)
        return f"item:{item_id}"

    @app.route("/healthz")
    def healthz() -> str:
        return "ok"

    class _SilentWSGIHandler(WSGIRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            del format, args

    with start_recorder(service_name="wsgi-flask") as rec:
        wrapped = o11y_wsgi.instrument_wsgi(
            app,
            telemetry=rec.telemetry,
            ignore_paths=("/healthz",),
            canonical_line=True,
            server_timing=True,
        )
        srv = make_server("127.0.0.1", 0, wrapped, handler_class=_SilentWSGIHandler)
        port = srv.server_port
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            with httpx.Client(
                transport=o11y_httpx.SyncTransport(telemetry=rec.telemetry)
            ) as client:
                r = client.get(f"http://127.0.0.1:{port}/items/42")
                assert r.status_code == 200
                assert r.text == "item:42"
                assert r.headers.get("server-timing", "").startswith('traceparent;desc="00-')

                r_health = client.get(f"http://127.0.0.1:{port}/healthz")
                assert r_health.status_code == 200
        finally:
            srv.shutdown()
            srv.server_close()
            t.join(timeout=2.0)

        rec.assert_conforms()
        server_spans = [s for s in rec.spans() if s.kind == SpanKind.SERVER]
        assert len(server_spans) == 1
        assert server_spans[0].name == "GET /items/<int:item_id>"
        assert server_spans[0].attributes is not None
        assert server_spans[0].attributes["http.route"] == "/items/<int:item_id>"

        # Client and server share the same trace (not public_endpoint)
        client_spans = [s for s in rec.spans() if s.kind == SpanKind.CLIENT]
        matching_client = next(
            s
            for s in client_spans
            if s.attributes is not None and "/items/42" in str(s.attributes.get("url.full", ""))
        )
        srv_sc = server_spans[0].get_span_context()
        cli_sc = matching_client.get_span_context()
        assert srv_sc is not None and cli_sc is not None
        assert srv_sc.trace_id == cli_sc.trace_id


def test_wsgi_django_route_template() -> None:
    django_mod = importlib.import_module("django")
    dj_conf = importlib.import_module("django.conf")
    dj_urls = importlib.import_module("django.urls")
    dj_http = importlib.import_module("django.http")

    def _django_article_view(_request: Any, article_id: int) -> Any:
        return dj_http.HttpResponse(f"article:{article_id}".encode())

    globals()["urlpatterns"] = [
        dj_urls.path("articles/<int:article_id>/", _django_article_view),
    ]

    if not dj_conf.settings.configured:
        dj_conf.settings.configure(
            DEBUG=True,
            SECRET_KEY="test-secret-key",
            ALLOWED_HOSTS=["*"],
            ROOT_URLCONF=__name__,
        )
        django_mod.setup()

    dj_wsgi = importlib.import_module("django.core.wsgi")
    dj_app = cast(o11y_wsgi.WSGIApp, dj_wsgi.get_wsgi_application())

    with start_recorder(service_name="wsgi-django") as rec:
        wrapped = o11y_wsgi.WSGIMiddleware(dj_app, telemetry=rec.telemetry)
        statuses: list[str] = []

        def _noop_write(_data: bytes) -> None:
            return None

        def start_response(
            status: str, headers: list[tuple[str, str]], exc_info: Any = None
        ) -> Any:
            del headers, exc_info
            statuses.append(status)
            return _noop_write

        environ: dict[str, Any] = {
            "REQUEST_METHOD": "GET",
            "PATH_INFO": "/articles/123/",
            "QUERY_STRING": "",
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "8000",
            "SERVER_PROTOCOL": "HTTP/1.1",
            "wsgi.url_scheme": "http",
            "wsgi.input": _EmptyStream(),
            "wsgi.errors": _EmptyStream(),
            "wsgi.version": (1, 0),
            "wsgi.multithread": False,
            "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        body = b"".join(wrapped(environ, start_response))
        assert body == b"article:123"
        assert statuses[0].startswith("200")

        spans = rec.spans()
        assert len(spans) == 1
        assert spans[0].name == "GET /articles/<int:article_id>/"
        assert spans[0].attributes is not None
        assert spans[0].attributes["http.route"] == "/articles/<int:article_id>/"


class _EmptyStream:
    def read(self, _n: int = -1) -> bytes:
        return b""

    def readline(self, _n: int = -1) -> bytes:
        return b""


def test_requests_adapter_instruments_only_mounted_session() -> None:
    with (
        _loopback_http_server() as (base_url, seen),
        start_recorder(service_name="requests-test") as rec,
    ):
        tracer = rec.telemetry.tracer_provider.get_tracer("req")

        # Unmounted requests.get() must NOT produce spans or inject headers.
        r_plain = requests.get(f"{base_url}/plain", timeout=5)
        assert r_plain.status_code == 200
        assert len(rec.spans()) == 0
        assert "traceparent" not in seen[-1]

        # Mounted session records client spans, metrics, exemplars, and traceparent.
        sess = requests.Session()
        o11y_requests.mount(sess, telemetry=rec.telemetry)
        try:
            with tracer.start_as_current_span("outer") as outer:
                outer_sc = outer.get_span_context()
                r_ok = sess.get(f"{base_url}/ok", timeout=5)
                r_404 = sess.get(f"{base_url}/notfound", timeout=5)
                r_503 = sess.get(f"{base_url}/fail", timeout=5)
        finally:
            sess.close()

        assert r_ok.status_code == 200
        assert r_404.status_code == 404
        assert r_503.status_code == 503
        assert "traceparent" in seen[-3]
        assert f"{outer_sc.trace_id:032x}" in seen[-3]["traceparent"]

        client_spans = [s for s in rec.spans() if s.kind == SpanKind.CLIENT]
        assert len(client_spans) == 3
        by_status = {(s.attributes or {}).get("http.response.status_code"): s for s in client_spans}
        assert by_status[200].status.status_code != StatusCode.ERROR
        assert by_status[404].status.status_code == StatusCode.ERROR
        assert (by_status[404].attributes or {}).get("error.type") == "404"
        assert by_status[503].status.status_code == StatusCode.ERROR

        pts = rec.metric_points("http.client.request.duration")
        assert len(pts) >= 3
        exemplars = rec.exemplars("http.client.request.duration")
        assert any(ex.trace_id == outer_sc.trace_id for ex in exemplars)


def test_httpx_strips_userinfo_from_url_full() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(200, text="ok")

    with start_recorder(service_name="httpx-sanitize") as rec:
        transport = o11y_httpx.SyncTransport(
            httpx.MockTransport(handler),
            telemetry=rec.telemetry,
        )
        with httpx.Client(transport=transport) as client:
            r = client.get("http://alice:supersecret@example.test/data")
            assert r.status_code == 200

        sp = rec.spans()[0]
        assert sp.attributes is not None
        assert sp.attributes["url.full"] == "http://example.test/data"
        assert "supersecret" not in str(sp.attributes["url.full"])
        assert sp.kind == trace.SpanKind.CLIENT
