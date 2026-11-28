"""Connect RPC server and client interceptors (async and sync) for connectrpc."""

from __future__ import annotations

import time
from contextlib import AbstractContextManager
from contextvars import Token
from dataclasses import dataclass
from threading import Lock
from typing import TYPE_CHECKING, Final, Literal
from urllib.parse import urlsplit

from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.interceptor import MetadataInterceptor, MetadataInterceptorSync
from connectrpc.method import StreamType
from connectrpc.request import RequestContext
from opentelemetry import context, metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Histogram, MeterProvider
from opentelemetry.propagators.textmap import TextMapPropagator
from opentelemetry.trace import (
    INVALID_SPAN,
    Link,
    Span,
    SpanKind,
    Status,
    StatusCode,
    Tracer,
    TracerProvider,
)
from opentelemetry.util.types import AttributeValue

from libo11y._internal.http_common import (
    HEADER_GETTER,
    HEADER_SETTER,
    HTTP_DURATION_BUCKETS,
    error_type_for_exception,
)
from libo11y.record import Record, start_record
from libo11y.spec import ATTR_DURATION, ATTR_OUTCOME, EVENT_REQUEST_SUMMARY, Outcome

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

_SCOPE_NAME: Final[str] = "libo11y.connect"
_HEALTH_SERVICE: Final[str] = "grpc.health.v1.Health"

_SERVER_FAULT_CODES: Final[frozenset[Code]] = frozenset(
    {
        Code.UNKNOWN,
        Code.DEADLINE_EXCEEDED,
        Code.UNIMPLEMENTED,
        Code.INTERNAL,
        Code.UNAVAILABLE,
        Code.DATA_LOSS,
    }
)

_CONNECT_HTTP_STATUS: Final[dict[Code, int]] = {
    Code.CANCELED: 499,
    Code.INVALID_ARGUMENT: 400,
    Code.FAILED_PRECONDITION: 400,
    Code.OUT_OF_RANGE: 400,
    Code.DEADLINE_EXCEEDED: 504,
    Code.NOT_FOUND: 404,
    Code.ALREADY_EXISTS: 409,
    Code.ABORTED: 409,
    Code.PERMISSION_DENIED: 403,
    Code.RESOURCE_EXHAUSTED: 429,
    Code.UNIMPLEMENTED: 501,
    Code.UNAVAILABLE: 503,
    Code.UNAUTHENTICATED: 401,
}


def _rpc_method[RequestT, ResponseT](ctx: RequestContext[RequestT, ResponseT]) -> str:
    return f"{ctx.method.service_name}/{ctx.method.name}"


def _is_health[RequestT, ResponseT](ctx: RequestContext[RequestT, ResponseT]) -> bool:
    return ctx.method.service_name == _HEALTH_SERVICE


def _rpc_system[RequestT, ResponseT](ctx: RequestContext[RequestT, ResponseT]) -> str:
    ct = ctx.request_headers.get("content-type", "").lower()
    if ct.startswith("application/grpc"):
        return "grpc"
    return "connectrpc"


class _InstrumentSource:
    def __init__(self, telemetry: Telemetry | None, role: Literal["client", "server"]) -> None:
        self._telemetry = telemetry
        self._role = role
        self._lock = Lock()
        self._fixed: tuple[Tracer, Histogram] | None = None
        self._cache: tuple[TracerProvider, MeterProvider, tuple[Tracer, Histogram]] | None = None
        if telemetry is not None:
            self._fixed = self._build(telemetry.tracer_provider, telemetry.meter_provider)

    def _build(self, tp: TracerProvider, mp: MeterProvider) -> tuple[Tracer, Histogram]:
        return (
            tp.get_tracer(_SCOPE_NAME),
            mp.get_meter(_SCOPE_NAME).create_histogram(
                f"rpc.{self._role}.call.duration",
                unit="s",
                description=f"Duration of RPC {self._role} calls.",
                explicit_bucket_boundaries_advisory=list(HTTP_DURATION_BUCKETS),
            ),
        )

    def instruments(self) -> tuple[Tracer, Histogram]:
        if self._fixed is not None:
            return self._fixed
        with self._lock:
            tp, mp = trace.get_tracer_provider(), metrics.get_meter_provider()
            cached = self._cache
            if cached is not None and cached[0] is tp and cached[1] is mp:
                return cached[2]
            instruments = self._build(tp, mp)
            self._cache = (tp, mp, instruments)
            return instruments

    def propagator(self) -> TextMapPropagator:
        if self._telemetry is not None:
            return self._telemetry.propagator
        return propagate.get_global_textmap()


