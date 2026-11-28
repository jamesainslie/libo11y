//! Metric sinks receiving OTLP [`ExportMetricsServiceRequest`] payloads with
//! exemplars already attached.
//!
//! Ships [`MemoryMetricSink`] (for tests and inspection),
//! [`ConsoleMetricSink`] (for `OTEL_METRICS_EXPORTER=console`), and, under
//! `otlp-http` and `otlp-grpc`, the OTLP/HTTP and OTLP/gRPC sinks.

use std::fmt;
use std::future::Future;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::any_value::Value as ProtoAnyValue;
use opentelemetry_proto::tonic::metrics::v1::{exemplar, metric::Data, number_data_point};
use opentelemetry_sdk::error::{OTelSdkError, OTelSdkResult};
use opentelemetry_sdk::metrics::Temporality;

#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
use crate::BoxError;
use crate::env::EnvLookup;
#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
use crate::export::SignalExport;

/// The standard environment variable selecting OTLP metrics temporality.
pub(crate) const TEMPORALITY_ENV: &str = "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE";

/// Resolves `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` through `env`.
///
/// Recognized values (trimmed and lowercased) are `cumulative`, `delta`, and
/// `lowmemory`. Unset or unrecognized values default to
/// [`Temporality::Cumulative`]. Under hermetic mode (`EnvLookup::empty()`) this
/// always returns [`Temporality::Cumulative`].
#[must_use]
pub(crate) fn temporality_preference(env: &EnvLookup) -> Temporality {
    let Some(raw) = env.trimmed(TEMPORALITY_ENV) else {
        return Temporality::Cumulative;
    };
    match raw.to_ascii_lowercase().as_str() {
        "delta" => Temporality::Delta,
        "lowmemory" => Temporality::LowMemory,
        _ => Temporality::Cumulative,
    }
}

/// Compression algorithm resolved for OTLP metric export.
#[cfg_attr(
    not(any(feature = "otlp-http", feature = "otlp-grpc")),
    allow(dead_code, reason = "used by OTLP HTTP and gRPC sinks")
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Compression {
    None,
    Gzip,
}

/// Resolves `OTEL_EXPORTER_OTLP_METRICS_COMPRESSION`, else
/// `OTEL_EXPORTER_OTLP_COMPRESSION`, through `env`.
#[cfg_attr(
    not(any(feature = "otlp-http", feature = "otlp-grpc")),
    allow(dead_code, reason = "used by OTLP HTTP and gRPC sinks")
)]
pub(crate) fn resolve_compression(env: &EnvLookup) -> Compression {
    let raw = env
        .trimmed("OTEL_EXPORTER_OTLP_METRICS_COMPRESSION")
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_COMPRESSION"));
    match raw.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("gzip") => Compression::Gzip,
        _ => Compression::None,
    }
}

/// Resolves `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, else
/// `OTEL_EXPORTER_OTLP_HEADERS`, through `env`, with URL percent-decoding per
/// the OpenTelemetry OTLP specification.
#[cfg_attr(
    not(any(feature = "otlp-http", feature = "otlp-grpc")),
    allow(dead_code, reason = "used by OTLP HTTP and gRPC sinks")
)]
pub(crate) fn resolve_headers(env: &EnvLookup) -> Vec<(String, String)> {
    let Some(raw) = env
        .trimmed("OTEL_EXPORTER_OTLP_METRICS_HEADERS")
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_HEADERS"))
    else {
        return Vec::new();
    };
    parse_headers(&raw)
}

/// Parses comma-separated `key=value` OTLP header pairs, trimming whitespace
/// and URL percent-decoding each value.
pub(crate) fn parse_headers(raw: &str) -> Vec<(String, String)> {
    raw.split(',')
        .filter_map(|entry| {
            let (key, value) = entry.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let value = value.trim();
            let decoded = percent_decode(value).unwrap_or_else(|| value.to_owned());
            Some((key.to_owned(), decoded))
        })
        .collect()
}

/// URL percent-decodes UTF-8 sequences per RFC 3986 / OpenTelemetry header
/// specification.
fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_digit(bytes[i + 1])?;
            let lo = hex_digit(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Resolves `OTEL_EXPORTER_OTLP_METRICS_INSECURE`, else
/// `OTEL_EXPORTER_OTLP_INSECURE`, through `env` (gRPC only).
#[cfg_attr(
    not(feature = "otlp-grpc"),
    allow(dead_code, reason = "used by OTLP gRPC sink")
)]
pub(crate) fn resolve_insecure(env: &EnvLookup) -> bool {
    let raw = env
        .trimmed("OTEL_EXPORTER_OTLP_METRICS_INSECURE")
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_INSECURE"));
    raw.is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

/// A destination for exported OTLP metrics (with exemplars already attached).
///
/// Pass a custom sink to [`Builder::with_metric_sink`](crate::Builder::with_metric_sink)
/// (or [`Builder::with_extra_metric_sink`](crate::Builder::with_extra_metric_sink))
/// to receive [`ExportMetricsServiceRequest`] payloads directly.
pub trait MetricSink: Send + Sync + 'static {
    /// Exports one OTLP metrics batch.
    fn export(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> impl Future<Output = OTelSdkResult> + Send;

    /// Flushes any buffered metrics in the sink.
    ///
    /// # Errors
    ///
    /// Returns an [`OTelSdkError`] if flushing fails.
    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    /// Shuts the sink down within `timeout`.
    ///
    /// # Errors
    ///
    /// Returns an [`OTelSdkError`] if shutdown fails.
    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }

    /// The aggregation temporality preference this sink requests from the SDK.
    fn temporality(&self) -> Temporality {
        Temporality::Cumulative
    }
}

