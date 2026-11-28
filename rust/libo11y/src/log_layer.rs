//! libo11y's log pipeline and `tracing` log layer: runtime-adjustable level
//! gating, single-pass field extraction, user attribute replacement, per-leg
//! independent classification, trace correlation, and fan-out to console,
//! OTLP, and extra [`LogSink`]s.

use std::fmt;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _};
use opentelemetry::trace::{SpanId, TraceContextExt as _, TraceId};
use opentelemetry::{Array, Context, Key, Value};
use opentelemetry_sdk::logs::SdkLogger;
use tracing::dispatcher::WeakDispatch;
use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Level, Subscriber};
use tracing_subscriber::layer::{Context as LayerContext, Layer};
use tracing_subscriber::registry::LookupSpan;

use libo11y_spec::{EVENT_NAME_KEY, Signal};

use crate::BoxError;
use crate::console::{ConsoleSink, level_str, severity_number};
use crate::forceemit::{force_emit_context, is_force_emit};
use crate::logredact::{PipelineClassifiedGuard, classify_log_attrs};
use crate::policy::Policy;
use crate::violations::ViolationRecorder;

/// Top-level attribute keys reserved for trace correlation, stripped from
/// user-supplied fields before and after the attribute replacer runs.
const TRACE_ID_KEY: &str = "trace_id";
const SPAN_ID_KEY: &str = "span_id";

/// A cheaply cloneable, thread-safe handle for adjusting the log pipeline's
/// minimum level at runtime.
///
/// Defaults to [`tracing::Level::INFO`]. Passing one handle to
/// [`Builder::log_level_handle`](crate::Builder::log_level_handle) lets
/// callers raise or lower verbosity at any time via [`LevelHandle::set`],
/// taking effect immediately for subsequent log records.
#[derive(Clone)]
pub struct LevelHandle(Arc<AtomicU8>);

impl LevelHandle {
    /// Creates a handle initialized to `level`.
    #[must_use]
    pub fn new(level: Level) -> Self {
        Self(Arc::new(AtomicU8::new(encode_level(level))))
    }

    /// Updates the minimum level immediately.
    pub fn set(&self, level: Level) {
        self.0.store(encode_level(level), Ordering::Relaxed);
    }

    /// Returns the current minimum level.
    #[must_use]
    pub fn level(&self) -> Level {
        decode_level(self.0.load(Ordering::Relaxed))
    }

    /// Reports whether an event at `level` passes the configured gate.
    ///
    /// In `tracing`, `ERROR < WARN < INFO < DEBUG < TRACE`, so an event passes
    /// when its encoded value is less than or equal to the configured level.
    pub(crate) fn accepts(&self, level: Level) -> bool {
        encode_level(level) <= self.0.load(Ordering::Relaxed)
    }
}

impl Default for LevelHandle {
    fn default() -> Self {
        Self::new(Level::INFO)
    }
}

impl fmt::Debug for LevelHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("LevelHandle").field(&self.level()).finish()
    }
}

const fn encode_level(level: Level) -> u8 {
    match level {
        Level::ERROR => 0,
        Level::WARN => 1,
        Level::INFO => 2,
        Level::DEBUG => 3,
        Level::TRACE => 4,
    }
}

const fn decode_level(code: u8) -> Level {
    match code {
        0 => Level::ERROR,
        1 => Level::WARN,
        3 => Level::DEBUG,
        4 => Level::TRACE,
        _ => Level::INFO,
    }
}

/// Rewrites or drops a leaf log attribute before sensitivity classification.
///
/// The first argument is the enclosing group path, kept for API parity with
/// Go's `AttrReplacer`. Because `tracing` events have flat fields rather than
/// nested `slog` groups, the slice is always empty (`&[]`) in Rust. Return
/// `Some((key, value))` to keep or rewrite the attribute (an empty key drops
/// it), or `None` to drop it.
///
/// Built-in fields (`time`, `level`, `msg`) and correlation fields
/// (`trace_id`, `span_id`) never reach the replacer, and any attribute the
/// replacer renames to `trace_id`, `span_id`, or (for [`Sdk::event`](crate::Sdk::event))
/// `event.name` is dropped.
pub type AttrReplacer =
    Arc<dyn Fn(&[&str], Key, AnyValue) -> Option<(Key, AnyValue)> + Send + Sync>;

