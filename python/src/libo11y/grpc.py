"""gRPC server and client interceptors for grpcio (sync and ``grpc.aio``).

The interceptors emit OpenTelemetry RPC spans and the ``rpc.server.call.duration``
and ``rpc.client.call.duration`` histograms (seconds) with the attributes Go's
``o11ygrpc`` records through ``otelgrpc``: ``rpc.system.name``, ``rpc.method``,
``rpc.response.status_code`` and, when the RPC failed for that role,
``error.type``. W3C trace context and baggage travel in request metadata.

Sync usage::

    server = grpc.server(pool, interceptors=[libo11y.grpc.server_interceptor()])
    channel = grpc.intercept_channel(raw, libo11y.grpc.client_interceptor())

``grpc.aio`` usage::

    server = grpc.aio.server(interceptors=[libo11y.grpc.aio_server_interceptor()])
    channel = grpc.aio.insecure_channel(
        target, interceptors=libo11y.grpc.aio_client_interceptors()
    )

``grpc.aio`` registers each client interceptor object for exactly one call
shape, so :func:`aio_client_interceptors` returns one interceptor per shape.
Pass the whole list to ``interceptors=``.

Client interceptors return grpcio's call objects, or wrappers that delegate
every call method to them, and end the client span when the call completes,
fails, is cancelled, or is abandoned. Status mapping follows ``otelgrpc``:
every non-OK status marks a client span as an error, and only ``UNKNOWN``,
``DEADLINE_EXCEEDED``, ``UNIMPLEMENTED``, ``INTERNAL``, ``UNAVAILABLE`` and
``DATA_LOSS`` mark a server span as an error. The span status description is
the RPC status message, and is never the text of a Python exception.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import threading
import time
import weakref
from collections.abc import (
    AsyncGenerator,
    AsyncIterable,
    AsyncIterator,
    Awaitable,
    Callable,
    Generator,
    Iterable,
    Iterator,
    Mapping,
)
from dataclasses import dataclass
from types import TracebackType
from typing import TYPE_CHECKING, Any, Final, Protocol, cast, runtime_checkable

import grpc
import grpc.aio
from opentelemetry import context, metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.metrics import Histogram, MeterProvider
from opentelemetry.propagators.textmap import Getter, Setter, TextMapPropagator
from opentelemetry.trace import INVALID_SPAN, Link, Span, SpanKind, Status, StatusCode, Tracer
from opentelemetry.trace import TracerProvider as OTelTracerProvider
from opentelemetry.util.types import AttributeValue

from libo11y._internal.http_common import HTTP_DURATION_BUCKETS, error_type_for_exception

if TYPE_CHECKING:
    # typeshed declares grpcio's call-future and call-iterator types as
    # private, type-check-only classes; they are the exact types the
    # interceptor interfaces use, so the signatures below name them.
    from grpc import _CallFuture, _CallIterator  # pyright: ignore[reportPrivateUsage]

    from libo11y.telemetry import Telemetry

if TYPE_CHECKING:
    _GrpcFuture = grpc.Future
else:

    class _GrpcFuture[T](grpc.Future):
        """grpcio's ``Future`` ABC, made subscriptable (typeshed types it as generic)."""


type GRPCFilter = Callable[[str], bool]
"""Decides whether a full method name (``/pkg.Service/Method``) is instrumented."""

_SCOPE_NAME: Final[str] = "libo11y.grpc"
_HEALTH_PREFIX: Final[str] = "/grpc.health.v1.Health/"
_RPC_SYSTEM: Final[str] = "grpc"
_SERVER_DURATION: Final[str] = "rpc.server.call.duration"
_CLIENT_DURATION: Final[str] = "rpc.client.call.duration"

# Status codes that mark a server span as an error (otelgrpc serverStatus).
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

type _Behaviour = Callable[..., Any]
type _MetadataPairs = Iterable[tuple[str, str | bytes]]


def _parse_full_method(full_method: str) -> tuple[str, str | None]:
    """Return the span name and ``rpc.method`` for a full method, as otelgrpc does."""
    if not full_method.startswith("/"):
        return full_method, None
    name = full_method[1:]
    return name, name or None


def _allowed(full_method: str, ignore_health: bool, filt: GRPCFilter | None) -> bool:
    if ignore_health and full_method.startswith(_HEALTH_PREFIX):
        return False
    return filt is None or filt(full_method)


def _method_name(method: str | bytes) -> str:
    # grpc.aio passes the method as bytes at runtime although typeshed says str.
    return method.decode() if isinstance(method, bytes) else method


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


