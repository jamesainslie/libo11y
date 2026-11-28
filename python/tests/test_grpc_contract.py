"""Contract tests for libo11y.grpc over real loopback channels.

Every test drives grpcio end to end: a ``grpc.server`` or ``grpc.aio.server``
on port 0 with generic handlers, and a real channel carrying the libo11y
client interceptors. The expected values come from Go's ``o11ygrpc`` (the
pinned ``otelgrpc``) and ``rust/libo11y-tonic``.
"""

from __future__ import annotations

import asyncio
import gc
import threading
from collections.abc import AsyncGenerator, AsyncIterator, Iterator
from concurrent import futures
from dataclasses import dataclass, field
from typing import Any, Final, cast

import grpc
import grpc.aio
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode

from libo11y import grpc as o11y_grpc
from libo11y.testing import Recorder, start_recorder

SERVICE: Final[str] = "demo.Echo"
UNARY: Final[str] = f"/{SERVICE}/Unary"
SERVER_STREAM: Final[str] = f"/{SERVICE}/ServerStream"
CLIENT_STREAM: Final[str] = f"/{SERVICE}/ClientStream"
BIDI: Final[str] = f"/{SERVICE}/Bidi"
SERVER_STREAM_WRITE: Final[str] = f"/{SERVICE}/ServerStreamWrite"
BIDI_WRITE: Final[str] = f"/{SERVICE}/BidiWrite"
HEALTH: Final[str] = "/grpc.health.v1.Health/Check"
WAIT_S: Final[float] = 5.0

SERVER_FAULT_CODES: Final[frozenset[grpc.StatusCode]] = frozenset(
    {
        grpc.StatusCode.UNKNOWN,
        grpc.StatusCode.DEADLINE_EXCEEDED,
        grpc.StatusCode.UNIMPLEMENTED,
        grpc.StatusCode.INTERNAL,
        grpc.StatusCode.UNAVAILABLE,
        grpc.StatusCode.DATA_LOSS,
    }
)
NON_OK_CODES: Final[list[grpc.StatusCode]] = [
    c for c in grpc.StatusCode if c is not grpc.StatusCode.OK
]


# --------------------------------------------------------------------------
# Handlers. The request payload selects the behaviour.
# --------------------------------------------------------------------------


class _ExplodedError(RuntimeError):
    """Raised by a handler to model an unhandled application exception."""


SECRET_TEXT: Final[str] = "secret-token-do-not-copy"


@dataclass
class _Signals:
    """Thread-safe signals a handler raises so a test can wait without sleeping."""

    started: threading.Event = field(default_factory=threading.Event)


def _parse_abort(payload: bytes) -> tuple[grpc.StatusCode, str] | None:
    text = payload.decode()
    if not text.startswith("abort:"):
        return None
    name = text.removeprefix("abort:")
    return grpc.StatusCode[name], f"detail for {name}"


def _sync_unary_behaviour(payload: bytes, ctx: grpc.ServicerContext, signals: _Signals) -> bytes:
    abort = _parse_abort(payload)
    if abort is not None:
        ctx.abort(abort[0], abort[1])
    if payload == b"raise":
        raise _ExplodedError(SECRET_TEXT)
    if payload == b"set_code":
        ctx.set_code(grpc.StatusCode.NOT_FOUND)
        ctx.set_details("set without raising")
        return b""
    if payload == b"block":
        done = threading.Event()
        ctx.add_callback(done.set)
        signals.started.set()
        done.wait(WAIT_S)
        return b"late"
    return b"echo:" + payload


class _SyncService(grpc.GenericRpcHandler):
    def __init__(self, signals: _Signals) -> None:
        self._signals = signals

    def _unary(self, req: bytes, ctx: grpc.ServicerContext) -> bytes:
        return _sync_unary_behaviour(req, ctx, self._signals)

    def _server_stream(self, req: bytes, ctx: grpc.ServicerContext) -> Iterator[bytes]:
        yield req + b"-1"
        if req == b"late_error":
            ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
        if req == b"late_raise":
            raise _ExplodedError(SECRET_TEXT)
        if req == b"block":
            done = threading.Event()
            ctx.add_callback(done.set)
            self._signals.started.set()
            done.wait(WAIT_S)
        yield req + b"-2"

    def _client_stream(self, reqs: Iterator[bytes], ctx: grpc.ServicerContext) -> bytes:
        seen: list[bytes] = []
        for req in reqs:
            if req == b"late_error":
                ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
            if req == b"block":
                done = threading.Event()
                ctx.add_callback(done.set)
                self._signals.started.set()
                done.wait(WAIT_S)
            seen.append(req)
        return b"|".join(seen)

    def _bidi(self, reqs: Iterator[bytes], ctx: grpc.ServicerContext) -> Iterator[bytes]:
        for req in reqs:
            if req == b"late_error":
                ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
            if req == b"block":
                done = threading.Event()
                ctx.add_callback(done.set)
                self._signals.started.set()
                done.wait(WAIT_S)
            yield b"echo:" + req

    def _health(self, _req: bytes, _ctx: grpc.ServicerContext) -> bytes:
        return b"SERVING"

    def service(
        self, handler_call_details: grpc.HandlerCallDetails
    ) -> grpc.RpcMethodHandler[Any, Any] | None:
        match handler_call_details.method:
            case "/demo.Echo/Unary":
                return grpc.unary_unary_rpc_method_handler(self._unary)
            case "/demo.Echo/ServerStream":
                return grpc.unary_stream_rpc_method_handler(self._server_stream)
            case "/demo.Echo/ClientStream":
                return grpc.stream_unary_rpc_method_handler(self._client_stream)
            case "/demo.Echo/Bidi":
                return grpc.stream_stream_rpc_method_handler(self._bidi)
            case "/grpc.health.v1.Health/Check":
                return grpc.unary_unary_rpc_method_handler(self._health)
            case _:
                return None