/// One structured log record delivered to a [`LogSink`].
#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    timestamp: SystemTime,
    level: Level,
    message: String,
    target: String,
    trace_id: Option<TraceId>,
    span_id: Option<SpanId>,
    event_name: Option<String>,
    attributes: Vec<(Key, AnyValue)>,
}

impl LogRecord {
    #[allow(
        clippy::too_many_arguments,
        reason = "internal constructor from the pipeline's extracted fields"
    )]
    pub(crate) fn new(
        timestamp: SystemTime,
        level: Level,
        message: String,
        target: String,
        trace_id: Option<TraceId>,
        span_id: Option<SpanId>,
        event_name: Option<String>,
        attributes: Vec<(Key, AnyValue)>,
    ) -> Self {
        Self {
            timestamp,
            level,
            message,
            target,
            trace_id,
            span_id,
            event_name,
            attributes,
        }
    }

    /// When the record was emitted.
    #[must_use]
    pub fn timestamp(&self) -> SystemTime {
        self.timestamp
    }

    /// The record's severity level.
    #[must_use]
    pub fn level(&self) -> Level {
        self.level
    }

    /// The log message or event body.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The `tracing` target or scope that emitted the record.
    #[must_use]
    pub fn target(&self) -> &str {
        &self.target
    }

    /// The active span's trace ID, when emitted inside a valid span context.
    #[must_use]
    pub fn trace_id(&self) -> Option<TraceId> {
        self.trace_id
    }

    /// The active span's span ID, when emitted inside a valid span context.
    #[must_use]
    pub fn span_id(&self) -> Option<SpanId> {
        self.span_id
    }

    /// The `event.name` value when the record carries one.
    #[must_use]
    pub fn event_name(&self) -> Option<&str> {
        self.event_name.as_deref()
    }

    /// The classified attributes, in emission order.
    #[must_use]
    pub fn attributes(&self) -> &[(Key, AnyValue)] {
        &self.attributes
    }

    /// Returns the first attribute value matching `key`, if present.
    #[must_use]
    pub fn attr(&self, key: &str) -> Option<&AnyValue> {
        self.attributes
            .iter()
            .find(|(k, _)| k.as_str() == key)
            .map(|(_, v)| v)
    }
}

/// A destination for structured log records produced by libo11y's log pipeline.
///
/// Register extra sinks with
/// [`Builder::with_extra_log_sink`](crate::Builder::with_extra_log_sink). Each
/// sink receives its own independently classified copy of every record that
/// passes the level gate (or is force-emitted), with active span correlation
/// already stamped.
pub trait LogSink: Send + Sync {
    /// Delivers one structured log record.
    ///
    /// # Errors
    ///
    /// Returns an error when the sink rejects or cannot write the record.
    /// During [`Builder::setup`](crate::Builder::setup), an error from the
    /// startup canary fails setup before any global is installed.
    fn emit(&self, record: &LogRecord) -> Result<(), BoxError>;
}

/// Optional source code location attached to `tracing` events on the OTLP leg.
/// Events emitted via [`Sdk::event`](crate::Sdk::event) carry `None`, matching
/// Go's PC 0.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SourceLocation {
    pub(crate) file: Option<&'static str>,
    pub(crate) line: Option<u32>,
}

/// The unified log pipeline shared by [`LogLayer`], [`Sdk::event`], the
/// startup canary, and shutdown drop reporting.
pub(crate) struct LogPipeline {
    level: LevelHandle,
    policy: Policy,
    violations: ViolationRecorder,
    replacer: Option<AttrReplacer>,
    console: Option<ConsoleSink>,
    otlp: Option<SdkLogger>,
    extra_sinks: Vec<Arc<dyn LogSink>>,
}