def _metadata_to_dict(metadata: _MetadataPairs | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in metadata or ():
        if isinstance(value, bytes):
            continue
        k = key.lower()
        out[k] = f"{out[k]},{value}" if k in out else value
    return out


def _merge_metadata(
    existing: _MetadataPairs | None, injected: list[tuple[str, str]]
) -> list[tuple[str, str | bytes]]:
    keys = {k for k, _ in injected}
    merged: list[tuple[str, str | bytes]] = [
        (k, v) for k, v in existing or () if k.lower() not in keys
    ]
    merged.extend(injected)
    return merged


# --------------------------------------------------------------------------
# Instruments
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Instruments:
    tracer: Tracer
    duration: Histogram


def _build_instruments(
    tracer_provider: OTelTracerProvider,
    meter_provider: MeterProvider,
    metric_name: str,
    description: str,
) -> _Instruments:
    return _Instruments(
        tracer=tracer_provider.get_tracer(_SCOPE_NAME),
        duration=meter_provider.get_meter(_SCOPE_NAME).create_histogram(
            metric_name,
            unit="s",
            description=description,
            explicit_bucket_boundaries_advisory=list(HTTP_DURATION_BUCKETS),
        ),
    )


class _InstrumentSource:
    """Supplies one interceptor's tracer, duration histogram and propagator.

    With ``telemetry`` the instruments are built once. Without it they are
    built from the global providers and rebuilt only when a global provider
    is replaced, so instrumentation constructed before ``libo11y.setup``
    still reports to the providers installed later.
    """

    __slots__ = ("_cached", "_description", "_fixed", "_metric_name", "_telemetry")

    def __init__(self, telemetry: Telemetry | None, metric_name: str, description: str) -> None:
        self._telemetry = telemetry
        self._metric_name = metric_name
        self._description = description
        self._cached: tuple[OTelTracerProvider, MeterProvider, _Instruments] | None = None
        self._fixed: _Instruments | None = None
        if telemetry is not None:
            self._fixed = _build_instruments(
                telemetry.tracer_provider, telemetry.meter_provider, metric_name, description
            )

    def instruments(self) -> _Instruments:
        if self._fixed is not None:
            return self._fixed
        tracer_provider = trace.get_tracer_provider()
        meter_provider = metrics.get_meter_provider()
        cached = self._cached
        if cached is not None and cached[0] is tracer_provider and cached[1] is meter_provider:
            return cached[2]
        built = _build_instruments(
            tracer_provider, meter_provider, self._metric_name, self._description
        )
        self._cached = (tracer_provider, meter_provider, built)
        return built

    def propagator(self) -> TextMapPropagator:
        if self._telemetry is not None:
            return self._telemetry.propagator
        return propagate.get_global_textmap()


# --------------------------------------------------------------------------
# One RPC: span, timing and the exactly-once finish
# --------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Outcome:
    """The terminal status of one RPC as seen by one role."""

    code: grpc.StatusCode
    message: str | None = None
    exception: BaseException | None = None
    """A local Python exception that ended the RPC without an RPC status."""


_CANCELLED: Final[_Outcome] = _Outcome(grpc.StatusCode.CANCELLED)


class _Rpc:
    """Owns one RPC span and records its duration exactly once."""

    __slots__ = ("_attrs", "_duration", "_finished", "_lock", "_server", "_start_ns", "span")

    def __init__(
        self,
        span: Span,
        duration: Histogram,
        metric_attrs: dict[str, AttributeValue],
        *,
        server: bool,
    ) -> None:
        self.span = span
        self._duration = duration
        self._attrs = metric_attrs
        self._server = server
        self._start_ns = time.perf_counter_ns()
        self._finished = False
        self._lock = threading.Lock()

    @property
    def finished(self) -> bool:
        return self._finished

    @contextlib.contextmanager
    def activated(self) -> Generator[None]:
        token = context.attach(trace.set_span_in_context(self.span))
        try:
            yield
        finally:
            context.detach(token)

    def finish(self, outcome: _Outcome) -> None:
        with self._lock:
            if self._finished:
                return
            self._finished = True
        elapsed_s = (time.perf_counter_ns() - self._start_ns) / 1e9
        status_name = outcome.code.name
        attrs = dict(self._attrs)
        attrs["rpc.response.status_code"] = status_name
        span = self.span
        span.set_attribute("rpc.response.status_code", status_name)

        is_error = (
            outcome.code in _SERVER_FAULT_CODES
            if self._server
            else outcome.code is not grpc.StatusCode.OK
        )
        if outcome.exception is not None:
            span.record_exception(outcome.exception)
            if not self._server:
                is_error = True
        if is_error:
            if outcome.exception is not None and not self._server:
                error_type = error_type_for_exception(outcome.exception)
            else:
                error_type = status_name
            span.set_attribute("error.type", error_type)
            attrs["error.type"] = error_type
            span.set_status(Status(StatusCode.ERROR, outcome.message or None))
        self._duration.record(elapsed_s, attrs, context=trace.set_span_in_context(span))
        span.end()


# --------------------------------------------------------------------------
# Client side
# --------------------------------------------------------------------------


def _wire_outcome(code: grpc.StatusCode, details: str | None) -> _Outcome:
    # grpcio synthesizes UNKNOWN details from unhandled Python exceptions.
    # Preserve the call's wire details, but keep those diagnostics out of spans.
    if (
        code is grpc.StatusCode.UNKNOWN
        and details is not None
        and details.startswith(
            (
                "Exception calling application: ",
                "Exception iterating responses: ",
                "Calling application raised unprintable Exception!",
                "Unexpected <class ",
            )
        )
    ):
        details = None
    return _Outcome(code, details or None)


@runtime_checkable
class _StatusCall(Protocol):
    """The status accessors every terminated grpcio sync call object offers."""

    def code(self) -> grpc.StatusCode | None: ...

    def details(self) -> str | None: ...


def _outcome_of_sync_call(call: object) -> _Outcome:
    """Read the terminal status of a finished grpcio sync call or outcome."""
    if isinstance(call, grpc.Future):
        future = cast("grpc.Future[object]", call)
        if not future.cancelled():
            exc = future.exception()
            if exc is not None and not isinstance(exc, grpc.RpcError):
                return _Outcome(grpc.StatusCode.UNKNOWN, None, exc)
    if isinstance(call, _StatusCall):
        code = call.code() or grpc.StatusCode.UNKNOWN
        return _wire_outcome(code, call.details())
    return _Outcome(grpc.StatusCode.UNKNOWN)


async def _outcome_of_aio_call(call: grpc.aio.Call) -> _Outcome:
    return _wire_outcome(await call.code(), await call.details())


def _outcome_of_aio_error(err: grpc.aio.AioRpcError) -> _Outcome:
    return _wire_outcome(err.code(), err.details())


class _ClientStarter:
    """Shared client configuration: filters, address attributes and instruments."""

    __slots__ = ("_filter", "_ignore_health", "_peer_attrs", "_source")

    def __init__(
        self,
        telemetry: Telemetry | None,
        ignore_health_checks: bool,
        filt: GRPCFilter | None,
        server_address: str | None,
        server_port: int | None,
    ) -> None:
        self._source = _InstrumentSource(
            telemetry, _CLIENT_DURATION, "Duration of RPC client calls."
        )
        self._ignore_health = ignore_health_checks
        self._filter = filt
        peer: dict[str, AttributeValue] = {}
        if server_address:
            peer["server.address"] = server_address
            if server_port is not None:
                peer["server.port"] = server_port
        self._peer_attrs = peer

    def start(self, full_method: str) -> _Rpc | None:
        if not _allowed(full_method, self._ignore_health, self._filter):
            return None
        name, rpc_method = _parse_full_method(full_method)
        attrs: dict[str, AttributeValue] = {"rpc.system.name": _RPC_SYSTEM}
        if rpc_method is not None:
            attrs["rpc.method"] = rpc_method
        attrs.update(self._peer_attrs)
        inst = self._source.instruments()
        span = inst.tracer.start_span(name, kind=SpanKind.CLIENT, attributes=attrs)
        return _Rpc(span, inst.duration, attrs, server=False)

    def inject(
        self, metadata: _MetadataPairs | None, rpc: _Rpc | None
    ) -> list[tuple[str, str | bytes]] | None:
        """Return metadata carrying the trace context, or None when nothing was injected."""
        ctx = trace.set_span_in_context(rpc.span) if rpc is not None else None
        injected: list[tuple[str, str]] = []
        self._source.propagator().inject(injected, context=ctx, setter=_META_SETTER)
        if not injected:
            return None
        return _merge_metadata(metadata, injected)


class _SyncClientCallDetails(grpc.ClientCallDetails):
    def __init__(
        self, base: grpc.ClientCallDetails, metadata: list[tuple[str, str | bytes]]
    ) -> None:
        self.method = base.method
        self.timeout = base.timeout
        self.metadata = tuple(metadata)
        self.credentials = base.credentials
        self.wait_for_ready = base.wait_for_ready
        self.compression = base.compression


def _sync_details(
    starter: _ClientStarter, details: grpc.ClientCallDetails, rpc: _Rpc | None
) -> grpc.ClientCallDetails:
    merged = starter.inject(details.metadata, rpc)
    return details if merged is None else _SyncClientCallDetails(details, merged)


def _aio_details(
    starter: _ClientStarter, details: grpc.aio.ClientCallDetails, rpc: _Rpc | None
) -> grpc.aio.ClientCallDetails:
    merged = starter.inject(details.metadata, rpc)
    if merged is None:
        return details
    return grpc.aio.ClientCallDetails(
        method=details.method,
        timeout=details.timeout,
        metadata=grpc.aio.Metadata(*merged),
        credentials=details.credentials,
        wait_for_ready=details.wait_for_ready,
    )


def _abandon_sync_call(call: grpc.Future[Any], rpc: _Rpc) -> None:
    """Cancel a sync call whose wrapper was garbage collected before it finished."""
    if not call.done():
        call.cancel()
    rpc.finish(_outcome_of_sync_call(call) if call.done() else _CANCELLED)


class _DebugErrorString[T](Protocol):
    def debug_error_string(self) -> T: ...


class _FutureTraceback(Protocol):
    def traceback(self, timeout: float | None = None) -> TracebackType | None: ...


class _SyncCall[ResponseT](grpc.Call, _GrpcFuture[ResponseT]):
    """A grpcio sync call that ends its client span when the RPC terminates.

    Every method delegates to grpcio's own call object. The span ends from
    whichever happens first: grpcio's done callback, the caller observing
    the end of the call, a cancel, or the wrapper being garbage collected.
    """

    def __init__(self, inner: _CallFuture[ResponseT], rpc: _Rpc) -> None:
        self._inner = inner
        self._rpc = rpc
        inner.add_done_callback(lambda done: rpc.finish(_outcome_of_sync_call(done)))
        weakref.finalize(self, _abandon_sync_call, inner, rpc)

    def _observe(self) -> None:
        if self._inner.done():
            self._rpc.finish(_outcome_of_sync_call(self._inner))

    # grpc.RpcContext
    def is_active(self) -> bool:
        return self._inner.is_active()

    def time_remaining(self) -> float:
        return self._inner.time_remaining()

    def cancel(self) -> bool:
        cancelled = self._inner.cancel()
        self._observe()
        return cancelled

    def add_callback(self, callback: Callable[[], None]) -> bool:
        return self._inner.add_callback(callback)

    # grpc.Call
    def code(self) -> grpc.StatusCode:
        code = self._inner.code()
        self._observe()
        return code

    def details(self) -> str:
        details = self._inner.details()
        self._observe()
        return details

    def initial_metadata(self) -> tuple[tuple[str, str | bytes], ...]:
        return self._inner.initial_metadata()

    def trailing_metadata(self) -> tuple[tuple[str, str | bytes], ...]:
        metadata = self._inner.trailing_metadata()
        self._observe()
        return metadata

    def debug_error_string(self) -> str:
        return cast("_DebugErrorString[str]", self._inner).debug_error_string()

    # grpc.Future
    def cancelled(self) -> bool:
        return self._inner.cancelled()

    def running(self) -> bool:
        return self._inner.running()

    def done(self) -> bool:
        return self._inner.done()

    def result(self, timeout: float | None = None) -> ResponseT:
        try:
            return self._inner.result(timeout)
        finally:
            self._observe()

    def exception(self, timeout: float | None = None) -> Exception | None:
        try:
            return self._inner.exception(timeout)
        finally:
            self._observe()

    def traceback(self, timeout: float | None = None) -> TracebackType | None:
        try:
            return cast(_FutureTraceback, self._inner).traceback(timeout)
        finally:
            self._observe()

    def add_done_callback(self, fn: Callable[[grpc.Future[ResponseT]], None]) -> None:
        self._inner.add_done_callback(lambda _done: fn(self))


class _SyncStreamCall[ResponseT](_SyncCall[ResponseT]):
    """A streaming grpcio sync call; iteration delegates to grpcio's iterator."""

    def __init__(self, inner: _CallIterator[ResponseT], rpc: _Rpc) -> None:
        super().__init__(cast("_CallFuture[ResponseT]", inner), rpc)
        self._iterator = inner

    def __iter__(self) -> _SyncStreamCall[ResponseT]:
        return self

    def __next__(self) -> ResponseT:
        try:
            return next(self._iterator)
        except (StopIteration, grpc.RpcError):
            self._observe()
            raise


class ClientInterceptor(
    grpc.UnaryUnaryClientInterceptor,
    grpc.UnaryStreamClientInterceptor,
    grpc.StreamUnaryClientInterceptor,
    grpc.StreamStreamClientInterceptor,
):
    """Synchronous grpcio client interceptor covering all four call shapes.

    Pass it to ``grpc.intercept_channel``. ``server_address`` and
    ``server_port`` set the ``server.address`` and ``server.port`` attributes,
    which grpcio does not expose to interceptors.
    """

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
        server_address: str | None = None,
        server_port: int | None = None,
    ) -> None:
        self._starter = _ClientStarter(
            telemetry, ignore_health_checks, filter, server_address, server_port
        )

    def _call_future[RequestT, ResponseT](
        self,
        continuation: Callable[[grpc.ClientCallDetails, RequestT], _CallFuture[ResponseT]],
        details: grpc.ClientCallDetails,
        request: RequestT,
    ) -> _CallFuture[ResponseT]:
        rpc = self._starter.start(details.method)
        new_details = _sync_details(self._starter, details, rpc)
        if rpc is None:
            return continuation(new_details, request)
        try:
            with rpc.activated():
                call = continuation(new_details, request)
        except Exception as exc:
            rpc.finish(_Outcome(grpc.StatusCode.UNKNOWN, None, exc))
            raise
        if call.done():
            # A blocking call (__call__ or with_call) returns a finished outcome.
            rpc.finish(_outcome_of_sync_call(call))
            return call
        return cast("_CallFuture[ResponseT]", _SyncCall(call, rpc))

    def _call_stream[RequestT, ResponseT](
        self,
        continuation: Callable[[grpc.ClientCallDetails, RequestT], _CallIterator[ResponseT]],
        details: grpc.ClientCallDetails,
        request: RequestT,
    ) -> _CallIterator[ResponseT]:
        rpc = self._starter.start(details.method)
        new_details = _sync_details(self._starter, details, rpc)
        if rpc is None:
            return continuation(new_details, request)
        try:
            with rpc.activated():
                call = continuation(new_details, request)
        except Exception as exc:
            rpc.finish(_Outcome(grpc.StatusCode.UNKNOWN, None, exc))
            raise
        return cast("_CallIterator[ResponseT]", _SyncStreamCall(call, rpc))

    def intercept_unary_unary[RequestT, ResponseT](
        self,
        continuation: Callable[[grpc.ClientCallDetails, RequestT], _CallFuture[ResponseT]],
        client_call_details: grpc.ClientCallDetails,
        request: RequestT,
    ) -> _CallFuture[ResponseT]:
        return self._call_future(continuation, client_call_details, request)

    def intercept_unary_stream[RequestT, ResponseT](
        self,
        continuation: Callable[[grpc.ClientCallDetails, RequestT], _CallIterator[ResponseT]],
        client_call_details: grpc.ClientCallDetails,
        request: RequestT,
    ) -> _CallIterator[ResponseT]:
        return self._call_stream(continuation, client_call_details, request)

    def intercept_stream_unary[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.ClientCallDetails, Iterator[RequestT]], _CallFuture[ResponseT]
        ],
        client_call_details: grpc.ClientCallDetails,
        request_iterator: Iterator[RequestT],
    ) -> _CallFuture[ResponseT]:
        return self._call_future(continuation, client_call_details, request_iterator)

    def intercept_stream_stream[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.ClientCallDetails, Iterator[RequestT]], _CallIterator[ResponseT]
        ],
        client_call_details: grpc.ClientCallDetails,
        request_iterator: Iterator[RequestT],
    ) -> _CallIterator[ResponseT]:
        return self._call_stream(continuation, client_call_details, request_iterator)