@dataclass
class _AioSignals:
    started: asyncio.Event = field(default_factory=asyncio.Event)
    finished: asyncio.Event = field(default_factory=asyncio.Event)


class _AioService(grpc.GenericRpcHandler):
    """Async handlers: async generators, and coroutines that call ``context.write``."""

    def __init__(self, signals: _AioSignals) -> None:
        self._signals = signals

    async def _block(self) -> None:
        self._signals.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self._signals.finished.set()

    async def _unary(self, req: bytes, ctx: grpc.aio.ServicerContext[bytes, bytes]) -> bytes:
        abort = _parse_abort(req)
        if abort is not None:
            await ctx.abort(abort[0], abort[1])
        if req == b"raise":
            raise _ExplodedError(SECRET_TEXT)
        if req == b"set_code":
            ctx.set_code(grpc.StatusCode.NOT_FOUND)
            ctx.set_details("set without raising")
            return b""
        if req == b"block":
            await self._block()
        return b"echo:" + req

    async def _server_stream(
        self, req: bytes, ctx: grpc.aio.ServicerContext[bytes, bytes]
    ) -> AsyncIterator[bytes]:
        yield req + b"-1"
        if req == b"late_error":
            await ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
        if req == b"late_raise":
            raise _ExplodedError(SECRET_TEXT)
        if req == b"block":
            await self._block()
        yield req + b"-2"

    async def _server_stream_write(
        self, req: bytes, ctx: grpc.aio.ServicerContext[bytes, bytes]
    ) -> None:
        await ctx.write(req + b"-1")
        if req == b"late_error":
            await ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
        if req == b"block":
            await self._block()
        await ctx.write(req + b"-2")

    async def _client_stream(
        self, reqs: AsyncIterator[bytes], ctx: grpc.aio.ServicerContext[bytes, bytes]
    ) -> bytes:
        seen: list[bytes] = []
        async for req in reqs:
            if req == b"late_error":
                await ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
            if req == b"block":
                await self._block()
            seen.append(req)
        return b"|".join(seen)

    async def _bidi(
        self, reqs: AsyncIterator[bytes], ctx: grpc.aio.ServicerContext[bytes, bytes]
    ) -> AsyncIterator[bytes]:
        async for req in reqs:
            if req == b"late_error":
                await ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
            if req == b"block":
                await self._block()
            yield b"echo:" + req

    async def _bidi_write(
        self, reqs: AsyncIterator[bytes], ctx: grpc.aio.ServicerContext[bytes, bytes]
    ) -> None:
        async for req in reqs:
            if req == b"late_error":
                await ctx.abort(grpc.StatusCode.INTERNAL, "late failure")
            await ctx.write(b"echo:" + req)

    async def _health(self, _req: bytes, _ctx: grpc.aio.ServicerContext[bytes, bytes]) -> bytes:
        return b"SERVING"

    def service(
        self, handler_call_details: grpc.HandlerCallDetails
    ) -> grpc.RpcMethodHandler[Any, Any] | None:
        match handler_call_details.method:
            case "/demo.Echo/Unary":
                return grpc.unary_unary_rpc_method_handler(self._unary)
            case "/demo.Echo/ServerStream":
                return grpc.unary_stream_rpc_method_handler(self._server_stream)
            case "/demo.Echo/ServerStreamWrite":
                return grpc.unary_stream_rpc_method_handler(self._server_stream_write)
            case "/demo.Echo/ClientStream":
                return grpc.stream_unary_rpc_method_handler(self._client_stream)
            case "/demo.Echo/Bidi":
                return grpc.stream_stream_rpc_method_handler(self._bidi)
            case "/demo.Echo/BidiWrite":
                return grpc.stream_stream_rpc_method_handler(self._bidi_write)
            case "/grpc.health.v1.Health/Check":
                return grpc.unary_unary_rpc_method_handler(self._health)
            case _:
                return None


# --------------------------------------------------------------------------
# Harnesses
# --------------------------------------------------------------------------


@dataclass
class SyncHarness:
    rec: Recorder
    channel: grpc.Channel
    signals: _Signals
    _server: grpc.Server
    _pool: futures.ThreadPoolExecutor
    _raw: grpc.Channel

    def unary(self, method: str = UNARY) -> grpc.UnaryUnaryMultiCallable[bytes, bytes]:
        return self.channel.unary_unary(method)

    def unary_stream(
        self, method: str = SERVER_STREAM
    ) -> grpc.UnaryStreamMultiCallable[bytes, bytes]:
        return self.channel.unary_stream(method)

    def stream_unary(
        self, method: str = CLIENT_STREAM
    ) -> grpc.StreamUnaryMultiCallable[bytes, bytes]:
        return self.channel.stream_unary(method)

    def stream_stream(self, method: str = BIDI) -> grpc.StreamStreamMultiCallable[bytes, bytes]:
        return self.channel.stream_stream(method)

    def drain(self) -> None:
        """Stop the server and wait until every handler, and its span, has finished."""
        self._raw.close()
        self._server.stop(grace=WAIT_S).wait(WAIT_S)
        self._pool.shutdown(wait=True)


def _start_sync(
    rec: Recorder,
    *,
    server_kwargs: dict[str, Any] | None = None,
    client_kwargs: dict[str, Any] | None = None,
) -> SyncHarness:
    signals = _Signals()
    pool = futures.ThreadPoolExecutor(max_workers=4)
    server = grpc.server(
        pool,
        interceptors=[
            o11y_grpc.server_interceptor(telemetry=rec.telemetry, **(server_kwargs or {}))
        ],
    )
    server.add_generic_rpc_handlers([_SyncService(signals)])
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    raw = grpc.insecure_channel(f"127.0.0.1:{port}")
    channel = grpc.intercept_channel(
        raw, o11y_grpc.client_interceptor(telemetry=rec.telemetry, **(client_kwargs or {}))
    )
    return SyncHarness(rec, channel, signals, server, pool, raw)