impl LogPipeline {
    pub(crate) fn new(
        level: LevelHandle,
        policy: Policy,
        violations: ViolationRecorder,
        replacer: Option<AttrReplacer>,
        console: Option<ConsoleSink>,
        otlp: Option<SdkLogger>,
        extra_sinks: Vec<Arc<dyn LogSink>>,
    ) -> Self {
        Self {
            level,
            policy,
            violations,
            replacer,
            console,
            otlp,
            extra_sinks,
        }
    }

    /// Filters out reserved keys before and after the user replacer, matching
    /// Go's `fanout.Handler` so a replacer cannot recreate `trace_id`,
    /// `span_id`, or a reserved `event.name`.
    fn prepare_attrs(
        &self,
        attrs: Vec<(Key, AnyValue)>,
        reserved_event_name: Option<&str>,
    ) -> Vec<(Key, AnyValue)> {
        let is_reserved = |k: &str| {
            k.is_empty()
                || k == TRACE_ID_KEY
                || k == SPAN_ID_KEY
                || (reserved_event_name.is_some() && k == EVENT_NAME_KEY)
        };
        let mut processed =
            Vec::with_capacity(attrs.len() + usize::from(reserved_event_name.is_some()));
        if let Some(event_name) = reserved_event_name {
            processed.push((
                Key::from_static_str(EVENT_NAME_KEY),
                AnyValue::from(event_name.to_owned()),
            ));
        }
        for (key, value) in attrs {
            if is_reserved(key.as_str()) {
                continue;
            }
            if let Some(replacer) = &self.replacer {
                if let Some((new_key, new_value)) = replacer(&[], key, value)
                    && !is_reserved(new_key.as_str())
                {
                    processed.push((new_key, new_value));
                }
            } else {
                processed.push((key, value));
            }
        }
        processed
    }