def _server_address_attributes(address: str | None) -> dict[str, AttributeValue]:
    if not address:
        return {}
    try:
        authority = urlsplit(f"//{address}")
        if authority.hostname is not None and authority.port is not None:
            return {"server.address": authority.hostname, "server.port": authority.port}
    except ValueError:
        pass
    return {"server.address": address}


def _http_status_for_code(code: Code) -> int:
    return _CONNECT_HTTP_STATUS.get(code, 500)


@dataclass(slots=True)
class _ServerToken:
    instrumented: bool
    start_ns: int = 0
    method: str = ""
    system: str = "connectrpc"
    span: Span | None = None
    parent_tok: Token[Context] | None = None
    span_tok: Token[Context] | None = None
    record_cm: AbstractContextManager[Record] | None = None
    record: Record | None = None
    duration_hist: Histogram | None = None


@dataclass(slots=True)
class _ClientToken:
    instrumented: bool
    start_ns: int = 0
    attributes: dict[str, AttributeValue] | None = None
    span: Span | None = None
    span_tok: Token[Context] | None = None
    duration_hist: Histogram | None = None


def _start_server[RequestT, ResponseT](
    ctx: RequestContext[RequestT, ResponseT],
    *,
    source: _InstrumentSource,
    public_endpoint: bool,
    ignore_health_checks: bool,
    canonical_line: bool,
) -> _ServerToken:
    if ignore_health_checks and _is_health(ctx):
        return _ServerToken(instrumented=False)

    tracer, duration_hist = source.instruments()
    method = _rpc_method(ctx)
    system = _rpc_system(ctx)

    # Only extract from headers when no outer span is already active (mirroring o11yconnect).
    cur_sc = trace.get_current_span().get_span_context()
    links: list[Link] = []
    parent_tok: Token[Context] | None = None
    if cur_sc.is_valid:
        parent_ctx = context.get_current()
    else:
        hdrs = {k.lower(): v for k, v in ctx.request_headers.items()}
        extracted = source.propagator().extract(hdrs, context=Context(), getter=HEADER_GETTER)
        if public_endpoint:
            remote_sc = trace.get_current_span(extracted).get_span_context()
            if remote_sc.is_valid:
                links.append(Link(remote_sc))
            parent_ctx = trace.set_span_in_context(INVALID_SPAN, extracted)
        else:
            parent_ctx = extracted
        parent_tok = context.attach(parent_ctx)

    start_ns = time.perf_counter_ns()
    span = tracer.start_span(
        method,
        context=parent_ctx,
        kind=SpanKind.SERVER,
        attributes={
            "rpc.system.name": system,
            "rpc.method": method,
        },
        links=links,
    )
    span_ctx = trace.set_span_in_context(span, parent_ctx)
    span_tok = context.attach(span_ctx)

    record_cm: AbstractContextManager[Record] | None = None
    record: Record | None = None
    if canonical_line:
        record_cm = start_record()
        record = record_cm.__enter__()

    return _ServerToken(
        instrumented=True,
        start_ns=start_ns,
        method=method,
        system=system,
        span=span,
        parent_tok=parent_tok,
        span_tok=span_tok,
        record_cm=record_cm,
        record=record,
        duration_hist=duration_hist,
    )


def _end_server[RequestT, ResponseT](
    tok: _ServerToken,
    ctx: RequestContext[RequestT, ResponseT],
    error: Exception | None,
    *,
    telemetry: Telemetry | None,
) -> None:
    if not tok.instrumented or tok.span is None:
        return
    try:
        elapsed_s = (time.perf_counter_ns() - tok.start_ns) / 1e9
        http_status = 200
        rpc_status = "OK"
        outcome = Outcome.SUCCESS
        is_server_fault = False
        err_type: str | None = None
        description: str | None = None

        if error is not None:
            if isinstance(error, ConnectError):
                code = error.code
                rpc_status = code.value.upper()
                err_type = rpc_status
                is_server_fault = code in _SERVER_FAULT_CODES
                description = error.message or None
                if ctx.method.stream_type is StreamType.UNARY and tok.system == "connectrpc":
                    http_status = _http_status_for_code(code)
                if is_server_fault:
                    outcome = Outcome.FAILURE
            else:
                http_status = 500
                rpc_status = "INTERNAL"
                outcome = Outcome.FAILURE
                is_server_fault = True
                err_type = error_type_for_exception(error)
                description = "panic"
                tok.span.record_exception(error)

        tok.span.set_attribute("rpc.response.status_code", rpc_status)
        if err_type is not None:
            tok.span.set_attribute("error.type", err_type)
        if is_server_fault:
            tok.span.set_status(Status(StatusCode.ERROR, description))

        if tok.duration_hist is not None:
            metric_attrs: dict[str, AttributeValue] = {
                "rpc.system.name": tok.system,
                "rpc.method": tok.method,
                "rpc.response.status_code": rpc_status,
            }
            if err_type is not None:
                metric_attrs["error.type"] = err_type
            tok.duration_hist.record(elapsed_s, metric_attrs)

        if tok.record is not None and telemetry is not None:
            tok.record.emit_event(
                telemetry,
                EVENT_REQUEST_SUMMARY,
                {
                    "http.request.method": ctx.http_method or "POST",
                    "http.response.status_code": http_status,
                    ATTR_OUTCOME: str(outcome),
                    ATTR_DURATION: elapsed_s,
                    "rpc.system.name": tok.system,
                    "rpc.method": tok.method,
                    "rpc.response.status_code": rpc_status,
                },
            )
    finally:
        if tok.record_cm is not None:
            tok.record_cm.__exit__(None, None, None)
        tok.span.end()
        if tok.span_tok is not None:
            context.detach(tok.span_tok)
        if tok.parent_tok is not None:
            context.detach(tok.parent_tok)

    if error is not None and not isinstance(error, ConnectError):
        # connectrpc's default UNKNOWN response uses str(error) as the wire
        # message. Supply an empty message so clients cannot copy it to a span.
        raise ConnectError(Code.UNKNOWN, "") from error


