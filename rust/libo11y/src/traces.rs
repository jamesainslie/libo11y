//! The tracer provider: the resource, the sampler, the span limits, and a
//! batch span processor over the selected exporter, every span redacted by
//! the sensitivity policy on its way out.

use std::fmt;
use std::time::Duration;

use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{
    BatchConfig, BatchConfigBuilder, BatchSpanProcessor, Sampler, SdkTracerProvider, ShouldSample,
    Span, SpanData, SpanExporter, SpanLimits, SpanProcessor,
};

use libo11y_spec::Signal;

use crate::env::EnvLookup;
use crate::export::failures::{ExportFailures, ObservedSpanExporter};
use crate::violations::ViolationRecorder;
use crate::{Decision, Policy, Violations};

/// Applies the sensitivity policy to ended spans: the attributes of the
/// span, of each event and of each link. Span keys are flat, so there is no
/// group path to join and no map value to walk, as in Go.
#[derive(Debug, Clone)]
pub(crate) struct SpanRedactor {
    policy: Policy,
    /// `None` redacts without counting: an injected processor next to an
    /// exporter leaves the counting to the exporter's path, so one
    /// attribute counts once.
    recorder: Option<ViolationRecorder>,
}

impl SpanRedactor {
    pub(crate) fn new(policy: Policy, recorder: Option<ViolationRecorder>) -> Self {
        Self { policy, recorder }
    }

    /// Redacts `span` in place and counts each dropped or rewritten
    /// attribute once.
    pub(crate) fn redact(&self, span: &mut SpanData) {
        let mut violations = Violations::default();
        self.filter(&mut span.attributes, &mut violations);
        for event in &mut span.events.events {
            self.filter(&mut event.attributes, &mut violations);
        }
        for link in &mut span.links.links {
            self.filter(&mut link.attributes, &mut violations);
        }
        if let Some(recorder) = &self.recorder {
            recorder.add_all(Signal::Traces, &violations);
        }
    }

    /// Classifies `attrs`, leaving the vector untouched when the policy
    /// keeps every key, the common case.
    fn filter(&self, attrs: &mut Vec<KeyValue>, violations: &mut Violations) {
        if attrs
            .iter()
            .all(|kv| self.policy.decide(kv.key.as_str()) == Decision::Keep)
        {
            return;
        }
        let (kept, counts) = self.policy.classify_all(std::mem::take(attrs));
        *attrs = kept;
        violations.merge(&counts);
    }
}

/// A span exporter that receives every span redacted.
#[derive(Debug)]
pub(crate) struct RedactingSpanExporter<E> {
    inner: E,
    redactor: SpanRedactor,
}

impl<E> RedactingSpanExporter<E> {
    pub(crate) fn new(inner: E, redactor: SpanRedactor) -> Self {
        Self { inner, redactor }
    }
}

