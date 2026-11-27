"""OTLP/HTTP, OTLP/gRPC, and console exporter construction with explicit config."""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from typing import Any

from opentelemetry.exporter.otlp.proto.http import Compression as HttpCompression
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter as HttpLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
    OTLPMetricExporter as HttpMetricExporter,
)
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as HttpSpanExporter,
)
from opentelemetry.sdk._logs.export import ConsoleLogRecordExporter, LogRecordExporter
from opentelemetry.sdk.metrics import (
    Counter,
    Histogram,
    ObservableCounter,
    ObservableGauge,
    ObservableUpDownCounter,
    UpDownCounter,
)
from opentelemetry.sdk.metrics.export import (
    AggregationTemporality,
    ConsoleMetricExporter,
    MetricExporter,
)
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SpanExporter

from libo11y._internal.env import EnvView, parse_otlp_headers
from libo11y.errors import ExporterError, UnsupportedProtocol

_ALLOWED_EXPORTERS = frozenset({"otlp", "console", "none"})
_DEFAULT_HTTP_ENDPOINT = "http://localhost:4318"
_DEFAULT_GRPC_ENDPOINT = "http://localhost:4317"
_DEFAULT_TIMEOUT = 10.0


def select_exporter_kind(env: EnvView, signal_upper: str) -> str:
    """Resolve OTEL_<SIGNAL>_EXPORTER: accepts only 'otlp', 'console', or 'none'."""
    if env.hermetic:
        return "none"
    raw = env.get(f"OTEL_{signal_upper}_EXPORTER", "otlp").strip().lower()
    if raw not in _ALLOWED_EXPORTERS:
        raise UnsupportedProtocol(
            f"o11y: unsupported exporter {raw!r} for OTEL_{signal_upper}_EXPORTER "
            f"(supported: otlp, console, none)"
        )
    return raw


def select_otlp_protocol(env: EnvView, signal_upper: str) -> str:
    """Resolve OTLP protocol for a signal: 'http/protobuf' or 'grpc'."""
    raw = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_PROTOCOL")
    if raw is None:
        raw = env.get("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
    proto = raw.strip().lower()
    if proto not in ("http/protobuf", "grpc"):
        raise UnsupportedProtocol(
            f"o11y: unsupported OTLP protocol {proto!r} (supported: http/protobuf, grpc)"
        )
    return proto


def _http_endpoint(env: EnvView, signal_upper: str, path_suffix: str) -> str:
    sig_ep = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_ENDPOINT")
    if sig_ep is not None:
        return sig_ep.strip()
    base = env.get("OTEL_EXPORTER_OTLP_ENDPOINT", _DEFAULT_HTTP_ENDPOINT).strip().rstrip("/")
    return f"{base}/{path_suffix}"


def _grpc_endpoint(env: EnvView, signal_upper: str) -> str:
    sig_ep = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_ENDPOINT")
    if sig_ep is not None:
        return sig_ep.strip()
    return env.get("OTEL_EXPORTER_OTLP_ENDPOINT", _DEFAULT_GRPC_ENDPOINT).strip()


def _timeout_seconds(env: EnvView, signal_upper: str) -> float:
    sig = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_TIMEOUT")
    gen = env.get_opt("OTEL_EXPORTER_OTLP_TIMEOUT")
    raw = sig if sig is not None else gen
    if raw is None:
        return _DEFAULT_TIMEOUT
    try:
        ms = float(raw.strip())
    except ValueError:
        return _DEFAULT_TIMEOUT
    return max(ms / 1000.0, 0.001)


def _http_compression(env: EnvView, signal_upper: str) -> HttpCompression:
    raw = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_COMPRESSION")
    if raw is None:
        raw = env.get("OTEL_EXPORTER_OTLP_COMPRESSION", "none")
    val = raw.strip().lower()
    if val == "gzip":
        return HttpCompression.Gzip
    if val == "deflate":
        return HttpCompression.Deflate
    return HttpCompression.NoCompression


def _tls_files(env: EnvView, signal_upper: str) -> tuple[str | None, str | None, str | None]:
    ca = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_CERTIFICATE") or env.get_opt(
        "OTEL_EXPORTER_OTLP_CERTIFICATE"
    )
    cert = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_CLIENT_CERTIFICATE") or env.get_opt(
        "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE"
    )
    key = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_CLIENT_KEY") or env.get_opt(
        "OTEL_EXPORTER_OTLP_CLIENT_KEY"
    )
    return ca, cert, key