def _start_client[RequestT, ResponseT](
    ctx: RequestContext[RequestT, ResponseT],
    *,
    source: _InstrumentSource,
    ignore_health_checks: bool,
) -> _ClientToken:
    if ignore_health_checks and _is_health(ctx):
        return _ClientToken(instrumented=False)

    tracer, duration_hist = source.instruments()
    method = _rpc_method(ctx)
    attributes: dict[str, AttributeValue] = {
        "rpc.system.name": _rpc_system(ctx),
        "rpc.method": method,
        **_server_address_attributes(ctx.server_address),
    }
    start_ns = time.perf_counter_ns()

    span = tracer.start_span(
        method,
        kind=SpanKind.CLIENT,
        attributes=attributes,
    )
    span_ctx = trace.set_span_in_context(span)
    span_tok = context.attach(span_ctx)
    source.propagator().inject(ctx.request_headers, context=span_ctx, setter=HEADER_SETTER)
    return _ClientToken(
        instrumented=True,
        start_ns=start_ns,
        attributes=attributes,
        span=span,
        span_tok=span_tok,
        duration_hist=duration_hist,
    )


def _end_client(
    tok: _ClientToken,
    error: Exception | None,
) -> None:
    if not tok.instrumented or tok.span is None:
        return
    try:
        elapsed_s = (time.perf_counter_ns() - tok.start_ns) / 1e9
        rpc_status = "OK"
        err_type: str | None = None
        if error is not None:
            description: str | None = None
            if isinstance(error, ConnectError):
                rpc_status = error.code.value.upper()
                err_type = rpc_status
                # connectrpc wraps local transport exceptions as UNAVAILABLE
                # with the original exception text as the message.
                cause = error.__cause__
                if error.code is Code.UNAVAILABLE and isinstance(cause, Exception):
                    tok.span.record_exception(cause)
                else:
                    description = error.message or None
            else:
                rpc_status = "UNKNOWN"
                err_type = error_type_for_exception(error)
                tok.span.record_exception(error)
            tok.span.set_status(Status(StatusCode.ERROR, description))

        tok.span.set_attribute("rpc.response.status_code", rpc_status)
        if err_type is not None:
            tok.span.set_attribute("error.type", err_type)

        if tok.duration_hist is not None:
            metric_attrs: dict[str, AttributeValue] = {
                **(tok.attributes or {}),
                "rpc.response.status_code": rpc_status,
            }
            if err_type is not None:
                metric_attrs["error.type"] = err_type
            tok.duration_hist.record(elapsed_s, metric_attrs)
    finally:
        tok.span.end()
        if tok.span_tok is not None:
            context.detach(tok.span_tok)


