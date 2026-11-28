"""Contract tests for the libo11y.httpx transports and the libo11y.requests adapter.

The references are TypeScript instrumentFetch and Zig o11yhttp.Client:
per-destination propagation, peer.service, cross-origin redirects without
trace context, one exception event per failure, and stable HTTP semconv.
"""

from __future__ import annotations

import http.server
import socket
import threading
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import requests
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode

from libo11y import httpx as o11y_httpx
from libo11y import requests as o11y_requests
from libo11y.testing import Recorder, start_recorder

# ---------------------------------------------------------------- helpers


def _client_spans(rec: Recorder) -> list[ReadableSpan]:
    return [s for s in rec.spans() if s.kind == SpanKind.CLIENT]


def _attrs(span: ReadableSpan) -> Mapping[str, Any]:
    return span.attributes or {}


def _exception_events(span: ReadableSpan) -> list[str]:
    return [e.name for e in span.events if e.name == "exception"]


@dataclass
class _Seen:
    """Requests a mock or loopback server received, by host and path."""

    requests: list[tuple[str, str, dict[str, str]]] = field(
        default_factory=list[tuple[str, str, dict[str, str]]]
    )

    def headers_for(self, host: str, path: str) -> dict[str, str]:
        return next(h for (hh, p, h) in self.requests if hh == host and p == path)


def _mock_handler(seen: _Seen) -> Callable[[httpx.Request], httpx.Response]:
    """A MockTransport handler: /status/<n>, /redirect?to=<url>, otherwise 200."""

    def handler(request: httpx.Request) -> httpx.Response:
        seen.requests.append(
            (request.url.host, request.url.path, {k.lower(): v for k, v in request.headers.items()})
        )
        path = request.url.path
        if path.startswith("/status/"):
            return httpx.Response(int(path.rsplit("/", 1)[1]))
        if path == "/redirect":
            return httpx.Response(302, headers={"Location": request.url.params["to"]})
        return httpx.Response(200, text="ok", extensions={"http_version": b"HTTP/2"})

    return handler


def _sync_client(rec: Recorder, seen: _Seen, **options: Any) -> httpx.Client:
    transport = o11y_httpx.SyncTransport(
        httpx.MockTransport(_mock_handler(seen)), telemetry=rec.telemetry, **options
    )
    return httpx.Client(transport=transport, follow_redirects=True)


def _async_client(rec: Recorder, seen: _Seen, **options: Any) -> httpx.AsyncClient:
    transport = o11y_httpx.AsyncTransport(
        httpx.MockTransport(_mock_handler(seen)), telemetry=rec.telemetry, **options
    )
    return httpx.AsyncClient(transport=transport, follow_redirects=True)


class _LoopbackHandler(http.server.BaseHTTPRequestHandler):
    seen: _Seen
    redirect_to: str = ""

    def log_message(self, format: str, *args: Any) -> None:
        del format, args

    def do_GET(self) -> None:
        host = self.headers.get("Host", "")
        self.seen.requests.append(
            (host, self.path, {k.lower(): v for k, v in self.headers.items()})
        )
        if self.path == "/redirect-away":
            self.send_response(302)
            self.send_header("Location", self.redirect_to)
            self.end_headers()
            return
        if self.path == "/redirect-here":
            self.send_response(302)
            self.send_header("Location", "/landing")
            self.end_headers()
            return
        if self.path.startswith("/status/"):
            self.send_response(int(self.path.rsplit("/", 1)[1]))
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")


