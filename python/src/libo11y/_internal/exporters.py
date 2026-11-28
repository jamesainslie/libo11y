"""OTLP/HTTP, OTLP/gRPC and console exporter construction, and export failure observation.

Every setting an exporter takes is resolved here from the EnvView and passed
explicitly, so a mapping given as ``env=`` decides headers, TLS, timeouts and
compression whatever the process environment holds.
"""

from __future__ import annotations

import importlib
import inspect
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Final
from urllib.parse import urlsplit, urlunsplit

import requests
from opentelemetry.exporter.otlp.proto.http import Compression as HttpCompression
from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
    OTLPMetricExporter as HttpMetricExporter,
)
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as HttpSpanExporter,
)
from opentelemetry.exporter.otlp.proto.http.version import __version__ as _http_version
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
    MetricExportResult,
    MetricsData,
)
from opentelemetry.sdk.metrics.view import (
    Aggregation,
    ExplicitBucketHistogramAggregation,
    ExponentialBucketHistogramAggregation,
)
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SpanExporter, SpanExportResult

from libo11y._internal.env import EnvView, parse_otlp_headers
from libo11y.errors import ExporterError, ExportFailed, UnsupportedProtocol

_ALLOWED_EXPORTERS = frozenset({"otlp", "console", "none"})
_DEFAULT_HTTP_ENDPOINT = "http://localhost:4318"
_DEFAULT_GRPC_ENDPOINT = "http://localhost:4317"
_DEFAULT_TIMEOUT = 10.0

SIGNALS: Final[tuple[str, ...]] = ("TRACES", "METRICS", "LOGS")

# How many distinct export errors one shutdown or force_flush call reports in
# full. Further failed exports during the call are counted, so a collector
# that rejects every batch of a large backlog yields a short report.
MAX_WINDOW_ERRORS: Final[int] = 5


def select_exporter_kind(env: EnvView, signal_upper: str) -> str:
    """Resolve OTEL_<SIGNAL>_EXPORTER: accepts only 'otlp', 'console', or 'none'."""
    if env.hermetic:
        return "none"
    raw = env.get(f"OTEL_{signal_upper}_EXPORTER", "otlp").lower()
    if raw not in _ALLOWED_EXPORTERS:
        raise UnsupportedProtocol(
            f"o11y: unsupported exporter {raw!r} for OTEL_{signal_upper}_EXPORTER "
            f"(supported: otlp, console, none)"
        )
    return raw


def select_otlp_protocol(env: EnvView, signal_upper: str) -> str:
    """Resolve OTLP protocol for a signal: 'http/protobuf' or 'grpc'."""
    raw = env.first(f"OTEL_EXPORTER_OTLP_{signal_upper}_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL")
    proto = "http/protobuf" if raw is None else raw.lower()
    if proto not in ("http/protobuf", "grpc"):
        raise UnsupportedProtocol(
            f"o11y: unsupported OTLP protocol {proto!r} (supported: http/protobuf, grpc)"
        )
    return proto


def check_export_selection(env: EnvView, signals_upper: Sequence[str]) -> None:
    """Raise for an exporter or protocol that cannot be built, before anything is built.

    Construction calls this first, for every signal it will build from the
    environment, so an unsupported selection never leaves a worker of an
    earlier signal running.
    """
    for signal_upper in signals_upper:
        if select_exporter_kind(env, signal_upper) != "otlp":
            continue
        if select_otlp_protocol(env, signal_upper) == "grpc":
            _import_grpc_module("grpc")


def _append_path(base: str, suffix: str) -> str:
    """Append suffix to the path of the URL base, keeping its query and fragment."""
    parts = urlsplit(base)
    path = f"{parts.path.rstrip('/')}/{suffix}"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