/// An in-memory [`MetricSink`] that records every exported
/// [`ExportMetricsServiceRequest`], including attached exemplars.
///
/// Cloning is cheap and shares the same underlying buffer, so tests can pass a
/// clone into [`Builder::with_metric_sink`](crate::Builder::with_metric_sink)
/// and inspect the exported metrics afterwards.
#[derive(Clone, Debug)]
pub struct MemoryMetricSink {
    inner: Arc<MemoryInner>,
}

#[derive(Debug)]
struct MemoryInner {
    requests: Mutex<Vec<ExportMetricsServiceRequest>>,
    temporality: Temporality,
    shutdown: AtomicBool,
}

impl Default for MemoryMetricSink {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryMetricSink {
    /// Creates an in-memory sink requesting [`Temporality::Cumulative`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_temporality(Temporality::Cumulative)
    }

    /// Creates an in-memory sink requesting `temporality`.
    #[must_use]
    pub fn with_temporality(temporality: Temporality) -> Self {
        Self {
            inner: Arc::new(MemoryInner {
                requests: Mutex::new(Vec::new()),
                temporality,
                shutdown: AtomicBool::new(false),
            }),
        }
    }

    /// Returns a snapshot of every request exported so far, in export order.
    #[must_use]
    pub fn requests(&self) -> Vec<ExportMetricsServiceRequest> {
        self.inner
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Clears all recorded requests.
    pub fn clear(&self) {
        self.inner
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// Reports whether shutdown has been invoked on this sink.
    #[must_use]
    pub fn is_shutdown(&self) -> bool {
        self.inner.shutdown.load(Ordering::Acquire)
    }
}

impl MetricSink for MemoryMetricSink {
    fn export(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> impl Future<Output = OTelSdkResult> + Send {
        let result = if self.inner.shutdown.load(Ordering::Acquire) {
            Err(OTelSdkError::AlreadyShutdown)
        } else {
            self.inner
                .requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(request);
            Ok(())
        };
        std::future::ready(result)
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown.store(true, Ordering::Release);
        Ok(())
    }

    fn temporality(&self) -> Temporality {
        self.inner.temporality
    }
}

/// A [`MetricSink`] that writes human-readable metrics (including exemplars)
/// to standard output or a custom writer. Used when
/// `OTEL_METRICS_EXPORTER=console`.
pub(crate) struct ConsoleMetricSink {
    writer: Mutex<Box<dyn Write + Send>>,
    temporality: Temporality,
    shutdown: AtomicBool,
}

impl fmt::Debug for ConsoleMetricSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConsoleMetricSink")
            .field("temporality", &self.temporality)
            .finish_non_exhaustive()
    }
}

impl ConsoleMetricSink {
    /// Writes to standard output with `temporality`.
    #[must_use]
    pub(crate) fn stdout(temporality: Temporality) -> Self {
        Self::with_writer(Box::new(io::stdout()), temporality)
    }