# --------------------------------------------------------------------------
# grpc.aio client side
# --------------------------------------------------------------------------


class _AioRpcTracker:
    """Ends an aio client span from grpcio's done callback when no caller does."""

    __slots__ = ("_pending", "rpc")

    def __init__(self, rpc: _Rpc) -> None:
        self.rpc = rpc
        self._pending: asyncio.Task[None] | None = None

    def on_done(self, call: grpc.aio.Call) -> None:
        if self.rpc.finished:
            return
        if call.cancelled():
            self.rpc.finish(_CANCELLED)
            return
        # The status is final but only readable through coroutines.
        self._pending = asyncio.get_running_loop().create_task(self._finish_from(call))

    async def _finish_from(self, call: grpc.aio.Call) -> None:
        self.rpc.finish(await _outcome_of_aio_call(call))


class _AioCall(grpc.aio.Call):
    """Delegates every ``grpc.aio.Call`` method to grpcio's call object.

    The span ends when the caller observes the end of the call, when the
    call is cancelled, or from grpcio's done callback when the call ends
    unobserved, for example because the caller abandoned it.
    """

    def __init__(self, inner: grpc.aio.Call, rpc: _Rpc) -> None:
        self._inner = inner
        self._rpc = rpc
        inner.add_done_callback(_AioRpcTracker(rpc).on_done)

    async def _finish_from_inner(self) -> None:
        if not self._rpc.finished:
            self._rpc.finish(await _outcome_of_aio_call(self._inner))

    def _finish_from_error(self, err: BaseException) -> None:
        if isinstance(err, grpc.aio.AioRpcError):
            self._rpc.finish(_outcome_of_aio_error(err))
        elif isinstance(err, asyncio.CancelledError):
            self._rpc.finish(_CANCELLED)

    def cancelled(self) -> bool:
        return self._inner.cancelled()

    def done(self) -> bool:
        return self._inner.done()

    def time_remaining(self) -> float | None:
        return self._inner.time_remaining()

    def cancel(self) -> bool:
        cancelled = self._inner.cancel()
        if cancelled:
            self._rpc.finish(_CANCELLED)
        return cancelled

    def add_done_callback(self, callback: Callable[[Any], None]) -> None:
        self._inner.add_done_callback(lambda _call: callback(self))

    async def initial_metadata(self) -> grpc.aio.Metadata:
        return await self._inner.initial_metadata()

    async def trailing_metadata(self) -> grpc.aio.Metadata:
        return await self._inner.trailing_metadata()

    async def code(self) -> grpc.StatusCode:
        return await self._inner.code()

    async def details(self) -> str:
        return await self._inner.details()

    async def wait_for_connection(self) -> None:
        await self._inner.wait_for_connection()

    async def debug_error_string(self) -> str:
        return await cast("_DebugErrorString[Awaitable[str]]", self._inner).debug_error_string()


