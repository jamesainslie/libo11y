"""In-process OTLP/HTTP and OTLP/gRPC receivers decoding real protobuf payloads."""

from __future__ import annotations

import gzip
import http.server
import importlib
import socket
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Literal

from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
    ExportLogsServiceResponse,
)
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest,
    ExportMetricsServiceResponse,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)

from libo11y.errors import UnsupportedProtocol

Signal = Literal["traces", "metrics", "logs"]
"""The OTLP signal a request carried."""

type Metadata = dict[str, str | bytes]
"""One gRPC call's invocation metadata. Keys ending in ``-bin`` carry bytes."""


def _netloc(host: str, port: int) -> str:
    """Render host and port for a URL, bracketing an IPv6 literal."""
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


@dataclass(frozen=True, slots=True)
class ReceivedTelemetry:
    """Decoded OTLP protobuf batches received over HTTP or gRPC."""

    trace_requests: tuple[ExportTraceServiceRequest, ...]
    metric_requests: tuple[ExportMetricsServiceRequest, ...]
    log_requests: tuple[ExportLogsServiceRequest, ...]

    def span_names(self) -> list[str]:
        out: list[str] = []
        for req in self.trace_requests:
            for rs in req.resource_spans:
                for ss in rs.scope_spans:
                    for sp in ss.spans:
                        out.append(sp.name)
        return out

    def metric_names(self) -> list[str]:
        out: list[str] = []
        for req in self.metric_requests:
            for rm in req.resource_metrics:
                for sm in rm.scope_metrics:
                    for m in sm.metrics:
                        out.append(m.name)
        return out

    def log_bodies(self) -> list[str]:
        out: list[str] = []
        for req in self.log_requests:
            for rl in req.resource_logs:
                for sl in rl.scope_logs:
                    for lr in sl.log_records:
                        out.append(lr.body.string_value)
        return out


class _HTTPServer(http.server.ThreadingHTTPServer):
    # Join request threads on server_close, so close() leaves none behind.
    daemon_threads = False
    block_on_close = True


class _HTTPServer6(_HTTPServer):
    address_family = socket.AF_INET6


class OTLPHTTPReceiver:
    """In-process loopback OTLP/HTTP protobuf receiver for wire tests.

    It decodes plain, gzip and deflate request bodies and records each
    request's headers. ``close()``, or leaving the ``with`` block, stops the
    server, joins its threads and releases the port.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._closed = False
        self._lock = threading.Lock()
        self._traces: list[ExportTraceServiceRequest] = []
        self._metrics: list[ExportMetricsServiceRequest] = []
        self._logs: list[ExportLogsServiceRequest] = []
        self._headers: list[tuple[Signal, dict[str, str]]] = []

        receiver = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:
                del format, args

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                enc = (self.headers.get("Content-Encoding") or "").strip().lower()
                if enc == "gzip":
                    body = gzip.decompress(body)
                elif enc == "deflate":
                    body = zlib.decompress(body)

                hdrs = {k.lower(): v for k, v in self.headers.items()}
                path = self.path.split("?", 1)[0]
                if path == "/v1/traces":
                    req_t = ExportTraceServiceRequest()
                    req_t.ParseFromString(body)
                    with receiver._lock:
                        receiver._traces.append(req_t)
                        receiver._headers.append(("traces", hdrs))
                    resp = ExportTraceServiceResponse().SerializeToString()
                elif path == "/v1/metrics":
                    req_m = ExportMetricsServiceRequest()
                    req_m.ParseFromString(body)
                    with receiver._lock:
                        receiver._metrics.append(req_m)
                        receiver._headers.append(("metrics", hdrs))
                    resp = ExportMetricsServiceResponse().SerializeToString()
                elif path == "/v1/logs":
                    req_l = ExportLogsServiceRequest()
                    req_l.ParseFromString(body)
                    with receiver._lock:
                        receiver._logs.append(req_l)
                        receiver._headers.append(("logs", hdrs))
                    resp = ExportLogsServiceResponse().SerializeToString()
                else:
                    self.send_response(404)
                    self.end_headers()
                    return

                self.send_response(200)
                self.send_header("Content-Type", "application/x-protobuf")
                self.send_header("Content-Length", str(len(resp)))
                self.end_headers()
                self.wfile.write(resp)

        server_class = _HTTPServer6 if ":" in host else _HTTPServer
        self._server = server_class((host, port), _Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="libo11y-otlp-http-receiver",
            daemon=True,
        )
        self._thread.start()

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    @property
    def endpoint(self) -> str:
        """The base URL exporters send to, on the host the receiver bound."""
        return f"http://{_netloc(self._host, self.port)}"

    def headers(self, signal: Signal | None = None) -> list[dict[str, str]]:
        """Return the lowercased headers of each request, for one signal or all, in order."""
        with self._lock:
            return [h for s, h in self._headers if signal is None or s == signal]

    def received(self) -> ReceivedTelemetry:
        with self._lock:
            return ReceivedTelemetry(
                trace_requests=tuple(self._traces),
                metric_requests=tuple(self._metrics),
                log_requests=tuple(self._logs),
            )

    def close(self) -> None:
        """Stop serving, join the server's threads and release the port. Idempotent."""
        if self._closed:
            return
        self._closed = True
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)

    def __enter__(self) -> OTLPHTTPReceiver:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        self.close()