def _temporality_preference(env: EnvView) -> dict[type, AggregationTemporality]:
    raw = env.get("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "cumulative").strip().lower()
    if raw == "delta":
        return {
            Counter: AggregationTemporality.DELTA,
            UpDownCounter: AggregationTemporality.CUMULATIVE,
            Histogram: AggregationTemporality.DELTA,
            ObservableCounter: AggregationTemporality.DELTA,
            ObservableUpDownCounter: AggregationTemporality.CUMULATIVE,
            ObservableGauge: AggregationTemporality.CUMULATIVE,
        }
    return {
        Counter: AggregationTemporality.CUMULATIVE,
        UpDownCounter: AggregationTemporality.CUMULATIVE,
        Histogram: AggregationTemporality.CUMULATIVE,
        ObservableCounter: AggregationTemporality.CUMULATIVE,
        ObservableUpDownCounter: AggregationTemporality.CUMULATIVE,
        ObservableGauge: AggregationTemporality.CUMULATIVE,
    }


def _import_grpc_module(mod_name: str) -> Any:
    try:
        return importlib.import_module(mod_name)
    except ImportError as exc:
        raise UnsupportedProtocol(
            "o11y: OTLP gRPC protocol requires optional dependencies; "
            "install with `pip install 'libo11y[grpc]'`"
        ) from exc


def _grpc_common_kwargs(env: EnvView, signal_upper: str) -> dict[str, Any]:
    grpc = _import_grpc_module("grpc")
    endpoint = _grpc_endpoint(env, signal_upper)
    headers: Mapping[str, str] = parse_otlp_headers(env, signal_upper)
    timeout = _timeout_seconds(env, signal_upper)

    comp_raw = (
        (
            env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_COMPRESSION")
            or env.get("OTEL_EXPORTER_OTLP_COMPRESSION", "none")
        )
        .strip()
        .lower()
    )
    compression = grpc.Compression.Gzip if comp_raw == "gzip" else grpc.Compression.NoCompression

    sig_insec = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_INSECURE")
    gen_insec = env.get_opt("OTEL_EXPORTER_OTLP_INSECURE")
    if sig_insec is not None:
        insecure = sig_insec.strip().lower() in ("true", "1", "yes")
    elif gen_insec is not None:
        insecure = gen_insec.strip().lower() in ("true", "1", "yes")
    else:
        insecure = endpoint.startswith("http://")

    ca, cert, key = _tls_files(env, signal_upper)
    credentials: Any = None
    if not insecure and (ca or cert or key):
        try:
            root_certs = open(ca, "rb").read() if ca else None  # noqa: SIM115
            private_key = open(key, "rb").read() if key else None  # noqa: SIM115
            cert_chain = open(cert, "rb").read() if cert else None  # noqa: SIM115
        except OSError as exc:
            raise ExporterError(f"o11y: failed to read TLS credential file: {exc}") from exc
        credentials = grpc.ssl_channel_credentials(
            root_certificates=root_certs,
            private_key=private_key,
            certificate_chain=cert_chain,
        )

    return {
        "endpoint": endpoint,
        "insecure": insecure,
        "credentials": credentials,
        "headers": dict(headers),
        "timeout": timeout,
        "compression": compression,
    }


def build_span_exporter(env: EnvView) -> tuple[SpanExporter | None, str]:
    kind = select_exporter_kind(env, "TRACES")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return ConsoleSpanExporter(), "console"
    proto = select_otlp_protocol(env, "TRACES")
    if proto == "grpc":
        mod = _import_grpc_module("opentelemetry.exporter.otlp.proto.grpc.trace_exporter")
        return mod.OTLPSpanExporter(**_grpc_common_kwargs(env, "TRACES")), "otlp"
    ca, cert, key = _tls_files(env, "TRACES")
    return (
        HttpSpanExporter(
            endpoint=_http_endpoint(env, "TRACES", "v1/traces"),
            certificate_file=ca or "",
            client_certificate_file=cert or "",
            client_key_file=key or "",
            headers=parse_otlp_headers(env, "TRACES"),
            timeout=_timeout_seconds(env, "TRACES"),
            compression=_http_compression(env, "TRACES"),
        ),
        "otlp",
    )


def build_metric_exporter(env: EnvView) -> tuple[MetricExporter | None, str]:
    kind = select_exporter_kind(env, "METRICS")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return ConsoleMetricExporter(), "console"
    temporality = _temporality_preference(env)
    proto = select_otlp_protocol(env, "METRICS")
    if proto == "grpc":
        mod = _import_grpc_module("opentelemetry.exporter.otlp.proto.grpc.metric_exporter")
        kwargs = _grpc_common_kwargs(env, "METRICS")
        kwargs["preferred_temporality"] = temporality
        return mod.OTLPMetricExporter(**kwargs), "otlp"
    ca, cert, key = _tls_files(env, "METRICS")
    return (
        HttpMetricExporter(
            endpoint=_http_endpoint(env, "METRICS", "v1/metrics"),
            certificate_file=ca or "",
            client_certificate_file=cert or "",
            client_key_file=key or "",
            headers=parse_otlp_headers(env, "METRICS"),
            timeout=_timeout_seconds(env, "METRICS"),
            compression=_http_compression(env, "METRICS"),
            preferred_temporality=temporality,
        ),
        "otlp",
    )


def build_log_exporter(env: EnvView) -> tuple[LogRecordExporter | None, str]:
    kind = select_exporter_kind(env, "LOGS")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return ConsoleLogRecordExporter(), "console"
    proto = select_otlp_protocol(env, "LOGS")
    if proto == "grpc":
        mod = _import_grpc_module("opentelemetry.exporter.otlp.proto.grpc._log_exporter")
        return mod.OTLPLogExporter(**_grpc_common_kwargs(env, "LOGS")), "otlp"
    ca, cert, key = _tls_files(env, "LOGS")
    return (
        HttpLogExporter(
            endpoint=_http_endpoint(env, "LOGS", "v1/logs"),
            certificate_file=ca or "",
            client_certificate_file=cert or "",
            client_key_file=key or "",
            headers=parse_otlp_headers(env, "LOGS"),
            timeout=_timeout_seconds(env, "LOGS"),
            compression=_http_compression(env, "LOGS"),
        ),
        "otlp",
    )
