"""Connect RPC contract tests through real Connect clients and applications."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager
from contextvars import Context
from typing import Literal, cast
from unittest.mock import patch

import httpx
import pytest
from connectrpc.client import ConnectClient, ConnectClientSync
from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.method import IdempotencyLevel, MethodInfo, StreamType
from connectrpc.protocol import ProtocolType
from connectrpc.request import RequestContext
from connectrpc.server import ConnectASGIApplication, ConnectWSGIApplication, Endpoint, EndpointSync
from opentelemetry import metrics, trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.trace import SpanKind, StatusCode
from protobuf.wkt import StringValue
from pyqwest import Client, Headers, Request, Response, SyncClient, SyncRequest, SyncResponse

import libo11y
from libo11y import connect as instrument
from libo11y.spec import EVENT_NAME_KEY, EVENT_REQUEST_SUMMARY
from libo11y.testing import Recorder, start_recorder

type Mode = Literal["asgi", "wsgi"]
type RPCContext = RequestContext[StringValue, StringValue]


def _method(service: str, name: str, shape: StreamType) -> MethodInfo[StringValue, StringValue]:
    return MethodInfo(
        name=name,
        service_name=service,
        input=StringValue,
        output=StringValue,
        idempotency_level=IdempotencyLevel.UNKNOWN,
        stream_type=shape,
    )


UNARY = _method("demo.Echo", "Unary", StreamType.UNARY)
STREAM = _method("demo.Echo", "Stream", StreamType.SERVER_STREAM)
HEALTH = _method("grpc.health.v1.Health", "Check", StreamType.UNARY)
SECRET = "private handler exception text"
ADDRESS = "http://connect.test:8080"


def _path(method: MethodInfo[StringValue, StringValue]) -> str:
    return f"/{method.service_name}/{method.name}"


class _ASGITransport:
    def __init__(self, http: httpx.AsyncClient) -> None:
        self.http = http

    async def execute(self, request: Request) -> Response:
        # Use a fresh context at the HTTP boundary, just as a remote server would.
        response = await asyncio.create_task(
            self.http.request(
                request.method,
                request.url,
                headers=list(request.headers.items()),
                content=request.content,
            ),
            context=Context(),
        )
        return Response(
            status=response.status_code,
            headers=Headers(response.headers.multi_items()),
            content=response.content,
        )


class _WSGITransport:
    def __init__(self, http: httpx.Client) -> None:
        self.http = http

    def execute_sync(self, request: SyncRequest) -> SyncResponse:
        content = request.content
        response = Context().run(
            self.http.request,
            request.method,
            request.url,
            headers=list(request.headers.items()),
            content=content if isinstance(content, bytes) else b"".join(content),
        )
        return SyncResponse(
            status=response.status_code,
            headers=Headers(response.headers.multi_items()),
            content=response.content,
        )


def _unary(request: StringValue, _ctx: RPCContext) -> StringValue:
    if record := libo11y.current_record():
        record.set("demo.value", "seen")
    if request.value == "raise":
        raise RuntimeError(SECRET)
    if request.value == "missing":
        raise ConnectError(Code.NOT_FOUND, "missing item")
    return request


def _stream(request: StringValue, _ctx: RPCContext) -> Iterator[StringValue]:
    yield StringValue(value="first")
    if request.value == "fail":
        raise ConnectError(Code.INTERNAL, "late stream failure")
    yield StringValue(value="second")


class _ASGIApp(ConnectASGIApplication[object]):
    @property
    def path(self) -> str:
        return "/"


class _WSGIApp(ConnectWSGIApplication):
    @property
    def path(self) -> str:
        return "/"


async def _async_unary(request: StringValue, ctx: RPCContext) -> StringValue:
    return _unary(request, ctx)


async def _async_stream(request: StringValue, ctx: RPCContext) -> AsyncIterator[StringValue]:
    for response in _stream(request, ctx):
        yield response


@asynccontextmanager
async def _client(
    mode: Mode,
    rec: Recorder,
    *,
    protocol: ProtocolType = ProtocolType.CONNECT,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    use_global_client: bool = False,
) -> AsyncGenerator[ConnectClient | ConnectClientSync]:
    client_telemetry = None if use_global_client else rec.telemetry
    if mode == "asgi":
        app = _ASGIApp(
            service=object(),
            endpoints=lambda _: {
                _path(UNARY): Endpoint.unary(UNARY, _async_unary),
                _path(HEALTH): Endpoint.unary(HEALTH, _async_unary),
                _path(STREAM): Endpoint.server_stream(STREAM, _async_stream),
            },
            interceptors=[
                instrument.server_interceptor(
                    telemetry=rec.telemetry,
                    public_endpoint=public_endpoint,
                    ignore_health_checks=ignore_health_checks,
                    canonical_line=True,
                )
            ],
        )
        # HTTPX types the ASGI boundary as generic dicts. Connect uses ASGI TypedDicts.
        asgi_app = cast("Callable[[object, object, object], Awaitable[None]]", app)
        async with (
            httpx.AsyncClient(transport=httpx.ASGITransport(app=asgi_app)) as http,
            ConnectClient(
                ADDRESS,
                protocol=protocol,
                http_client=Client(transport=_ASGITransport(http)),
                interceptors=[
                    instrument.client_interceptor(
                        telemetry=client_telemetry, ignore_health_checks=ignore_health_checks
                    )
                ],
            ) as client,
        ):
            yield client
    else:
        app = _WSGIApp(
            endpoints={
                _path(UNARY): EndpointSync.unary(method=UNARY, function=_unary),
                _path(HEALTH): EndpointSync.unary(method=HEALTH, function=_unary),
                _path(STREAM): EndpointSync.server_stream(method=STREAM, function=_stream),
            },
            interceptors=[
                instrument.sync_server_interceptor(
                    telemetry=rec.telemetry,
                    public_endpoint=public_endpoint,
                    ignore_health_checks=ignore_health_checks,
                    canonical_line=True,
                )
            ],
        )
        with (
            httpx.Client(transport=httpx.WSGITransport(app=app)) as http,
            ConnectClientSync(
                ADDRESS,
                protocol=protocol,
                http_client=SyncClient(transport=_WSGITransport(http)),
                interceptors=[
                    instrument.sync_client_interceptor(
                        telemetry=client_telemetry, ignore_health_checks=ignore_health_checks
                    )
                ],
            ) as client,
        ):
            yield client


def _span(
    rec: Recorder, kind: SpanKind, method: MethodInfo[StringValue, StringValue]
) -> ReadableSpan:
    (span,) = [s for s in rec.spans() if s.kind is kind and s.name == _path(method)[1:]]
    return span


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_streaming_rpc_status_message_is_kept_after_first_response(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        request = StringValue(value="fail")
        async with _client(mode, rec) as client:
            if isinstance(client, ConnectClient):
                responses = client.execute_server_stream(request=request, method=STREAM)
                assert (await anext(responses)).value == "first"
                with pytest.raises(ConnectError) as error:
                    await anext(responses)
            else:
                responses_sync = client.execute_server_stream(request=request, method=STREAM)
                assert next(responses_sync).value == "first"
                with pytest.raises(ConnectError) as error:
                    next(responses_sync)
        assert error.value.code is Code.INTERNAL
        for kind in (SpanKind.SERVER, SpanKind.CLIENT):
            span = _span(rec, kind, STREAM)
            assert span.status.status_code is StatusCode.ERROR
            assert span.status.description == "late stream failure"
            assert len(span.events) == 0


async def _call_unary(
    client: ConnectClient | ConnectClientSync,
    value: str,
    method: MethodInfo[StringValue, StringValue] = UNARY,
) -> str:
    request = StringValue(value=value)
    if isinstance(client, ConnectClient):
        return (await client.execute_unary(request=request, method=method)).value
    return client.execute_unary(request=request, method=method).value


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_unhandled_handler_exception_has_one_event_and_safe_status(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec) as client:
            with pytest.raises(ConnectError) as error:
                await _call_unary(client, "raise")

        assert error.value.code is Code.UNKNOWN
        server = _span(rec, SpanKind.SERVER, UNARY)
        assert server.status.status_code is StatusCode.ERROR
        assert server.status.description == "panic"
        assert [event.name for event in server.events] == ["exception"]
        client_span = _span(rec, SpanKind.CLIENT, UNARY)
        assert client_span.status.status_code is StatusCode.ERROR
        assert client_span.status.description is None
        assert not client_span.events


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
@pytest.mark.parametrize(
    ("protocol", "system"), [(ProtocolType.CONNECT, "connectrpc"), (ProtocolType.GRPC_WEB, "grpc")]
)
async def test_unary_span_and_duration_report_wire_protocol(
    mode: Mode,
    protocol: ProtocolType,
    system: str,
) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec, protocol=protocol) as client:
            assert await _call_unary(client, "hello") == "hello"

        for kind in (SpanKind.SERVER, SpanKind.CLIENT):
            expected: dict[str, str | int] = {
                "rpc.system.name": system,
                "rpc.method": "demo.Echo/Unary",
                "rpc.response.status_code": "OK",
            }
            if kind is SpanKind.CLIENT:
                expected.update({"server.address": "connect.test", "server.port": 8080})
            assert _span(rec, kind, UNARY).attributes == expected
            (point,) = rec.metric_points(f"rpc.{kind.name.lower()}.call.duration")
            assert point["attributes"] == expected


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_stream_completes_both_spans_and_records_one_duration_per_role(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec) as client:
            request = StringValue(value="success")
            if isinstance(client, ConnectClient):
                responses = client.execute_server_stream(request=request, method=STREAM)
                assert (await anext(responses)).value == "first"
                assert not any(s.kind is SpanKind.CLIENT for s in rec.spans())
                assert [r.value async for r in responses] == ["second"]
            else:
                responses_sync = client.execute_server_stream(request=request, method=STREAM)
                assert next(responses_sync).value == "first"
                assert not any(s.kind is SpanKind.CLIENT for s in rec.spans())
                assert [r.value for r in responses_sync] == ["second"]
        for kind in (SpanKind.CLIENT, SpanKind.SERVER):
            assert _span(rec, kind, STREAM).status.status_code is StatusCode.UNSET
            (point,) = rec.metric_points(f"rpc.{kind.name.lower()}.call.duration")
            assert point["count"] == 1


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_ignored_health_call_emits_no_telemetry(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec, ignore_health_checks=True) as client:
            assert await _call_unary(client, "serving", HEALTH) == "serving"
        assert not rec.spans()
        assert not rec.metric_points("rpc.server.call.duration")
        assert not rec.metric_points("rpc.client.call.duration")
        assert not rec.otel_logs()


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
@pytest.mark.parametrize("public_endpoint", [False, True])
async def test_remote_context_is_parent_or_link_according_to_public_endpoint(
    mode: Mode, public_endpoint: bool
) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec, public_endpoint=public_endpoint) as client:
            assert await _call_unary(client, "hello") == "hello"
        server = _span(rec, SpanKind.SERVER, UNARY)
        client_context = _span(rec, SpanKind.CLIENT, UNARY).context
        assert client_context is not None
        if public_endpoint:
            assert server.parent is None
            (link,) = server.links
            assert link.context.trace_id == client_context.trace_id
            assert link.context.span_id == client_context.span_id
        else:
            assert server.parent is not None
            assert server.parent.span_id == client_context.span_id
            assert not server.links


@pytest.mark.parametrize(
    "factory", [instrument.server_interceptor, instrument.sync_server_interceptor]
)
def test_canonical_line_requires_telemetry(factory: object) -> None:
    assert callable(factory)
    with pytest.raises(ValueError, match="canonical_line requires telemetry"):
        factory(canonical_line=True)


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_canonical_line_matches_go_for_unary_client_fault(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        async with _client(mode, rec) as client:
            with pytest.raises(ConnectError, match="missing item") as error:
                await _call_unary(client, "missing")
        assert error.value.code is Code.NOT_FOUND
        server = _span(rec, SpanKind.SERVER, UNARY)
        assert server.status.status_code is StatusCode.UNSET
        assert server.status.description is None
        assert server.attributes is not None
        assert server.attributes["error.type"] == "NOT_FOUND"
        (point,) = rec.metric_points("rpc.server.call.duration")
        assert point["attributes"]["error.type"] == "NOT_FOUND"
        (summary,) = [
            log.log_record
            for log in rec.otel_logs()
            if (log.log_record.attributes or {}).get(EVENT_NAME_KEY) == EVENT_REQUEST_SUMMARY
        ]
        assert server.context is not None
        assert summary.span_id == server.context.span_id
        attrs = dict(summary.attributes or {})
        assert attrs["http.request.method"] == "POST"
        assert attrs["http.response.status_code"] == 404
        assert attrs["o11y.outcome"] == "success"
        assert attrs["rpc.system.name"] == "connectrpc"
        assert attrs["rpc.method"] == "demo.Echo/Unary"
        assert attrs["rpc.response.status_code"] == "NOT_FOUND"
        assert attrs["demo.value"] == "seen"
        assert isinstance(attrs["o11y.duration"], float)


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_instruments_are_created_once_for_explicit_telemetry(mode: Mode) -> None:
    with start_recorder(service_name="connect-contract") as rec:
        tp, mp = rec.telemetry.tracer_provider, rec.telemetry.meter_provider
        with (
            patch.object(tp, "get_tracer", wraps=tp.get_tracer) as get_tracer,
            patch.object(mp, "get_meter", wraps=mp.get_meter) as get_meter,
        ):
            async with _client(mode, rec) as client:
                assert get_tracer.call_count == get_meter.call_count == 2
                for _ in range(3):
                    assert await _call_unary(client, "hello") == "hello"
                assert get_tracer.call_count == get_meter.call_count == 2


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_global_instruments_are_reused_and_follow_provider_changes(
    mode: Mode,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with (
        start_recorder(service_name="connect-server") as server,
        start_recorder(service_name="connect-global-first") as first,
        start_recorder(service_name="connect-global-second") as second,
    ):
        tracer_provider = first.telemetry.tracer_provider
        meter_provider = first.telemetry.meter_provider
        monkeypatch.setattr(trace, "get_tracer_provider", lambda: tracer_provider)
        monkeypatch.setattr(metrics, "get_meter_provider", lambda: meter_provider)

        with (
            patch.object(
                tracer_provider, "get_tracer", wraps=tracer_provider.get_tracer
            ) as get_tracer,
            patch.object(meter_provider, "get_meter", wraps=meter_provider.get_meter) as get_meter,
        ):
            async with _client(mode, server, use_global_client=True) as client:
                for _ in range(2):
                    assert await _call_unary(client, "first") == "first"
                assert get_tracer.call_count == get_meter.call_count == 1
                tracer_provider = second.telemetry.tracer_provider
                meter_provider = second.telemetry.meter_provider
                assert await _call_unary(client, "second") == "second"

        assert len([s for s in first.spans() if s.kind is SpanKind.CLIENT]) == 2
        _span(second, SpanKind.CLIENT, UNARY)


class _BrokenTransport:
    async def execute(self, request: Request) -> Response:
        raise RuntimeError(SECRET)

    def execute_sync(self, request: SyncRequest) -> SyncResponse:
        raise RuntimeError(SECRET)


@pytest.mark.parametrize("mode", ["asgi", "wsgi"])
async def test_client_transport_exception_has_one_event_and_safe_status(mode: Mode) -> None:
    transport = _BrokenTransport()
    with start_recorder(service_name="connect-contract") as rec:
        with pytest.raises(ConnectError) as error:
            if mode == "asgi":
                async with ConnectClient(
                    ADDRESS,
                    http_client=Client(transport=transport),
                    interceptors=[instrument.client_interceptor(telemetry=rec.telemetry)],
                ) as client:
                    await _call_unary(client, "hello")
            else:
                with ConnectClientSync(
                    ADDRESS,
                    http_client=SyncClient(transport=transport),
                    interceptors=[instrument.sync_client_interceptor(telemetry=rec.telemetry)],
                ) as client_sync:
                    await _call_unary(client_sync, "hello")
        assert error.value.code is Code.UNAVAILABLE
        span = _span(rec, SpanKind.CLIENT, UNARY)
        assert span.status.status_code is StatusCode.ERROR
        assert span.status.description is None
        assert [event.name for event in span.events] == ["exception"]