@pytest.fixture
def sync_harness() -> Iterator[SyncHarness]:
    with start_recorder(service_name="grpc-contract-sync") as rec:
        h = _start_sync(rec)
        try:
            yield h
        finally:
            h.drain()


@dataclass
class AioHarness:
    rec: Recorder
    channel: grpc.aio.Channel
    signals: _AioSignals
    server: grpc.aio.Server

    def unary(self, method: str = UNARY) -> grpc.aio.UnaryUnaryMultiCallable[bytes, bytes]:
        return self.channel.unary_unary(method)

    def unary_stream(
        self, method: str = SERVER_STREAM
    ) -> grpc.aio.UnaryStreamMultiCallable[bytes, bytes]:
        return self.channel.unary_stream(method)

    def stream_unary(
        self, method: str = CLIENT_STREAM
    ) -> grpc.aio.StreamUnaryMultiCallable[bytes, bytes]:
        return self.channel.stream_unary(method)

    def stream_stream(self, method: str = BIDI) -> grpc.aio.StreamStreamMultiCallable[bytes, bytes]:
        return self.channel.stream_stream(method)


async def _start_aio(
    rec: Recorder,
    *,
    server_kwargs: dict[str, Any] | None = None,
    client_kwargs: dict[str, Any] | None = None,
) -> AioHarness:
    signals = _AioSignals()
    server = grpc.aio.server(
        interceptors=[
            o11y_grpc.aio_server_interceptor(telemetry=rec.telemetry, **(server_kwargs or {}))
        ]
    )
    server.add_generic_rpc_handlers([_AioService(signals)])
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    channel = grpc.aio.insecure_channel(
        f"127.0.0.1:{port}",
        interceptors=o11y_grpc.aio_client_interceptors(
            telemetry=rec.telemetry, **(client_kwargs or {})
        ),
    )
    return AioHarness(rec, channel, signals, server)


@pytest.fixture
async def aio_harness() -> AsyncIterator[AioHarness]:
    with start_recorder(service_name="grpc-contract-aio") as rec:
        h = await _start_aio(rec)
        try:
            yield h
        finally:
            await h.channel.close()
            await h.server.stop(grace=None)


def _spans(rec: Recorder, kind: SpanKind, method: str) -> list[ReadableSpan]:
    name = method.removeprefix("/")
    return [s for s in rec.spans() if s.kind == kind and s.name == name]


def _one(rec: Recorder, kind: SpanKind, method: str) -> ReadableSpan:
    found = _spans(rec, kind, method)
    assert len(found) == 1, f"want one {kind} span for {method}, got {len(found)}"
    return found[0]


def _attr(span: ReadableSpan, key: str) -> object:
    return (span.attributes or {}).get(key)


def _ctx(span: ReadableSpan) -> trace.SpanContext:
    sc = span.get_span_context()
    assert sc is not None
    return sc


def _exception_events(span: ReadableSpan) -> int:
    return sum(1 for e in span.events if e.name == "exception")


async def _wait(event: asyncio.Event) -> None:
    await asyncio.wait_for(event.wait(), WAIT_S)


def _requests(*items: bytes) -> Iterator[bytes]:
    yield from items


async def _arequests(*items: bytes) -> AsyncIterator[bytes]:
    for item in items:
        yield item


# --------------------------------------------------------------------------
# Finding 1: the aio client interceptors cover every call shape.
# --------------------------------------------------------------------------


def test_aio_client_interceptors_returns_one_interceptor_per_call_shape() -> None:
    interceptors = o11y_grpc.aio_client_interceptors()
    kinds = (
        grpc.aio.UnaryUnaryClientInterceptor,
        grpc.aio.UnaryStreamClientInterceptor,
        grpc.aio.StreamUnaryClientInterceptor,
        grpc.aio.StreamStreamClientInterceptor,
    )
    assert len(interceptors) == 4
    for kind, ic in zip(kinds, interceptors, strict=True):
        assert isinstance(ic, kind)
        assert sum(isinstance(ic, k) for k in kinds) == 1


async def test_aio_client_spans_every_call_shape(aio_harness: AioHarness) -> None:
    h = aio_harness
    assert await h.unary()(b"a") == b"echo:a"
    assert [m async for m in h.unary_stream()(b"b")] == [b"b-1", b"b-2"]
    assert await h.stream_unary()(_arequests(b"c", b"d")) == b"c|d"
    assert [m async for m in h.stream_stream()(_arequests(b"e"))] == [b"echo:e"]

    for method in (UNARY, SERVER_STREAM, CLIENT_STREAM, BIDI):
        client = _one(h.rec, SpanKind.CLIENT, method)
        server = _one(h.rec, SpanKind.SERVER, method)
        assert _attr(client, "rpc.response.status_code") == "OK"
        assert _ctx(client).trace_id == _ctx(server).trace_id
        assert server.parent is not None
        assert server.parent.span_id == _ctx(client).span_id


# --------------------------------------------------------------------------
# Finding 2: aio call objects are preserved and spans end with the call.
# --------------------------------------------------------------------------


async def test_aio_unary_call_keeps_grpc_call_methods(aio_harness: AioHarness) -> None:
    call = aio_harness.unary()(b"a")
    assert await call == b"echo:a"
    assert await call.code() is grpc.StatusCode.OK
    assert await call.details() in ("", None)
    assert await call.initial_metadata() is not None
    assert await call.trailing_metadata() is not None