    /// Writes to `writer` with `temporality`.
    #[must_use]
    pub(crate) fn with_writer(writer: Box<dyn Write + Send>, temporality: Temporality) -> Self {
        Self {
            writer: Mutex::new(writer),
            temporality,
            shutdown: AtomicBool::new(false),
        }
    }
}

impl MetricSink for ConsoleMetricSink {
    fn export(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> impl Future<Output = OTelSdkResult> + Send {
        let result = if self.shutdown.load(Ordering::Acquire) {
            Err(OTelSdkError::AlreadyShutdown)
        } else {
            let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
            write_console_request(&mut *writer, &request)
                .and_then(|()| writer.flush())
                .map_err(|err| OTelSdkError::InternalFailure(err.to_string()))
        };
        std::future::ready(result)
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.shutdown.store(true, Ordering::Release);
        Ok(())
    }

    fn temporality(&self) -> Temporality {
        self.temporality
    }
}

fn write_console_request(
    w: &mut dyn Write,
    request: &ExportMetricsServiceRequest,
) -> io::Result<()> {
    for rm in &request.resource_metrics {
        for sm in &rm.scope_metrics {
            let scope = sm.scope.as_ref().map_or("", |s| s.name.as_str());
            for metric in &sm.metrics {
                writeln!(
                    w,
                    "metric scope={scope:?} name={:?} unit={:?}",
                    metric.name, metric.unit
                )?;
                match &metric.data {
                    Some(Data::Sum(sum)) => {
                        for dp in &sum.data_points {
                            write_number_point(w, "sum", dp)?;
                        }
                    }
                    Some(Data::Gauge(gauge)) => {
                        for dp in &gauge.data_points {
                            write_number_point(w, "gauge", dp)?;
                        }
                    }
                    Some(Data::Histogram(hist)) => {
                        for dp in &hist.data_points {
                            writeln!(
                                w,
                                "  histogram count={} sum={:?} bounds={:?} buckets={:?} attrs={}",
                                dp.count,
                                dp.sum,
                                dp.explicit_bounds,
                                dp.bucket_counts,
                                format_proto_attrs(&dp.attributes)
                            )?;
                            for ex in &dp.exemplars {
                                write_exemplar(w, ex)?;
                            }
                        }
                    }
                    Some(Data::ExponentialHistogram(exp)) => {
                        for dp in &exp.data_points {
                            writeln!(
                                w,
                                "  exp_histogram count={} sum={:?} scale={} attrs={}",
                                dp.count,
                                dp.sum,
                                dp.scale,
                                format_proto_attrs(&dp.attributes)
                            )?;
                            for ex in &dp.exemplars {
                                write_exemplar(w, ex)?;
                            }
                        }
                    }
                    Some(Data::Summary(_)) | None => {}
                }
            }
        }
    }
    Ok(())
}

fn write_number_point(
    w: &mut dyn Write,
    kind: &str,
    dp: &opentelemetry_proto::tonic::metrics::v1::NumberDataPoint,
) -> io::Result<()> {
    let val = match dp.value {
        Some(number_data_point::Value::AsInt(i)) => i.to_string(),
        Some(number_data_point::Value::AsDouble(d)) => d.to_string(),
        None => "none".to_owned(),
    };
    writeln!(
        w,
        "  {kind} value={val} attrs={}",
        format_proto_attrs(&dp.attributes)
    )?;
    for ex in &dp.exemplars {
        write_exemplar(w, ex)?;
    }
    Ok(())
}

fn write_exemplar(
    w: &mut dyn Write,
    ex: &opentelemetry_proto::tonic::metrics::v1::Exemplar,
) -> io::Result<()> {
    let val = match ex.value {
        Some(exemplar::Value::AsInt(i)) => i.to_string(),
        Some(exemplar::Value::AsDouble(d)) => d.to_string(),
        None => "none".to_owned(),
    };
    writeln!(
        w,
        "    exemplar value={val} trace_id={} span_id={} filtered={}",
        hex_encode(&ex.trace_id),
        hex_encode(&ex.span_id),
        format_proto_attrs(&ex.filtered_attributes)
    )
}

fn format_proto_attrs(attrs: &[opentelemetry_proto::tonic::common::v1::KeyValue]) -> String {
    let items: Vec<String> = attrs
        .iter()
        .map(|kv| {
            let v = kv
                .value
                .as_ref()
                .and_then(|a| a.value.as_ref())
                .map_or_else(|| "null".to_owned(), format_any_value);
            format!("{}={v}", kv.key)
        })
        .collect();
    format!("{{{}}}", items.join(", "))
}

fn format_any_value(val: &ProtoAnyValue) -> String {
    match val {
        ProtoAnyValue::StringValue(s) => format!("{s:?}"),
        ProtoAnyValue::BoolValue(b) => b.to_string(),
        ProtoAnyValue::IntValue(i) => i.to_string(),
        ProtoAnyValue::DoubleValue(d) => d.to_string(),
        other => format!("{other:?}"),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Validates an OTLP/HTTP endpoint URL at SDK init so malformed URLs fail
/// immediately without leaking embedded credentials or query strings.
#[cfg(feature = "otlp-http")]
pub(crate) fn validate_http_endpoint(
    signal: &str,
    endpoint: &str,
) -> Result<reqwest::Url, BoxError> {
    let safe_endpoint = crate::sanitize::sanitize_endpoint(endpoint);
    let parsed = reqwest::Url::parse(endpoint).map_err(|err| {
        format!(
            "invalid OTLP/HTTP {signal} endpoint {}: {err}",
            libo11y_spec::go_quote(&safe_endpoint)
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.has_host() {
        return Err(format!(
            "invalid OTLP/HTTP {signal} endpoint {}: scheme must be http or https with a host",
            libo11y_spec::go_quote(&safe_endpoint)
        )
        .into());
    }
    Ok(parsed)
}

/// OTLP/HTTP metric sink supporting `http/protobuf` and `http/json`, gzip
/// compression, custom headers, TLS/mTLS, timeouts, and exponential-backoff
/// retries on 429/502/503/504.
#[cfg(feature = "otlp-http")]
pub(crate) struct OtlpHttpMetricSink {
    client: reqwest::blocking::Client,
    endpoint: String,
    protocol: crate::export::Protocol,
    compression: Compression,
    headers: reqwest::header::HeaderMap,
    timeout: Duration,
    temporality: Temporality,
    error_handler: crate::diagnostics::ErrorHandler,
    shutdown: AtomicBool,
}

#[cfg(feature = "otlp-http")]
impl fmt::Debug for OtlpHttpMetricSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtlpHttpMetricSink")
            .field("endpoint", &self.endpoint)
            .field("protocol", &self.protocol)
            .field("compression", &self.compression)
            .field("temporality", &self.temporality)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "otlp-http")]
impl OtlpHttpMetricSink {
    const MAX_RETRIES: u32 = 3;
    const BASE_BACKOFF: Duration = Duration::from_millis(100);

    /// Builds an OTLP/HTTP metric sink from `export` and `env`.
    pub(crate) fn new(
        export: &SignalExport,
        env: &EnvLookup,
        error_handler: crate::diagnostics::ErrorHandler,
    ) -> Result<Self, BoxError> {
        validate_http_endpoint("metrics", &export.endpoint)?;
        let tls = export.tls.load()?;
        let client = if let Some(material) = tls {
            material.blocking_client(export.timeout)?
        } else {
            crate::export::tls::blocking_client(None, None, export.timeout)?
        };

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(concat!(
                "OTel-OTLP-Exporter-Rust/libo11y-",
                env!("CARGO_PKG_VERSION")
            )),
        );
        for (name, value) in resolve_headers(env) {
            if let (Ok(hname), Ok(hval)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_str(&value),
            ) {
                headers.insert(hname, hval);
            }
        }

        Ok(Self {
            client,
            endpoint: export.endpoint.clone(),
            protocol: export.protocol,
            compression: resolve_compression(env),
            headers,
            timeout: export.timeout,
            temporality: temporality_preference(env),
            error_handler,
            shutdown: AtomicBool::new(false),
        })
    }

    fn encode_request(
        &self,
        request: &ExportMetricsServiceRequest,
    ) -> Result<(Vec<u8>, &'static str), OTelSdkError> {
        let (raw, content_type) = if self.protocol == crate::export::Protocol::HttpJson {
            let bytes = serde_json::to_vec(request).map_err(|err| {
                OTelSdkError::InternalFailure(format!("encoding OTLP/JSON metrics: {err}"))
            })?;
            (bytes, "application/json")
        } else {
            use prost::Message as _;
            (request.encode_to_vec(), "application/x-protobuf")
        };

        if self.compression == Compression::Gzip {
            let mut encoder =
                flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&raw).map_err(|err| {
                OTelSdkError::InternalFailure(format!("gzip compressing OTLP metrics: {err}"))
            })?;
            let compressed = encoder.finish().map_err(|err| {
                OTelSdkError::InternalFailure(format!("finishing gzip OTLP metrics: {err}"))
            })?;
            Ok((compressed, content_type))
        } else {
            Ok((raw, content_type))
        }
    }

    fn send_with_retry(&self, body: &[u8], content_type: &'static str) -> OTelSdkResult {
        for attempt in 0..=Self::MAX_RETRIES {
            if self.shutdown.load(Ordering::Acquire) {
                return Err(OTelSdkError::AlreadyShutdown);
            }
            let mut req = self
                .client
                .post(&self.endpoint)
                .headers(self.headers.clone())
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(body.to_vec());
            if self.compression == Compression::Gzip {
                req = req.header(reqwest::header::CONTENT_ENCODING, "gzip");
            }
            let response = match req.send() {
                Ok(resp) => resp,
                Err(err) => {
                    let err = err.without_url();
                    return Err(OTelSdkError::InternalFailure(format!(
                        "OTLP/HTTP metric export failed: {err}"
                    )));
                }
            };
            let status = response.status();
            if status.is_success() {
                handle_http_partial_success(response, self.protocol, &self.error_handler);
                return Ok(());
            }
            let retryable = matches!(status.as_u16(), 429 | 502 | 503 | 504);
            if retryable && attempt < Self::MAX_RETRIES {
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.trim().parse::<u64>().ok())
                    .map(Duration::from_secs);
                let exp = Self::BASE_BACKOFF.saturating_mul(1u32 << attempt);
                let delay = retry_after.unwrap_or(exp).min(self.timeout);
                std::thread::sleep(delay);
                continue;
            }
            return Err(OTelSdkError::InternalFailure(format!(
                "OTLP/HTTP metric export rejected with HTTP {}",
                status.as_u16()
            )));
        }
        Err(OTelSdkError::InternalFailure(
            "OTLP/HTTP metric export exhausted retries".to_owned(),
        ))
    }
}

#[cfg(feature = "otlp-http")]
impl MetricSink for OtlpHttpMetricSink {
    fn export(
        &self,
        request: ExportMetricsServiceRequest,
    ) -> impl Future<Output = OTelSdkResult> + Send {
        let result = if self.shutdown.load(Ordering::Acquire) {
            Err(OTelSdkError::AlreadyShutdown)
        } else {
            self.encode_request(&request)
                .and_then(|(body, content_type)| self.send_with_retry(&body, content_type))
        };
        std::future::ready(result)
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.shutdown.store(true, Ordering::Release);
        Ok(())
    }