@contextmanager
def _loopback(seen: _Seen, redirect_to: str = "") -> Generator[str]:
    class _Handler(_LoopbackHandler):
        pass

    _Handler.seen = seen
    _Handler.redirect_to = redirect_to
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    worker = threading.Thread(target=srv.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{srv.server_address[1]}"
    finally:
        srv.shutdown()
        srv.server_close()
        worker.join(timeout=5)


@contextmanager
def _session(rec: Recorder, **options: Any) -> Generator[requests.Session]:
    sess = requests.Session()
    o11y_requests.mount(sess, telemetry=rec.telemetry, **options)
    try:
        yield sess
    finally:
        sess.close()


def _closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# ---------------------------------------------------------------- 10. propagate_fn


@pytest.mark.parametrize(("allow", "injected"), [(True, True), (False, False)])
def test_httpx_propagate_fn_decides_injection_per_destination(allow: bool, injected: bool) -> None:
    seen = _Seen()
    asked: list[str] = []

    def propagate(url: httpx.URL) -> bool:
        asked.append(str(url))
        return allow

    with start_recorder() as rec, _sync_client(rec, seen, propagate_fn=propagate) as client:
        client.get("http://third.party/data")
    assert asked == ["http://third.party/data"]
    assert ("traceparent" in seen.headers_for("third.party", "/data")) is injected


def test_httpx_injects_by_default() -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        client.get("http://api.local/data")
    assert "traceparent" in seen.headers_for("api.local", "/data")


def test_httpx_propagate_fn_that_raises_sends_no_context() -> None:
    seen = _Seen()

    def propagate(url: httpx.URL) -> bool:
        raise RuntimeError(f"cannot decide for {url}")

    with start_recorder() as rec, _sync_client(rec, seen, propagate_fn=propagate) as client:
        assert client.get("http://api.local/data").status_code == 200
    assert "traceparent" not in seen.headers_for("api.local", "/data")
    assert len(_client_spans(rec)) == 1


async def test_httpx_async_propagate_fn_decides_injection() -> None:
    seen = _Seen()

    def never(_url: httpx.URL) -> bool:
        return False

    with start_recorder() as rec:
        async with _async_client(rec, seen, propagate_fn=never) as client:
            await client.get("http://third.party/data")
    assert "traceparent" not in seen.headers_for("third.party", "/data")


@pytest.mark.parametrize(("allow", "injected"), [(True, True), (False, False)])
def test_requests_propagate_fn_decides_injection_per_destination(
    allow: bool, injected: bool
) -> None:
    seen = _Seen()
    asked: list[str] = []

    def propagate(url: str) -> bool:
        asked.append(url)
        return allow

    with (
        _loopback(seen) as base,
        start_recorder() as rec,
        _session(rec, propagate_fn=propagate) as sess,
    ):
        sess.get(f"{base}/data", timeout=5)
    assert asked == [f"{base}/data"]
    assert ("traceparent" in seen.requests[0][2]) is injected


# ---------------------------------------------------------------- 10. peer_service


def test_httpx_peer_service_names_the_callee() -> None:
    seen = _Seen()
    with start_recorder() as rec:
        with _sync_client(rec, seen, peer_service="billing") as client:
            client.get("http://billing.internal/invoices")
        with _sync_client(rec, seen) as client:
            client.get("http://other.internal/x")
        by_host = {_attrs(s)["server.address"]: _attrs(s) for s in _client_spans(rec)}
    assert by_host["billing.internal"]["peer.service"] == "billing"
    assert "peer.service" not in by_host["other.internal"]


async def test_httpx_async_peer_service_names_the_callee() -> None:
    seen = _Seen()
    with start_recorder() as rec:
        async with _async_client(rec, seen, peer_service="billing") as client:
            await client.get("http://billing.internal/invoices")
        [span] = _client_spans(rec)
    assert _attrs(span)["peer.service"] == "billing"


def test_requests_peer_service_names_the_callee() -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec:
        with _session(rec, peer_service="billing") as sess:
            sess.get(f"{base}/x", timeout=5)
        [span] = _client_spans(rec)
    assert _attrs(span)["peer.service"] == "billing"


# ---------------------------------------------------------------- 11. protocol version


def test_httpx_client_span_records_the_protocol_version() -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        client.get("http://api.local/data")
        [span] = _client_spans(rec)
        [point] = rec.metric_points("http.client.request.duration")
    assert _attrs(span)["network.protocol.version"] == "2"
    assert point["attributes"]["network.protocol.version"] == "2"


def test_requests_client_span_records_the_protocol_version() -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec, _session(rec) as sess:
        sess.get(f"{base}/x", timeout=5)
        [span] = _client_spans(rec)
    # BaseHTTPRequestHandler answers in HTTP/1.0 by default.
    assert _attrs(span)["network.protocol.version"] == "1.0"


# ---------------------------------------------------------------- 4. one exception event


def test_httpx_failure_is_recorded_once_without_a_status_description() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("token=secret refused", request=request)

    with start_recorder() as rec:
        transport = o11y_httpx.SyncTransport(httpx.MockTransport(handler), telemetry=rec.telemetry)
        with httpx.Client(transport=transport) as client, pytest.raises(httpx.ConnectError):
            client.get("http://api.local/data")
        [span] = _client_spans(rec)
    assert _exception_events(span) == ["exception"]
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description is None
    assert _attrs(span)["error.type"] == "httpx.ConnectError"


async def test_httpx_async_failure_is_recorded_once_without_a_status_description() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("token=secret refused", request=request)

    with start_recorder() as rec:
        transport = o11y_httpx.AsyncTransport(httpx.MockTransport(handler), telemetry=rec.telemetry)
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get("http://api.local/data")
        [span] = _client_spans(rec)
    assert _exception_events(span) == ["exception"]
    assert span.status.description is None


def test_requests_failure_is_recorded_once_without_a_status_description() -> None:
    with start_recorder() as rec, _session(rec) as sess:
        with pytest.raises(requests.ConnectionError):
            sess.get(f"http://127.0.0.1:{_closed_port()}/x", timeout=5)
        [span] = _client_spans(rec)
    assert _exception_events(span) == ["exception"]
    assert span.status.status_code == StatusCode.ERROR
    assert span.status.description is None
    assert _attrs(span)["error.type"] == "requests.exceptions.ConnectionError"


# ---------------------------------------------------------------- 6. instruments built once


class _CallCounter:
    def __init__(self, target: object, name: str, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls = 0
        real: Callable[..., Any] = getattr(target, name)

        def counting(*args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            return real(*args, **kwargs)

        monkeypatch.setattr(target, name, counting)


def test_httpx_with_telemetry_builds_instruments_once(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _Seen()
    with start_recorder() as rec:
        tracers = _CallCounter(rec.telemetry.tracer_provider, "get_tracer", monkeypatch)
        meters = _CallCounter(rec.telemetry.meter_provider, "get_meter", monkeypatch)
        with _sync_client(rec, seen) as client:
            for _ in range(3):
                client.get("http://api.local/data")
        assert len(_client_spans(rec)) == 3
    assert (tracers.calls, meters.calls) == (1, 1)


def test_requests_with_telemetry_builds_instruments_once(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec:
        tracers = _CallCounter(rec.telemetry.tracer_provider, "get_tracer", monkeypatch)
        meters = _CallCounter(rec.telemetry.meter_provider, "get_meter", monkeypatch)
        with _session(rec) as sess:
            for _ in range(3):
                sess.get(f"{base}/x", timeout=5)
        assert len(_client_spans(rec)) == 3
    assert (tracers.calls, meters.calls) == (1, 1)


# ---------------------------------------------------------------- 12. verified contracts


def test_requests_strips_credentials_from_url_full() -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec, _session(rec) as sess:
        sess.get(base.replace("http://", "http://alice:supersecret@") + "/x", timeout=5)
        [span] = _client_spans(rec)
    assert _attrs(span)["url.full"] == f"{base}/x"


def test_httpx_cross_origin_redirect_carries_no_trace_context() -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        resp = client.get("http://a.test/redirect", params={"to": "http://b.test/landing"})
        assert resp.status_code == 200
    assert "traceparent" in seen.headers_for("a.test", "/redirect")
    assert "traceparent" not in seen.headers_for("b.test", "/landing")


def test_httpx_same_origin_redirect_carries_fresh_trace_context() -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        client.get("http://a.test/redirect", params={"to": "http://a.test/landing"})
        spans = _client_spans(rec)
    first = seen.headers_for("a.test", "/redirect")["traceparent"]
    second = seen.headers_for("a.test", "/landing")["traceparent"]
    assert first != second
    assert {f"{s.context.span_id:016x}" for s in spans if s.context} == {
        first.split("-")[2],
        second.split("-")[2],
    }


async def test_httpx_async_cross_origin_redirect_carries_no_trace_context() -> None:
    seen = _Seen()
    with start_recorder() as rec:
        async with _async_client(rec, seen) as client:
            await client.get("http://a.test/redirect", params={"to": "http://b.test/landing"})
    assert "traceparent" not in seen.headers_for("b.test", "/landing")


def test_requests_cross_origin_redirect_carries_no_trace_context() -> None:
    seen_b = _Seen()
    seen_a = _Seen()
    with (
        _loopback(seen_b) as base_b,
        _loopback(seen_a, redirect_to=f"{base_b}/landing") as base_a,
        start_recorder() as rec,
        _session(rec) as sess,
    ):
        assert sess.get(f"{base_a}/redirect-away", timeout=5).status_code == 200
    assert "traceparent" in seen_a.requests[0][2]
    assert "traceparent" not in seen_b.requests[0][2]


def test_requests_same_origin_redirect_carries_trace_context() -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec, _session(rec) as sess:
        assert sess.get(f"{base}/redirect-here", timeout=5).status_code == 200
    [first, second] = [h["traceparent"] for (_host, _path, h) in seen.requests]
    assert first != second


def test_httpx_unknown_method_is_recorded_as_other() -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        client.request("PURGE", "http://api.local/cache")
        [span] = _client_spans(rec)
    assert span.name == "HTTP"
    assert _attrs(span)["http.request.method"] == "_OTHER"
    assert _attrs(span)["http.request.method_original"] == "PURGE"


def test_requests_unknown_method_is_recorded_as_other() -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec, _session(rec) as sess:
        sess.request("PURGE", f"{base}/x", timeout=5)
        [span] = _client_spans(rec)
    assert span.name == "HTTP"
    assert _attrs(span)["http.request.method"] == "_OTHER"
    assert _attrs(span)["http.request.method_original"] == "PURGE"


@pytest.mark.parametrize(("status", "failed"), [(200, False), (404, True), (503, True)])
def test_httpx_4xx_and_5xx_mark_the_client_span_failed(status: int, failed: bool) -> None:
    seen = _Seen()
    with start_recorder() as rec, _sync_client(rec, seen) as client:
        client.get(f"http://api.local/status/{status}")
        [span] = _client_spans(rec)
    assert (span.status.status_code == StatusCode.ERROR) is failed
    assert span.status.description is None
    assert _attrs(span).get("error.type") == (str(status) if failed else None)


@pytest.mark.parametrize(("status", "failed"), [(200, False), (404, True), (503, True)])
def test_requests_4xx_and_5xx_mark_the_client_span_failed(status: int, failed: bool) -> None:
    seen = _Seen()
    with _loopback(seen) as base, start_recorder() as rec, _session(rec) as sess:
        sess.get(f"{base}/status/{status}", timeout=5)
        [span] = _client_spans(rec)
    assert (span.status.status_code == StatusCode.ERROR) is failed
    assert span.status.description is None
