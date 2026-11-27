"""gRPC server and client interceptors for grpcio (sync and grpc.aio)."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Final, cast

import grpc
import grpc.aio
from opentelemetry import context, metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Histogram
from opentelemetry.propagators.textmap import Getter, Setter, TextMapPropagator
from opentelemetry.trace import INVALID_SPAN, Link, SpanKind, StatusCode, Tracer

from libo11y._internal.http_common import HTTP_DURATION_BUCKETS, error_type_for_exception

if TYPE_CHECKING:
    from libo11y.telemetry import Telemetry

type GRPCFilter = Callable[[str], bool]

_SCOPE_NAME: Final[str] = "libo11y.grpc"
_HEALTH_PREFIX: Final[str] = "/grpc.health.v1.Health/"

# Server fault status codes matching OTel gRPC semantic conventions and Go o11yconnect/o11ygrpc.
_SERVER_FAULT_CODES: Final[frozenset[grpc.StatusCode]] = frozenset(
    {
        grpc.StatusCode.UNKNOWN,
        grpc.StatusCode.DEADLINE_EXCEEDED,
        grpc.StatusCode.UNIMPLEMENTED,
        grpc.StatusCode.INTERNAL,
        grpc.StatusCode.UNAVAILABLE,
        grpc.StatusCode.DATA_LOSS,
    }
)


def _trim_method(full_method: str) -> str:
    return full_method.lstrip("/")


def _is_health_method(full_method: str) -> bool:
    return full_method.startswith(_HEALTH_PREFIX)


def _allowed(full_method: str, ignore_health: bool, filt: GRPCFilter | None) -> bool:
    if ignore_health and _is_health_method(full_method):
        return False
    return not (filt is not None and not filt(full_method))


class _MetadataGetter(Getter[Mapping[str, str]]):
    def get(self, carrier: Mapping[str, str], key: str) -> list[str] | None:
        val = carrier.get(key.lower())
        return [val] if val is not None else None

    def keys(self, carrier: Mapping[str, str]) -> list[str]:
        return list(carrier.keys())


class _MetadataSetter(Setter[list[tuple[str, str]]]):
    def set(self, carrier: list[tuple[str, str]], key: str, value: str) -> None:
        carrier.append((key.lower(), value))


_META_GETTER: Final[_MetadataGetter] = _MetadataGetter()
_META_SETTER: Final[_MetadataSetter] = _MetadataSetter()


def _metadata_to_dict(metadata: Sequence[Any] | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not metadata:
        return out
    for item in metadata:
        k: Any
        v: Any
        if hasattr(item, "key") and hasattr(item, "value"):
            k, v = item.key, item.value
        else:
            k, v = item[0], item[1]
        if isinstance(v, bytes):
            continue
        key_l = str(k).lower()
        val_s = str(v)
        out[key_l] = f"{out[key_l]},{val_s}" if key_l in out else val_s
    return out


def _resolve_rpc_primitives(
    telemetry: Telemetry | None,
    metric_name: str,
    metric_desc: str,
) -> tuple[Tracer, Histogram, TextMapPropagator]:
    tp = telemetry.tracer_provider if telemetry is not None else trace.get_tracer_provider()
    mp = telemetry.meter_provider if telemetry is not None else metrics.get_meter_provider()
    prop = telemetry.propagator if telemetry is not None else propagate.get_global_textmap()
    tracer = tp.get_tracer(_SCOPE_NAME)
    meter = mp.get_meter(_SCOPE_NAME)
    hist = meter.create_histogram(
        metric_name,
        unit="s",
        description=metric_desc,
        explicit_bucket_boundaries_advisory=list(HTTP_DURATION_BUCKETS),
    )
    return tracer, hist, prop


def _status_code_from_context(servicer_ctx: Any) -> grpc.StatusCode:
    code_fn = getattr(servicer_ctx, "code", None)
    if callable(code_fn):
        code = code_fn()
        if isinstance(code, grpc.StatusCode):
            return code
    return grpc.StatusCode.OK


def _status_code_from_exc(exc: BaseException) -> grpc.StatusCode:
    if isinstance(exc, grpc.RpcError):
        code_fn = getattr(exc, "code", None)
        if callable(code_fn):
            code = code_fn()
            if isinstance(code, grpc.StatusCode):
                return code
    return grpc.StatusCode.UNKNOWN


def _prepare_server_parent(
    propagator: TextMapPropagator,
    metadata: Sequence[Any] | None,
    public_endpoint: bool,
) -> tuple[Context, list[Link]]:
    hdrs = _metadata_to_dict(metadata)
    extracted = propagator.extract(hdrs, context=Context(), getter=_META_GETTER)
    links: list[Link] = []
    if public_endpoint:
        sc = trace.get_current_span(extracted).get_span_context()
        if sc.is_valid:
            links.append(Link(sc))
        return trace.set_span_in_context(INVALID_SPAN, extracted), links
    return extracted, links


def _resolve_server_status(
    servicer_ctx: Any,
    raised: BaseException | None,
) -> tuple[grpc.StatusCode, BaseException | None]:
    """Resolve gRPC status and whether raised was an unexpected non-abort exception."""
    ctx_code = _status_code_from_context(servicer_ctx)
    if ctx_code is not grpc.StatusCode.OK:
        # ctx.abort() sets servicer_ctx.code() and raises an internal sentinel Exception().
        return ctx_code, None
    if raised is not None:
        return _status_code_from_exc(raised), raised
    return grpc.StatusCode.OK, None


def _record_server_finish(
    span: trace.Span,
    duration_hist: Histogram,
    method: str,
    start_ns: int,
    status: grpc.StatusCode,
    raised: BaseException | None,
) -> None:
    elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
    status_name = status.name
    span.set_attribute("rpc.response.status_code", status_name)

    is_err = (raised is not None and not isinstance(raised, grpc.RpcError)) or (
        status in _SERVER_FAULT_CODES
    )
    err_type: str | None = None
    if raised is not None and not isinstance(raised, grpc.RpcError):
        err_type = error_type_for_exception(raised)
    elif is_err:
        err_type = status_name

    if err_type is not None:
        span.set_attribute("error.type", err_type)
    if is_err:
        span.set_status(StatusCode.ERROR)

    metric_attrs: dict[str, Any] = {
        "rpc.system.name": "grpc",
        "rpc.method": method,
        "rpc.response.status_code": status_name,
    }
    if err_type is not None:
        metric_attrs["error.type"] = err_type
    duration_hist.record(elapsed_s, metric_attrs)


def _record_client_finish(
    span: trace.Span,
    duration_hist: Histogram,
    method: str,
    start_ns: int,
    status: grpc.StatusCode,
    raised: BaseException | None,
) -> None:
    elapsed_s = (time.perf_counter_ns() - start_ns) / 1e9
    status_name = status.name
    span.set_attribute("rpc.response.status_code", status_name)

    is_err = raised is not None or status is not grpc.StatusCode.OK
    err_type: str | None = None
    if raised is not None and not isinstance(raised, grpc.RpcError):
        err_type = error_type_for_exception(raised)
    elif is_err:
        err_type = status_name

    if err_type is not None:
        span.set_attribute("error.type", err_type)
    if is_err:
        span.set_status(StatusCode.ERROR)

    metric_attrs: dict[str, Any] = {
        "rpc.system.name": "grpc",
        "rpc.method": method,
        "rpc.response.status_code": status_name,
    }
    if err_type is not None:
        metric_attrs["error.type"] = err_type
    duration_hist.record(elapsed_s, metric_attrs)


class _WrappedClientCallDetails(grpc.ClientCallDetails):
    def __init__(self, base: grpc.ClientCallDetails, metadata: tuple[tuple[str, Any], ...]) -> None:
        self.method = getattr(base, "method", "")
        self.timeout = getattr(base, "timeout", None)
        self.metadata = metadata
        self.credentials = getattr(base, "credentials", None)
        self.wait_for_ready = getattr(base, "wait_for_ready", None)
        self.compression = getattr(base, "compression", None)


def _inject_sync_call_details(
    call_details: grpc.ClientCallDetails,
    propagator: TextMapPropagator,
) -> grpc.ClientCallDetails:
    raw_meta: Any = getattr(call_details, "metadata", None)
    existing: list[tuple[Any, Any]] = list(raw_meta) if raw_meta is not None else []
    injected: list[tuple[str, str]] = []
    propagator.inject(injected, setter=_META_SETTER)
    if not injected:
        return call_details
    injected_keys = {k for k, _ in injected}
    merged: list[tuple[str, Any]] = [
        (str(k), v) for k, v in existing if str(k).lower() not in injected_keys
    ]
    merged.extend(injected)
    return _WrappedClientCallDetails(call_details, tuple(merged))


def _inject_aio_call_details(
    call_details: grpc.aio.ClientCallDetails,
    propagator: TextMapPropagator,
) -> grpc.aio.ClientCallDetails:
    raw_meta: Any = call_details.metadata
    existing: list[tuple[str, Any]] = list(raw_meta) if raw_meta is not None else []
    injected: list[tuple[str, str]] = []
    propagator.inject(injected, setter=_META_SETTER)
    if not injected:
        return call_details
    injected_keys = {k for k, _ in injected}
    merged: list[tuple[str, Any]] = [
        (str(k), v) for k, v in existing if str(k).lower() not in injected_keys
    ]
    merged.extend(injected)
    return grpc.aio.ClientCallDetails(
        method=call_details.method,
        timeout=call_details.timeout,
        metadata=grpc.aio.Metadata(*merged),
        credentials=call_details.credentials,
        wait_for_ready=call_details.wait_for_ready,
    )


class ServerInterceptor(grpc.ServerInterceptor):
    """Synchronous grpcio server interceptor."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._public_endpoint = public_endpoint
        self._ignore_health = ignore_health_checks
        self._filter = filter

    def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], grpc.RpcMethodHandler[Any, Any] | None],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler[Any, Any] | None:
        handler: Any = continuation(handler_call_details)
        if handler is None:
            return None

        full_method = str(getattr(handler_call_details, "method", "") or "")
        invocation_meta = getattr(handler_call_details, "invocation_metadata", None)
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.server.duration",
            "Duration of RPC server requests.",
        )
        instrumented = _allowed(full_method, self._ignore_health, self._filter)
        method = _trim_method(full_method)

        def _wrap_unary(fn: Callable[[Any, Any], Any]) -> Callable[[Any, Any], Any]:
            def _inner(request: Any, servicer_ctx: Any) -> Any:
                parent_ctx, links = _prepare_server_parent(
                    propagator, invocation_meta, self._public_endpoint
                )
                tok = context.attach(parent_ctx)
                try:
                    if not instrumented:
                        return fn(request, servicer_ctx)
                    start_ns = time.perf_counter_ns()
                    raised: BaseException | None = None
                    with tracer.start_as_current_span(
                        method,
                        context=parent_ctx,
                        kind=SpanKind.SERVER,
                        attributes={"rpc.system.name": "grpc", "rpc.method": method},
                        links=links,
                        record_exception=False,
                        set_status_on_exception=False,
                    ) as span:
                        try:
                            return fn(request, servicer_ctx)
                        except Exception as exc:
                            raised = exc
                            raise
                        finally:
                            status, unexpected = _resolve_server_status(servicer_ctx, raised)
                            if unexpected is not None:
                                span.record_exception(unexpected)
                            _record_server_finish(
                                span, duration_hist, method, start_ns, status, unexpected
                            )
                finally:
                    context.detach(tok)

            return _inner

        def _wrap_stream(
            fn: Callable[[Any, Any], Iterator[Any]],
        ) -> Callable[[Any, Any], Iterator[Any]]:
            def _inner(request: Any, servicer_ctx: Any) -> Iterator[Any]:
                parent_ctx, links = _prepare_server_parent(
                    propagator, invocation_meta, self._public_endpoint
                )
                tok = context.attach(parent_ctx)
                try:
                    if not instrumented:
                        yield from fn(request, servicer_ctx)
                        return
                    start_ns = time.perf_counter_ns()
                    raised: BaseException | None = None
                    with tracer.start_as_current_span(
                        method,
                        context=parent_ctx,
                        kind=SpanKind.SERVER,
                        attributes={"rpc.system.name": "grpc", "rpc.method": method},
                        links=links,
                        record_exception=False,
                        set_status_on_exception=False,
                    ) as span:
                        try:
                            yield from fn(request, servicer_ctx)
                        except Exception as exc:
                            raised = exc
                            raise
                        finally:
                            status, unexpected = _resolve_server_status(servicer_ctx, raised)
                            if unexpected is not None:
                                span.record_exception(unexpected)
                            _record_server_finish(
                                span, duration_hist, method, start_ns, status, unexpected
                            )
                finally:
                    context.detach(tok)

            return _inner

        if handler.unary_unary is not None:
            return grpc.unary_unary_rpc_method_handler(
                _wrap_unary(handler.unary_unary),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.unary_stream is not None:
            return grpc.unary_stream_rpc_method_handler(
                _wrap_stream(handler.unary_stream),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_unary is not None:
            return grpc.stream_unary_rpc_method_handler(
                _wrap_unary(handler.stream_unary),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_stream is not None:
            return grpc.stream_stream_rpc_method_handler(
                _wrap_stream(handler.stream_stream),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        return handler


class ClientInterceptor(
    grpc.UnaryUnaryClientInterceptor,
    grpc.UnaryStreamClientInterceptor,
    grpc.StreamUnaryClientInterceptor,
    grpc.StreamStreamClientInterceptor,
):
    """Synchronous grpcio client interceptor covering unary and streaming calls."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._ignore_health = ignore_health_checks
        self._filter = filter

    def _call_unary(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        full_method = str(getattr(client_call_details, "method", "") or "")
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.client.duration",
            "Duration of RPC client requests.",
        )
        if not _allowed(full_method, self._ignore_health, self._filter):
            return continuation(_inject_sync_call_details(client_call_details, propagator), request)

        method = _trim_method(full_method)
        start_ns = time.perf_counter_ns()
        raised: BaseException | None = None
        status = grpc.StatusCode.OK
        with tracer.start_as_current_span(
            method,
            kind=SpanKind.CLIENT,
            attributes={"rpc.system.name": "grpc", "rpc.method": method},
        ) as span:
            details = _inject_sync_call_details(client_call_details, propagator)
            try:
                response = continuation(details, request)
                code_fn = getattr(response, "code", None)
                if callable(code_fn):
                    code = code_fn()
                    if isinstance(code, grpc.StatusCode):
                        status = code
                return response
            except Exception as exc:
                raised = exc
                status = _status_code_from_exc(exc)
                span.record_exception(exc)
                raise
            finally:
                _record_client_finish(span, duration_hist, method, start_ns, status, raised)

    def _call_stream(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        full_method = str(getattr(client_call_details, "method", "") or "")
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.client.duration",
            "Duration of RPC client requests.",
        )
        if not _allowed(full_method, self._ignore_health, self._filter):
            return continuation(_inject_sync_call_details(client_call_details, propagator), request)

        method = _trim_method(full_method)
        start_ns = time.perf_counter_ns()
        span = tracer.start_span(
            method,
            kind=SpanKind.CLIENT,
            attributes={"rpc.system.name": "grpc", "rpc.method": method},
        )
        span_ctx = trace.set_span_in_context(span)
        tok = context.attach(span_ctx)
        details = _inject_sync_call_details(client_call_details, propagator)
        context.detach(tok)

        def _gen() -> Iterator[Any]:
            raised: BaseException | None = None
            status = grpc.StatusCode.OK
            inner_tok = context.attach(span_ctx)
            try:
                call = continuation(details, request)
                yield from call
                code_fn = getattr(call, "code", None)
                if callable(code_fn):
                    code = code_fn()
                    if isinstance(code, grpc.StatusCode):
                        status = code
            except Exception as exc:
                raised = exc
                status = _status_code_from_exc(exc)
                span.record_exception(exc)
                raise
            finally:
                _record_client_finish(span, duration_hist, method, start_ns, status, raised)
                span.end()
                context.detach(inner_tok)

        return _gen()

    def intercept_unary_unary(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        return self._call_unary(continuation, client_call_details, request)

    def intercept_unary_stream(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request: Any,
    ) -> Any:
        return self._call_stream(continuation, client_call_details, request)

    def intercept_stream_unary(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request_iterator: Any,
    ) -> Any:
        return self._call_unary(continuation, client_call_details, request_iterator)

    def intercept_stream_stream(
        self,
        continuation: Callable[[grpc.ClientCallDetails, Any], Any],
        client_call_details: grpc.ClientCallDetails,
        request_iterator: Any,
    ) -> Any:
        return self._call_stream(continuation, client_call_details, request_iterator)


class AioServerInterceptor(grpc.aio.ServerInterceptor):
    """Asynchronous grpc.aio server interceptor."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._public_endpoint = public_endpoint
        self._ignore_health = ignore_health_checks
        self._filter = filter

    async def intercept_service(
        self,
        continuation: Callable[
            [grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler[Any, Any] | None]
        ],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler[Any, Any] | None:
        handler: Any = await continuation(handler_call_details)
        if handler is None:
            return None

        full_method = str(getattr(handler_call_details, "method", "") or "")
        invocation_meta = getattr(handler_call_details, "invocation_metadata", None)
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.server.duration",
            "Duration of RPC server requests.",
        )
        instrumented = _allowed(full_method, self._ignore_health, self._filter)
        method = _trim_method(full_method)

        def _wrap_unary(
            fn: Callable[[Any, Any], Awaitable[Any]],
        ) -> Callable[[Any, Any], Awaitable[Any]]:
            async def _inner(request: Any, servicer_ctx: Any) -> Any:
                parent_ctx, links = _prepare_server_parent(
                    propagator, invocation_meta, self._public_endpoint
                )
                tok = context.attach(parent_ctx)
                try:
                    if not instrumented:
                        return await fn(request, servicer_ctx)
                    start_ns = time.perf_counter_ns()
                    raised: BaseException | None = None
                    with tracer.start_as_current_span(
                        method,
                        context=parent_ctx,
                        kind=SpanKind.SERVER,
                        attributes={"rpc.system.name": "grpc", "rpc.method": method},
                        links=links,
                        record_exception=False,
                        set_status_on_exception=False,
                    ) as span:
                        try:
                            return await fn(request, servicer_ctx)
                        except Exception as exc:
                            raised = exc
                            raise
                        finally:
                            status, unexpected = _resolve_server_status(servicer_ctx, raised)
                            if unexpected is not None:
                                span.record_exception(unexpected)
                            _record_server_finish(
                                span, duration_hist, method, start_ns, status, unexpected
                            )
                finally:
                    context.detach(tok)

            return _inner

        def _wrap_stream(
            fn: Callable[[Any, Any], AsyncIterator[Any]],
        ) -> Callable[[Any, Any], AsyncIterator[Any]]:
            async def _inner(request: Any, servicer_ctx: Any) -> AsyncIterator[Any]:
                parent_ctx, links = _prepare_server_parent(
                    propagator, invocation_meta, self._public_endpoint
                )
                tok = context.attach(parent_ctx)
                try:
                    if not instrumented:
                        async for item in fn(request, servicer_ctx):
                            yield item
                        return
                    start_ns = time.perf_counter_ns()
                    raised: BaseException | None = None
                    with tracer.start_as_current_span(
                        method,
                        context=parent_ctx,
                        kind=SpanKind.SERVER,
                        attributes={"rpc.system.name": "grpc", "rpc.method": method},
                        links=links,
                        record_exception=False,
                        set_status_on_exception=False,
                    ) as span:
                        try:
                            async for item in fn(request, servicer_ctx):
                                yield item
                        except Exception as exc:
                            raised = exc
                            raise
                        finally:
                            status, unexpected = _resolve_server_status(servicer_ctx, raised)
                            if unexpected is not None:
                                span.record_exception(unexpected)
                            _record_server_finish(
                                span, duration_hist, method, start_ns, status, unexpected
                            )
                finally:
                    context.detach(tok)

            return _inner

        if handler.unary_unary is not None:
            return grpc.unary_unary_rpc_method_handler(
                _wrap_unary(handler.unary_unary),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.unary_stream is not None:
            return grpc.unary_stream_rpc_method_handler(
                _wrap_stream(handler.unary_stream),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_unary is not None:
            return grpc.stream_unary_rpc_method_handler(
                _wrap_unary(handler.stream_unary),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        if handler.stream_stream is not None:
            return grpc.stream_stream_rpc_method_handler(
                _wrap_stream(handler.stream_stream),
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )
        return handler


class AioClientInterceptor(
    grpc.aio.UnaryUnaryClientInterceptor,
    grpc.aio.UnaryStreamClientInterceptor,
    grpc.aio.StreamUnaryClientInterceptor,
    grpc.aio.StreamStreamClientInterceptor,
):
    """Asynchronous grpc.aio client interceptor."""

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._ignore_health = ignore_health_checks
        self._filter = filter

    async def _call_unary(
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, Any], Awaitable[Any]],
        client_call_details: grpc.aio.ClientCallDetails,
        request: Any,
    ) -> Any:
        full_method = (
            client_call_details.method.decode("utf-8")
            if isinstance(client_call_details.method, bytes)
            else str(client_call_details.method)
        )
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.client.duration",
            "Duration of RPC client requests.",
        )
        if not _allowed(full_method, self._ignore_health, self._filter):
            return await continuation(
                _inject_aio_call_details(client_call_details, propagator), request
            )

        method = _trim_method(full_method)
        start_ns = time.perf_counter_ns()
        raised: BaseException | None = None
        status = grpc.StatusCode.OK
        with tracer.start_as_current_span(
            method,
            kind=SpanKind.CLIENT,
            attributes={"rpc.system.name": "grpc", "rpc.method": method},
        ) as span:
            details = _inject_aio_call_details(client_call_details, propagator)
            try:
                call = await continuation(details, request)
                resp = await call
                code_fn: Any = getattr(call, "code", None)
                if callable(code_fn):
                    code = await cast(Awaitable[Any], code_fn())
                    if isinstance(code, grpc.StatusCode):
                        status = code
                return resp
            except Exception as exc:
                raised = exc
                status = _status_code_from_exc(exc)
                span.record_exception(exc)
                raise
            finally:
                _record_client_finish(span, duration_hist, method, start_ns, status, raised)

    async def intercept_unary_unary(
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, Any], Awaitable[Any]],
        client_call_details: grpc.aio.ClientCallDetails,
        request: Any,
    ) -> Any:
        return await self._call_unary(continuation, client_call_details, request)

    async def intercept_stream_unary(
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, Any], Awaitable[Any]],
        client_call_details: grpc.aio.ClientCallDetails,
        request_iterator: Any,
    ) -> Any:
        return await self._call_unary(continuation, client_call_details, request_iterator)

    async def intercept_unary_stream(
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, Any], Awaitable[Any]],
        client_call_details: grpc.aio.ClientCallDetails,
        request: Any,
    ) -> Any:
        full_method = (
            client_call_details.method.decode("utf-8")
            if isinstance(client_call_details.method, bytes)
            else str(client_call_details.method)
        )
        tracer, duration_hist, propagator = _resolve_rpc_primitives(
            self._telemetry,
            "rpc.client.duration",
            "Duration of RPC client requests.",
        )
        if not _allowed(full_method, self._ignore_health, self._filter):
            return await continuation(
                _inject_aio_call_details(client_call_details, propagator), request
            )
        method = _trim_method(full_method)
        start_ns = time.perf_counter_ns()
        with tracer.start_as_current_span(
            method,
            kind=SpanKind.CLIENT,
            attributes={"rpc.system.name": "grpc", "rpc.method": method},
        ) as span:
            details = _inject_aio_call_details(client_call_details, propagator)
            raised: BaseException | None = None
            status = grpc.StatusCode.OK
            try:
                return await continuation(details, request)
            except Exception as exc:
                raised = exc
                status = _status_code_from_exc(exc)
                span.record_exception(exc)
                raise
            finally:
                _record_client_finish(span, duration_hist, method, start_ns, status, raised)

    async def intercept_stream_stream(
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, Any], Awaitable[Any]],
        client_call_details: grpc.aio.ClientCallDetails,
        request_iterator: Any,
    ) -> Any:
        return await self.intercept_unary_stream(
            continuation, client_call_details, request_iterator
        )


def server_interceptor(
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
) -> ServerInterceptor:
    """Create a synchronous grpcio server interceptor."""
    return ServerInterceptor(
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
    )


def client_interceptor(
    *,
    telemetry: Telemetry | None = None,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
) -> ClientInterceptor:
    """Create a synchronous grpcio client interceptor."""
    return ClientInterceptor(
        telemetry=telemetry,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
    )


def aio_server_interceptor(
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
) -> AioServerInterceptor:
    """Create an asynchronous grpc.aio server interceptor."""
    return AioServerInterceptor(
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
    )


def aio_client_interceptor(
    *,
    telemetry: Telemetry | None = None,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
) -> AioClientInterceptor:
    """Create an asynchronous grpc.aio client interceptor."""
    return AioClientInterceptor(
        telemetry=telemetry,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
    )


__all__ = [
    "AioClientInterceptor",
    "AioServerInterceptor",
    "ClientInterceptor",
    "GRPCFilter",
    "ServerInterceptor",
    "aio_client_interceptor",
    "aio_server_interceptor",
    "client_interceptor",
    "server_interceptor",
]