    fn temporality(&self) -> Temporality {
        self.temporality
    }
}

/// OTLP/gRPC metric sink over tonic's generated `MetricsServiceClient`.
#[cfg(feature = "otlp-grpc")]
pub(crate) struct OtlpGrpcMetricSink {
    channel: tonic::transport::Channel,
    runtime: tokio::runtime::Handle,
    compression: Compression,
    metadata: Vec<(http::HeaderName, http::HeaderValue)>,
    timeout: Duration,
    temporality: Temporality,
    error_handler: crate::diagnostics::ErrorHandler,
    shutdown: AtomicBool,
}

#[cfg(feature = "otlp-grpc")]
impl fmt::Debug for OtlpGrpcMetricSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OtlpGrpcMetricSink")
            .field("compression", &self.compression)
            .field("temporality", &self.temporality)
            .finish_non_exhaustive()
    }
}

/// Normalizes a gRPC endpoint so schemeless `host:port` values get `http://`
/// when `insecure` is set, else `https://`. Unix sockets (`unix:`) and
/// endpoints that already carry a `scheme://` prefix before `/`, `?`, or `#`
/// are returned unchanged.
#[cfg_attr(
    not(feature = "otlp-grpc"),
    allow(dead_code, reason = "used by OTLP gRPC sink")
)]
pub(crate) fn normalize_grpc_endpoint(raw: &str, insecure: bool) -> String {
    if raw.starts_with("unix:") {
        return raw.to_owned();
    }
    let authority_end = raw.find(['/', '?', '#']).unwrap_or(raw.len());
    if raw
        .find("://")
        .is_some_and(|pos| pos > 0 && pos < authority_end)
    {
        return raw.to_owned();
    }
    let scheme = if insecure { "http://" } else { "https://" };
    format!("{scheme}{raw}")
}