async def test_aio_stream_unary_call_supports_write_api(aio_harness: AioHarness) -> None:
    call = aio_harness.stream_unary()()
    await call.write(b"x")
    await call.write(b"y")
    await call.done_writing()
    assert await call == b"x|y"
    assert (
        _attr(_one(aio_harness.rec, SpanKind.CLIENT, CLIENT_STREAM), "rpc.response.status_code")
        == "OK"
    )


async def test_aio_stream_stream_call_supports_read_write_api(aio_harness: AioHarness) -> None:
    call = aio_harness.stream_stream()()
    await call.write(b"x")
    assert await call.read() == b"echo:x"
    await call.done_writing()
    assert not isinstance(await call.read(), bytes)
    assert await call.code() is grpc.StatusCode.OK
    assert _attr(_one(aio_harness.rec, SpanKind.CLIENT, BIDI), "rpc.response.status_code") == "OK"


async def test_aio_stream_span_is_open_until_the_stream_ends(aio_harness: AioHarness) -> None:
    call = aio_harness.unary_stream()(b"b")
    assert await call.read() == b"b-1"
    assert _spans(aio_harness.rec, SpanKind.CLIENT, SERVER_STREAM) == []
    assert [m async for m in call] == [b"b-2"]
    assert (
        _attr(_one(aio_harness.rec, SpanKind.CLIENT, SERVER_STREAM), "rpc.response.status_code")
        == "OK"
    )


@pytest.mark.parametrize(
    ("shape", "method"),
    [("unary_stream", SERVER_STREAM), ("stream_stream", BIDI)],
)
async def test_aio_late_stream_error_is_recorded_on_the_client_span(
    aio_harness: AioHarness, shape: str, method: str
) -> None:
    h = aio_harness
    call: Any = (
        h.unary_stream()(b"late_error")
        if shape == "unary_stream"
        else h.stream_stream()(_arequests(b"ok", b"late_error"))
    )
    received: list[bytes] = []
    with pytest.raises(grpc.aio.AioRpcError) as err:
        async for m in call:
            received.append(m)
    assert err.value.code() is grpc.StatusCode.INTERNAL
    assert received
    span = _one(h.rec, SpanKind.CLIENT, method)
    assert _attr(span, "rpc.response.status_code") == "INTERNAL"
    assert _attr(span, "error.type") == "INTERNAL"
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description == "late failure"
    assert _exception_events(span) == 0


async def test_aio_stream_unary_late_error_is_recorded(aio_harness: AioHarness) -> None:
    with pytest.raises(grpc.aio.AioRpcError):
        await aio_harness.stream_unary()(_arequests(b"ok", b"late_error"))
    span = _one(aio_harness.rec, SpanKind.CLIENT, CLIENT_STREAM)
    assert _attr(span, "rpc.response.status_code") == "INTERNAL"
    assert span.status.status_code is StatusCode.ERROR


async def test_aio_unary_error_keeps_status_on_call(aio_harness: AioHarness) -> None:
    call = aio_harness.unary()(b"abort:NOT_FOUND")
    with pytest.raises(grpc.aio.AioRpcError):
        await call
    assert await call.code() is grpc.StatusCode.NOT_FOUND
    assert await call.details() == "detail for NOT_FOUND"


async def test_aio_client_cancel_records_cancelled(aio_harness: AioHarness) -> None:
    h = aio_harness
    call = h.unary_stream()(b"block")
    assert await call.read() == b"block-1"
    await _wait(h.signals.started)
    assert call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call.read()
    span = _one(h.rec, SpanKind.CLIENT, SERVER_STREAM)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"
    assert span.status.status_code is StatusCode.ERROR
    await _wait(h.signals.finished)
    server = _one(h.rec, SpanKind.SERVER, SERVER_STREAM)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"
    assert server.status.status_code is StatusCode.UNSET


async def test_aio_unary_cancel_records_cancelled(aio_harness: AioHarness) -> None:
    h = aio_harness
    call = h.unary()(b"block")
    await _wait(h.signals.started)
    assert call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    span = _one(h.rec, SpanKind.CLIENT, UNARY)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"
    await _wait(h.signals.finished)
    server = _one(h.rec, SpanKind.SERVER, UNARY)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"


