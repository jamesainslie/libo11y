//! In-memory telemetry recorder wrapping a hermetic [`libo11y::Sdk`].

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use opentelemetry::Context;
use opentelemetry::logs::AnyValue;
use opentelemetry::trace::{SpanContext, TraceContextExt as _};
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    KeyValue as ProtoKeyValue, any_value::Value as ProtoAnyValue,
};
use opentelemetry_proto::tonic::metrics::v1::{Exemplar as ProtoExemplar, exemplar, metric::Data};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{Sampler, Span, SpanData, SpanProcessor};

use libo11y::{
    BoxError, Builder, Environment, Error, ExemplarFilter, LogRecord, LogSink, MemoryMetricSink,
    Sdk,
};

/// One captured log record together with the active span context observed
/// when it was emitted.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedLog {
    record: LogRecord,
    span_context: Option<SpanContext>,
}

impl CapturedLog {
    pub(crate) fn new(record: LogRecord, span_context: Option<SpanContext>) -> Self {
        Self {
            record,
            span_context,
        }
    }

    /// The underlying structured [`LogRecord`] delivered to the sink.
    #[must_use]
    pub fn record(&self) -> &LogRecord {
        &self.record
    }

    /// The active span context when the record was emitted, if any.
    #[must_use]
    pub fn span_context(&self) -> Option<&SpanContext> {
        self.span_context.as_ref()
    }

    /// The log message or event body.
    #[must_use]
    pub fn message(&self) -> &str {
        self.record.message()
    }

    /// The record's severity level.
    #[must_use]
    pub fn level(&self) -> tracing::Level {
        self.record.level()
    }

    /// The `tracing` target or scope that emitted the record.
    #[must_use]
    pub fn target(&self) -> &str {
        self.record.target()
    }

    /// The `event.name` attribute value when the record carries one.
    #[must_use]
    pub fn event_name(&self) -> Option<&str> {
        self.record.event_name()
    }

    /// The 32-character lowercase hex trace ID stamped on the record, if any.
    #[must_use]
    pub fn trace_id(&self) -> Option<String> {
        self.record.trace_id().map(|id| id.to_string())
    }

    /// The 16-character lowercase hex span ID stamped on the record, if any.
    #[must_use]
    pub fn span_id(&self) -> Option<String> {
        self.record.span_id().map(|id| id.to_string())
    }

    /// Returns the first top-level attribute value matching `key`, if present.
    #[must_use]
    pub fn attr(&self, key: &str) -> Option<&AnyValue> {
        self.record.attr(key)
    }

    /// Returns the string rendering of the first top-level attribute matching
    /// `key`, if present.
    #[must_use]
    pub fn attr_str(&self, key: &str) -> Option<String> {
        self.record.attr(key).map(format_log_any_value)
    }
}

/// One metric exemplar recorded on an instrument: its trace identity, numeric
/// value, and any filtered attributes preserved on the exemplar.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedExemplar {
    /// Lowercase hex trace ID (32 characters) when recorded inside a valid
    /// span, or empty when recorded outside any span.
    pub trace_id: String,
    /// Lowercase hex span ID (16 characters) when recorded inside a valid
    /// span, or empty when recorded outside any span.
    pub span_id: String,
    /// The measured value, converted to `f64` for integer instruments.
    pub value: f64,
    /// Attributes dropped from the metric stream by a view and attached to
    /// the exemplar.
    pub filtered_attributes: Vec<(String, String)>,
}

/// A hermetic test harness recording spans, metrics (with exemplars), and
/// structured log records in memory without touching process globals.
///
/// Dropping a `Recorder` shuts its [`Sdk`] down cleanly.
pub struct Recorder {
    sdk: Sdk,
    spans: SpanRecorder,
    metrics: MemoryMetricSink,
    logs: LogCapture,
}

impl fmt::Debug for Recorder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Recorder")
            .field("sdk", &self.sdk)
            .field("spans", &self.spans.len())
            .field("logs", &self.logs.len())
            .finish_non_exhaustive()
    }
}

impl Recorder {
    /// Builds a hermetic [`Sdk`] for `service_name` with in-memory span,
    /// metric (exemplar-preserving), and log capture.
    ///
    /// Defaults: [`Environment::Test`], `DEBUG` log level, `AlwaysOn` trace
    /// sampler, `TraceBased` exemplar filter, runtime metrics off, console
    /// logging off, OTLP log export off, and `without_otel_env()`.
    ///
    /// # Panics
    ///
    /// Panics with `libo11y-test: building SDK: <err>` if SDK construction
    /// fails (for example, when `service_name` is blank). Use
    /// [`Recorder::try_start`] or [`Recorder::start_with`] to handle errors
    /// explicitly.
    #[must_use]
    pub fn start(service_name: impl Into<String>) -> Self {
        Self::try_start(service_name)
            .unwrap_or_else(|err| panic!("libo11y-test: building SDK: {err}"))
    }