    /// Dispatches one record through the full pipeline: level gate (bypassed
    /// when `force_override` or `is_force_emit(cx)`), top-level
    /// `trace_id`/`span_id` drop (and `event.name` when `reserved_event_name`
    /// is set), user replacer once (re-dropping reserved keys afterward), then
    /// independent per-leg classification and delivery to console, OTLP, and
    /// extra sinks.
    #[allow(
        clippy::too_many_arguments,
        reason = "internal dispatch carrying the record's extracted fields"
    )]
    pub(crate) fn dispatch(
        &self,
        cx: &Context,
        timestamp: SystemTime,
        level: Level,
        message: &str,
        target: &'static str,
        source: Option<SourceLocation>,
        attrs: Vec<(Key, AnyValue)>,
        reserved_event_name: Option<&str>,
        force_override: bool,
    ) -> Result<(), BoxError> {
        let forced = force_override || is_force_emit(cx);
        if !forced && !self.level.accepts(level) {
            return Ok(());
        }

        let processed = self.prepare_attrs(attrs, reserved_event_name);

        let span_ctx = cx.span().span_context().clone();
        let (trace_id, span_id, trace_flags) = if span_ctx.is_valid() {
            (
                Some(span_ctx.trace_id()),
                Some(span_ctx.span_id()),
                Some(span_ctx.trace_flags()),
            )
        } else {
            (None, None, None)
        };

        let mut errs: Vec<BoxError> = Vec::new();

        // 1. Console leg.
        if let Some(console) = &self.console {
            let (classified, counts) = classify_log_attrs(&self.policy, &processed);
            self.violations.add_all(Signal::Logs, &counts);
            let event_name = extract_event_name(&classified);
            let record = LogRecord::new(
                timestamp,
                level,
                message.to_owned(),
                target.to_owned(),
                trace_id,
                span_id,
                event_name,
                classified,
            );
            if let Err(err) = console.emit(&record) {
                errs.push(err);
            }
        }

        // 2. OTLP leg.
        if let Some(logger) = &self.otlp {
            let (classified, counts) = classify_log_attrs(&self.policy, &processed);
            self.violations.add_all(Signal::Logs, &counts);
            let mut otlp_record = logger.create_log_record();
            otlp_record.set_timestamp(timestamp);
            otlp_record.set_observed_timestamp(timestamp);
            otlp_record.set_severity_number(severity_number(level));
            otlp_record.set_severity_text(level_str(level));
            otlp_record.set_body(AnyValue::from(message.to_owned()));
            otlp_record.set_target(target);
            if let (Some(tid), Some(sid)) = (trace_id, span_id) {
                otlp_record.set_trace_context(tid, sid, trace_flags);
            }
            if let Some(src) = source {
                if let Some(file) = src.file {
                    otlp_record.add_attribute("code.file.path", file);
                }
                if let Some(line) = src.line {
                    otlp_record.add_attribute("code.line.number", i64::from(line));
                }
            }
            otlp_record.add_attributes(classified);

            // Prevent upstream's SdkLogger::emit from grabbing an ambient span
            // when the caller explicitly dispatched under an uncorrelated cx.
            let _uncorrelated = trace_id.is_none().then(|| Context::new().attach());
            let _classified = PipelineClassifiedGuard::enter();
            logger.emit(otlp_record);
        }

        // 3. Extra sinks.
        let _cx = (!self.extra_sinks.is_empty()).then(|| cx.clone().attach());
        for sink in &self.extra_sinks {
            let (classified, counts) = classify_log_attrs(&self.policy, &processed);
            self.violations.add_all(Signal::Logs, &counts);
            let event_name = extract_event_name(&classified);
            let record = LogRecord::new(
                timestamp,
                level,
                message.to_owned(),
                target.to_owned(),
                trace_id,
                span_id,
                event_name,
                classified,
            );
            if let Err(err) = sink.emit(&record) {
                errs.push(err);
            }
        }

        match errs.len() {
            0 => Ok(()),
            1 => Err(errs.remove(0)),
            _ => Err(Box::new(JoinedErrors(errs))),
        }
    }
}

impl fmt::Debug for LogPipeline {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LogPipeline")
            .field("level", &self.level)
            .field("console", &self.console.is_some())
            .field("otlp", &self.otlp.is_some())
            .field("extra_sinks", &self.extra_sinks.len())
            .finish_non_exhaustive()
    }
}

/// Multiple sink errors joined with newlines, matching Go's `errors.Join`.
#[derive(Debug)]
struct JoinedErrors(Vec<BoxError>);

impl fmt::Display for JoinedErrors {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, err) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str("\n")?;
            }
            write!(f, "{err}")?;
        }
        Ok(())
    }
}