def http_endpoint(env: EnvView, signal_upper: str, path_suffix: str) -> str:
    """Resolve the OTLP/HTTP URL of a signal.

    A per-signal endpoint is used as given. Otherwise the signal path is
    appended to the path of the base endpoint, as the OTLP exporter
    specification says, so a base URL keeps its query.
    """
    sig_ep = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_ENDPOINT")
    if sig_ep is not None:
        return sig_ep
    return _append_path(env.get("OTEL_EXPORTER_OTLP_ENDPOINT", _DEFAULT_HTTP_ENDPOINT), path_suffix)


def _grpc_endpoint(env: EnvView, signal_upper: str) -> str:
    sig_ep = env.get_opt(f"OTEL_EXPORTER_OTLP_{signal_upper}_ENDPOINT")
    if sig_ep is not None:
        return sig_ep
    return env.get("OTEL_EXPORTER_OTLP_ENDPOINT", _DEFAULT_GRPC_ENDPOINT)


def _timeout_seconds(env: EnvView, signal_upper: str) -> float:
    """Resolve the export timeout. A negative or non-finite value uses the default."""
    default_ms = _DEFAULT_TIMEOUT * 1000.0
    general = env.get_float("OTEL_EXPORTER_OTLP_TIMEOUT", default_ms, minimum=0.0)
    millis = env.get_float(f"OTEL_EXPORTER_OTLP_{signal_upper}_TIMEOUT", general, minimum=0.0)
    return max(millis / 1000.0, 0.001)


def _compression_name(env: EnvView, signal_upper: str) -> str:
    raw = env.first(
        f"OTEL_EXPORTER_OTLP_{signal_upper}_COMPRESSION", "OTEL_EXPORTER_OTLP_COMPRESSION"
    )
    return "none" if raw is None else raw.lower()


def _http_compression(env: EnvView, signal_upper: str) -> HttpCompression:
    name = _compression_name(env, signal_upper)
    if name == "gzip":
        return HttpCompression.Gzip
    if name == "deflate":
        return HttpCompression.Deflate
    return HttpCompression.NoCompression


def _tls_files(env: EnvView, signal_upper: str) -> tuple[str | None, str | None, str | None]:
    """Resolve the CA file, the client certificate file and the client key file."""
    prefix = f"OTEL_EXPORTER_OTLP_{signal_upper}_"
    ca = env.first(f"{prefix}CERTIFICATE", "OTEL_EXPORTER_OTLP_CERTIFICATE")
    cert = env.first(f"{prefix}CLIENT_CERTIFICATE", "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE")
    key = env.first(f"{prefix}CLIENT_KEY", "OTEL_EXPORTER_OTLP_CLIENT_KEY")
    return ca, cert, key


