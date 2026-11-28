"""Contract tests for the in-process OTLP receivers: host, gzip, metadata and cleanup."""

from __future__ import annotations

import gzip
import importlib
import logging
import socket
import subprocess
import sys
import threading
import urllib.request
from collections.abc import Callable
from typing import Any

import grpc
import pytest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

import libo11y
from libo11y.errors import UnsupportedProtocol
from libo11y.testing import OTLPGRPCReceiver, OTLPHTTPReceiver

Receiver = OTLPHTTPReceiver | OTLPGRPCReceiver
ReceiverFactory = Callable[..., Receiver]

_GRPC_MODULES = (
    "grpc",
    "opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc",
    "opentelemetry.proto.collector.metrics.v1.metrics_service_pb2_grpc",
    "opentelemetry.proto.collector.logs.v1.logs_service_pb2_grpc",
)


def _ipv6_loopback() -> bool:
    if not socket.has_ipv6:
        return False
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
    except OSError:
        return False
    return True


def _trace_request(span_name: str) -> ExportTraceServiceRequest:
    req = ExportTraceServiceRequest()
    span = req.resource_spans.add().scope_spans.add().spans.add()
    span.name = span_name
    span.trace_id = bytes(range(1, 17))
    span.span_id = bytes(range(1, 9))
    return req