async def _await_response[ResponseT](
    wrapper: _AioCall, awaitable: Awaitable[ResponseT]
) -> ResponseT:
    try:
        response = await awaitable
    except (grpc.aio.AioRpcError, asyncio.CancelledError) as err:
        wrapper._finish_from_error(err)  # pyright: ignore[reportPrivateUsage]
        raise
    await wrapper._finish_from_inner()  # pyright: ignore[reportPrivateUsage]
    return response


async def _iterate_responses[ResponseT](
    wrapper: _AioCall, responses: AsyncIterator[ResponseT]
) -> AsyncIterator[ResponseT]:
    try:
        async for response in responses:
            yield response
    except GeneratorExit:
        wrapper.cancel()
        raise
    except (grpc.aio.AioRpcError, asyncio.CancelledError) as err:
        wrapper._finish_from_error(err)  # pyright: ignore[reportPrivateUsage]
        raise
    await wrapper._finish_from_inner()  # pyright: ignore[reportPrivateUsage]


async def _read_response[ResponseT](
    wrapper: _AioCall, read: Callable[[], Awaitable[object]]
) -> object:
    try:
        message = await read()
    except (grpc.aio.AioRpcError, asyncio.CancelledError) as err:
        wrapper._finish_from_error(err)  # pyright: ignore[reportPrivateUsage]
        raise
    if wrapper.done():
        await wrapper._finish_from_inner()  # pyright: ignore[reportPrivateUsage]
    return message