impl<E: SpanExporter> SpanExporter for RedactingSpanExporter<E> {
    fn export(
        &self,
        mut batch: Vec<SpanData>,
    ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
        for span in &mut batch {
            self.redactor.redact(span);
        }
        self.inner.export(batch)
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

/// An injected span processor: `on_start` sees the live span, `on_end` the
/// redacted one, as in Go.
#[derive(Debug)]
pub(crate) struct RedactingSpanProcessor {
    inner: Box<dyn SpanProcessor>,
    redactor: SpanRedactor,
}

impl RedactingSpanProcessor {
    pub(crate) fn new(inner: Box<dyn SpanProcessor>, redactor: SpanRedactor) -> Self {
        Self { inner, redactor }
    }
}

impl SpanProcessor for RedactingSpanProcessor {
    fn on_start(&self, span: &mut Span, cx: &Context) {
        self.inner.on_start(span, cx);
    }

    fn on_end(&self, mut span: SpanData) {
        self.redactor.redact(&mut span);
        self.inner.on_end(span);
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

/// A span exporter waiting to be wrapped and batched. It erases the
/// exporter's type, which the builder cannot name.
pub(crate) trait PendingSpanExporter: Send {
    /// The batch span processor over the exporter, wrapped to observe
    /// failures and, inside that, to redact.
    fn into_processor(
        self: Box<Self>,
        redactor: SpanRedactor,
        failures: ExportFailures,
        batch: BatchConfig,
    ) -> BatchSpanProcessor;

    /// Shuts down an exporter the SDK will not use.
    fn discard(self: Box<Self>);
}

/// A span exporter of a known type, pending.
pub(crate) struct Pending<E>(pub(crate) E);

impl<E: SpanExporter + 'static> PendingSpanExporter for Pending<E> {
    fn into_processor(
        self: Box<Self>,
        redactor: SpanRedactor,
        failures: ExportFailures,
        batch: BatchConfig,
    ) -> BatchSpanProcessor {
        let exporter =
            ObservedSpanExporter::new(RedactingSpanExporter::new(self.0, redactor), failures);
        BatchSpanProcessor::builder(exporter)
            .with_batch_config(batch)
            .build()
    }

    fn discard(self: Box<Self>) {
        // Nothing reached the exporter, so there is nothing to flush.
        let _ = self.0.shutdown_with_timeout(Duration::ZERO);
    }
}

impl fmt::Debug for dyn PendingSpanExporter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PendingSpanExporter")
    }
}

/// The sampler and how the effective configuration names it.
pub(crate) struct SamplerChoice {
    pub(crate) sampler: Box<dyn ShouldSample>,
    /// The `OTEL_TRACES_SAMPLER` name, or the explicit sampler's debug form.
    #[cfg_attr(not(test), allow(dead_code, reason = "R3b's startup summary reads it"))]
    pub(crate) report: String,
}

impl fmt::Debug for SamplerChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SamplerChoice")
            .field("report", &self.report)
            .finish_non_exhaustive()
    }
}

/// The default sampler's name.
const DEFAULT_SAMPLER: &str = "parentbased_always_on";

impl SamplerChoice {
    /// An explicit sampler wins. Otherwise `OTEL_TRACES_SAMPLER` and
    /// `OTEL_TRACES_SAMPLER_ARG` are read through `env`, which is empty under
    /// hermetic mode, so hermetic mode gets the default: the name trimmed
    /// and lowercased, as Go matches it; the six standard samplers;
    /// a ratio sampler without a valid argument samples everything, as
    /// upstream's does; any other name is the default, `ParentBased(AlwaysOn)`.
    pub(crate) fn resolve(explicit: Option<Box<dyn ShouldSample>>, env: &EnvLookup) -> Self {
        if let Some(sampler) = explicit {
            let report = format!("{sampler:?}");
            return Self { sampler, report };
        }
        let name = env
            .trimmed("OTEL_TRACES_SAMPLER")
            .map(|name| name.to_lowercase())
            .unwrap_or_default();
        let ratio = || {
            env.trimmed("OTEL_TRACES_SAMPLER_ARG")
                .and_then(|arg| arg.parse::<f64>().ok())
                .unwrap_or(1.0)
        };
        let (sampler, report) = match name.as_str() {
            "always_on" => (Sampler::AlwaysOn, name),
            "always_off" => (Sampler::AlwaysOff, name),
            "traceidratio" => (Sampler::TraceIdRatioBased(ratio()), name),
            "parentbased_always_off" => (Sampler::ParentBased(Box::new(Sampler::AlwaysOff)), name),
            "parentbased_traceidratio" => (
                Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio()))),
                name,
            ),
            _ => (
                Sampler::ParentBased(Box::new(Sampler::AlwaysOn)),
                DEFAULT_SAMPLER.to_owned(),
            ),
        };
        Self {
            sampler: Box::new(sampler),
            report,
        }
    }
}