def temporality_preference(env: EnvView) -> dict[type, AggregationTemporality]:
    """Resolve OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE.

    The values are cumulative (the default), delta and lowmemory, in any
    case, as the OTLP metrics exporter specification defines them. Any other
    value is cumulative.
    """
    cumulative = AggregationTemporality.CUMULATIVE
    delta = AggregationTemporality.DELTA
    preference = env.get("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "cumulative").lower()
    synchronous = delta if preference in ("delta", "lowmemory") else cumulative
    observable_counter = delta if preference == "delta" else cumulative
    return {
        Counter: synchronous,
        UpDownCounter: cumulative,
        Histogram: synchronous,
        ObservableCounter: observable_counter,
        ObservableUpDownCounter: cumulative,
        ObservableGauge: cumulative,
    }


def histogram_aggregation(env: EnvView) -> dict[type, Aggregation]:
    """Resolve OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION."""
    name = env.get(
        "OTEL_EXPORTER_OTLP_METRICS_DEFAULT_HISTOGRAM_AGGREGATION", "explicit_bucket_histogram"
    ).lower()
    if name == "base2_exponential_bucket_histogram":
        return {Histogram: ExponentialBucketHistogramAggregation()}
    return {Histogram: ExplicitBucketHistogramAggregation()}


class _ConfiguredOTLPSession(requests.Session):
    """Use the resolved OTLP headers before requests validates the request."""

    def __init__(self, headers: Mapping[str, str], compression: HttpCompression) -> None:
        super().__init__()
        self.trust_env = False
        self._otlp_headers = {
            "content-type": "application/x-protobuf",
            "user-agent": f"OTel-OTLP-Exporter-Python/{_http_version}",
        }
        if compression is not HttpCompression.NoCompression:
            self._otlp_headers["content-encoding"] = compression.value
        self._otlp_headers.update(headers)

    def prepare_request(self, request: requests.Request) -> requests.PreparedRequest:
        request.headers = self._otlp_headers.copy()
        return super().prepare_request(request)


def build_http_exporter[ExporterT](
    factory: Callable[..., ExporterT],
    env: EnvView,
    signal_upper: str,
    path_suffix: str,
    **extra: object,
) -> ExporterT:
    """Build an OTLP/HTTP exporter with every setting passed explicitly.

    With an explicit environment the exporter gets a session of its own
    whose headers and TLS files come only from that environment: upstream
    falls back to the process's OTEL_EXPORTER_OTLP_* variables for headers,
    the CA file and the client certificate and key when an argument is empty.
    """
    ca, cert, key = _tls_files(env, signal_upper)
    headers = parse_otlp_headers(env, signal_upper)
    compression = _http_compression(env, signal_upper)
    session = None if env.ambient else _ConfiguredOTLPSession(headers, compression)
    try:
        exporter = factory(
            endpoint=http_endpoint(env, signal_upper, path_suffix),
            certificate_file=ca,
            client_certificate_file=cert,
            client_key_file=key,
            headers=headers,
            timeout=_timeout_seconds(env, signal_upper),
            compression=compression,
            session=session,
            **extra,
        )
    except Exception:
        if session is not None:
            session.close()
        raise
    if session is not None:
        # The exporter's transport has just written the ambient fallbacks here.
        session.verify = ca if ca is not None else True
        session.cert = (cert, key) if cert is not None and key is not None else cert
    return exporter


@dataclass(frozen=True, slots=True)
class BatchSettings:
    """The settings of a batch span or log record processor."""

    max_queue_size: int
    schedule_delay_millis: float
    max_export_batch_size: int
    export_timeout_millis: float


_DEFAULT_MAX_QUEUE_SIZE = 2048
_DEFAULT_MAX_EXPORT_BATCH_SIZE = 512
_DEFAULT_EXPORT_TIMEOUT_MILLIS = 30000


def batch_settings(env: EnvView, prefix: str, default_delay_millis: int) -> BatchSettings:
    """Resolve the OTEL_BSP_* or OTEL_BLRP_* batch settings, named by prefix.

    A value the processor would refuse (a queue, batch or delay that is not
    positive, or a negative timeout) uses the default instead, and a batch
    larger than the queue is cut down to it, as the Go SDK does.
    """
    queue = env.get_int(f"OTEL_{prefix}_MAX_QUEUE_SIZE", _DEFAULT_MAX_QUEUE_SIZE, minimum=1)
    batch = env.get_int(
        f"OTEL_{prefix}_MAX_EXPORT_BATCH_SIZE", _DEFAULT_MAX_EXPORT_BATCH_SIZE, minimum=1
    )
    if batch > queue:
        batch = min(queue, _DEFAULT_MAX_EXPORT_BATCH_SIZE)
    return BatchSettings(
        max_queue_size=queue,
        schedule_delay_millis=float(
            env.get_int(
                f"OTEL_{prefix}_SCHEDULE_DELAY",
                default_delay_millis,
                minimum=1,
                maximum=int(threading.TIMEOUT_MAX * 1000),
            )
        ),
        max_export_batch_size=batch,
        export_timeout_millis=float(
            env.get_int(f"OTEL_{prefix}_EXPORT_TIMEOUT", _DEFAULT_EXPORT_TIMEOUT_MILLIS, minimum=0)
        ),
    )


def attribute_limits(env: EnvView, count_key: str, length_key: str) -> tuple[int, int | None]:
    """Resolve an attribute count limit and value length limit, with their general fallbacks.

    A negative count uses the default of 128. No length limit, or a negative
    one, is no limit.
    """
    general_count = env.get_int("OTEL_ATTRIBUTE_COUNT_LIMIT", 128, minimum=0)
    general_length = env.get_int("OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", -1, minimum=0)
    count = env.get_int(count_key, general_count, minimum=0)
    length = env.get_int(length_key, general_length, minimum=0)
    return count, (length if length >= 0 else None)


def _import_grpc_module(mod_name: str) -> ModuleType:
    try:
        return importlib.import_module(mod_name)
    except ImportError as exc:
        raise UnsupportedProtocol(
            "o11y: OTLP gRPC protocol requires optional dependencies; "
            "install with `pip install 'libo11y[grpc]'`"
        ) from exc


class _ConfiguredHeaders(dict[str, str]):
    """Header mapping that is true even when empty.

    The OTLP/gRPC exporters read the process's OTEL_EXPORTER_OTLP_HEADERS
    whenever the headers they are given are false, which an empty mapping is.
    """

    def __bool__(self) -> bool:
        return True


def _read_credential(path: str | None) -> bytes | None:
    if path is None:
        return None
    try:
        return Path(path).read_bytes()
    except OSError as exc:
        raise ExporterError(f"o11y: failed to read TLS credential file: {exc}") from exc


def _grpc_insecure(env: EnvView, signal_upper: str, endpoint: str) -> bool:
    scheme = urlsplit(endpoint).scheme
    if scheme == "https":
        return False
    raw = env.first(f"OTEL_EXPORTER_OTLP_{signal_upper}_INSECURE", "OTEL_EXPORTER_OTLP_INSECURE")
    if raw is not None:
        return raw.lower() in ("true", "1", "yes")
    return scheme == "http"


def _grpc_common_kwargs(env: EnvView, signal_upper: str) -> dict[str, object]:
    grpc = _import_grpc_module("grpc")
    endpoint = _grpc_endpoint(env, signal_upper)
    headers = parse_otlp_headers(env, signal_upper)
    gzip = _compression_name(env, signal_upper) == "gzip"
    insecure = _grpc_insecure(env, signal_upper, endpoint)

    ca, cert, key = _tls_files(env, signal_upper)
    credentials: object = None
    # With an explicit environment the credentials are always built here.
    # Left unset, upstream builds them from the process's certificate variables.
    if not insecure:
        credentials = grpc.ssl_channel_credentials(
            root_certificates=_read_credential(ca),
            private_key=_read_credential(key),
            certificate_chain=_read_credential(cert),
        )

    return {
        "endpoint": endpoint,
        "insecure": insecure,
        "credentials": credentials,
        "headers": _ConfiguredHeaders(headers),
        "timeout": _timeout_seconds(env, signal_upper),
        "compression": grpc.Compression.Gzip if gzip else grpc.Compression.NoCompression,
    }


def build_grpc_exporter[ExporterT](
    env: EnvView,
    signal_upper: str,
    *,
    exporter_type: type[ExporterT],
    result: type,
    temporality: dict[type, AggregationTemporality] | None = None,
    aggregation: dict[type, Aggregation] | None = None,
) -> ExporterT:
    """Initialize the pinned OTLP/gRPC exporter with the resolved settings.

    The signal constructors parse ambient timeout strings before applying
    constructor arguments. Initialize their shared transport directly to avoid
    that read. The SDK still owns encoding, retry, and channel lifecycle.
    """
    module_name, class_name, stub_name, component = {
        "TRACES": ("trace_exporter", "OTLPSpanExporter", "TraceServiceStub", "SPAN"),
        "METRICS": ("metric_exporter", "OTLPMetricExporter", "MetricsServiceStub", "METRIC"),
        "LOGS": ("_log_exporter", "OTLPLogExporter", "LogsServiceStub", "LOG"),
    }[signal_upper]
    module = _import_grpc_module(f"opentelemetry.exporter.otlp.proto.grpc.{module_name}")
    factory = getattr(module, class_name)
    exporter: object = factory.__new__(factory)
    if not isinstance(exporter, exporter_type):
        raise ExporterError(f"o11y: incompatible OpenTelemetry gRPC {signal_upper} exporter")
    if isinstance(exporter, MetricExporter):
        MetricExporter.__init__(
            exporter, preferred_temporality=temporality, preferred_aggregation=aggregation
        )
        # Match the pinned gRPC metric constructor's default batch size.
        exporter._max_export_batch_size = None  # pyright: ignore[reportAttributeAccessIssue]
    module.OTLPExporterMixin.__init__(
        exporter,
        **_grpc_common_kwargs(env, signal_upper),
        stub=getattr(module, stub_name),
        result=result,
        component_type=getattr(module.OtelComponentTypeValues, f"OTLP_GRPC_{component}_EXPORTER"),
        signal=signal_upper.lower(),
    )
    return exporter


def build_span_exporter(env: EnvView) -> tuple[SpanExporter | None, str]:
    kind = select_exporter_kind(env, "TRACES")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return ConsoleSpanExporter(), "console"
    if select_otlp_protocol(env, "TRACES") == "grpc":
        exporter = build_grpc_exporter(
            env, "TRACES", exporter_type=SpanExporter, result=SpanExportResult
        )
        return exporter, "otlp"
    return build_http_exporter(HttpSpanExporter, env, "TRACES", "v1/traces"), "otlp"


@dataclass(frozen=True, slots=True)
class BuiltMetricExporter:
    """A metric exporter and the stream preferences it was built with."""

    exporter: MetricExporter
    temporality: dict[type, AggregationTemporality]
    aggregation: dict[type, Aggregation]


def build_metric_exporter(env: EnvView) -> tuple[BuiltMetricExporter | None, str]:
    kind = select_exporter_kind(env, "METRICS")
    if kind == "none":
        return None, "none"
    if kind == "console":
        return BuiltMetricExporter(ConsoleMetricExporter(), {}, {}), "console"
    temporality = temporality_preference(env)
    aggregation = histogram_aggregation(env)
    if select_otlp_protocol(env, "METRICS") == "grpc":
        exporter = build_grpc_exporter(
            env,
            "METRICS",
            exporter_type=MetricExporter,
            result=MetricExportResult,
            temporality=temporality,
            aggregation=aggregation,
        )
    else:
        exporter = build_http_exporter(
            HttpMetricExporter,
            env,
            "METRICS",
            "v1/metrics",
            preferred_temporality=temporality,
            preferred_aggregation=aggregation,
        )
    return BuiltMetricExporter(exporter, temporality, aggregation), "otlp"


class FailureWindow:
    """The export errors of one signal recorded while a shutdown or force_flush call ran.

    It keeps the first MAX_WINDOW_ERRORS distinct errors and counts the
    failed exports beyond them.
    """

    def __init__(self, signal: str) -> None:
        self.signal = signal
        self._lock = threading.Lock()
        self._errors: list[Exception] = []
        self._keys: list[tuple[type, str]] = []
        self._more = 0

    def add(self, error: Exception) -> None:
        key = (type(error), str(error))
        with self._lock:
            if len(self._errors) < MAX_WINDOW_ERRORS and key not in self._keys:
                self._errors.append(error)
                self._keys.append(key)
            else:
                self._more += 1

    def join(self, primary: Exception | None = None) -> Exception | None:
        """Combine the call's own error with the export failures recorded here.

        One error is returned as it is. Several become an ExceptionGroup,
        whose last member counts the failed exports beyond the first
        MAX_WINDOW_ERRORS distinct ones.
        """
        with self._lock:
            errors = [e for e in self._errors if e is not primary]
            more = self._more
        if primary is not None:
            errors.insert(0, primary)
        if more:
            plural = "export" if more == 1 else "exports"
            errors.append(ExportFailed(self.signal, f"o11y: {more} more failed {plural}"))
        if not errors:
            return None
        if len(errors) == 1:
            return errors[0]
        return ExceptionGroup(f"o11y: {self.signal}: {len(errors)} errors", errors)


class ExportFailures:
    """Observes the failed exports of one signal for shutdown and force_flush.

    OpenTelemetry's batch processors and periodic reader export on their own
    threads and log a failed export instead of returning it, so a batch that
    is rejected during shutdown is otherwise never reported to the caller.
    A window records every export that fails while it is open, whoever
    started the export, and two overlapping calls each see the same failure.
    """

    def __init__(self, signal: str) -> None:
        self.signal = signal
        self._lock = threading.Lock()
        self._windows: tuple[FailureWindow, ...] = ()
        self.abandoned = False

    def open(self) -> FailureWindow:
        """Start recording failures for one call. close() must follow."""
        window = FailureWindow(self.signal)
        with self._lock:
            self._windows = (*self._windows, window)
        return window

    def close(self, window: FailureWindow) -> None:
        """Stop recording into window."""
        with self._lock:
            self._windows = tuple(w for w in self._windows if w is not window)

    def record(self, error: Exception) -> None:
        """Add a failed export's error to every open window."""
        for window in self._windows:
            window.add(error)

    def rejected(self) -> None:
        """Record an export the exporter answered with a failure result."""
        self.record(ExportFailed(self.signal))


def shutdown_exporter(shutdown: Callable[..., None], timeout_millis: float) -> None:
    """Call an exporter's shutdown, passing the timeout when it takes one."""
    if "timeout_millis" in inspect.signature(shutdown).parameters:
        shutdown(timeout_millis=timeout_millis)
    else:
        shutdown()


class ObservedSpanExporter(SpanExporter):
    """Reports every failed span export to an ExportFailures, changing nothing else."""

    def __init__(self, inner: SpanExporter, failures: ExportFailures) -> None:
        self._inner = inner
        self._failures = failures

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        if self._failures.abandoned:
            return SpanExportResult.SUCCESS
        try:
            result = self._inner.export(spans)
        except Exception as exc:
            self._failures.record(exc)
            raise
        if result is not SpanExportResult.SUCCESS:
            self._failures.rejected()
        return result

    def shutdown(self, timeout_millis: float = 30_000) -> None:
        shutdown_exporter(self._inner.shutdown, timeout_millis)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return self._inner.force_flush(timeout_millis)


class ObservedMetricExporter(MetricExporter):
    """Reports every failed metric export to an ExportFailures, changing nothing else."""

    def __init__(self, built: BuiltMetricExporter, failures: ExportFailures) -> None:
        super().__init__(
            preferred_temporality=built.temporality,
            preferred_aggregation=built.aggregation,
        )
        self._inner = built.exporter
        self._failures = failures

    def export(
        self,
        metrics_data: MetricsData,
        timeout_millis: float = 10_000,
        **kwargs: Any,
    ) -> MetricExportResult:
        if self._failures.abandoned:
            return MetricExportResult.SUCCESS
        try:
            # The upstream base class leaves its variadic keywords untyped.
            result = self._inner.export(metrics_data, timeout_millis=timeout_millis, **kwargs)  # pyright: ignore[reportUnknownMemberType]
        except Exception as exc:
            self._failures.record(exc)
            raise
        if result is not MetricExportResult.SUCCESS:
            self._failures.rejected()
        return result

    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        return self._inner.force_flush(timeout_millis=timeout_millis)

    def shutdown(
        self, timeout_millis: float = 30_000, *, timeout: float | None = None, **kwargs: object
    ) -> None:
        # The periodic reader passes its remaining milliseconds as "timeout".
        remaining = timeout_millis if timeout is None else max(timeout, 0)
        self._inner.shutdown(timeout_millis=remaining, **kwargs)  # pyright: ignore[reportUnknownMemberType]
