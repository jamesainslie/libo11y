"""In-process OTLP/HTTP and OTLP/gRPC receivers decoding real protobuf payloads."""

from __future__ import annotations

import gzip
import http.server
import importlib
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from types import TracebackType
from typing import Any

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


class OTLPHTTPReceiver:
    """In-process loopback OTLP/HTTP protobuf receiver for wire tests."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._lock = threading.Lock()
        self._traces: list[ExportTraceServiceRequest] = []
        self._metrics: list[ExportMetricsServiceRequest] = []
        self._logs: list[ExportLogsServiceRequest] = []
        self._headers: list[dict[str, str]] = []

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
                        receiver._headers.append(hdrs)
                    resp = ExportTraceServiceResponse().SerializeToString()
                elif path == "/v1/metrics":
                    req_m = ExportMetricsServiceRequest()
                    req_m.ParseFromString(body)
                    with receiver._lock:
                        receiver._metrics.append(req_m)
                        receiver._headers.append(hdrs)
                    resp = ExportMetricsServiceResponse().SerializeToString()
                elif path == "/v1/logs":
                    req_l = ExportLogsServiceRequest()
                    req_l.ParseFromString(body)
                    with receiver._lock:
                        receiver._logs.append(req_l)
                        receiver._headers.append(hdrs)
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

        self._server = http.server.ThreadingHTTPServer((host, port), _Handler)
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
        return f"http://127.0.0.1:{self.port}"

    def headers(self) -> list[dict[str, str]]:
        with self._lock:
            return list(self._headers)

    def received(self) -> ReceivedTelemetry:
        with self._lock:
            return ReceivedTelemetry(
                trace_requests=tuple(self._traces),
                metric_requests=tuple(self._metrics),
                log_requests=tuple(self._logs),
            )

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2.0)

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


class OTLPGRPCReceiver:
    """In-process loopback OTLP/gRPC protobuf receiver for wire tests."""

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

        self._lock = threading.Lock()
        self._traces: list[ExportTraceServiceRequest] = []
        self._metrics: list[ExportMetricsServiceRequest] = []
        self._logs: list[ExportLogsServiceRequest] = []

        receiver = self

        class _TraceServicer(trace_grpc.TraceServiceServicer):
            def Export(self, request: ExportTraceServiceRequest, context: Any) -> Any:  # noqa: N802
                del context
                with receiver._lock:
                    receiver._traces.append(request)
                return ExportTraceServiceResponse()

        class _MetricsServicer(metrics_grpc.MetricsServiceServicer):
            def Export(self, request: ExportMetricsServiceRequest, context: Any) -> Any:  # noqa: N802
                del context
                with receiver._lock:
                    receiver._metrics.append(request)
                return ExportMetricsServiceResponse()

        class _LogsServicer(logs_grpc.LogsServiceServicer):
            def Export(self, request: ExportLogsServiceRequest, context: Any) -> Any:  # noqa: N802
                del context
                with receiver._lock:
                    receiver._logs.append(request)
                return ExportLogsServiceResponse()

        self._server: Any = grpc.server(ThreadPoolExecutor(max_workers=4))
        trace_grpc.add_TraceServiceServicer_to_server(_TraceServicer(), self._server)
        metrics_grpc.add_MetricsServiceServicer_to_server(_MetricsServicer(), self._server)
        logs_grpc.add_LogsServiceServicer_to_server(_LogsServicer(), self._server)
        self._port: int = int(self._server.add_insecure_port(f"{host}:{port}"))
        self._server.start()

    @property
    def port(self) -> int:
        return self._port

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    def received(self) -> ReceivedTelemetry:
        with self._lock:
            return ReceivedTelemetry(
                trace_requests=tuple(self._traces),
                metric_requests=tuple(self._metrics),
                log_requests=tuple(self._logs),
            )

    def close(self) -> None:
        self._server.stop(grace=1.0).wait(timeout=2.0)

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