/// The span limits upstream reads from the environment, read through `env`
/// so every one is set in code: `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT`,
/// `OTEL_SPAN_EVENT_COUNT_LIMIT`, `OTEL_SPAN_LINK_COUNT_LIMIT`, else
/// upstream's defaults.
pub(crate) fn span_limits(env: &EnvLookup) -> SpanLimits {
    let mut limits = SpanLimits::default();
    let read = |key: &str| env.trimmed(key).and_then(|v| v.parse::<u32>().ok());
    if let Some(n) = read("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT") {
        limits.max_attributes_per_span = n;
    }
    if let Some(n) = read("OTEL_SPAN_EVENT_COUNT_LIMIT") {
        limits.max_events_per_span = n;
    }
    if let Some(n) = read("OTEL_SPAN_LINK_COUNT_LIMIT") {
        limits.max_links_per_span = n;
    }
    limits
}

/// The batch span processor's configuration, every field upstream lets
/// code set taken from `env` or upstream's default, so the process
/// environment upstream reads underneath is overridden: `OTEL_BSP_MAX_QUEUE_SIZE`
/// (2048), `OTEL_BSP_SCHEDULE_DELAY` (5000 ms), `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`
/// (512).
pub(crate) fn batch_config(env: &EnvLookup) -> BatchConfig {
    let read = |key: &str, default: u64| {
        env.trimmed(key)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default)
    };
    BatchConfigBuilder::default()
        .with_max_queue_size(usize::try_from(read("OTEL_BSP_MAX_QUEUE_SIZE", 2048)).unwrap_or(2048))
        .with_scheduled_delay(Duration::from_millis(read("OTEL_BSP_SCHEDULE_DELAY", 5000)))
        .with_max_export_batch_size(
            usize::try_from(read("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512)).unwrap_or(512),
        )
        .build()
}

/// What the tracer provider is built from.
pub(crate) struct TraceParts {
    pub(crate) resource: Resource,
    pub(crate) sampler: Box<dyn ShouldSample>,
    pub(crate) limits: SpanLimits,
    pub(crate) batch: BatchConfig,
    pub(crate) processor: Option<Box<dyn SpanProcessor>>,
    pub(crate) exporter: Option<Box<dyn PendingSpanExporter>>,
    pub(crate) policy: Policy,
    pub(crate) recorder: ViolationRecorder,
    pub(crate) failures: ExportFailures,
    /// `OTEL_SDK_DISABLED`: no processor, and nothing is sampled.
    pub(crate) disabled: bool,
}

/// Builds the tracer provider, in Go's order: the injected processor
/// (redacting, silent when an exporter also runs), then the batch processor
/// over the exporter. While the SDK is disabled nothing is registered and
/// nothing is sampled, so no span records while context still propagates,
/// and what was injected is shut down now.
pub(crate) fn build_tracer_provider(parts: TraceParts) -> SdkTracerProvider {
    let builder = SdkTracerProvider::builder()
        .with_resource(parts.resource)
        .with_span_limits(parts.limits);
    if parts.disabled {
        if let Some(processor) = parts.processor {
            let _ = processor.shutdown_with_timeout(Duration::ZERO);
        }
        if let Some(exporter) = parts.exporter {
            exporter.discard();
        }
        return builder.with_sampler(Sampler::AlwaysOff).build();
    }
    let mut builder = builder.with_sampler(parts.sampler);
    if let Some(processor) = parts.processor {
        let recorder = parts.exporter.is_none().then(|| parts.recorder.clone());
        builder = builder.with_span_processor(RedactingSpanProcessor::new(
            processor,
            SpanRedactor::new(parts.policy.clone(), recorder),
        ));
    }
    if let Some(exporter) = parts.exporter {
        builder = builder.with_span_processor(exporter.into_processor(
            SpanRedactor::new(parts.policy, Some(parts.recorder)),
            parts.failures,
            parts.batch,
        ));
    }
    builder.build()
}

impl fmt::Debug for TraceParts {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TraceParts")
            .field("disabled", &self.disabled)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::time::SystemTime;

    use opentelemetry::trace::{
        Event, Link, SpanContext, SpanId, SpanKind, Status, TraceFlags, TraceId, TraceState,
    };
    use opentelemetry::{InstrumentationScope, Key};
    use opentelemetry_sdk::trace::{SpanEvents, SpanLinks};

    use crate::test_support::{ViolationReader, violation_points};
    use crate::{PiiMode, Rule};

    fn policy(mode: PiiMode) -> Policy {
        Policy::new(mode, &[9; 32], HashMap::new()).expect("a policy")
    }

    fn classified() -> Vec<KeyValue> {
        vec![
            KeyValue::new("http.request.header.authorization", "Bearer s3cret"),
            KeyValue::new("host.ip", "10.9.8.7"),
            KeyValue::new("http.route", "/orders"),
        ]
    }

    fn span() -> SpanData {
        let cx = SpanContext::new(
            TraceId::from(1_u128),
            SpanId::from(1_u64),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        );
        let mut events = SpanEvents::default();
        events
            .events
            .push(Event::new("e", SystemTime::now(), classified(), 0));
        let mut links = SpanLinks::default();
        links.links.push(Link::new(cx.clone(), classified(), 0));
        SpanData {
            span_context: cx,
            parent_span_id: SpanId::INVALID,
            parent_span_is_remote: false,
            span_kind: SpanKind::Internal,
            name: "op".into(),
            start_time: SystemTime::now(),
            end_time: SystemTime::now(),
            attributes: classified(),
            dropped_attributes_count: 0,
            events,
            links,
            status: Status::Unset,
            instrumentation_scope: InstrumentationScope::default(),
        }
    }

    fn keys(attrs: &[KeyValue]) -> Vec<&str> {
        attrs.iter().map(|kv| kv.key.as_str()).collect()
    }

    // go/spanredact_test.go TestRedactingExporterDropsSecretSpanAttr and
    // TestRedactingExporterStripsSecretFromEventsAndLinks.
    #[test]
    fn span_event_and_link_attributes_are_classified() {
        let mut data = span();
        SpanRedactor::new(policy(PiiMode::Drop), None).redact(&mut data);
        assert_eq!(keys(&data.attributes), ["http.route"]);
        assert_eq!(keys(&data.events.events[0].attributes), ["http.route"]);
        assert_eq!(keys(&data.links.links[0].attributes), ["http.route"]);
    }

    // TestRedactingExporterAppliesPIIMode.
    #[test]
    fn pii_follows_the_mode_and_secrets_always_drop() {
        let mut hashed = span();
        SpanRedactor::new(policy(PiiMode::Hash), None).redact(&mut hashed);
        let token = hashed
            .attributes
            .iter()
            .find(|kv| kv.key == Key::from_static_str("host.ip"))
            .map(|kv| kv.value.to_string())
            .expect("the token stays");
        assert!(token.starts_with("hmac-sha256:"), "{token}");
        assert_eq!(keys(&hashed.attributes), ["host.ip", "http.route"]);

        let mut allowed = span();
        SpanRedactor::new(policy(PiiMode::Allow), None).redact(&mut allowed);
        assert_eq!(keys(&allowed.attributes), ["host.ip", "http.route"]);
        assert_eq!(
            allowed.attributes[0].value.to_string(),
            "10.9.8.7",
            "allowed PII passes unchanged"
        );
    }

    #[test]
    fn nothing_classified_leaves_the_span_alone() {
        let mut data = span();
        data.attributes = vec![KeyValue::new("http.route", "/x")];
        data.events = SpanEvents::default();
        data.links = SpanLinks::default();
        let before = data.clone();
        SpanRedactor::new(policy(PiiMode::Drop), None).redact(&mut data);
        assert_eq!(data, before);
    }

    // TestRedactingExporterCountsOneViolationPerPIIAttribute.
    #[test]
    fn each_redacted_attribute_counts_once_on_traces() {
        let reader = ViolationReader::new();
        let recorder = ViolationRecorder::new(reader.provider());
        let mut data = span();
        SpanRedactor::new(policy(PiiMode::Hash), Some(recorder)).redact(&mut data);
        let points = violation_points(&reader.collect());
        // One secret and one PII attribute on the span, its event and its
        // link.
        assert_eq!(
            points,
            [
                (
                    "traces".to_owned(),
                    Rule::PiiAttribute.as_str().to_owned(),
                    3
                ),
                (
                    "traces".to_owned(),
                    Rule::SecretAttribute.as_str().to_owned(),
                    3
                ),
            ]
        );
    }

    #[test]
    fn the_sampler_comes_from_the_option_then_the_environment() {
        let env = |name: &str, arg: &str| {
            EnvLookup::from_pairs([
                ("OTEL_TRACES_SAMPLER", name.to_owned()),
                ("OTEL_TRACES_SAMPLER_ARG", arg.to_owned()),
            ])
        };
        let table = [
            ("", "", "parentbased_always_on", "ParentBased(AlwaysOn)"),
            ("always_on", "", "always_on", "AlwaysOn"),
            (" ALWAYS_OFF ", "", "always_off", "AlwaysOff"),
            (
                "traceidratio",
                "0.25",
                "traceidratio",
                "TraceIdRatioBased(0.25)",
            ),
            (
                "traceidratio",
                "soon",
                "traceidratio",
                "TraceIdRatioBased(1.0)",
            ),
            (
                "parentbased_always_off",
                "",
                "parentbased_always_off",
                "ParentBased(AlwaysOff)",
            ),
            (
                "parentbased_traceidratio",
                "0.5",
                "parentbased_traceidratio",
                "ParentBased(TraceIdRatioBased(0.5))",
            ),
            ("xray", "", "parentbased_always_on", "ParentBased(AlwaysOn)"),
            ("typo", "", "parentbased_always_on", "ParentBased(AlwaysOn)"),
        ];
        for (name, arg, report, debug) in table {
            let choice = SamplerChoice::resolve(None, &env(name, arg));
            assert_eq!(choice.report, report, "{name:?}");
            assert_eq!(format!("{:?}", choice.sampler), debug, "{name:?}");
        }
        let explicit =
            SamplerChoice::resolve(Some(Box::new(Sampler::AlwaysOff)), &env("always_on", ""));
        assert_eq!(explicit.report, "AlwaysOff");
        assert_eq!(
            SamplerChoice::resolve(None, &EnvLookup::empty()).report,
            "parentbased_always_on"
        );
    }

    #[test]
    fn span_limits_and_batching_are_set_in_code() {
        let env = EnvLookup::from_pairs([
            ("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "7"),
            ("OTEL_SPAN_EVENT_COUNT_LIMIT", "x"),
            ("OTEL_SPAN_LINK_COUNT_LIMIT", "3"),
            ("OTEL_BSP_MAX_QUEUE_SIZE", "64"),
            ("OTEL_BSP_SCHEDULE_DELAY", "250"),
            ("OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "32"),
        ]);
        let limits = span_limits(&env);
        assert_eq!(limits.max_attributes_per_span, 7);
        assert_eq!(limits.max_events_per_span, 128);
        assert_eq!(limits.max_links_per_span, 3);
        assert_eq!(
            format!("{:?}", span_limits(&EnvLookup::empty())),
            format!("{:?}", SpanLimits::default())
        );

        let batch = format!("{:?}", batch_config(&env));
        assert!(batch.contains("max_queue_size: 64"), "{batch}");
        assert!(batch.contains("scheduled_delay: 250ms"), "{batch}");
        assert!(batch.contains("max_export_batch_size: 32"), "{batch}");
        let defaults = format!("{:?}", batch_config(&EnvLookup::empty()));
        assert!(defaults.contains("max_queue_size: 2048"), "{defaults}");
        assert!(defaults.contains("scheduled_delay: 5s"), "{defaults}");
        assert!(
            defaults.contains("max_export_batch_size: 512"),
            "{defaults}"
        );
    }
}
