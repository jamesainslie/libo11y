"""Export configuration: env parsing, endpoint composition, isolation and temporality."""

from __future__ import annotations

import builtins
import gc
import logging
from collections.abc import Callable, Generator, Mapping
from concurrent import futures
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

import grpc
import pytest
import requests
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
    ExportTraceServiceResponse,
)
from opentelemetry.proto.metrics.v1.metrics_pb2 import AggregationTemporality
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

import libo11y
from libo11y._internal.env import EnvView
from libo11y._internal.exporters import http_endpoint
from otlp_loopback import Collector, otlp_collector

_SIGNALS = ("traces", "metrics", "logs")


@pytest.fixture
def collector() -> Generator[Collector]:
    with otlp_collector() as running:
        yield running


def _only(signal: str, endpoint: str, **extra: str) -> dict[str, str]:
    """An environment that exports one signal to endpoint and switches the others off."""
    env = {f"OTEL_{other.upper()}_EXPORTER": "none" for other in _SIGNALS if other != signal}
    env["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint
    env.update(extra)
    return env


def _init(env: Mapping[str, str], **kwargs: Any) -> libo11y.Telemetry:
    options: dict[str, Any] = {
        "env": env,
        "service_name": "checkout",
        "environment": "production",
        "console_enabled": False,
        "runtime_metrics": False,
    }
    options.update(kwargs)
    return libo11y.init(**options)


def _emit(tel: libo11y.Telemetry, signal: str) -> None:
    """Produce one item of signal and flush it to the exporter."""
    if signal == "traces":
        tel.tracer_provider.get_tracer("test").start_span("op").end()
    elif signal == "metrics":
        tel.meter_provider.get_meter("test").create_counter("jobs").add(1)
    else:
        logger = logging.Logger("export-config")
        logger.addHandler(tel.logging_handler())
        logger.warning("hello")
    tel.force_flush()


# Item 9: an empty or whitespace-only value is unset.


@pytest.mark.parametrize("value", ["", "   ", "\t"])
@pytest.mark.parametrize("signal", _SIGNALS)
def test_empty_exporter_selection_is_unset(signal: str, value: str, collector: Collector) -> None:
    env = _only(signal, collector.url, **{f"OTEL_{signal.upper()}_EXPORTER": value})
    with _init(env) as tel:
        assert f"o11y.config.{signal}=otlp" in tel.effective_config()


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_protocol_is_unset(value: str, collector: Collector) -> None:
    env = _only("traces", collector.url, OTEL_EXPORTER_OTLP_PROTOCOL=value)
    with _init(env) as tel:
        _emit(tel, "traces")
    assert collector.paths() == ["/v1/traces"]


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_endpoint_is_unset(value: str) -> None:
    env = EnvView({"OTEL_EXPORTER_OTLP_ENDPOINT": value})
    assert http_endpoint(env, "TRACES", "v1/traces") == "http://localhost:4318/v1/traces"


@pytest.mark.parametrize("value", ["", "   "])
def test_empty_signal_endpoint_falls_back_to_the_base(value: str) -> None:
    env = EnvView(
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": value,
        }
    )
    assert http_endpoint(env, "LOGS", "v1/logs") == "http://collector:4318/v1/logs"


def test_empty_endpoint_is_not_reported_in_the_effective_config() -> None:
    env = _only("traces", "   ", OTEL_TRACES_EXPORTER="none")
    with _init(env) as tel:
        assert "o11y.config.endpoint" not in tel.effective_config()


# Item 11: the signal path is appended to the URL path.


@pytest.mark.parametrize(
    ("base", "want"),
    [
        ("http://h:4318", "http://h:4318/v1/logs"),
        ("http://h:4318/", "http://h:4318/v1/logs"),
        ("http://h:4318/base", "http://h:4318/base/v1/logs"),
        ("http://h:4318/base/", "http://h:4318/base/v1/logs"),
        ("http://h:4318/base?x=1", "http://h:4318/base/v1/logs?x=1"),
        ("http://h:4318?x=1", "http://h:4318/v1/logs?x=1"),
        ("http://h:4318/?x=1&y=2", "http://h:4318/v1/logs?x=1&y=2"),
        ("  http://h:4318/base  ", "http://h:4318/base/v1/logs"),
    ],
)
def test_signal_path_is_appended_to_the_base_url_path(base: str, want: str) -> None:
    env = EnvView({"OTEL_EXPORTER_OTLP_ENDPOINT": base})
    assert http_endpoint(env, "LOGS", "v1/logs") == want