class ServerInterceptor(MetadataInterceptor[_ServerToken]):
    """Async Connect RPC server interceptor for ConnectASGIApplication."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_health_checks: bool = False,
        canonical_line: bool = False,
    ) -> None:
        if canonical_line and telemetry is None:
            raise ValueError("o11yconnect: canonical_line requires telemetry")
        self._telemetry = telemetry
        self._source = _InstrumentSource(telemetry, "server")
        self._public_endpoint = public_endpoint
        self._ignore_health = ignore_health_checks
        self._canonical_line = canonical_line

    async def on_start[RequestT, ResponseT](
        self, ctx: RequestContext[RequestT, ResponseT]
    ) -> _ServerToken:
        return _start_server(
            ctx,
            source=self._source,
            public_endpoint=self._public_endpoint,
            ignore_health_checks=self._ignore_health,
            canonical_line=self._canonical_line,
        )

    async def on_end[RequestT, ResponseT](
        self,
        token: _ServerToken,
        ctx: RequestContext[RequestT, ResponseT],
        error: Exception | None,
    ) -> None:
        _end_server(token, ctx, error, telemetry=self._telemetry)


class SyncServerInterceptor(MetadataInterceptorSync[_ServerToken]):
    """Sync Connect RPC server interceptor for ConnectWSGIApplication."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_health_checks: bool = False,
        canonical_line: bool = False,
    ) -> None:
        if canonical_line and telemetry is None:
            raise ValueError("o11yconnect: canonical_line requires telemetry")
        self._telemetry = telemetry
        self._source = _InstrumentSource(telemetry, "server")
        self._public_endpoint = public_endpoint
        self._ignore_health = ignore_health_checks
        self._canonical_line = canonical_line

    def on_start_sync[RequestT, ResponseT](
        self, ctx: RequestContext[RequestT, ResponseT]
    ) -> _ServerToken:
        return _start_server(
            ctx,
            source=self._source,
            public_endpoint=self._public_endpoint,
            ignore_health_checks=self._ignore_health,
            canonical_line=self._canonical_line,
        )

    def on_end_sync[RequestT, ResponseT](
        self,
        token: _ServerToken,
        ctx: RequestContext[RequestT, ResponseT],
        error: Exception | None,
    ) -> None:
        _end_server(token, ctx, error, telemetry=self._telemetry)


class ClientInterceptor(MetadataInterceptor[_ClientToken]):
    """Async Connect RPC client interceptor for ConnectClient."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        ignore_health_checks: bool = False,
    ) -> None:
        self._source = _InstrumentSource(telemetry, "client")
        self._ignore_health = ignore_health_checks

    async def on_start[RequestT, ResponseT](
        self, ctx: RequestContext[RequestT, ResponseT]
    ) -> _ClientToken:
        return _start_client(
            ctx,
            source=self._source,
            ignore_health_checks=self._ignore_health,
        )

    async def on_end[RequestT, ResponseT](
        self,
        token: _ClientToken,
        ctx: RequestContext[RequestT, ResponseT],
        error: Exception | None,
    ) -> None:
        del ctx
        _end_client(token, error)


class SyncClientInterceptor(MetadataInterceptorSync[_ClientToken]):
    """Sync Connect RPC client interceptor for ConnectClientSync."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        ignore_health_checks: bool = False,
    ) -> None:
        self._source = _InstrumentSource(telemetry, "client")
        self._ignore_health = ignore_health_checks

    def on_start_sync[RequestT, ResponseT](
        self, ctx: RequestContext[RequestT, ResponseT]
    ) -> _ClientToken:
        return _start_client(
            ctx,
            source=self._source,
            ignore_health_checks=self._ignore_health,
        )

    def on_end_sync[RequestT, ResponseT](
        self,
        token: _ClientToken,
        ctx: RequestContext[RequestT, ResponseT],
        error: Exception | None,
    ) -> None:
        del ctx
        _end_client(token, error)


def server_interceptor(
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    canonical_line: bool = False,
) -> ServerInterceptor:
    """Create an async Connect RPC server interceptor."""
    return ServerInterceptor(
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_health_checks=ignore_health_checks,
        canonical_line=canonical_line,
    )


def sync_server_interceptor(
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    canonical_line: bool = False,
) -> SyncServerInterceptor:
    """Create a sync Connect RPC server interceptor."""
    return SyncServerInterceptor(
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_health_checks=ignore_health_checks,
        canonical_line=canonical_line,
    )


def client_interceptor(
    *,
    telemetry: Telemetry | None = None,
    ignore_health_checks: bool = False,
) -> ClientInterceptor:
    """Create an async Connect RPC client interceptor."""
    return ClientInterceptor(
        telemetry=telemetry,
        ignore_health_checks=ignore_health_checks,
    )


def sync_client_interceptor(
    *,
    telemetry: Telemetry | None = None,
    ignore_health_checks: bool = False,
) -> SyncClientInterceptor:
    """Create a sync Connect RPC client interceptor."""
    return SyncClientInterceptor(
        telemetry=telemetry,
        ignore_health_checks=ignore_health_checks,
    )


__all__ = [
    "ClientInterceptor",
    "ServerInterceptor",
    "SyncClientInterceptor",
    "SyncServerInterceptor",
    "client_interceptor",
    "server_interceptor",
    "sync_client_interceptor",
    "sync_server_interceptor",
]