#[cfg(feature = "otlp-grpc")]
impl OtlpGrpcMetricSink {
    /// Builds an OTLP/gRPC metric sink lazily on the current Tokio runtime.
    pub(crate) fn new(
        export: &SignalExport,
        env: &EnvLookup,
        error_handler: crate::diagnostics::ErrorHandler,
    ) -> Result<Self, BoxError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| -> BoxError {
            "OTLP over grpc needs a Tokio runtime: build the SDK inside one and keep it running while the SDK exports".into()
        })?;
        let tls = export.tls.load()?;
        let insecure = resolve_insecure(env);

        let endpoint_str = normalize_grpc_endpoint(&export.endpoint, insecure);
        let mut endpoint =
            tonic::transport::Endpoint::from_shared(endpoint_str.clone())?.timeout(export.timeout);
        if !endpoint_str.starts_with("unix:")
            && (tls.is_some()
                || endpoint
                    .uri()
                    .scheme_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case("https")))
        {
            endpoint =
                endpoint.tls_config(crate::export::tls::TlsMaterial::tonic_config(tls.as_ref()))?;
        }
        let channel = endpoint.connect_lazy();

        let mut metadata = Vec::new();
        for (name, value) in resolve_headers(env) {
            if let Some((k, v)) = crate::export::otlp::parse_grpc_header(&name, &value) {
                metadata.push((k, v));
            }
        }

        Ok(Self {
            channel,
            runtime,
            compression: resolve_compression(env),
            metadata,
            timeout: export.timeout,
            temporality: temporality_preference(env),
            error_handler,
            shutdown: AtomicBool::new(false),
        })
    }
}

#[cfg(feature = "otlp-grpc")]
impl MetricSink for OtlpGrpcMetricSink {
    async fn export(&self, request: ExportMetricsServiceRequest) -> OTelSdkResult {
        if self.shutdown.load(Ordering::Acquire) {
            return Err(OTelSdkError::AlreadyShutdown);
        }
        let channel = self.channel.clone();
        let compression = self.compression;
        let metadata = self.metadata.clone();
        let timeout = self.timeout;
        let handle = self.runtime.spawn(async move {
            use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_client::MetricsServiceClient;

            let mut client = MetricsServiceClient::new(channel);
            if compression == Compression::Gzip {
                client = client.send_compressed(tonic::codec::CompressionEncoding::Gzip);
            }
            let mut req = tonic::Request::new(request);
            req.set_timeout(timeout);
            if !metadata.is_empty() {
                let mut headers =
                    std::mem::replace(req.metadata_mut(), tonic::metadata::MetadataMap::new())
                        .into_headers();
                for (k, v) in metadata {
                    headers.insert(k, v);
                }
                *req.metadata_mut() = tonic::metadata::MetadataMap::from_headers(headers);
            }
            client.export(req).await
        });
        match handle.await {
            Ok(Ok(response)) => {
                if let Some(partial) = response.into_inner().partial_success {
                    report_partial_success(
                        &self.error_handler,
                        "TonicMetricsClient.PartialSuccess",
                        &partial,
                    );
                }
                Ok(())
            }
            Ok(Err(status)) => Err(OTelSdkError::InternalFailure(format!(
                "OTLP/gRPC metric export failed: {status}"
            ))),
            Err(join_err) => Err(OTelSdkError::InternalFailure(format!(
                "OTLP/gRPC metric export task failed: {join_err}"
            ))),
        }
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        self.shutdown.store(true, Ordering::Release);
        Ok(())
    }

    fn temporality(&self) -> Temporality {
        self.temporality
    }
}

/// Maximum response body bytes read while inspecting OTLP/HTTP partial success,
/// matching `opentelemetry-http`'s 4 MiB cap.
#[cfg(feature = "otlp-http")]
const MAX_PARTIAL_SUCCESS_BODY_BYTES: u64 = 4 * 1024 * 1024;

