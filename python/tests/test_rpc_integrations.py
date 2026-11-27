"""Tests for P6 RPC integrations: libo11y.grpc (sync + aio) and libo11y.connect."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent import futures
from typing import Any, cast

import grpc
import grpc.aio
import pytest
from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.method import IdempotencyLevel, MethodInfo, StreamType
from connectrpc.request import Headers, RequestContext
from google.protobuf.wrappers_pb2 import StringValue
from opentelemetry import baggage, context
from opentelemetry.trace import SpanKind, StatusCode

import libo11y
from libo11y import connect as o11y_connect
from libo11y import grpc as o11y_grpc
from libo11y.spec import EVENT_NAME_KEY, EVENT_REQUEST_SUMMARY, Outcome
from libo11y.testing import start_recorder


def _make_generic_sync_handler() -> grpc.GenericRpcHandler:
    def echo(req: bytes, ctx: grpc.ServicerContext) -> bytes:
        text = req.decode("utf-8")
        if text == "not_found":
            ctx.abort(grpc.StatusCode.NOT_FOUND, "missing")
        if text == "internal":
            ctx.abort(grpc.StatusCode.INTERNAL, "boom")
        tenant = baggage.get_baggage("tenant") or ""
        return f"{text}|{tenant}".encode()

    def echo_stream(req: bytes, _ctx: grpc.ServicerContext) -> Iterator[bytes]:
        yield req + b"-1"
        yield req + b"-2"

    def health(_req: bytes, _ctx: grpc.ServicerContext) -> bytes:
        return b"SERVING"

    handlers: dict[str, grpc.RpcMethodHandler[Any, Any]] = {
        "/demo.Echo/Say": grpc.unary_unary_rpc_method_handler(echo),
        "/demo.Echo/Stream": grpc.unary_stream_rpc_method_handler(echo_stream),
        "/grpc.health.v1.Health/Check": grpc.unary_unary_rpc_method_handler(health),
    }

    class _Generic(grpc.GenericRpcHandler):
        def service(
            self, handler_call_details: grpc.HandlerCallDetails
        ) -> grpc.RpcMethodHandler[Any, Any] | None:
            return handlers.get(handler_call_details.method)

    return _Generic()


def test_grpc_sync_unary_stream_errors_health_and_propagation() -> None:
    with start_recorder(service_name="grpc-sync-test") as rec:
        srv_ic = o11y_grpc.server_interceptor(
            telemetry=rec.telemetry,
            ignore_health_checks=True,
        )
        cli_ic = o11y_grpc.client_interceptor(
            telemetry=rec.telemetry,
            ignore_health_checks=True,
        )

        server = grpc.server(
            futures.ThreadPoolExecutor(max_workers=4),
            interceptors=[srv_ic],
        )
        server.add_generic_rpc_handlers([_make_generic_sync_handler()])
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        try:
            raw_chan = grpc.insecure_channel(f"127.0.0.1:{port}")
            chan = grpc.intercept_channel(raw_chan, cli_ic)
            try:
                chan_any = cast(Any, chan)
                say: Any = chan_any.unary_unary("/demo.Echo/Say")
                stream_say: Any = chan_any.unary_stream("/demo.Echo/Stream")
                health_check: Any = chan_any.unary_unary("/grpc.health.v1.Health/Check")

                # Propagate baggage + trace context
                tok = context.attach(baggage.set_baggage("tenant", "acme"))
                try:
                    resp = say(b"hello")
                    assert resp == b"hello|acme"

                    chunks = list(stream_say(b"hi"))
                    assert chunks == [b"hi-1", b"hi-2"]

                    # Health check ignored by both interceptors
                    assert health_check(b"") == b"SERVING"

                    # Client error (NOT_FOUND): client span ERROR, server span UNSET
                    with pytest.raises(grpc.RpcError) as nf_err:
                        say(b"not_found")
                    assert nf_err.value.code() == grpc.StatusCode.NOT_FOUND

                    # Server fault (INTERNAL): both client and server spans ERROR
                    with pytest.raises(grpc.RpcError) as int_err:
                        say(b"internal")
                    assert int_err.value.code() == grpc.StatusCode.INTERNAL
                finally:
                    context.detach(tok)
            finally:
                raw_chan.close()
        finally:
            server.stop(grace=1.0).wait()

        rec.assert_conforms()
        spans = rec.spans()
        assert not any("Health" in s.name for s in spans)

        srv_say = [s for s in spans if s.kind == SpanKind.SERVER and s.name == "demo.Echo/Say"]
        cli_say = [s for s in spans if s.kind == SpanKind.CLIENT and s.name == "demo.Echo/Say"]
        assert len(srv_say) == 3
        assert len(cli_say) == 3

        ok_srv = next(
            s for s in srv_say if (s.attributes or {}).get("rpc.response.status_code") == "OK"
        )
        ok_cli = next(
            s for s in cli_say if (s.attributes or {}).get("rpc.response.status_code") == "OK"
        )
        ok_srv_sc = ok_srv.get_span_context()
        ok_cli_sc = ok_cli.get_span_context()
        assert ok_srv_sc is not None and ok_cli_sc is not None
        assert ok_srv_sc.trace_id == ok_cli_sc.trace_id
        assert (ok_srv.attributes or {}).get("rpc.system.name") == "grpc"

        nf_srv = next(
            s
            for s in srv_say
            if (s.attributes or {}).get("rpc.response.status_code") == "NOT_FOUND"
        )
        nf_cli = next(
            s
            for s in cli_say
            if (s.attributes or {}).get("rpc.response.status_code") == "NOT_FOUND"
        )
        assert nf_srv.status.status_code != StatusCode.ERROR
        assert nf_cli.status.status_code == StatusCode.ERROR

        int_srv = next(
            s for s in srv_say if (s.attributes or {}).get("rpc.response.status_code") == "INTERNAL"
        )
        assert int_srv.status.status_code == StatusCode.ERROR

        assert len(rec.metric_points("rpc.server.duration")) >= 1
        assert len(rec.metric_points("rpc.client.duration")) >= 1
        assert len(rec.exemplars("rpc.server.duration")) >= 1
        assert len(rec.exemplars("rpc.client.duration")) >= 1


@pytest.mark.asyncio
async def test_grpc_aio_public_endpoint_links_remote_span() -> None:
    async def aio_echo(req: bytes, _ctx: grpc.aio.ServicerContext[Any, Any]) -> bytes:
        tenant = baggage.get_baggage("tenant") or ""
        return f"aio:{req.decode()}|{tenant}".encode()

    class _AioGeneric(grpc.GenericRpcHandler):
        def service(
            self, handler_call_details: grpc.HandlerCallDetails
        ) -> grpc.RpcMethodHandler[Any, Any] | None:
            if handler_call_details.method == "/demo.Echo/AioSay":
                h: grpc.RpcMethodHandler[Any, Any] = grpc.unary_unary_rpc_method_handler(aio_echo)
                return h
            return None

    with start_recorder(service_name="grpc-aio-test") as rec:
        srv = grpc.aio.server(
            interceptors=[
                o11y_grpc.aio_server_interceptor(
                    telemetry=rec.telemetry,
                    public_endpoint=True,
                )
            ]
        )
        srv.add_generic_rpc_handlers([_AioGeneric()])
        port = srv.add_insecure_port("127.0.0.1:0")
        await srv.start()
        try:
            async with grpc.aio.insecure_channel(
                f"127.0.0.1:{port}",
                interceptors=[o11y_grpc.aio_client_interceptor(telemetry=rec.telemetry)],
            ) as chan:
                call: Any = cast(Any, chan).unary_unary("/demo.Echo/AioSay")
                tok = context.attach(baggage.set_baggage("tenant", "beta"))
                try:
                    resp = await call(b"ping")
                finally:
                    context.detach(tok)
                assert resp == b"aio:ping|beta"
        finally:
            await srv.stop(grace=1.0)

        rec.assert_conforms()
        srv_sp = next(s for s in rec.spans() if s.kind == SpanKind.SERVER)
        cli_sp = next(s for s in rec.spans() if s.kind == SpanKind.CLIENT)
        srv_sc = srv_sp.get_span_context()
        cli_sc = cli_sp.get_span_context()
        assert srv_sc is not None and cli_sc is not None
        assert srv_sp.parent is None
        assert srv_sc.trace_id != cli_sc.trace_id
        assert len(srv_sp.links) == 1
        assert srv_sp.links[0].context.span_id == cli_sc.span_id


@pytest.mark.asyncio
async def test_connect_async_and_sync_interceptors_with_canonical_line() -> None:
    with pytest.raises(ValueError, match="canonical_line requires telemetry"):
        o11y_connect.server_interceptor(canonical_line=True)

    method_info = MethodInfo(
        name="Greet",
        service_name="demo.v1.GreetService",
        input=StringValue,
        output=StringValue,
        idempotency_level=IdempotencyLevel.NO_SIDE_EFFECTS,
        stream_type=StreamType.UNARY,
    )
    health_info = MethodInfo(
        name="Check",
        service_name="grpc.health.v1.Health",
        input=StringValue,
        output=StringValue,
        idempotency_level=IdempotencyLevel.NO_SIDE_EFFECTS,
        stream_type=StreamType.UNARY,
    )

    with start_recorder(service_name="connect-test") as rec:
        cli_ic = o11y_connect.client_interceptor(telemetry=rec.telemetry, ignore_health_checks=True)
        srv_ic = o11y_connect.server_interceptor(
            telemetry=rec.telemetry,
            ignore_health_checks=True,
            canonical_line=True,
        )

        # 1. End-to-end async client -> server call with propagation + canonical line
        headers = Headers({"content-type": "application/json"})
        cli_ctx = RequestContext(method=method_info, http_method="POST", request_headers=headers)
        cli_tok = await cli_ic.on_start(cli_ctx)
        assert "traceparent" in cli_ctx.request_headers

        srv_ctx = RequestContext(
            method=method_info,
            http_method="POST",
            request_headers=Headers(dict(cli_ctx.request_headers.items())),
        )
        srv_tok = await srv_ic.on_start(srv_ctx)
        cur = libo11y.current_record()
        assert cur is not None
        cur.set("greet.target", "world")
        await srv_ic.on_end(srv_tok, srv_ctx, None)
        await cli_ic.on_end(cli_tok, cli_ctx, None)

        # 2. ConnectError(NOT_FOUND) -> 404, outcome=success, server span not ERROR
        nf_ctx = RequestContext(
            method=method_info,
            http_method="POST",
            request_headers=Headers({"content-type": "application/json"}),
        )
        nf_tok = await srv_ic.on_start(nf_ctx)
        await srv_ic.on_end(nf_tok, nf_ctx, ConnectError(Code.NOT_FOUND, "missing"))

        # 3. ConnectError(INTERNAL) -> 500, outcome=failure, server span ERROR
        int_ctx = RequestContext(
            method=method_info,
            http_method="POST",
            request_headers=Headers({"content-type": "application/json"}),
        )
        int_tok = await srv_ic.on_start(int_ctx)
        await srv_ic.on_end(int_tok, int_ctx, ConnectError(Code.INTERNAL, "boom"))

        # 4. Health check ignored (no spans, no canonical line)
        h_ctx = RequestContext(
            method=health_info,
            http_method="POST",
            request_headers=Headers({"content-type": "application/json"}),
        )
        h_tok = await srv_ic.on_start(h_ctx)
        await srv_ic.on_end(h_tok, h_ctx, None)

        # 5. Sync interceptors work identically
        s_cli = o11y_connect.sync_client_interceptor(telemetry=rec.telemetry)
        s_srv = o11y_connect.sync_server_interceptor(telemetry=rec.telemetry, canonical_line=True)
        s_hdrs = Headers({"content-type": "application/grpc"})
        s_cli_ctx = RequestContext(method=method_info, http_method="POST", request_headers=s_hdrs)
        s_cli_tok = s_cli.on_start_sync(s_cli_ctx)
        s_srv_ctx = RequestContext(
            method=method_info,
            http_method="POST",
            request_headers=Headers(dict(s_cli_ctx.request_headers.items())),
        )
        s_srv_tok = s_srv.on_start_sync(s_srv_ctx)
        s_srv.on_end_sync(s_srv_tok, s_srv_ctx, None)
        s_cli.on_end_sync(s_cli_tok, s_cli_ctx, None)

        rec.assert_conforms()
        spans = rec.spans()
        assert not any("Health" in s.name for s in spans)

        srv_spans = [s for s in spans if s.kind == SpanKind.SERVER]
        cli_spans = [s for s in spans if s.kind == SpanKind.CLIENT]
        assert len(srv_spans) == 4
        assert len(cli_spans) == 2

        # First call propagated trace id from client to server
        s0_sc = srv_spans[0].get_span_context()
        c0_sc = cli_spans[0].get_span_context()
        assert s0_sc is not None and c0_sc is not None
        assert s0_sc.trace_id == c0_sc.trace_id
        assert (srv_spans[0].attributes or {}).get("rpc.system.name") == "connectrpc"
        assert (srv_spans[3].attributes or {}).get("rpc.system.name") == "grpc"

        summary_logs = [
            lr
            for lr in rec.otel_logs()
            if (lr.log_record.attributes or {}).get(EVENT_NAME_KEY) == EVENT_REQUEST_SUMMARY
        ]
        assert len(summary_logs) == 4
        attrs_list = [dict(lr.log_record.attributes or {}) for lr in summary_logs]
        assert attrs_list[0]["greet.target"] == "world"
        assert attrs_list[0]["http.response.status_code"] == 200
        assert attrs_list[0]["o11y.outcome"] == str(Outcome.SUCCESS)
        assert attrs_list[1]["http.response.status_code"] == 404
        assert attrs_list[1]["rpc.response.status_code"] == "NOT_FOUND"
        assert attrs_list[1]["o11y.outcome"] == str(Outcome.SUCCESS)
        assert attrs_list[2]["http.response.status_code"] == 500
        assert attrs_list[2]["rpc.response.status_code"] == "INTERNAL"
        assert attrs_list[2]["o11y.outcome"] == str(Outcome.FAILURE)

        assert len(rec.metric_points("rpc.server.call.duration")) >= 1
        assert len(rec.metric_points("rpc.client.call.duration")) >= 1
        assert len(rec.exemplars("rpc.server.call.duration")) >= 1