impl std::error::Error for JoinedErrors {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0
            .first()
            .map(|e| e.as_ref() as &(dyn std::error::Error + 'static))
    }
}

fn extract_event_name(attrs: &[(Key, AnyValue)]) -> Option<String> {
    attrs.iter().find_map(|(k, v)| {
        if k.as_str() == EVENT_NAME_KEY {
            match v {
                AnyValue::String(s) => Some(s.as_str().to_owned()),
                _ => None,
            }
        } else {
            None
        }
    })
}

/// Converts an OpenTelemetry attribute [`Value`] into a log [`AnyValue`].
pub(crate) fn value_to_any(value: Value) -> AnyValue {
    match value {
        Value::Bool(b) => AnyValue::Boolean(b),
        Value::I64(i) => AnyValue::Int(i),
        Value::F64(f) => AnyValue::Double(f),
        Value::String(s) => AnyValue::String(s),
        Value::Array(Array::Bool(items)) => {
            AnyValue::ListAny(Box::new(items.into_iter().map(AnyValue::Boolean).collect()))
        }
        Value::Array(Array::I64(items)) => {
            AnyValue::ListAny(Box::new(items.into_iter().map(AnyValue::Int).collect()))
        }
        Value::Array(Array::F64(items)) => {
            AnyValue::ListAny(Box::new(items.into_iter().map(AnyValue::Double).collect()))
        }
        Value::Array(Array::String(items)) => {
            AnyValue::ListAny(Box::new(items.into_iter().map(AnyValue::String).collect()))
        }
        other => AnyValue::from(other.to_string()),
    }
}

/// Single-pass field visitor extracting `message` as the log body and all
/// remaining fields as flat ordered `(Key, AnyValue)` pairs.
#[derive(Default)]
struct FieldExtractor {
    message: Option<String>,
    attrs: Vec<(Key, AnyValue)>,
}

impl FieldExtractor {
    fn push(&mut self, field: &Field, value: AnyValue) {
        if field.name() == "message" {
            self.message = Some(match value {
                AnyValue::String(s) => s.as_str().to_owned(),
                AnyValue::Int(i) => i.to_string(),
                AnyValue::Double(f) => crate::canonical::go_float(f),
                AnyValue::Boolean(b) => b.to_string(),
                other => format!("{other:?}"),
            });
        } else {
            self.attrs.push((Key::from_static_str(field.name()), value));
        }
    }
}

impl Visit for FieldExtractor {
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.push(field, AnyValue::Double(value));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.push(field, AnyValue::Int(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        let any = match i64::try_from(value) {
            Ok(i) => AnyValue::Int(i),
            Err(_) => AnyValue::from(value.to_string()),
        };
        self.push(field, any);
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        let any = match i64::try_from(value) {
            Ok(i) => AnyValue::Int(i),
            Err(_) => AnyValue::from(value.to_string()),
        };
        self.push(field, any);
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        let any = match i64::try_from(value) {
            Ok(i) => AnyValue::Int(i),
            Err(_) => AnyValue::from(value.to_string()),
        };
        self.push(field, any);
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.push(field, AnyValue::Boolean(value));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.push(field, AnyValue::from(value.to_owned()));
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.push(field, AnyValue::from(value.to_string()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.push(field, AnyValue::from(format!("{value:?}")));
    }
}

/// The `tracing` layer feeding libo11y's log pipeline.
///
/// Runs behind a per-layer filter (`!is_diagnostic(m) && m.is_event()`) so it
/// never vetoes spans or OpenTelemetry diagnostics. Level checks happen inside
/// `on_event`, so runtime [`LevelHandle`] updates and [`with_force_emit`] take
/// effect immediately without cache invalidation races.
pub(crate) struct LogLayer {
    pipeline: Arc<dyn Fn() -> Arc<LogPipeline> + Send + Sync>,
    dispatch: OnceLock<WeakDispatch>,
}

impl LogLayer {
    pub(crate) fn new(current: impl Fn() -> Arc<LogPipeline> + Send + Sync + 'static) -> Self {
        Self {
            pipeline: Arc::new(current),
            dispatch: OnceLock::new(),
        }
    }
}

impl<S> Layer<S> for LogLayer
where
    S: Subscriber + for<'span> LookupSpan<'span>,
{
    fn on_register_dispatch(&self, subscriber: &Dispatch) {
        let _ = self.dispatch.set(subscriber.downgrade());
    }

    fn on_event(&self, event: &Event<'_>, _ctx: LayerContext<'_, S>) {
        let (suppressed, current_forced) =
            Context::map_current(|cx| (cx.is_telemetry_suppressed(), is_force_emit(cx)));
        if suppressed {
            return;
        }
        let pipeline = (self.pipeline)();
        let metadata = event.metadata();
        let level = *metadata.level();
        if !current_forced && !pipeline.level.accepts(level) {
            return;
        }
        let cx = event_context::<S>(event, self.dispatch.get());
        let mut extractor = FieldExtractor::default();
        event.record(&mut extractor);
        let source = if metadata.file().is_some() || metadata.line().is_some() {
            Some(SourceLocation {
                file: metadata.file(),
                line: metadata.line(),
            })
        } else {
            None
        };
        let _ = pipeline.dispatch(
            &cx,
            SystemTime::now(),
            level,
            extractor.message.as_deref().unwrap_or(""),
            metadata.target(),
            source,
            extractor.attrs,
            None,
            false,
        );
    }
}

/// Resolves the OpenTelemetry correlation [`Context`] for a `tracing` event.
///
/// Contextual events use [`Context::current`]. Explicit root events
/// (`parent: None`) have no span context. Events with an explicit parent span
/// (`parent: &span`) walk that span's ancestor chain and adopt the nearest
/// OpenTelemetry span context via [`tracing_opentelemetry::get_otel_context`],
/// rather than the unrelated span entered on the current thread. Any
/// `force_emit` marker on the current thread context is preserved.
fn event_context<S>(event: &Event<'_>, weak_dispatch: Option<&WeakDispatch>) -> Context
where
    S: Subscriber + for<'span> LookupSpan<'span>,
{
    let current = Context::current();
    if event.is_contextual() {
        return current;
    }
    let forced = is_force_emit(&current);
    let base = if event.is_root() {
        Context::new()
    } else if let Some(parent_id) = event.parent() {
        let mut found = None;
        // Look up the explicit parent on the unfiltered subscriber `S` via the
        // registered dispatch (avoiding nested `dispatcher::get_default`, which
        // returns `Dispatch::none()` inside scoped dispatchers): `LogLayer`
        // sits behind an event-only per-layer filter so it never enables
        // disabled spans, which would make `LayerContext::span_scope` empty.
        if let Some(dispatch) = weak_dispatch.and_then(WeakDispatch::upgrade)
            && let Some(subscriber) = dispatch.downcast_ref::<S>()
            && let Some(parent) = subscriber.span(parent_id)
        {
            for span in parent.scope() {
                if let Some(otel_cx) =
                    tracing_opentelemetry::get_otel_context(&span.id(), &dispatch)
                    && otel_cx.span().span_context().is_valid()
                {
                    found = Some(otel_cx);
                    break;
                }
            }
        }
        found.unwrap_or_default()
    } else {
        current
    };
    if forced && !is_force_emit(&base) {
        force_emit_context(&base)
    } else {
        base
    }
}

impl fmt::Debug for LogLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LogLayer").finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_handle_defaults_to_info_and_updates_immediately() {
        let handle = LevelHandle::default();
        assert_eq!(handle.level(), Level::INFO);
        assert!(handle.accepts(Level::ERROR));
        assert!(handle.accepts(Level::WARN));
        assert!(handle.accepts(Level::INFO));
        assert!(!handle.accepts(Level::DEBUG));
        assert!(!handle.accepts(Level::TRACE));

        let clone = handle.clone();
        clone.set(Level::TRACE);
        assert_eq!(handle.level(), Level::TRACE);
        assert!(handle.accepts(Level::TRACE));

        handle.set(Level::ERROR);
        assert_eq!(clone.level(), Level::ERROR);
        assert!(clone.accepts(Level::ERROR));
        assert!(!clone.accepts(Level::WARN));
    }

    #[test]
    fn value_to_any_converts_all_variants() {
        assert_eq!(value_to_any(Value::Bool(true)), AnyValue::Boolean(true));
        assert_eq!(value_to_any(Value::I64(-42)), AnyValue::Int(-42));
        assert_eq!(value_to_any(Value::F64(1.5)), AnyValue::Double(1.5));
        assert_eq!(value_to_any(Value::from("hi")), AnyValue::from("hi"));
        assert_eq!(
            value_to_any(Value::Array(Array::I64(vec![1, 2]))),
            AnyValue::ListAny(Box::new(vec![AnyValue::Int(1), AnyValue::Int(2)]))
        );
    }
}