class _AioUnaryUnaryCall[RequestT, ResponseT](
    _AioCall, grpc.aio.UnaryUnaryCall[RequestT, ResponseT]
):
    def __init__(self, inner: grpc.aio.UnaryUnaryCall[RequestT, ResponseT], rpc: _Rpc) -> None:
        super().__init__(inner, rpc)
        self._call = inner

    def __await__(self) -> Generator[None, None, ResponseT]:
        return _await_response(self, self._call).__await__()


class _AioUnaryStreamCall[RequestT, ResponseT](
    _AioCall, grpc.aio.UnaryStreamCall[RequestT, ResponseT]
):
    def __init__(self, inner: grpc.aio.UnaryStreamCall[RequestT, ResponseT], rpc: _Rpc) -> None:
        super().__init__(inner, rpc)
        self._call = inner

    def __aiter__(self) -> AsyncIterator[ResponseT]:
        return _iterate_responses(self, aiter(self._call))

    async def read(self) -> object:
        return await _read_response(self, self._call.read)


class _AioStreamUnaryCall[RequestT, ResponseT](
    _AioCall, grpc.aio.StreamUnaryCall[RequestT, ResponseT]
):
    def __init__(self, inner: grpc.aio.StreamUnaryCall[RequestT, ResponseT], rpc: _Rpc) -> None:
        super().__init__(inner, rpc)
        self._call = inner

    async def write(self, request: RequestT) -> None:
        await self._call.write(request)

    async def done_writing(self) -> None:
        await self._call.done_writing()

    @property
    def _done_writing_flag(self) -> bool:
        # grpc.aio's write() reads this from the call an interceptor returns,
        # as grpc's own StreamStreamCallResponseIterator wrapper provides it.
        return bool(getattr(self._call, "_done_writing_flag", False))

    def __await__(self) -> Generator[None, None, ResponseT]:
        return _await_response(self, self._call).__await__()


class _AioStreamStreamCall[RequestT, ResponseT](
    _AioCall, grpc.aio.StreamStreamCall[RequestT, ResponseT]
):
    def __init__(self, inner: grpc.aio.StreamStreamCall[RequestT, ResponseT], rpc: _Rpc) -> None:
        super().__init__(inner, rpc)
        self._call = inner

    def __aiter__(self) -> AsyncIterator[ResponseT]:
        return _iterate_responses(self, aiter(self._call))

    async def read(self) -> object:
        return await _read_response(self, self._call.read)

    async def write(self, request: RequestT) -> None:
        await self._call.write(request)

    async def done_writing(self) -> None:
        await self._call.done_writing()

    @property
    def _done_writing_flag(self) -> bool:
        # grpc.aio's write() reads this from the call an interceptor returns,
        # as grpc's own StreamStreamCallResponseIterator wrapper provides it.
        return bool(getattr(self._call, "_done_writing_flag", False))