/// Decodes an OTLP/HTTP `ExportMetricsServiceResponse` body and reports any
/// non-empty `partial_success` directly to `error_handler` without failing or
/// retrying the export.
#[cfg(feature = "otlp-http")]
fn handle_http_partial_success(
    response: reqwest::blocking::Response,
    protocol: crate::export::Protocol,
    error_handler: &crate::diagnostics::ErrorHandler,
) {
    use io::Read as _;
    use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse;
    use prost::Message as _;

    let mut body = Vec::new();
    if response
        .take(MAX_PARTIAL_SUCCESS_BODY_BYTES)
        .read_to_end(&mut body)
        .is_err()
        || body.is_empty()
    {
        return;
    }
    let decoded: Result<ExportMetricsServiceResponse, String> =
        if protocol == crate::export::Protocol::HttpJson {
            serde_json::from_slice(&body).map_err(|err| err.to_string())
        } else {
            ExportMetricsServiceResponse::decode(body.as_slice()).map_err(|err| err.to_string())
        };
    match decoded {
        Ok(resp) => {
            if let Some(partial) = resp.partial_success {
                report_partial_success(error_handler, "HttpMetricsClient.PartialSuccess", &partial);
            }
        }
        Err(err) => {
            tracing::debug!(
                name: "HttpMetricsClient.ResponseParseError",
                target: "opentelemetry-otlp",
                error = %err,
            );
        }
    }
}