@pytest.mark.parametrize("shape", ["unary_stream", "stream_stream"])
async def test_aio_abandoned_stream_ends_span_once_when_channel_closes(
    aio_harness: AioHarness, shape: str
) -> None:
    h = aio_harness
    method = SERVER_STREAM if shape == "unary_stream" else BIDI
    if shape == "unary_stream":
        stream = h.unary_stream()(b"block")
        expected = b"block-1"
    else:
        stream = h.stream_stream()(_arequests(b"ok", b"block"))
        expected = b"echo:ok"
    async for message in stream:
        assert message == expected
        break
    await _wait(h.signals.started)
    del stream
    await h.channel.close()
    await _wait(h.signals.finished)
    span = _one(h.rec, SpanKind.CLIENT, method)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"
    assert len(h.rec.metric_points("rpc.client.call.duration")) == 1
    server = _one(h.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"


async def test_aio_closing_response_iterator_cancels_open_rpc(aio_harness: AioHarness) -> None:
    h = aio_harness
    call = h.unary_stream()(b"block")
    responses = cast("AsyncGenerator[bytes]", aiter(call))
    assert await anext(responses) == b"block-1"
    await _wait(h.signals.started)
    await responses.aclose()
    await _wait(h.signals.finished)
    for kind in (SpanKind.CLIENT, SpanKind.SERVER):
        assert _attr(_one(h.rec, kind, SERVER_STREAM), "rpc.response.status_code") == "CANCELLED"


# --------------------------------------------------------------------------
# Finding 3: sync streaming calls keep grpcio's call object.
# --------------------------------------------------------------------------


def test_sync_stream_call_starts_rpc_before_iteration(sync_harness: SyncHarness) -> None:
    call = sync_harness.unary_stream()(b"block")
    assert sync_harness.signals.started.wait(WAIT_S)
    assert call.cancel()
    span = _one(sync_harness.rec, SpanKind.CLIENT, SERVER_STREAM)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"


def test_sync_stream_call_keeps_grpc_call_methods(sync_harness: SyncHarness) -> None:
    call = sync_harness.unary_stream()(b"b")
    assert list(call) == [b"b-1", b"b-2"]
    assert call.code() is grpc.StatusCode.OK
    assert call.trailing_metadata() is not None
    assert call.initial_metadata() is not None
    assert not call.is_active()
    span = _one(sync_harness.rec, SpanKind.CLIENT, SERVER_STREAM)
    assert _attr(span, "rpc.response.status_code") == "OK"


def test_sync_stream_late_error_is_recorded_once(sync_harness: SyncHarness) -> None:
    call = sync_harness.unary_stream()(b"late_error")
    with pytest.raises(grpc.RpcError):
        list(call)
    assert call.code() is grpc.StatusCode.INTERNAL
    span = _one(sync_harness.rec, SpanKind.CLIENT, SERVER_STREAM)
    assert _attr(span, "rpc.response.status_code") == "INTERNAL"
    assert span.status.description == "late failure"
    assert _exception_events(span) == 0
    assert len(sync_harness.rec.metric_points("rpc.client.call.duration")) == 1


@pytest.mark.parametrize("method", [SERVER_STREAM, BIDI])
def test_sync_abandoned_stream_ends_span_cancelled(sync_harness: SyncHarness, method: str) -> None:
    if method == SERVER_STREAM:
        call = sync_harness.unary_stream()(b"block")
        assert next(call) == b"block-1"
    else:
        call = sync_harness.stream_stream()(_requests(b"ok", b"block"))
        assert next(call) == b"echo:ok"
    assert sync_harness.signals.started.wait(WAIT_S)
    del call
    gc.collect()
    span = _one(sync_harness.rec, SpanKind.CLIENT, method)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"


def test_sync_unary_future_ends_span_when_rpc_completes(sync_harness: SyncHarness) -> None:
    fut = sync_harness.unary().future(b"a")
    assert fut.result(WAIT_S) == b"echo:a"
    assert fut.code() is grpc.StatusCode.OK
    span = _one(sync_harness.rec, SpanKind.CLIENT, UNARY)
    assert _attr(span, "rpc.response.status_code") == "OK"


def test_sync_unary_future_cancel_records_cancelled(sync_harness: SyncHarness) -> None:
    fut = sync_harness.unary().future(b"block")
    assert sync_harness.signals.started.wait(WAIT_S)
    assert fut.cancel()
    span = _one(sync_harness.rec, SpanKind.CLIENT, UNARY)
    assert _attr(span, "rpc.response.status_code") == "CANCELLED"
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, UNARY)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"


def test_sync_bidi_cancel_records_cancelled(sync_harness: SyncHarness) -> None:
    call = sync_harness.stream_stream()(_requests(b"ok", b"block"))
    assert next(call) == b"echo:ok"
    assert sync_harness.signals.started.wait(WAIT_S)
    assert call.cancel()
    assert (
        _attr(_one(sync_harness.rec, SpanKind.CLIENT, BIDI), "rpc.response.status_code")
        == "CANCELLED"
    )
    sync_harness.drain()
    assert (
        _attr(_one(sync_harness.rec, SpanKind.SERVER, BIDI), "rpc.response.status_code")
        == "CANCELLED"
    )


def test_sync_client_stream_cancel_records_cancelled(sync_harness: SyncHarness) -> None:
    h = sync_harness
    call = h.stream_unary().future(_requests(b"block"))
    assert h.signals.started.wait(WAIT_S)
    assert call.cancel()
    h.drain()
    for kind in (SpanKind.CLIENT, SpanKind.SERVER):
        assert _attr(_one(h.rec, kind, CLIENT_STREAM), "rpc.response.status_code") == "CANCELLED"


@pytest.mark.parametrize("method", [CLIENT_STREAM, BIDI])
async def test_aio_client_stream_cancel_records_cancelled(
    aio_harness: AioHarness, method: str
) -> None:
    h = aio_harness
    call = (
        h.stream_unary()(_arequests(b"block"))
        if method == CLIENT_STREAM
        else h.stream_stream()(_arequests(b"block"))
    )
    await _wait(h.signals.started)
    assert call.cancel()
    await _wait(h.signals.finished)
    for kind in (SpanKind.CLIENT, SpanKind.SERVER):
        assert _attr(_one(h.rec, kind, method), "rpc.response.status_code") == "CANCELLED"


def test_sync_all_shapes_succeed_with_spans(sync_harness: SyncHarness) -> None:
    h = sync_harness
    assert h.unary()(b"a") == b"echo:a"
    assert list(h.unary_stream()(b"b")) == [b"b-1", b"b-2"]
    assert h.stream_unary()(_requests(b"c", b"d")) == b"c|d"
    assert list(h.stream_stream()(_requests(b"e"))) == [b"echo:e"]
    h.drain()
    for method in (UNARY, SERVER_STREAM, CLIENT_STREAM, BIDI):
        client = _one(h.rec, SpanKind.CLIENT, method)
        server = _one(h.rec, SpanKind.SERVER, method)
        assert _attr(client, "rpc.response.status_code") == "OK"
        assert _attr(server, "rpc.response.status_code") == "OK"
        assert server.parent is not None
        assert server.parent.span_id == _ctx(client).span_id