class _AioClientBase:
    """Configuration shared by the four per-shape ``grpc.aio`` client interceptors."""

    def __init__(self, starter: _ClientStarter) -> None:
        self._starter = starter

    async def _start[RequestArgT, CallT](
        self,
        continuation: Callable[[grpc.aio.ClientCallDetails, RequestArgT], Awaitable[CallT]],
        details: grpc.aio.ClientCallDetails,
        request: RequestArgT,
    ) -> tuple[CallT, _Rpc | None]:
        rpc = self._starter.start(_method_name(details.method))
        new_details = _aio_details(self._starter, details, rpc)
        if rpc is None:
            return await continuation(new_details, request), None
        try:
            with rpc.activated():
                call = await continuation(new_details, request)
        except asyncio.CancelledError:
            rpc.finish(_CANCELLED)
            raise
        except grpc.aio.AioRpcError as err:
            rpc.finish(_outcome_of_aio_error(err))
            raise
        except Exception as exc:
            rpc.finish(_Outcome(grpc.StatusCode.UNKNOWN, None, exc))
            raise
        return call, rpc


class AioUnaryUnaryClientInterceptor(_AioClientBase, grpc.aio.UnaryUnaryClientInterceptor):
    """``grpc.aio`` client interceptor for unary-unary calls."""

    async def intercept_unary_unary[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.aio.ClientCallDetails, RequestT],
            Awaitable[grpc.aio.UnaryUnaryCall[RequestT, ResponseT]],
        ],
        client_call_details: grpc.aio.ClientCallDetails,
        request: RequestT,
    ) -> ResponseT | grpc.aio.UnaryUnaryCall[RequestT, ResponseT]:
        call, rpc = await self._start(continuation, client_call_details, request)
        return call if rpc is None else _AioUnaryUnaryCall(call, rpc)


class AioUnaryStreamClientInterceptor(_AioClientBase, grpc.aio.UnaryStreamClientInterceptor):
    """``grpc.aio`` client interceptor for unary-stream calls."""

    async def intercept_unary_stream[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.aio.ClientCallDetails, RequestT],
            Awaitable[grpc.aio.UnaryStreamCall[RequestT, ResponseT]],
        ],
        client_call_details: grpc.aio.ClientCallDetails,
        request: RequestT,
    ) -> AsyncIterator[ResponseT] | grpc.aio.UnaryStreamCall[RequestT, ResponseT]:
        call, rpc = await self._start(continuation, client_call_details, request)
        return call if rpc is None else _AioUnaryStreamCall(call, rpc)


class AioStreamUnaryClientInterceptor(_AioClientBase, grpc.aio.StreamUnaryClientInterceptor):
    """``grpc.aio`` client interceptor for stream-unary calls."""

    async def intercept_stream_unary[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.aio.ClientCallDetails, AsyncIterable[RequestT] | Iterable[RequestT]],
            Awaitable[grpc.aio.StreamUnaryCall[RequestT, ResponseT]],
        ],
        client_call_details: grpc.aio.ClientCallDetails,
        request_iterator: AsyncIterable[RequestT] | Iterable[RequestT],
    ) -> ResponseT | grpc.aio.StreamUnaryCall[RequestT, ResponseT]:
        call, rpc = await self._start(continuation, client_call_details, request_iterator)
        return call if rpc is None else _AioStreamUnaryCall(call, rpc)


class AioStreamStreamClientInterceptor(_AioClientBase, grpc.aio.StreamStreamClientInterceptor):
    """``grpc.aio`` client interceptor for stream-stream calls."""

    async def intercept_stream_stream[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.aio.ClientCallDetails, AsyncIterable[RequestT] | Iterable[RequestT]],
            Awaitable[grpc.aio.StreamStreamCall[RequestT, ResponseT]],
        ],
        client_call_details: grpc.aio.ClientCallDetails,
        request_iterator: AsyncIterable[RequestT] | Iterable[RequestT],
    ) -> AsyncIterator[ResponseT] | grpc.aio.StreamStreamCall[RequestT, ResponseT]:
        call, rpc = await self._start(continuation, client_call_details, request_iterator)
        return call if rpc is None else _AioStreamStreamCall(call, rpc)


# --------------------------------------------------------------------------
# Server side
# --------------------------------------------------------------------------


@runtime_checkable
class _StatusContext(Protocol):
    """Status accessors grpcio's sync and aio servicer contexts provide at runtime."""

    def code(self) -> grpc.StatusCode | int | None: ...

    def details(self) -> str | bytes | None: ...


@runtime_checkable
class _ActiveContext(Protocol):
    def is_active(self) -> bool: ...


@runtime_checkable
class _CancellableContext(Protocol):
    def cancelled(self) -> bool: ...


def _context_status(servicer_ctx: object) -> tuple[grpc.StatusCode, str | None] | None:
    """Return the status a handler set on its context, or None if it set none."""
    if not isinstance(servicer_ctx, _StatusContext):
        return None
    code = servicer_ctx.code()
    if not isinstance(code, grpc.StatusCode):
        return None
    details = servicer_ctx.details()
    if isinstance(details, bytes):
        details = details.decode("utf-8", "replace")
    return code, details or None


def _context_cancelled(servicer_ctx: object) -> bool:
    if isinstance(servicer_ctx, _ActiveContext):
        return not servicer_ctx.is_active()
    if isinstance(servicer_ctx, _CancellableContext):
        return servicer_ctx.cancelled()
    return False