    /// Fallible counterpart to [`Recorder::start`].
    ///
    /// # Errors
    ///
    /// Returns any [`libo11y::Error`] produced while building the SDK.
    pub fn try_start(service_name: impl Into<String>) -> Result<Self, Error> {
        Self::start_with(service_name, |builder| builder)
    }

    /// Builds a hermetic [`Sdk`] applying `configure` on top of the harness's
    /// base configuration, so caller options override harness defaults.
    ///
    /// # Errors
    ///
    /// Returns any [`libo11y::Error`] produced while building the SDK.
    pub fn start_with(
        service_name: impl Into<String>,
        configure: impl FnOnce(Builder) -> Builder,
    ) -> Result<Self, Error> {
        let spans = SpanRecorder::default();
        let metrics = MemoryMetricSink::new();
        let logs = LogCapture::default();

        let base = Sdk::builder()
            .service_name(service_name)
            .environment(Environment::Test)
            .log_level(tracing::Level::DEBUG)
            .with_span_processor(spans.clone())
            .with_metric_sink(metrics.clone())
            .without_log_export()
            .without_runtime_metrics()
            .without_console_log()
            .without_otel_env()
            .with_extra_log_sink(logs.clone())
            .trace_sampler(Sampler::AlwaysOn)
            .exemplar_filter(ExemplarFilter::TraceBased);

        let sdk = configure(base).build()?;
        Ok(Self {
            sdk,
            spans,
            metrics,
            logs,
        })
    }

    /// The in-memory [`Sdk`] owned by this harness.
    pub fn sdk(&self) -> &Sdk {
        &self.sdk
    }

    /// Executes `f` with this harness's `tracing` subscriber installed as the
    /// thread-local default, without modifying process-global state.
    pub fn in_scope<R>(&self, f: impl FnOnce() -> R) -> R {
        tracing::subscriber::with_default(self.sdk.subscriber(), f)
    }

    /// Returns all ended spans captured so far, in end order. Spans are
    /// already redacted by the SDK's sensitivity policy.
    #[must_use]
    pub fn spans(&self) -> Vec<SpanData> {
        self.spans.snapshot()
    }

    /// Flushes the SDK and returns every exported OTLP metric request
    /// (including attached exemplars) recorded so far.
    #[must_use]
    pub fn metrics(&self) -> Vec<ExportMetricsServiceRequest> {
        let _ = self.sdk.force_flush();
        self.metrics.requests()
    }

    /// Returns all already-exported OTLP metric requests without triggering
    /// an additional flush.
    pub(crate) fn recorded_metrics(&self) -> Vec<ExportMetricsServiceRequest> {
        self.metrics.requests()
    }

    /// Flushes metrics and returns the unique instrument names present in
    /// exported data, in first-seen order.
    #[must_use]
    pub fn metric_names(&self) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut names = Vec::new();
        for request in self.metrics() {
            for rm in request.resource_metrics {
                for sm in rm.scope_metrics {
                    for metric in sm.metrics {
                        if seen.insert(metric.name.clone()) {
                            names.push(metric.name);
                        }
                    }
                }
            }
        }
        names
    }

    /// Returns all captured structured log records so far, in emission order.
    #[must_use]
    pub fn logs(&self) -> Vec<CapturedLog> {
        self.logs.snapshot()
    }

    /// Flushes metrics and returns all exemplars recorded on `instrument_name`
    /// across every data point and aggregation kind (`Sum`, `Gauge`,
    /// `Histogram`, and `ExponentialHistogram`, for both integer and double
    /// values).
    #[must_use]
    pub fn exemplars(&self, instrument_name: &str) -> Vec<RecordedExemplar> {
        let mut out = Vec::new();
        for request in self.metrics() {
            for rm in &request.resource_metrics {
                for sm in &rm.scope_metrics {
                    for metric in &sm.metrics {
                        if metric.name != instrument_name {
                            continue;
                        }
                        if let Some(data) = &metric.data {
                            collect_exemplars(data, &mut out);
                        }
                    }
                }
            }
        }
        out
    }

    /// Drains any pending buffered telemetry (including exemplars) and clears
    /// all spans, exported metric batches, and logs recorded so far.
    pub fn reset(&self) {
        let _ = self.sdk.force_flush();
        self.spans.clear();
        self.metrics.clear();
        self.logs.clear();
    }

    /// Plants a span directly into the recorder's buffer, bypassing redaction
    /// (for testing clear-text regression detection).
    #[cfg(test)]
    pub(crate) fn push_raw_span(&self, span: SpanData) {
        self.spans.push_raw(span);
    }

    /// Plants a captured log directly into the recorder's buffer, bypassing
    /// redaction and correlation (for testing regression detection).
    #[cfg(test)]
    pub(crate) fn push_raw_log(&self, log: CapturedLog) {
        self.logs.push_raw(log);
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.sdk.shutdown();
    }
}