def _port_is_free(host: str, port: int) -> bool:
    """Report whether a new server could listen on port, as servers bind, with SO_REUSEADDR.

    SO_REUSEADDR lets the bind pass over connections in TIME_WAIT but not over
    a socket that is still listening.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            s.listen()
        except OSError:
            return False
    return True


def _receiver_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name.startswith("libo11y-otlp-")]


RECEIVERS: list[ReceiverFactory] = [OTLPHTTPReceiver, OTLPGRPCReceiver]


@pytest.mark.parametrize("factory", RECEIVERS)
@pytest.mark.parametrize(
    ("host", "netloc"),
    [
        ("127.0.0.1", "127.0.0.1"),
        ("localhost", "localhost"),
        pytest.param(
            "::1",
            "[::1]",
            marks=pytest.mark.skipif(not _ipv6_loopback(), reason="no IPv6 loopback"),
        ),
    ],
)
def test_endpoint_uses_the_bound_host(factory: ReceiverFactory, host: str, netloc: str) -> None:
    with factory(host=host) as rx:
        assert rx.endpoint == f"http://{netloc}:{rx.port}"


def _trace_stub(channel: grpc.Channel) -> Any:
    module: Any = importlib.import_module(
        "opentelemetry.proto.collector.trace.v1.trace_service_pb2_grpc"
    )
    return module.TraceServiceStub(channel)


def _send_trace(rx: Receiver, span_name: str) -> None:
    payload = _trace_request(span_name)
    if isinstance(rx, OTLPHTTPReceiver):
        req = urllib.request.Request(
            f"{rx.endpoint}/v1/traces",
            data=payload.SerializeToString(),
            method="POST",
            headers={"Content-Type": "application/x-protobuf"},
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            assert resp.status == 200
        return
    with grpc.insecure_channel(f"127.0.0.1:{rx.port}") as channel:
        _trace_stub(channel).Export(payload, timeout=5.0)


@pytest.mark.parametrize("factory", RECEIVERS)
def test_close_releases_the_port_and_threads(factory: ReceiverFactory) -> None:
    before = set(_receiver_threads())
    rx = factory()
    port = rx.port
    _send_trace(rx, "before-close")
    assert rx.received().span_names() == ["before-close"]
    assert set(_receiver_threads()) - before
    rx.close()
    assert _port_is_free("127.0.0.1", port)
    assert set(_receiver_threads()) - before == set()
    rx.close()


def test_http_receiver_decodes_a_gzip_body_and_records_its_headers() -> None:
    body = gzip.compress(_trace_request("gzip-http").SerializeToString())
    with OTLPHTTPReceiver() as rx:
        req = urllib.request.Request(
            f"{rx.endpoint}/v1/traces",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/x-protobuf",
                "Content-Encoding": "gzip",
                "X-Test-Token": "ok123",
            },
        )
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            assert resp.status == 200
        got = rx.received()
        trace_headers = rx.headers("traces")
        assert rx.headers("logs") == []
        assert rx.headers() == trace_headers

    assert got.span_names() == ["gzip-http"]
    assert len(trace_headers) == 1
    assert trace_headers[0]["content-encoding"] == "gzip"
    assert trace_headers[0]["x-test-token"] == "ok123"


def test_grpc_receiver_decodes_a_gzip_call_and_records_its_metadata() -> None:
    with OTLPGRPCReceiver() as rx:
        with grpc.insecure_channel(f"127.0.0.1:{rx.port}") as channel:
            _trace_stub(channel).Export(
                _trace_request("gzip-grpc"),
                metadata=(("x-test-token", "ok123"),),
                compression=grpc.Compression.Gzip,
                timeout=5.0,
            )
        got = rx.received()
        trace_metadata = rx.metadata("traces")
        assert rx.metadata("metrics") == []
        assert rx.metadata() == trace_metadata

    assert got.span_names() == ["gzip-grpc"]
    assert len(trace_metadata) == 1
    assert trace_metadata[0]["x-test-token"] == "ok123"


def test_grpc_exporter_with_gzip_and_headers_reaches_the_receiver() -> None:
    with OTLPGRPCReceiver() as rx:
        tel = libo11y.init(
            env={
                "OTEL_EXPORTER_OTLP_ENDPOINT": rx.endpoint,
                "OTEL_EXPORTER_OTLP_PROTOCOL": "grpc",
                "OTEL_EXPORTER_OTLP_INSECURE": "true",
                "OTEL_EXPORTER_OTLP_COMPRESSION": "gzip",
                "OTEL_EXPORTER_OTLP_HEADERS": "x-test-token=ok123",
                "OTEL_TRACES_EXPORTER": "otlp",
                "OTEL_METRICS_EXPORTER": "otlp",
                "OTEL_LOGS_EXPORTER": "otlp",
            },
            service_name="grpc-gzip",
            environment="test",
            console_enabled=False,
            runtime_metrics=False,
        )
        lg = logging.Logger("grpc.gzip.test", logging.DEBUG)
        lg.propagate = False
        lg.addHandler(tel.logging_handler())
        try:
            with tel.tracer_provider.get_tracer("t").start_as_current_span("grpc-gzip-op"):
                tel.meter_provider.get_meter("t").create_counter("grpc.gzip.calls").add(1)
                lg.info("grpc-gzip-log")
        finally:
            lg.removeHandler(tel.logging_handler())
        assert tel.shutdown(timeout=5.0).ok
        got = rx.received()
        trace_metadata = rx.metadata("traces")
        metric_metadata = rx.metadata("metrics")
        log_metadata = rx.metadata("logs")

    assert "grpc-gzip-op" in got.span_names()
    assert "grpc.gzip.calls" in got.metric_names()
    assert "grpc-gzip-log" in got.log_bodies()
    assert trace_metadata and all(m.get("x-test-token") == "ok123" for m in trace_metadata)
    assert metric_metadata and all(m.get("x-test-token") == "ok123" for m in metric_metadata)
    assert log_metadata and all(m.get("x-test-token") == "ok123" for m in log_metadata)


def test_grpc_receiver_without_grpcio_names_the_extra(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in _GRPC_MODULES:
        monkeypatch.setitem(sys.modules, name, None)
    with pytest.raises(UnsupportedProtocol, match=r"libo11y\[grpc\]"):
        OTLPGRPCReceiver()


def test_testing_package_imports_without_grpcio() -> None:
    script = (
        "import sys\n"
        f"for name in {_GRPC_MODULES!r}:\n"
        "    sys.modules[name] = None\n"
        "import libo11y.testing\n"
        "with libo11y.testing.OTLPHTTPReceiver() as rx:\n"
        "    pass\n"
        "try:\n"
        "    libo11y.testing.OTLPGRPCReceiver()\n"
        "except libo11y.UnsupportedProtocol as exc:\n"
        "    sys.stdout.write(str(exc))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, check=True
    )
    assert "libo11y[grpc]" in out.stdout