def _outcome_after_return(servicer_ctx: object) -> _Outcome:
    status = _context_status(servicer_ctx)
    if status is not None:
        return _Outcome(status[0], status[1])
    if _context_cancelled(servicer_ctx):
        return _CANCELLED
    return _Outcome(grpc.StatusCode.OK)


def _outcome_after_error(servicer_ctx: object, exc: Exception) -> _Outcome:
    """Map a handler exception to the status grpcio sends for it.

    ``abort`` sets the context status and raises a sentinel, so a non-OK
    context status wins. Any other exception is sent as ``UNKNOWN``.
    """
    status = _context_status(servicer_ctx)
    if status is not None and status[0] is not grpc.StatusCode.OK:
        return _Outcome(status[0], status[1])
    if isinstance(exc, grpc.RpcError) and _context_cancelled(servicer_ctx):
        return _CANCELLED
    return _Outcome(grpc.StatusCode.UNKNOWN, None, exc)


@dataclass(frozen=True, slots=True)
class _ServerCall:
    """Per-RPC server state computed once from the handler call details."""

    source: _InstrumentSource
    full_method: str
    metadata: _MetadataPairs | None
    instrumented: bool
    public_endpoint: bool

    def parent(self) -> tuple[Context, list[Link]]:
        hdrs = _metadata_to_dict(self.metadata)
        extracted = self.source.propagator().extract(hdrs, context=Context(), getter=_META_GETTER)
        if not self.public_endpoint:
            return extracted, []
        remote = trace.get_current_span(extracted).get_span_context()
        links = [Link(remote)] if remote.is_valid else []
        # Keep inbound baggage, drop the remote parent (otelgrpc WithPublicEndpoint).
        return trace.set_span_in_context(INVALID_SPAN, extracted), links

    @contextlib.contextmanager
    def run(self) -> Generator[_Rpc | None]:
        """Attach the inbound context, and the server span when instrumented."""
        parent, links = self.parent()
        parent_token = context.attach(parent)
        try:
            if not self.instrumented:
                yield None
                return
            name, rpc_method = _parse_full_method(self.full_method)
            attrs: dict[str, AttributeValue] = {"rpc.system.name": _RPC_SYSTEM}
            if rpc_method is not None:
                attrs["rpc.method"] = rpc_method
            inst = self.source.instruments()
            span = inst.tracer.start_span(
                name, context=parent, kind=SpanKind.SERVER, attributes=attrs, links=links
            )
            rpc = _Rpc(span, inst.duration, attrs, server=True)
            with rpc.activated():
                yield rpc
        finally:
            context.detach(parent_token)


def _wrap_sync_unary(call: _ServerCall, fn: _Behaviour) -> _Behaviour:
    def handler(request: object, servicer_ctx: object) -> object:
        with call.run() as rpc:
            if rpc is None:
                return fn(request, servicer_ctx)
            try:
                response = fn(request, servicer_ctx)
            except Exception as exc:
                rpc.finish(_outcome_after_error(servicer_ctx, exc))
                raise
            rpc.finish(_outcome_after_return(servicer_ctx))
            return response

    return handler


def _wrap_sync_stream(call: _ServerCall, fn: _Behaviour) -> _Behaviour:
    def handler(request: object, servicer_ctx: object) -> Iterator[object]:
        with call.run() as rpc:
            if rpc is None:
                yield from cast("Iterator[object]", fn(request, servicer_ctx))
                return
            try:
                yield from cast("Iterator[object]", fn(request, servicer_ctx))
            except GeneratorExit:
                # grpcio dropped the stream: the client cancelled or went away.
                rpc.finish(_CANCELLED)
                raise
            except Exception as exc:
                rpc.finish(_outcome_after_error(servicer_ctx, exc))
                raise
            rpc.finish(_outcome_after_return(servicer_ctx))

    return handler


def _wrap_aio_unary(call: _ServerCall, fn: _Behaviour) -> _Behaviour:
    """Wrap a coroutine handler: unary responses, or a stream written with ``context.write``."""

    async def handler(request: object, servicer_ctx: object) -> object:
        with call.run() as rpc:
            awaitable = cast("Awaitable[object]", fn(request, servicer_ctx))
            if rpc is None:
                return await awaitable
            try:
                response = await awaitable
            except asyncio.CancelledError:
                rpc.finish(_CANCELLED)
                raise
            except Exception as exc:
                rpc.finish(_outcome_after_error(servicer_ctx, exc))
                raise
            rpc.finish(_outcome_after_return(servicer_ctx))
            return response

    return handler


def _wrap_aio_stream(call: _ServerCall, fn: _Behaviour) -> _Behaviour:
    """Wrap an async generator handler."""

    async def handler(request: object, servicer_ctx: object) -> AsyncIterator[object]:
        with call.run() as rpc:
            responses = cast("AsyncGenerator[object]", fn(request, servicer_ctx))
            async with contextlib.aclosing(responses):
                if rpc is None:
                    async for item in responses:
                        yield item
                    return
                try:
                    async for item in responses:
                        yield item
                except (asyncio.CancelledError, GeneratorExit):
                    rpc.finish(_CANCELLED)
                    raise
                except Exception as exc:
                    rpc.finish(_outcome_after_error(servicer_ctx, exc))
                    raise
                rpc.finish(_outcome_after_return(servicer_ctx))

    return handler


def _wrap_aio_handler(call: _ServerCall, fn: _Behaviour, *, streaming: bool) -> _Behaviour:
    """Wrap a handler registered on a ``grpc.aio`` server, keeping its form.

    ``grpc.aio`` dispatches on the handler's form, so the wrapper must be a
    coroutine function, an async generator function, or a plain function
    exactly when the wrapped handler is.
    """
    if inspect.isasyncgenfunction(fn):
        return _wrap_aio_stream(call, fn)
    if inspect.iscoroutinefunction(fn):
        return _wrap_aio_unary(call, fn)
    return _wrap_sync_stream(call, fn) if streaming else _wrap_sync_unary(call, fn)