def _invocation_metadata(context: Any) -> Metadata:
    """Copy a servicer context's invocation metadata into a plain dict."""
    pairs: Any = context.invocation_metadata()
    out: Metadata = {}
    for item in pairs:
        key: str = item.key
        value: str | bytes = item.value
        out[key] = value
    return out


class OTLPGRPCReceiver:
    """In-process loopback OTLP/gRPC protobuf receiver for wire tests.

    It needs the ``grpc`` extra (``pip install 'libo11y[grpc]'``). gRPC
    decompresses gzip calls itself. The receiver records each call's
    invocation metadata. ``close()``, or leaving the ``with`` block, stops the
    server, shuts its worker threads down and releases the port.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        try:
            grpc: Any = importlib.import_module("grpc")
            trace_grpc: Any = importlib.import_module(
                "opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc"
            )
            metrics_grpc: Any = importlib.import_module(
                "opentelemetry.proto.collector.metrics.v1.metrics_service_pb2_grpc"
            )
            logs_grpc: Any = importlib.import_module(
                "opentelemetry.proto.collector.logs.v1.logs_service_pb2_grpc"
            )
        except ImportError as exc:
            raise UnsupportedProtocol(
                "o11y: OTLPGRPCReceiver requires optional dependencies; "
                "install with `pip install 'libo11y[grpc]'`"
            ) from exc

        self._host = host
        self._closed = False
        self._lock = threading.Lock()
        self._traces: list[ExportTraceServiceRequest] = []
        self._metrics: list[ExportMetricsServiceRequest] = []
        self._logs: list[ExportLogsServiceRequest] = []
        self._metadata: list[tuple[Signal, Metadata]] = []

        receiver = self

        class _TraceServicer(trace_grpc.TraceServiceServicer):
            def Export(self, request: ExportTraceServiceRequest, context: Any) -> Any:  # noqa: N802
                metadata = _invocation_metadata(context)
                with receiver._lock:
                    receiver._traces.append(request)
                    receiver._metadata.append(("traces", metadata))
                return ExportTraceServiceResponse()

        class _MetricsServicer(metrics_grpc.MetricsServiceServicer):
            def Export(self, request: ExportMetricsServiceRequest, context: Any) -> Any:  # noqa: N802
                metadata = _invocation_metadata(context)
                with receiver._lock:
                    receiver._metrics.append(request)
                    receiver._metadata.append(("metrics", metadata))
                return ExportMetricsServiceResponse()

        class _LogsServicer(logs_grpc.LogsServiceServicer):
            def Export(self, request: ExportLogsServiceRequest, context: Any) -> Any:  # noqa: N802
                metadata = _invocation_metadata(context)
                with receiver._lock:
                    receiver._logs.append(request)
                    receiver._metadata.append(("logs", metadata))
                return ExportLogsServiceResponse()

        self._executor = ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="libo11y-otlp-grpc-receiver"
        )
        self._server: Any = grpc.server(self._executor)
        trace_grpc.add_TraceServiceServicer_to_server(_TraceServicer(), self._server)
        metrics_grpc.add_MetricsServiceServicer_to_server(_MetricsServicer(), self._server)
        logs_grpc.add_LogsServiceServicer_to_server(_LogsServicer(), self._server)
        self._port: int = int(self._server.add_insecure_port(_netloc(host, port)))
        self._server.start()

    @property
    def port(self) -> int:
        return self._port

    @property
    def endpoint(self) -> str:
        """The base URL exporters send to, on the host the receiver bound."""
        return f"http://{_netloc(self._host, self._port)}"

    def metadata(self, signal: Signal | None = None) -> list[Metadata]:
        """Return the invocation metadata of each call, for one signal or all, in order."""
        with self._lock:
            return [m for s, m in self._metadata if signal is None or s == signal]

    def received(self) -> ReceivedTelemetry:
        with self._lock:
            return ReceivedTelemetry(
                trace_requests=tuple(self._traces),
                metric_requests=tuple(self._metrics),
                log_requests=tuple(self._logs),
            )

    def close(self) -> None:
        """Stop the server, shut its worker threads down and release the port. Idempotent."""
        if self._closed:
            return
        self._closed = True
        self._server.stop(grace=1.0).wait(timeout=5.0)
        self._executor.shutdown(wait=True)

    def __enter__(self) -> OTLPGRPCReceiver:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        del exc_type, exc_val, exc_tb
        self.close()