/// In-memory [`SpanProcessor`] that records ended spans in end order and
/// retains them across SDK shutdown.
#[derive(Debug, Clone, Default)]
struct SpanRecorder {
    spans: Arc<Mutex<Vec<SpanData>>>,
}

impl SpanRecorder {
    fn snapshot(&self) -> Vec<SpanData> {
        self.spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn clear(&self) {
        self.spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    fn len(&self) -> usize {
        self.spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    #[cfg(test)]
    fn push_raw(&self, span: SpanData) {
        self.spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(span);
    }
}

impl SpanProcessor for SpanRecorder {
    fn on_start(&self, _span: &mut Span, _cx: &Context) {}

    fn on_end(&self, span: SpanData) {
        self.spans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(span);
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }
}

/// Concurrency-safe [`LogSink`] capturing every log record alongside the
/// active span context.
#[derive(Debug, Clone, Default)]
struct LogCapture {
    records: Arc<Mutex<Vec<CapturedLog>>>,
}

impl LogCapture {
    fn snapshot(&self) -> Vec<CapturedLog> {
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn clear(&self) {
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    fn len(&self) -> usize {
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    #[cfg(test)]
    fn push_raw(&self, log: CapturedLog) {
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(log);
    }
}

impl LogSink for LogCapture {
    fn emit(&self, record: &LogRecord) -> Result<(), BoxError> {
        let current = Context::current();
        let active = current.span().span_context().clone();
        let span_context = active.is_valid().then_some(active);
        self.records
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(CapturedLog::new(record.clone(), span_context));
        Ok(())
    }
}

fn collect_exemplars(data: &Data, out: &mut Vec<RecordedExemplar>) {
    match data {
        Data::Sum(sum) => {
            for dp in &sum.data_points {
                extend_exemplars(&dp.exemplars, out);
            }
        }
        Data::Gauge(gauge) => {
            for dp in &gauge.data_points {
                extend_exemplars(&dp.exemplars, out);
            }
        }
        Data::Histogram(hist) => {
            for dp in &hist.data_points {
                extend_exemplars(&dp.exemplars, out);
            }
        }
        Data::ExponentialHistogram(exp) => {
            for dp in &exp.data_points {
                extend_exemplars(&dp.exemplars, out);
            }
        }
        Data::Summary(_) => {}
    }
}

fn extend_exemplars(exemplars: &[ProtoExemplar], out: &mut Vec<RecordedExemplar>) {
    for ex in exemplars {
        out.push(convert_exemplar(ex));
    }
}

#[allow(
    clippy::cast_precision_loss,
    reason = "RecordedExemplar exposes a uniform f64 value matching Go's o11ytest.Exemplar"
)]
fn convert_exemplar(ex: &ProtoExemplar) -> RecordedExemplar {
    let value = match ex.value {
        Some(exemplar::Value::AsDouble(v)) => v,
        Some(exemplar::Value::AsInt(v)) => v as f64,
        None => 0.0,
    };
    let filtered_attributes = ex
        .filtered_attributes
        .iter()
        .map(|kv| (kv.key.clone(), format_proto_kv_value(kv)))
        .collect();
    RecordedExemplar {
        trace_id: hex_encode(&ex.trace_id),
        span_id: hex_encode(&ex.span_id),
        value,
        filtered_attributes,
    }
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn format_proto_kv_value(kv: &ProtoKeyValue) -> String {
    kv.value
        .as_ref()
        .and_then(|any| any.value.as_ref())
        .map_or_else(String::new, format_proto_any_value)
}

pub(crate) fn format_proto_any_value(val: &ProtoAnyValue) -> String {
    match val {
        ProtoAnyValue::StringValue(s) => s.clone(),
        ProtoAnyValue::BoolValue(b) => b.to_string(),
        ProtoAnyValue::IntValue(i) => i.to_string(),
        ProtoAnyValue::DoubleValue(d) => d.to_string(),
        ProtoAnyValue::BytesValue(bytes) => hex_encode(bytes),
        ProtoAnyValue::ArrayValue(arr) => {
            let parts: Vec<String> = arr
                .values
                .iter()
                .map(|v| {
                    v.value
                        .as_ref()
                        .map_or_else(String::new, format_proto_any_value)
                })
                .collect();
            format!("[{}]", parts.join(","))
        }
        ProtoAnyValue::KvlistValue(kvs) => {
            let parts: Vec<String> = kvs
                .values
                .iter()
                .map(|kv| format!("{}={}", kv.key, format_proto_kv_value(kv)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        ProtoAnyValue::StringValueStrindex(idx) => idx.to_string(),
    }
}

fn format_log_any_value(val: &AnyValue) -> String {
    match val {
        AnyValue::String(s) => s.as_str().to_owned(),
        AnyValue::Boolean(b) => b.to_string(),
        AnyValue::Int(i) => i.to_string(),
        AnyValue::Double(d) => d.to_string(),
        AnyValue::Bytes(bytes) => hex_encode(bytes),
        other => format!("{other:?}"),
    }
}