@pytest.mark.parametrize(
    ("shape", "method"),
    [("stream_unary", CLIENT_STREAM), ("stream_stream", BIDI)],
)
def test_sync_late_client_stream_error_is_recorded(
    sync_harness: SyncHarness, shape: str, method: str
) -> None:
    h = sync_harness
    with pytest.raises(grpc.RpcError):
        if shape == "stream_unary":
            h.stream_unary()(_requests(b"ok", b"late_error"))
        else:
            list(h.stream_stream()(_requests(b"ok", b"late_error")))
    client = _one(h.rec, SpanKind.CLIENT, method)
    assert _attr(client, "rpc.response.status_code") == "INTERNAL"
    h.drain()
    server = _one(h.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "INTERNAL"
    assert server.status.status_code is StatusCode.ERROR


# --------------------------------------------------------------------------
# Finding 4: aio server supports coroutine handlers that write.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("method", [SERVER_STREAM_WRITE, BIDI_WRITE])
async def test_aio_server_supports_write_style_streaming_handlers(
    aio_harness: AioHarness, method: str
) -> None:
    h = aio_harness
    if method == SERVER_STREAM_WRITE:
        got = [m async for m in h.unary_stream(method)(b"w")]
        assert got == [b"w-1", b"w-2"]
    else:
        got = [m async for m in h.stream_stream(method)(_arequests(b"w"))]
        assert got == [b"echo:w"]
    server = _one(h.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "OK"


async def test_aio_server_write_style_late_error_is_recorded(aio_harness: AioHarness) -> None:
    with pytest.raises(grpc.aio.AioRpcError):
        _ = [m async for m in aio_harness.unary_stream(SERVER_STREAM_WRITE)(b"late_error")]
    server = _one(aio_harness.rec, SpanKind.SERVER, SERVER_STREAM_WRITE)
    assert _attr(server, "rpc.response.status_code") == "INTERNAL"
    assert server.status.status_code is StatusCode.ERROR
    assert server.status.description == "late failure"


async def test_aio_server_all_shapes_succeed(aio_harness: AioHarness) -> None:
    h = aio_harness
    await h.unary()(b"a")
    _ = [m async for m in h.unary_stream()(b"b")]
    await h.stream_unary()(_arequests(b"c"))
    _ = [m async for m in h.stream_stream()(_arequests(b"d"))]
    for method in (UNARY, SERVER_STREAM, CLIENT_STREAM, BIDI):
        assert _attr(_one(h.rec, SpanKind.SERVER, method), "rpc.response.status_code") == "OK"


# --------------------------------------------------------------------------
# Finding 5: metric names and attributes match otelgrpc and libo11y-tonic.
# --------------------------------------------------------------------------


def test_sync_records_current_rpc_metric_names(sync_harness: SyncHarness) -> None:
    sync_harness.unary()(b"a")
    sync_harness.drain()
    names = sync_harness.rec.metric_names()
    assert "rpc.server.call.duration" in names
    assert "rpc.client.call.duration" in names
    assert "rpc.server.duration" not in names
    assert "rpc.client.duration" not in names
    assert sync_harness.rec.exemplars("rpc.server.call.duration")
    assert sync_harness.rec.exemplars("rpc.client.call.duration")


def test_sync_metric_attributes_match_go(sync_harness: SyncHarness) -> None:
    h = sync_harness
    h.unary()(b"a")
    with pytest.raises(grpc.RpcError):
        h.unary()(b"abort:NOT_FOUND")
    h.drain()
    server_points = {
        p["attributes"]["rpc.response.status_code"]: p["attributes"]
        for p in h.rec.metric_points("rpc.server.call.duration")
    }
    client_points = {
        p["attributes"]["rpc.response.status_code"]: p["attributes"]
        for p in h.rec.metric_points("rpc.client.call.duration")
    }
    base = {"rpc.system.name": "grpc", "rpc.method": "demo.Echo/Unary"}
    assert server_points["OK"] == {**base, "rpc.response.status_code": "OK"}
    # NOT_FOUND is a client fault: an error on the client, not on the server.
    assert server_points["NOT_FOUND"] == {**base, "rpc.response.status_code": "NOT_FOUND"}
    assert client_points["OK"] == {**base, "rpc.response.status_code": "OK"}
    assert client_points["NOT_FOUND"] == {
        **base,
        "rpc.response.status_code": "NOT_FOUND",
        "error.type": "NOT_FOUND",
    }


def test_span_name_and_attributes_keep_the_full_method(sync_harness: SyncHarness) -> None:
    sync_harness.unary()(b"a")
    sync_harness.drain()
    for kind in (SpanKind.SERVER, SpanKind.CLIENT):
        span = _one(sync_harness.rec, kind, UNARY)
        assert span.name == "demo.Echo/Unary"
        assert _attr(span, "rpc.method") == "demo.Echo/Unary"
        assert _attr(span, "rpc.system.name") == "grpc"


def test_client_server_address_attributes_are_recorded() -> None:
    with start_recorder(service_name="grpc-contract-addr") as rec:
        h = _start_sync(rec, client_kwargs={"server_address": "api.internal", "server_port": 8443})
        try:
            h.unary()(b"a")
        finally:
            h.drain()
        span = _one(rec, SpanKind.CLIENT, UNARY)
        assert _attr(span, "server.address") == "api.internal"
        assert _attr(span, "server.port") == 8443
        (point,) = rec.metric_points("rpc.client.call.duration")
        assert point["attributes"]["server.address"] == "api.internal"
        assert point["attributes"]["server.port"] == 8443


# --------------------------------------------------------------------------
# Findings 6 and 6b: one exception event, one status, Go's description.
# --------------------------------------------------------------------------


def test_sync_client_error_records_status_message_and_no_exception_event(
    sync_harness: SyncHarness,
) -> None:
    with pytest.raises(grpc.RpcError):
        sync_harness.unary()(b"abort:INTERNAL")
    span = _one(sync_harness.rec, SpanKind.CLIENT, UNARY)
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description == "detail for INTERNAL"
    assert _exception_events(span) == 0


async def test_aio_client_error_records_one_status_and_no_exception_event(
    aio_harness: AioHarness,
) -> None:
    with pytest.raises(grpc.aio.AioRpcError):
        await aio_harness.unary()(b"abort:INTERNAL")
    span = _one(aio_harness.rec, SpanKind.CLIENT, UNARY)
    assert span.status.status_code is StatusCode.ERROR
    assert span.status.description == "detail for INTERNAL"
    assert _exception_events(span) == 0


@pytest.mark.parametrize("method", [UNARY, SERVER_STREAM])
def test_sync_handler_exception_is_unknown_with_one_event_and_no_text(
    sync_harness: SyncHarness,
    method: str,
) -> None:
    with pytest.raises(grpc.RpcError) as err:
        if method == UNARY:
            sync_harness.unary()(b"raise")
        else:
            list(sync_harness.unary_stream()(b"late_raise"))
    assert err.value.code() is grpc.StatusCode.UNKNOWN
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "UNKNOWN"
    assert _attr(server, "error.type") == "UNKNOWN"
    assert server.status.status_code is StatusCode.ERROR
    assert server.status.description is None
    assert _exception_events(server) == 1
    assert _one(sync_harness.rec, SpanKind.CLIENT, method).status.description is None


@pytest.mark.parametrize("payload", [b"raise", b"late_raise"])
async def test_aio_handler_exception_is_unknown_with_one_event_and_no_text(
    aio_harness: AioHarness, payload: bytes
) -> None:
    h = aio_harness
    method = UNARY if payload == b"raise" else SERVER_STREAM
    with pytest.raises(grpc.aio.AioRpcError) as err:
        if method == UNARY:
            await h.unary()(payload)
        else:
            _ = [m async for m in h.unary_stream()(payload)]
    assert err.value.code() is grpc.StatusCode.UNKNOWN
    server = _one(h.rec, SpanKind.SERVER, method)
    assert _attr(server, "rpc.response.status_code") == "UNKNOWN"
    assert server.status.status_code is StatusCode.ERROR
    assert server.status.description is None
    assert SECRET_TEXT not in (server.status.description or "")
    assert _exception_events(server) == 1
    assert _one(h.rec, SpanKind.CLIENT, method).status.description is None


# --------------------------------------------------------------------------
# Finding 7: instruments are created once.
# --------------------------------------------------------------------------


class _CountingMeterProvider:
    """Wraps a MeterProvider and counts get_meter calls."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = 0

    def get_meter(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        return self.inner.get_meter(*args, **kwargs)


class _CountingTracerProvider:
    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls = 0

    def get_tracer(self, *args: Any, **kwargs: Any) -> Any:
        self.calls += 1
        return self.inner.get_tracer(*args, **kwargs)


class _TelemetryView:
    """Duck-typed Telemetry exposing counting providers."""

    def __init__(self, rec: Recorder) -> None:
        self.tracer_provider = _CountingTracerProvider(rec.telemetry.tracer_provider)
        self.meter_provider = _CountingMeterProvider(rec.telemetry.meter_provider)
        self.propagator = rec.telemetry.propagator


def test_instruments_are_created_once_per_interceptor() -> None:
    with start_recorder(service_name="grpc-contract-once") as rec:
        view = _TelemetryView(rec)
        telemetry = cast(Any, view)
        signals = _Signals()
        pool = futures.ThreadPoolExecutor(max_workers=2)
        server = grpc.server(pool, interceptors=[o11y_grpc.server_interceptor(telemetry=telemetry)])
        server.add_generic_rpc_handlers([_SyncService(signals)])
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        raw = grpc.insecure_channel(f"127.0.0.1:{port}")
        try:
            chan = grpc.intercept_channel(raw, o11y_grpc.client_interceptor(telemetry=telemetry))
            unary: grpc.UnaryUnaryMultiCallable[bytes, bytes] = chan.unary_unary(UNARY)
            setup_tracers = view.tracer_provider.calls
            setup_meters = view.meter_provider.calls
            for _ in range(3):
                unary(b"a")
            assert view.tracer_provider.calls == setup_tracers
            assert view.meter_provider.calls == setup_meters
        finally:
            raw.close()
            server.stop(grace=WAIT_S).wait(WAIT_S)
            pool.shutdown(wait=True)


def test_global_provider_change_after_construction_is_honoured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    interceptor = o11y_grpc.client_interceptor()
    with start_recorder(service_name="grpc-contract-global") as rec:
        signals = _Signals()
        pool = futures.ThreadPoolExecutor(max_workers=2)
        server = grpc.server(pool)
        server.add_generic_rpc_handlers([_SyncService(signals)])
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        raw = grpc.insecure_channel(f"127.0.0.1:{port}")
        try:
            chan = grpc.intercept_channel(raw, interceptor)
            unary: grpc.UnaryUnaryMultiCallable[bytes, bytes] = chan.unary_unary(UNARY)
            unary(b"before")
            # The API allows one set_tracer_provider per process, so the test
            # swaps the module-level provider and monkeypatch restores it.
            monkeypatch.setattr(trace, "_TRACER_PROVIDER", rec.telemetry.tracer_provider)
            unary(b"after")
        finally:
            raw.close()
            server.stop(grace=WAIT_S).wait(WAIT_S)
            pool.shutdown(wait=True)
        assert len(_spans(rec, SpanKind.CLIENT, UNARY)) == 1


# --------------------------------------------------------------------------
# Finding 8: status mapping per role.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("code", NON_OK_CODES, ids=lambda c: c.name)
def test_sync_abort_status_maps_exactly_per_role(
    sync_harness: SyncHarness, code: grpc.StatusCode
) -> None:
    with pytest.raises(grpc.RpcError) as err:
        sync_harness.unary()(f"abort:{code.name}".encode())
    assert err.value.code() is code
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, UNARY)
    client = _one(sync_harness.rec, SpanKind.CLIENT, UNARY)
    assert _attr(server, "rpc.response.status_code") == code.name
    assert _attr(client, "rpc.response.status_code") == code.name
    assert client.status.status_code is StatusCode.ERROR
    assert _attr(client, "error.type") == code.name
    if code in SERVER_FAULT_CODES:
        assert server.status.status_code is StatusCode.ERROR
        assert server.status.description == f"detail for {code.name}"
        assert _attr(server, "error.type") == code.name
    else:
        assert server.status.status_code is StatusCode.UNSET
        assert _attr(server, "error.type") is None
    assert _exception_events(server) == 0


@pytest.mark.parametrize(
    "code",
    [grpc.StatusCode.NOT_FOUND, grpc.StatusCode.INTERNAL, grpc.StatusCode.PERMISSION_DENIED],
    ids=lambda c: c.name,
)
async def test_aio_abort_status_maps_exactly_per_role(
    aio_harness: AioHarness, code: grpc.StatusCode
) -> None:
    with pytest.raises(grpc.aio.AioRpcError):
        await aio_harness.unary()(f"abort:{code.name}".encode())
    server = _one(aio_harness.rec, SpanKind.SERVER, UNARY)
    assert _attr(server, "rpc.response.status_code") == code.name
    expected = StatusCode.ERROR if code in SERVER_FAULT_CODES else StatusCode.UNSET
    assert server.status.status_code is expected
    assert _exception_events(server) == 0


def test_sync_abort_with_status_maps_exactly() -> None:
    def handler(_req: bytes, ctx: grpc.ServicerContext) -> bytes:
        ctx.abort_with_status(_Status(grpc.StatusCode.UNAVAILABLE, "try later", ()))

    with start_recorder(service_name="grpc-contract-abort-status") as rec:
        pool = futures.ThreadPoolExecutor(max_workers=2)
        server = grpc.server(
            pool, interceptors=[o11y_grpc.server_interceptor(telemetry=rec.telemetry)]
        )
        server.add_generic_rpc_handlers(
            [
                grpc.method_handlers_generic_handler(
                    SERVICE, {"Unary": grpc.unary_unary_rpc_method_handler(handler)}
                )
            ]
        )
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        raw = grpc.insecure_channel(f"127.0.0.1:{port}")
        try:
            with pytest.raises(grpc.RpcError) as err:
                raw.unary_unary(UNARY)(b"x")
            assert err.value.code() is grpc.StatusCode.UNAVAILABLE
        finally:
            raw.close()
            server.stop(grace=WAIT_S).wait(WAIT_S)
            pool.shutdown(wait=True)
        span = _one(rec, SpanKind.SERVER, UNARY)
        assert _attr(span, "rpc.response.status_code") == "UNAVAILABLE"
        assert span.status.status_code is StatusCode.ERROR
        assert span.status.description == "try later"


@dataclass(frozen=True)
class _Status(grpc.Status):
    code: grpc.StatusCode
    details: str
    trailing_metadata: tuple[tuple[str, str | bytes], ...]


def test_sync_set_code_without_raising_is_recorded(sync_harness: SyncHarness) -> None:
    with pytest.raises(grpc.RpcError):
        sync_harness.unary()(b"set_code")
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, UNARY)
    assert _attr(server, "rpc.response.status_code") == "NOT_FOUND"
    assert server.status.status_code is StatusCode.UNSET


async def test_aio_set_code_without_raising_is_recorded(aio_harness: AioHarness) -> None:
    with pytest.raises(grpc.aio.AioRpcError):
        await aio_harness.unary()(b"set_code")
    server = _one(aio_harness.rec, SpanKind.SERVER, UNARY)
    assert _attr(server, "rpc.response.status_code") == "NOT_FOUND"


def test_sync_server_stream_cancel_is_cancelled_on_server(sync_harness: SyncHarness) -> None:
    call = sync_harness.unary_stream()(b"block")
    assert next(call) == b"block-1"
    assert sync_harness.signals.started.wait(WAIT_S)
    call.cancel()
    sync_harness.drain()
    server = _one(sync_harness.rec, SpanKind.SERVER, SERVER_STREAM)
    assert _attr(server, "rpc.response.status_code") == "CANCELLED"
    assert server.status.status_code is StatusCode.UNSET


# --------------------------------------------------------------------------
# Health checks, filters, and propagation without spans.
# --------------------------------------------------------------------------


def test_ignored_health_checks_have_no_spans_or_metrics() -> None:
    with start_recorder(service_name="grpc-contract-health") as rec:
        h = _start_sync(
            rec,
            server_kwargs={"ignore_health_checks": True},
            client_kwargs={"ignore_health_checks": True},
        )
        try:
            assert h.unary(HEALTH)(b"") == b"SERVING"
        finally:
            h.drain()
        assert rec.spans() == []
        assert rec.metric_points("rpc.server.call.duration") == []
        assert rec.metric_points("rpc.client.call.duration") == []


async def test_aio_public_endpoint_links_instead_of_parenting() -> None:
    with start_recorder(service_name="grpc-contract-public") as rec:
        h = await _start_aio(rec, server_kwargs={"public_endpoint": True})
        try:
            await h.unary()(b"a")
        finally:
            await h.channel.close()
            await h.server.stop(grace=None)
        server = _one(rec, SpanKind.SERVER, UNARY)
        client = _one(rec, SpanKind.CLIENT, UNARY)
        assert server.parent is None
        assert len(server.links) == 1
        assert server.links[0].context.span_id == _ctx(client).span_id