def _rebuild_handler(
    handler: grpc.RpcMethodHandler[Any, Any],
    wrap: Callable[[_Behaviour, bool], _Behaviour],
) -> grpc.RpcMethodHandler[Any, Any]:
    ser = handler.response_serializer
    de = handler.request_deserializer
    if handler.unary_unary is not None:
        return grpc.unary_unary_rpc_method_handler(
            wrap(handler.unary_unary, False), request_deserializer=de, response_serializer=ser
        )
    if handler.unary_stream is not None:
        return grpc.unary_stream_rpc_method_handler(
            wrap(handler.unary_stream, True), request_deserializer=de, response_serializer=ser
        )
    if handler.stream_unary is not None:
        return grpc.stream_unary_rpc_method_handler(
            wrap(handler.stream_unary, False), request_deserializer=de, response_serializer=ser
        )
    if handler.stream_stream is not None:
        return grpc.stream_stream_rpc_method_handler(
            wrap(handler.stream_stream, True), request_deserializer=de, response_serializer=ser
        )
    return handler


class _ServerConfig:
    __slots__ = ("_filter", "_ignore_health", "_public_endpoint", "_source")

    def __init__(
        self,
        telemetry: Telemetry | None,
        public_endpoint: bool,
        ignore_health_checks: bool,
        filt: GRPCFilter | None,
    ) -> None:
        self._source = _InstrumentSource(
            telemetry, _SERVER_DURATION, "Duration of RPC server calls."
        )
        self._public_endpoint = public_endpoint
        self._ignore_health = ignore_health_checks
        self._filter = filt

    def call(self, details: grpc.HandlerCallDetails) -> _ServerCall:
        full_method = _method_name(details.method)
        return _ServerCall(
            source=self._source,
            full_method=full_method,
            metadata=details.invocation_metadata,
            instrumented=_allowed(full_method, self._ignore_health, self._filter),
            public_endpoint=self._public_endpoint,
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
        self._config = _ServerConfig(telemetry, public_endpoint, ignore_health_checks, filter)

    def intercept_service[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.HandlerCallDetails], grpc.RpcMethodHandler[RequestT, ResponseT] | None
        ],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler[RequestT, ResponseT] | None:
        handler = continuation(handler_call_details)
        if handler is None:
            return None
        call = self._config.call(handler_call_details)
        return _rebuild_handler(
            handler,
            lambda fn, streaming: (_wrap_sync_stream if streaming else _wrap_sync_unary)(call, fn),
        )


class AioServerInterceptor(grpc.aio.ServerInterceptor):
    """Asynchronous ``grpc.aio`` server interceptor.

    Supports coroutine handlers (including streaming handlers that call
    ``context.write``), async generator handlers, and plain handlers.
    """

    def __init__(
        self,
        *,
        telemetry: Telemetry | None = None,
        public_endpoint: bool = False,
        ignore_health_checks: bool = False,
        filter: GRPCFilter | None = None,
    ) -> None:
        self._config = _ServerConfig(telemetry, public_endpoint, ignore_health_checks, filter)

    async def intercept_service[RequestT, ResponseT](
        self,
        continuation: Callable[
            [grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler[RequestT, ResponseT] | None]
        ],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler[RequestT, ResponseT] | None:
        handler = await continuation(handler_call_details)
        if handler is None:
            return None
        call = self._config.call(handler_call_details)
        return _rebuild_handler(
            handler, lambda fn, streaming: _wrap_aio_handler(call, fn, streaming=streaming)
        )


# --------------------------------------------------------------------------
# Constructors
# --------------------------------------------------------------------------


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
    server_address: str | None = None,
    server_port: int | None = None,
) -> ClientInterceptor:
    """Create a synchronous grpcio client interceptor for ``grpc.intercept_channel``."""
    return ClientInterceptor(
        telemetry=telemetry,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
        server_address=server_address,
        server_port=server_port,
    )


def aio_server_interceptor(
    *,
    telemetry: Telemetry | None = None,
    public_endpoint: bool = False,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
) -> AioServerInterceptor:
    """Create an asynchronous ``grpc.aio`` server interceptor."""
    return AioServerInterceptor(
        telemetry=telemetry,
        public_endpoint=public_endpoint,
        ignore_health_checks=ignore_health_checks,
        filter=filter,
    )


def aio_client_interceptors(
    *,
    telemetry: Telemetry | None = None,
    ignore_health_checks: bool = False,
    filter: GRPCFilter | None = None,
    server_address: str | None = None,
    server_port: int | None = None,
) -> list[grpc.aio.ClientInterceptor]:
    """Create the ``grpc.aio`` client interceptors, one per call shape.

    ``grpc.aio`` registers each interceptor object for a single call shape,
    so pass the whole list as the channel's ``interceptors=`` argument::

        grpc.aio.insecure_channel(target, interceptors=aio_client_interceptors())
    """
    starter = _ClientStarter(telemetry, ignore_health_checks, filter, server_address, server_port)
    return [
        AioUnaryUnaryClientInterceptor(starter),
        AioUnaryStreamClientInterceptor(starter),
        AioStreamUnaryClientInterceptor(starter),
        AioStreamStreamClientInterceptor(starter),
    ]


__all__ = [
    "AioServerInterceptor",
    "AioStreamStreamClientInterceptor",
    "AioStreamUnaryClientInterceptor",
    "AioUnaryStreamClientInterceptor",
    "AioUnaryUnaryClientInterceptor",
    "ClientInterceptor",
    "GRPCFilter",
    "ServerInterceptor",
    "aio_client_interceptors",
    "aio_server_interceptor",
    "client_interceptor",
    "server_interceptor",
]