def test_signal_endpoint_is_used_as_given() -> None:
    env = EnvView(
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://base:4318/ignored",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://h:4318/custom?x=1",
        }
    )
    assert http_endpoint(env, "TRACES", "v1/traces") == "http://h:4318/custom?x=1"


def test_base_endpoint_query_survives_on_the_wire(collector: Collector) -> None:
    with _init(_only("traces", f"{collector.url}/base?x=1")) as tel:
        _emit(tel, "traces")
    assert collector.paths() == ["/base/v1/traces?x=1"]


# Item 10: the mapping given as env= is authoritative.


@pytest.mark.parametrize("signal", _SIGNALS)
def test_ambient_headers_never_reach_the_collector_over_http(
    signal: str, collector: Collector, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer ambient,x-ambient=1")
    monkeypatch.setenv(f"OTEL_EXPORTER_OTLP_{signal.upper()}_HEADERS", "x-signal-ambient=1")
    env = _only(signal, collector.url, OTEL_EXPORTER_OTLP_HEADERS="x-tenant=acme")
    with _init(env) as tel:
        _emit(tel, signal)

    headers = collector.wait_for(1)[0].headers
    assert headers["x-tenant"] == "acme"
    assert headers["content-type"] == "application/x-protobuf"
    assert headers["user-agent"].startswith("OTel-OTLP-Exporter-Python/")
    assert not {"authorization", "x-ambient", "x-signal-ambient"} & headers.keys()


@pytest.mark.parametrize("signal", _SIGNALS)
def test_signal_headers_from_the_mapping_win_over_its_general_headers(
    signal: str, collector: Collector
) -> None:
    env = _only(
        signal,
        collector.url,
        OTEL_EXPORTER_OTLP_HEADERS="x-tenant=acme,x-shared=general",
        **{f"OTEL_EXPORTER_OTLP_{signal.upper()}_HEADERS": "x-shared=signal"},
    )
    with _init(env) as tel:
        _emit(tel, signal)

    headers = collector.wait_for(1)[0].headers
    assert headers["x-tenant"] == "acme"
    assert headers["x-shared"] == "signal"


@pytest.mark.parametrize("signal", _SIGNALS)
def test_ambient_compression_does_not_apply_over_http(
    signal: str, collector: Collector, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip")
    with _init(_only(signal, collector.url)) as tel:
        _emit(tel, signal)
    assert "content-encoding" not in collector.wait_for(1)[0].headers


def test_compression_from_the_mapping_applies_over_http(collector: Collector) -> None:
    with _init(_only("traces", collector.url, OTEL_EXPORTER_OTLP_COMPRESSION="gzip")) as tel:
        _emit(tel, "traces")
    assert collector.wait_for(1)[0].headers["content-encoding"] == "gzip"


def _sessions_created_by(build: Callable[[], libo11y.Telemetry]) -> list[requests.Session]:
    """Run build and return the requests sessions it created."""
    gc.collect()
    before = {id(obj) for obj in gc.get_objects() if isinstance(obj, requests.Session)}
    with build():
        return [
            obj
            for obj in gc.get_objects()
            if isinstance(obj, requests.Session) and id(obj) not in before
        ]


@pytest.mark.parametrize("signal", _SIGNALS)
def test_ambient_tls_files_do_not_apply_over_http(
    signal: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_CERTIFICATE", "/ambient/ca.pem")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", "/ambient/client.pem")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_CLIENT_KEY", "/ambient/client.key")

    sessions = _sessions_created_by(lambda: _init(_only(signal, "https://collector:4318")))

    assert len(sessions) == 1
    assert sessions[0].verify is True
    assert sessions[0].cert is None


@pytest.mark.parametrize("signal", _SIGNALS)
def test_tls_files_from_the_mapping_apply_over_http(
    signal: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_CERTIFICATE", "/ambient/ca.pem")
    env = _only(
        signal,
        "https://collector:4318",
        OTEL_EXPORTER_OTLP_CERTIFICATE="/explicit/ca.pem",
        OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE="/explicit/client.pem",
        OTEL_EXPORTER_OTLP_CLIENT_KEY="/explicit/client.key",
    )

    sessions = _sessions_created_by(lambda: _init(env))

    assert len(sessions) == 1
    assert sessions[0].verify == "/explicit/ca.pem"
    assert sessions[0].cert == ("/explicit/client.pem", "/explicit/client.key")


@contextmanager
def _grpc_trace_collector() -> Generator[tuple[str, list[dict[str, str]]]]:
    """Serve the OTLP trace service over loopback gRPC, recording each call's metadata."""
    seen: list[dict[str, str]] = []

    def export(
        request: ExportTraceServiceRequest, context: grpc.ServicerContext
    ) -> ExportTraceServiceResponse:
        del request
        seen.append({str(key): str(value) for key, value in context.invocation_metadata()})
        return ExportTraceServiceResponse()

    handler = grpc.method_handlers_generic_handler(
        "opentelemetry.proto.collector.trace.v1.TraceService",
        {
            "Export": grpc.unary_unary_rpc_method_handler(
                export,
                request_deserializer=ExportTraceServiceRequest.FromString,
                response_serializer=ExportTraceServiceResponse.SerializeToString,
            )
        },
    )
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
    server.add_generic_rpc_handlers((handler,))
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield f"http://127.0.0.1:{port}", seen
    finally:
        server.stop(grace=None).wait(timeout=5.0)


def test_ambient_headers_never_reach_the_collector_over_grpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer ambient")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-signal-ambient=1")
    with _grpc_trace_collector() as (endpoint, seen):
        with _init(_only("traces", endpoint, OTEL_EXPORTER_OTLP_PROTOCOL="grpc")) as tel:
            _emit(tel, "traces")
        assert len(seen) == 1
        assert not {"authorization", "x-signal-ambient"} & seen[0].keys()


def test_headers_from_the_mapping_reach_the_collector_over_grpc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer ambient")
    with _grpc_trace_collector() as (endpoint, seen):
        env = _only(
            "traces",
            endpoint,
            OTEL_EXPORTER_OTLP_PROTOCOL="grpc",
            OTEL_EXPORTER_OTLP_HEADERS="x-tenant=acme",
        )
        with _init(env) as tel:
            _emit(tel, "traces")
        assert len(seen) == 1
        assert seen[0]["x-tenant"] == "acme"
        assert "authorization" not in seen[0]


@contextmanager
def _recorded_opens(monkeypatch: pytest.MonkeyPatch) -> Generator[list[str]]:
    """Record the path of every file opened through the open() builtin."""
    opened: list[str] = []
    real_open = cast(Callable[..., object], builtins.open)

    def spy(file: object, *args: object, **kwargs: object) -> object:
        opened.append(str(file))
        return real_open(file, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(builtins, "open", spy)
        yield opened


@pytest.mark.parametrize("signal", _SIGNALS)
def test_ambient_tls_files_are_not_read_over_grpc(
    signal: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ambient = {
        "OTEL_EXPORTER_OTLP_CERTIFICATE": tmp_path / "ambient-ca.pem",
        "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE": tmp_path / "ambient-client.pem",
        "OTEL_EXPORTER_OTLP_CLIENT_KEY": tmp_path / "ambient-client.key",
    }
    for name, path in ambient.items():
        path.write_bytes(b"ambient")
        monkeypatch.setenv(name, str(path))

    env = _only(signal, "https://collector:4317", OTEL_EXPORTER_OTLP_PROTOCOL="grpc")
    with _recorded_opens(monkeypatch) as opened, _init(env):
        pass

    assert not {str(path) for path in ambient.values()} & set(opened)


def test_tls_files_from_the_mapping_are_read_and_closed_over_grpc(
    tmp_path: Path, recwarn: pytest.WarningsRecorder
) -> None:
    ca = tmp_path / "ca.pem"
    ca.write_bytes(b"not a certificate")
    env = _only(
        "traces",
        "https://collector:4317",
        OTEL_EXPORTER_OTLP_PROTOCOL="grpc",
        OTEL_EXPORTER_OTLP_CERTIFICATE=str(ca),
    )
    with _init(env):
        pass
    gc.collect()
    assert not [w for w in recwarn if issubclass(w.category, ResourceWarning)]


def test_unreadable_tls_file_over_grpc_is_an_exporter_error(tmp_path: Path) -> None:
    env = _only(
        "traces",
        "https://collector:4317",
        OTEL_EXPORTER_OTLP_PROTOCOL="grpc",
        OTEL_EXPORTER_OTLP_CERTIFICATE=str(tmp_path / "missing.pem"),
    )
    with pytest.raises(libo11y.ExporterError, match=r"missing\.pem"):
        _init(env)


# Item 12: temporality preference.


def _temporalities(collector: Collector) -> dict[str, int]:
    """Map each exported sum or histogram to its aggregation temporality."""
    found: dict[str, int] = {}
    for received in collector.wait_for(1):
        request = ExportMetricsServiceRequest.FromString(received.body)
        for resource_metrics in request.resource_metrics:
            for scope_metrics in resource_metrics.scope_metrics:
                for metric in scope_metrics.metrics:
                    kind = metric.WhichOneof("data")
                    if kind == "sum":
                        found[metric.name] = metric.sum.aggregation_temporality
                    elif kind == "histogram":
                        found[metric.name] = metric.histogram.aggregation_temporality
    return found


_CUMULATIVE = AggregationTemporality.AGGREGATION_TEMPORALITY_CUMULATIVE
_DELTA = AggregationTemporality.AGGREGATION_TEMPORALITY_DELTA


@pytest.mark.parametrize(
    ("preference", "want"),
    [
        pytest.param(
            None,
            {
                "jobs": _CUMULATIVE,
                "queue": _CUMULATIVE,
                "latency": _CUMULATIVE,
                "seen": _CUMULATIVE,
                "open": _CUMULATIVE,
            },
            id="default",
        ),
        pytest.param(
            "cumulative",
            {
                "jobs": _CUMULATIVE,
                "queue": _CUMULATIVE,
                "latency": _CUMULATIVE,
                "seen": _CUMULATIVE,
                "open": _CUMULATIVE,
            },
            id="cumulative",
        ),
        pytest.param(
            "delta",
            {
                "jobs": _DELTA,
                "queue": _CUMULATIVE,
                "latency": _DELTA,
                "seen": _DELTA,
                "open": _CUMULATIVE,
            },
            id="delta",
        ),
        pytest.param(
            "LowMemory",
            {
                "jobs": _DELTA,
                "queue": _CUMULATIVE,
                "latency": _DELTA,
                "seen": _CUMULATIVE,
                "open": _CUMULATIVE,
            },
            id="lowmemory",
        ),
        pytest.param(
            "bogus",
            {
                "jobs": _CUMULATIVE,
                "queue": _CUMULATIVE,
                "latency": _CUMULATIVE,
                "seen": _CUMULATIVE,
                "open": _CUMULATIVE,
            },
            id="unknown value is cumulative",
        ),
    ],
)
def test_temporality_preference(
    preference: str | None,
    want: dict[str, int],
    collector: Collector,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The mapping decides, whatever the ambient variable says.
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta")
    extra: dict[str, str] = {}
    if preference is not None:
        extra["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = preference

    def observe(options: CallbackOptions) -> list[Observation]:
        del options
        return [Observation(3)]

    with _init(_only("metrics", collector.url, **extra)) as tel:
        meter = tel.meter_provider.get_meter("test")
        meter.create_counter("jobs").add(1)
        meter.create_up_down_counter("queue").add(1)
        meter.create_histogram("latency").record(0.2)
        meter.create_observable_counter("seen", callbacks=[observe])
        meter.create_observable_up_down_counter("open", callbacks=[observe])
        tel.force_flush()

    assert _temporalities(collector) == want


# Item 6: an out-of-range numeric value uses the default.


@pytest.mark.parametrize(
    "extra",
    [
        {"OTEL_BSP_MAX_QUEUE_SIZE": "0"},
        {"OTEL_BSP_MAX_QUEUE_SIZE": "-5"},
        {"OTEL_BSP_MAX_QUEUE_SIZE": "999999999999999999999"},
        {"OTEL_BSP_SCHEDULE_DELAY": "0"},
        {"OTEL_BSP_SCHEDULE_DELAY": "-1"},
        {"OTEL_BSP_MAX_EXPORT_BATCH_SIZE": "0"},
        {"OTEL_BSP_MAX_EXPORT_BATCH_SIZE": "4096"},
        {"OTEL_BSP_MAX_QUEUE_SIZE": "8"},
        {"OTEL_BSP_EXPORT_TIMEOUT": "-1"},
        {"OTEL_BLRP_MAX_QUEUE_SIZE": "0"},
        {"OTEL_BLRP_SCHEDULE_DELAY": "0"},
        {"OTEL_BLRP_MAX_EXPORT_BATCH_SIZE": "-3"},
        {"OTEL_BLRP_MAX_EXPORT_BATCH_SIZE": "4096"},
        {"OTEL_BLRP_MAX_QUEUE_SIZE": "8"},
        {"OTEL_METRIC_EXPORT_INTERVAL": "0"},
        {"OTEL_METRIC_EXPORT_INTERVAL": "-10"},
        {"OTEL_METRIC_EXPORT_TIMEOUT": "-10"},
        {"OTEL_ATTRIBUTE_COUNT_LIMIT": "-1"},
        {"OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT": "-1"},
        {"OTEL_SPAN_EVENT_COUNT_LIMIT": "-1"},
        {"OTEL_SPAN_LINK_COUNT_LIMIT": "-1"},
        {"OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT": "-1"},
        {"OTEL_LINK_ATTRIBUTE_COUNT_LIMIT": "-1"},
        {"OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT": "-1"},
        {"OTEL_TRACES_SAMPLER": "traceidratio", "OTEL_TRACES_SAMPLER_ARG": "7"},
        {"OTEL_TRACES_SAMPLER": "traceidratio", "OTEL_TRACES_SAMPLER_ARG": "nan"},
        {"OTEL_EXPORTER_OTLP_TIMEOUT": "-1"},
        {"OTEL_EXPORTER_OTLP_TIMEOUT": "nan"},
        {"OTEL_EXPORTER_OTLP_TIMEOUT": "inf"},
    ],
    ids=lambda extra: ",".join(f"{k}={v}" for k, v in extra.items()),
)
def test_out_of_range_numeric_value_uses_the_default(
    extra: dict[str, str], collector: Collector
) -> None:
    env = {"OTEL_EXPORTER_OTLP_ENDPOINT": collector.url, **extra}
    with _init(env) as tel:
        _emit(tel, "traces")
    assert "/v1/traces" in collector.paths()


@pytest.mark.parametrize(
    ("raw", "minimum", "want"),
    [
        ("12", 1, 12),
        ("0", 1, 7),
        ("-4", 0, 7),
        ("abc", 0, 7),
        ("", 0, 7),
        (" 9 ", 0, 9),
    ],
)
def test_env_int_below_its_minimum_uses_the_default(raw: str, minimum: int, want: int) -> None:
    assert EnvView({"KEY": raw}).get_int("KEY", 7, minimum=minimum) == want


@pytest.mark.parametrize("ratio", ["7", "-0.5", "nan"])
def test_out_of_range_sampler_ratio_samples_everything_like_go(ratio: str) -> None:
    env = {
        "OTEL_TRACES_EXPORTER": "none",
        "OTEL_METRICS_EXPORTER": "none",
        "OTEL_LOGS_EXPORTER": "none",
        "OTEL_TRACES_SAMPLER": "traceidratio",
        "OTEL_TRACES_SAMPLER_ARG": ratio,
    }
    with _init(env) as tel:
        span = tel.tracer_provider.get_tracer("test").start_span("op")
        assert span.get_span_context().trace_flags.sampled
        span.end()


def test_upstream_construction_failure_is_an_o11y_error() -> None:
    reader = InMemoryMetricReader()
    with _init(libo11y.HERMETIC, metric_reader=reader):
        # OpenTelemetry refuses a reader that another provider already holds.
        with pytest.raises(libo11y.O11yError) as excinfo:
            _init(libo11y.HERMETIC, metric_reader=reader)
        assert excinfo.value.__cause__ is not None


@pytest.mark.parametrize("signal", _SIGNALS)
def test_explicit_http_env_overrides_ambient_transport_headers(
    signal: str, collector: Collector, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        f"OTEL_EXPORTER_OTLP_{signal.upper()}_HEADERS",
        "content-type=text/plain,content-encoding=deflate,user-agent=ambient",
    )
    with _init(_only(signal, collector.url, OTEL_EXPORTER_OTLP_COMPRESSION="gzip")) as tel:
        _emit(tel, signal)

    headers = collector.wait_for(1)[0].headers
    assert headers["content-type"] == "application/x-protobuf"
    assert headers["content-encoding"] == "gzip"
    assert headers["user-agent"].startswith("OTel-OTLP-Exporter-Python/")


@pytest.mark.parametrize("signal", _SIGNALS)
def test_explicit_grpc_env_ignores_malformed_ambient_timeout(
    signal: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(f"OTEL_EXPORTER_OTLP_{signal.upper()}_TIMEOUT", " 	")
    with _init(_only(signal, "http://127.0.0.1:4317", OTEL_EXPORTER_OTLP_PROTOCOL="grpc")):
        pass