/// Reports a non-empty collector partial-success response directly to the SDK's
/// error handler so it is delivered from background periodic-reader threads
/// even when no global `tracing` subscriber is installed.
#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
fn report_partial_success(
    error_handler: &crate::diagnostics::ErrorHandler,
    event_name: &'static str,
    partial: &opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsPartialSuccess,
) {
    if partial.rejected_data_points > 0 || !partial.error_message.is_empty() {
        use std::fmt::Write as _;

        let mut message = format!(
            "MetricsClient.PartialSuccess: client={event_name} rejected_data_points={}",
            partial.rejected_data_points
        );
        if !partial.error_message.is_empty() {
            let _ = write!(message, " error_message={}", partial.error_message);
        }
        error_handler(&crate::diagnostics::TelemetryError::with_target(
            "opentelemetry-otlp",
            message,
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporality_env_resolution() {
        let env = |v: &str| EnvLookup::from_pairs([(TEMPORALITY_ENV, v)]);
        assert_eq!(
            temporality_preference(&EnvLookup::empty()),
            Temporality::Cumulative
        );
        assert_eq!(temporality_preference(&env("delta")), Temporality::Delta);
        assert_eq!(
            temporality_preference(&env("  LOWMEMORY ")),
            Temporality::LowMemory
        );
        assert_eq!(
            temporality_preference(&env("CUMULATIVE")),
            Temporality::Cumulative
        );
        assert_eq!(
            temporality_preference(&env("invalid")),
            Temporality::Cumulative
        );
    }

    #[test]
    fn header_parsing_trims_and_percent_decodes() {
        let headers =
            parse_headers("authorization=Bearer%20tok%2Fen, x-custom = a%3Db , =bad, ok=1");
        assert_eq!(
            headers,
            vec![
                ("authorization".to_owned(), "Bearer tok/en".to_owned()),
                ("x-custom".to_owned(), "a=b".to_owned()),
                ("ok".to_owned(), "1".to_owned()),
            ]
        );
    }

    #[test]
    fn compression_and_insecure_resolution() {
        let env = EnvLookup::from_pairs([
            ("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip"),
            ("OTEL_EXPORTER_OTLP_METRICS_COMPRESSION", "none"),
            ("OTEL_EXPORTER_OTLP_INSECURE", "false"),
            ("OTEL_EXPORTER_OTLP_METRICS_INSECURE", "TRUE"),
        ]);
        assert_eq!(resolve_compression(&env), Compression::None);
        assert!(resolve_insecure(&env));

        let general_only = EnvLookup::from_pairs([("OTEL_EXPORTER_OTLP_COMPRESSION", "GZIP")]);
        assert_eq!(resolve_compression(&general_only), Compression::Gzip);
        assert!(!resolve_insecure(&general_only));
    }

    #[test]
    fn console_sink_prints_metrics_and_exemplars() {
        use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
        use opentelemetry_proto::tonic::metrics::v1::{
            Exemplar, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics, Sum,
        };

        struct SharedBuf(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedBuf {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().expect("lock").extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        let buf = Arc::new(Mutex::new(Vec::new()));
        let sink = ConsoleMetricSink::with_writer(
            Box::new(SharedBuf(Arc::clone(&buf))),
            Temporality::Cumulative,
        );
        let request = ExportMetricsServiceRequest {
            resource_metrics: vec![ResourceMetrics {
                resource: None,
                scope_metrics: vec![ScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "demo".to_owned(),
                        ..Default::default()
                    }),
                    metrics: vec![Metric {
                        name: "demo.hits".to_owned(),
                        unit: "{hit}".to_owned(),
                        data: Some(Data::Sum(Sum {
                            data_points: vec![NumberDataPoint {
                                value: Some(number_data_point::Value::AsInt(42)),
                                exemplars: vec![Exemplar {
                                    trace_id: vec![0xab; 16],
                                    span_id: vec![0xcd; 8],
                                    value: Some(exemplar::Value::AsInt(7)),
                                    ..Default::default()
                                }],
                                ..Default::default()
                            }],
                            ..Default::default()
                        })),
                        ..Default::default()
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        // Export synchronously via poll on Ready.
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("rt");
        rt.block_on(sink.export(request)).expect("console export");
        let output = String::from_utf8(buf.lock().expect("lock").clone()).expect("utf8");
        assert!(output.contains("demo.hits"), "{output}");
        assert!(output.contains("value=42"), "{output}");
        assert!(output.contains("exemplar value=7"), "{output}");
        assert!(
            output.contains("trace_id=abababababababababababababababab"),
            "{output}"
        );
        assert!(output.contains("span_id=cdcdcdcdcdcdcdcd"), "{output}");
    }

    #[test]
    fn grpc_endpoint_normalization_handles_schemeless_unix_and_schemes() {
        assert_eq!(
            normalize_grpc_endpoint("collector.example:4317", false),
            "https://collector.example:4317"
        );
        assert_eq!(
            normalize_grpc_endpoint("collector.example:4317", true),
            "http://collector.example:4317"
        );
        assert_eq!(
            normalize_grpc_endpoint("http://localhost:4317", false),
            "http://localhost:4317"
        );
        assert_eq!(
            normalize_grpc_endpoint("https://collector.example:4317", true),
            "https://collector.example:4317"
        );
        assert_eq!(
            normalize_grpc_endpoint("unix:///tmp/otel.sock", false),
            "unix:///tmp/otel.sock"
        );
        assert_eq!(
            normalize_grpc_endpoint("collector.example:4317/path://ignored", false),
            "https://collector.example:4317/path://ignored"
        );
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn http_metric_sink_rejects_malformed_endpoints_at_init() {
        let noop: crate::diagnostics::ErrorHandler = Arc::new(|_| {});
        for bad in [
            "not-a-url",
            "://missing-scheme",
            "ftp://user:secret@collector:4318/v1/metrics?api_key=tok",
            "http://",
        ] {
            let export = SignalExport {
                route: crate::export::Route::Otlp,
                protocol: crate::export::Protocol::HttpProtobuf,
                endpoint: bad.to_owned(),
                timeout: Duration::from_secs(5),
                tls: crate::export::tls::TlsFiles::default(),
            };
            let err = OtlpHttpMetricSink::new(&export, &EnvLookup::empty(), Arc::clone(&noop))
                .expect_err("malformed endpoint must fail init");
            let msg = err.to_string();
            assert!(
                msg.contains("invalid OTLP/HTTP metrics endpoint"),
                "for {bad}: {msg}"
            );
            assert!(!msg.contains("secret"), "credential leaked: {msg}");
            assert!(!msg.contains("tok"), "query token leaked: {msg}");
        }
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn http_metric_sink_transport_errors_strip_url_credentials() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let noop: crate::diagnostics::ErrorHandler = Arc::new(|_| {});
        let export = SignalExport {
            route: crate::export::Route::Otlp,
            protocol: crate::export::Protocol::HttpProtobuf,
            endpoint: format!(
                "http://user:secret@127.0.0.1:{}/v1/metrics?api_key=tok123",
                addr.port()
            ),
            timeout: Duration::from_secs(2),
            tls: crate::export::tls::TlsFiles::default(),
        };
        let sink = OtlpHttpMetricSink::new(&export, &EnvLookup::empty(), noop).expect("sink");
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("rt");
        let err = rt
            .block_on(sink.export(ExportMetricsServiceRequest::default()))
            .expect_err("closed port must fail export");
        let msg = err.to_string();
        assert!(!msg.contains("secret"), "userinfo leaked: {msg}");
        assert!(!msg.contains("tok123"), "query credential leaked: {msg}");
        assert!(!msg.contains("api_key"), "query key leaked: {msg}");
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn http_metric_sink_reports_partial_success_directly_to_error_handler() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        use opentelemetry_proto::tonic::collector::metrics::v1::{
            ExportMetricsPartialSuccess, ExportMetricsServiceResponse,
        };
        use prost::Message as _;

        let response_proto = ExportMetricsServiceResponse {
            partial_success: Some(ExportMetricsPartialSuccess {
                rejected_data_points: 3,
                error_message: "bad label".to_owned(),
            }),
        };

        for (protocol, content_type, body) in [
            (
                crate::export::Protocol::HttpProtobuf,
                "application/x-protobuf",
                response_proto.encode_to_vec(),
            ),
            (
                crate::export::Protocol::HttpJson,
                "application/json",
                serde_json::to_vec(&response_proto).expect("json"),
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let addr = listener.local_addr().expect("addr");
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).expect("head");
                stream.write_all(&body).expect("body");
            });

            let reported = Arc::new(Mutex::new(Vec::<(Option<String>, String)>::new()));
            let capture = Arc::clone(&reported);
            let handler: crate::diagnostics::ErrorHandler = Arc::new(move |err| {
                capture
                    .lock()
                    .expect("lock")
                    .push((err.target().map(str::to_owned), err.message().to_owned()));
            });

            let export = SignalExport {
                route: crate::export::Route::Otlp,
                protocol,
                endpoint: format!("http://{addr}/v1/metrics"),
                timeout: Duration::from_secs(5),
                tls: crate::export::tls::TlsFiles::default(),
            };
            let sink =
                OtlpHttpMetricSink::new(&export, &EnvLookup::empty(), handler).expect("sink");

            // No tracing subscriber is installed: delivery must still reach
            // the error handler directly.
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .expect("rt");
            rt.block_on(sink.export(ExportMetricsServiceRequest::default()))
                .expect("partial success does not fail export");
            server.join().expect("server");

            let messages = reported.lock().expect("lock");
            assert_eq!(
                messages.len(),
                1,
                "expected 1 diagnostic for {protocol:?}: {messages:?}"
            );
            assert_eq!(messages[0].0.as_deref(), Some("opentelemetry-otlp"));
            assert!(
                messages[0].1.contains("rejected_data_points=3"),
                "{messages:?}"
            );
            assert!(messages[0].1.contains("bad label"), "{messages:?}");
        }
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn sdk_build_delivers_metric_partial_success_without_tracing_subscriber() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        use opentelemetry_proto::tonic::collector::metrics::v1::{
            ExportMetricsPartialSuccess, ExportMetricsServiceResponse,
        };
        use prost::Message as _;

        let body = ExportMetricsServiceResponse {
            partial_success: Some(ExportMetricsPartialSuccess {
                rejected_data_points: 1,
                error_message: "periodic reader partial".to_owned(),
            }),
        }
        .encode_to_vec();

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).expect("head");
            stream.write_all(&body).expect("body");
        });

        let reported = Arc::new(Mutex::new(Vec::<String>::new()));
        let capture = Arc::clone(&reported);
        let env = EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "none"),
            ("OTEL_LOGS_EXPORTER", "none"),
            ("OTEL_METRICS_EXPORTER", "otlp"),
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"),
            (
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                &format!("http://{addr}/v1/metrics"),
            ),
        ]);
        let sdk = crate::Sdk::builder()
            .service_name("partial-no-subscriber")
            .environment(crate::Environment::Test)
            .without_console_log()
            .without_runtime_metrics()
            .env_lookup(env)
            .with_error_handler(move |err| {
                capture.lock().expect("lock").push(err.message().to_owned());
            })
            .build()
            .expect("SDK");
        sdk.meter("svc").u64_counter("hits").build().add(1, &[]);
        sdk.force_flush().expect("flush");
        server.join().expect("server");
        let _ = sdk.shutdown();

        let messages = reported.lock().expect("lock");
        assert!(
            messages
                .iter()
                .any(|m| m.contains("rejected_data_points=1")
                    && m.contains("periodic reader partial")),
            "partial success did not reach error handler on build(): {messages:?}"
        );
    }

    #[cfg(feature = "otlp-grpc")]
    #[tokio::test]
    async fn grpc_metric_sink_reports_partial_success_directly_to_error_handler() {
        use opentelemetry_proto::tonic::collector::metrics::v1::{
            ExportMetricsPartialSuccess, ExportMetricsServiceResponse,
            metrics_service_server::{MetricsService, MetricsServiceServer},
        };

        struct PartialService;

        #[tonic::async_trait]
        impl MetricsService for PartialService {
            async fn export(
                &self,
                _request: tonic::Request<ExportMetricsServiceRequest>,
            ) -> Result<tonic::Response<ExportMetricsServiceResponse>, tonic::Status> {
                Ok(tonic::Response::new(ExportMetricsServiceResponse {
                    partial_success: Some(ExportMetricsPartialSuccess {
                        rejected_data_points: 2,
                        error_message: "grpc partial".to_owned(),
                    }),
                }))
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let incoming = tonic::transport::server::TcpIncoming::from(listener);
        let server = tokio::spawn(async move {
            let _ = tonic::transport::Server::builder()
                .add_service(MetricsServiceServer::new(PartialService))
                .serve_with_incoming(incoming)
                .await;
        });

        let reported = Arc::new(Mutex::new(Vec::<(Option<String>, String)>::new()));
        let capture = Arc::clone(&reported);
        let handler: crate::diagnostics::ErrorHandler = Arc::new(move |err| {
            capture
                .lock()
                .expect("lock")
                .push((err.target().map(str::to_owned), err.message().to_owned()));
        });

        let export = SignalExport {
            route: crate::export::Route::Otlp,
            protocol: crate::export::Protocol::Grpc,
            endpoint: format!("http://{addr}"),
            timeout: Duration::from_secs(5),
            tls: crate::export::tls::TlsFiles::default(),
        };
        let sink =
            OtlpGrpcMetricSink::new(&export, &EnvLookup::empty(), handler).expect("grpc sink");

        sink.export(ExportMetricsServiceRequest::default())
            .await
            .expect("partial success does not fail export");
        server.abort();

        let messages = reported.lock().expect("lock");
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert_eq!(messages[0].0.as_deref(), Some("opentelemetry-otlp"));
        assert!(
            messages[0].1.contains("rejected_data_points=2"),
            "{messages:?}"
        );
        assert!(messages[0].1.contains("grpc partial"), "{messages:?}");
    }
}
