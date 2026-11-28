//! Classifying and exemplar-sampling [`MeterProvider`] wrapper over
//! [`SdkMeterProvider`].
//!
//! Every synchronous and asynchronous instrument handed out by
//! [`Libo11yMeterProvider`] wraps the underlying SDK instrument:
//! - Every measurement attribute is classified through [`Policy::keeps_on_metrics`]:
//!   secrets are always dropped, PII is dropped unless [`PiiMode::Allow`](crate::PiiMode::Allow)
//!   (even under [`PiiMode::Hash`](crate::PiiMode::Hash)), and metric drops
//!   never increment `o11y.schema.violations`.
//! - Every synchronous measurement checks [`ExemplarFilter`] against
//!   [`Context::current`] and, when sampled, offers the measurement (with
//!   classified attributes only) to every registered reader's exemplar store.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use opentelemetry::metrics::{
    AsyncInstrument, AsyncInstrumentBuilder, Counter, Gauge, Histogram, HistogramBuilder,
    InstrumentBuilder, InstrumentProvider, Meter, MeterProvider, ObservableCounter,
    ObservableGauge, ObservableUpDownCounter, SyncInstrument, UpDownCounter,
};
use opentelemetry::trace::TraceContextExt as _;
use opentelemetry::{Context, InstrumentationScope, KeyValue};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::SdkMeterProvider;

use crate::Policy;
use crate::metrics::exemplar::{
    ExemplarFilter, ExemplarRegistry, ExemplarSample, ExemplarValue, ReservoirSpec, ScopeKey,
    StoredExemplar, default_fixed_reservoir_size,
};

/// Default explicit histogram bucket boundaries from the OpenTelemetry
/// specification and `opentelemetry_sdk`.
pub(crate) const DEFAULT_HISTOGRAM_BOUNDARIES: &[f64] = &[
    0.0, 5.0, 10.0, 25.0, 50.0, 75.0, 100.0, 250.0, 500.0, 750.0, 1000.0, 2500.0, 5000.0, 7500.0,
    10000.0,
];

/// A configured histogram bucket override registered through
/// [`Builder::with_histogram_buckets`](crate::Builder::with_histogram_buckets).
#[derive(Debug, Clone)]
pub(crate) struct HistogramBucketRule {
    pub(crate) pattern: String,
    pub(crate) boundaries: Vec<f64>,
}

/// A classifying and exemplar-aware [`MeterProvider`] wrapping
/// [`SdkMeterProvider`].
///
/// Cloning is cheap: clones share the underlying SDK provider, sensitivity
/// policy, exemplar filter, and per-reader exemplar registry.
/// [`Builder::setup`](crate::Builder::setup) installs this provider globally,
/// so third-party instrumentation using `opentelemetry::global::meter` gets
/// attribute classification and exemplars automatically.
#[derive(Clone)]
pub struct Libo11yMeterProvider {
    inner: Arc<ProviderInner>,
}

struct ProviderInner {
    sdk: SdkMeterProvider,
    policy: Policy,
    exemplar_filter: ExemplarFilter,
    exemplars: Arc<ExemplarRegistry>,
    histogram_rules: Vec<HistogramBucketRule>,
    fixed_reservoir_size: usize,
}

impl fmt::Debug for Libo11yMeterProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Libo11yMeterProvider")
            .field("exemplar_filter", &self.inner.exemplar_filter)
            .field("policy", &self.inner.policy)
            .finish_non_exhaustive()
    }
}

impl Libo11yMeterProvider {
    /// Wraps `sdk` with attribute classification and exemplar sampling.
    pub(crate) fn new(
        sdk: SdkMeterProvider,
        policy: Policy,
        exemplar_filter: ExemplarFilter,
        exemplars: Arc<ExemplarRegistry>,
        histogram_rules: Vec<HistogramBucketRule>,
    ) -> Self {
        Self {
            inner: Arc::new(ProviderInner {
                sdk,
                policy,
                exemplar_filter,
                exemplars,
                histogram_rules,
                fixed_reservoir_size: default_fixed_reservoir_size(),
            }),
        }
    }

    /// Returns the underlying [`SdkMeterProvider`].
    #[must_use]
    pub fn sdk(&self) -> &SdkMeterProvider {
        &self.inner.sdk
    }

    /// Returns the active [`ExemplarFilter`].
    #[must_use]
    pub fn exemplar_filter(&self) -> ExemplarFilter {
        self.inner.exemplar_filter
    }

    /// Flushes all readers attached to the underlying meter provider.
    ///
    /// # Errors
    ///
    /// Returns any error reported by [`SdkMeterProvider::force_flush`].
    pub fn force_flush(&self) -> OTelSdkResult {
        self.inner.sdk.force_flush()
    }

    /// Shuts down the underlying meter provider with the default timeout.
    ///
    /// # Errors
    ///
    /// Returns any error reported by [`SdkMeterProvider::shutdown`].
    pub fn shutdown(&self) -> OTelSdkResult {
        self.inner.sdk.shutdown()
    }

    /// Shuts down the underlying meter provider with `timeout`.
    ///
    /// # Errors
    ///
    /// Returns any error reported by [`SdkMeterProvider::shutdown_with_timeout`].
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.sdk.shutdown_with_timeout(timeout)
    }

    /// Returns the boundaries for a histogram named `name`, preferring the
    /// last matching [`HistogramBucketRule`], then the instrument's advisory
    /// `boundaries`, then [`DEFAULT_HISTOGRAM_BOUNDARIES`].
    fn histogram_boundaries(&self, name: &str, advisory: Option<&[f64]>) -> Vec<f64> {
        if let Some(rule) = self
            .inner
            .histogram_rules
            .iter()
            .rev()
            .find(|rule| wildcard_match(&rule.pattern, name))
        {
            return rule.boundaries.clone();
        }
        if let Some(bounds) = advisory {
            return bounds.to_vec();
        }
        DEFAULT_HISTOGRAM_BOUNDARIES.to_vec()
    }
}

impl MeterProvider for Libo11yMeterProvider {
    fn meter_with_scope(&self, scope: InstrumentationScope) -> Meter {
        let inner_meter = self.inner.sdk.meter_with_scope(scope.clone());
        let scope_key = ScopeKey::from_scope(&scope);
        let provider = Libo11yInstrumentProvider {
            inner_meter,
            scope_key,
            provider: self.clone(),
        };
        Meter::new(Arc::new(provider))
    }
}

/// Wildcard matcher matching OpenTelemetry view instrument name patterns:
/// `*` matches zero or more characters and `?` matches any single character.
pub(crate) fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern_chars: Vec<char> = pattern.chars().collect();
    let text_chars: Vec<char> = text.chars().collect();
    let (mut pat_idx, mut txt_idx) = (0usize, 0usize);
    let mut star_pattern: Option<usize> = None;
    let mut star_text = 0usize;

    while txt_idx < text_chars.len() {
        if pat_idx < pattern_chars.len()
            && (pattern_chars[pat_idx] == '?' || pattern_chars[pat_idx] == text_chars[txt_idx])
        {
            pat_idx += 1;
            txt_idx += 1;
        } else if pat_idx < pattern_chars.len() && pattern_chars[pat_idx] == '*' {
            star_pattern = Some(pat_idx);
            pat_idx += 1;
            star_text = txt_idx;
        } else if let Some(sp) = star_pattern {
            pat_idx = sp + 1;
            star_text += 1;
            txt_idx = star_text;
        } else {
            return false;
        }
    }

    while pat_idx < pattern_chars.len() && pattern_chars[pat_idx] == '*' {
        pat_idx += 1;
    }

    pat_idx == pattern_chars.len()
}

/// Classifies metric attributes, borrowing `attributes` without allocating
/// when every attribute is kept.
fn classify_metric_attrs<'a>(
    policy: &Policy,
    attributes: &'a [KeyValue],
) -> std::borrow::Cow<'a, [KeyValue]> {
    if attributes
        .iter()
        .all(|kv| policy.keeps_on_metrics(kv.key.as_str()))
    {
        std::borrow::Cow::Borrowed(attributes)
    } else {
        std::borrow::Cow::Owned(
            attributes
                .iter()
                .filter(|kv| policy.keeps_on_metrics(kv.key.as_str()))
                .cloned()
                .collect(),
        )
    }
}

struct Libo11yInstrumentProvider {
    inner_meter: Meter,
    scope_key: ScopeKey,
    provider: Libo11yMeterProvider,
}

impl Libo11yInstrumentProvider {
    fn fixed_spec(&self) -> ReservoirSpec {
        ReservoirSpec::FixedSize(self.provider.inner.fixed_reservoir_size)
    }

    fn histogram_spec(&self, name: &str, advisory: Option<&[f64]>) -> ReservoirSpec {
        ReservoirSpec::AlignedHistogram(self.provider.histogram_boundaries(name, advisory))
    }

    fn wrap_sync<I>(
        &self,
        name: String,
        spec: ReservoirSpec,
        inner: I,
    ) -> WrappedSyncInstrument<I> {
        WrappedSyncInstrument {
            inner,
            scope_key: self.scope_key.clone(),
            instrument_name: name,
            spec,
            provider: Arc::clone(&self.provider.inner),
        }
    }
}

/// Forwards a classified synchronous measurement to the underlying SDK
/// instrument.
trait Forward<T>: Send + Sync {
    fn forward(&self, value: T, attributes: &[KeyValue]);
}

impl Forward<u64> for Counter<u64> {
    fn forward(&self, value: u64, attributes: &[KeyValue]) {
        self.add(value, attributes);
    }
}

impl Forward<f64> for Counter<f64> {
    fn forward(&self, value: f64, attributes: &[KeyValue]) {
        self.add(value, attributes);
    }
}

impl Forward<i64> for UpDownCounter<i64> {
    fn forward(&self, value: i64, attributes: &[KeyValue]) {
        self.add(value, attributes);
    }
}

impl Forward<f64> for UpDownCounter<f64> {
    fn forward(&self, value: f64, attributes: &[KeyValue]) {
        self.add(value, attributes);
    }
}

impl Forward<u64> for Gauge<u64> {
    fn forward(&self, value: u64, attributes: &[KeyValue]) {
        self.record(value, attributes);
    }
}

impl Forward<i64> for Gauge<i64> {
    fn forward(&self, value: i64, attributes: &[KeyValue]) {
        self.record(value, attributes);
    }
}

impl Forward<f64> for Gauge<f64> {
    fn forward(&self, value: f64, attributes: &[KeyValue]) {
        self.record(value, attributes);
    }
}

impl Forward<u64> for Histogram<u64> {
    fn forward(&self, value: u64, attributes: &[KeyValue]) {
        self.record(value, attributes);
    }
}

impl Forward<f64> for Histogram<f64> {
    fn forward(&self, value: f64, attributes: &[KeyValue]) {
        self.record(value, attributes);
    }
}

/// Converts a numeric measurement into an [`ExemplarValue`].
trait IntoExemplarValue: Copy {
    fn into_exemplar_value(self) -> ExemplarValue;
}

impl IntoExemplarValue for u64 {
    fn into_exemplar_value(self) -> ExemplarValue {
        ExemplarValue::from_u64(self)
    }
}

impl IntoExemplarValue for i64 {
    fn into_exemplar_value(self) -> ExemplarValue {
        ExemplarValue::Int(self)
    }
}

impl IntoExemplarValue for f64 {
    fn into_exemplar_value(self) -> ExemplarValue {
        ExemplarValue::Double(self)
    }
}

struct WrappedSyncInstrument<I> {
    inner: I,
    scope_key: ScopeKey,
    instrument_name: String,
    spec: ReservoirSpec,
    provider: Arc<ProviderInner>,
}

impl<T, I> SyncInstrument<T> for WrappedSyncInstrument<I>
where
    T: IntoExemplarValue,
    I: Forward<T> + Send + Sync,
{
    fn measure(&self, measurement: T, attributes: &[KeyValue]) {
        let kept = classify_metric_attrs(&self.provider.policy, attributes);

        if self.provider.exemplar_filter != ExemplarFilter::AlwaysOff
            && !self.provider.exemplars.is_empty()
        {
            let cx = Context::current();
            let span_ref = cx.span();
            let sc = span_ref.span_context();
            if self.provider.exemplar_filter.should_sample(sc) {
                let (trace_id, span_id) = if sc.is_valid() {
                    (
                        Some(sc.trace_id().to_bytes()),
                        Some(sc.span_id().to_bytes()),
                    )
                } else {
                    (None, None)
                };
                let sample = StoredExemplar {
                    sample: ExemplarSample {
                        timestamp: SystemTime::now(),
                        value: measurement.into_exemplar_value(),
                        trace_id,
                        span_id,
                        filtered_attributes: Vec::new(),
                    },
                    attributes: kept.as_ref().to_vec(),
                };
                self.provider.exemplars.offer(
                    &self.scope_key,
                    &self.instrument_name,
                    &self.spec,
                    &sample,
                );
            }
        }

        self.inner.forward(measurement, kept.as_ref());
    }
}

/// Wraps an SDK [`AsyncInstrument`] observer so attributes emitted inside
/// observable callbacks are classified by [`Policy::keeps_on_metrics`].
struct ClassifyingObserver<'a, T> {
    inner: &'a dyn AsyncInstrument<T>,
    policy: &'a Policy,
}

impl<T> AsyncInstrument<T> for ClassifyingObserver<'_, T> {
    fn observe(&self, measurement: T, attributes: &[KeyValue]) {
        let kept = classify_metric_attrs(self.policy, attributes);
        self.inner.observe(measurement, kept.as_ref());
    }
}

macro_rules! impl_sync_instrument {
    ($method:ident, $ret:ty) => {
        fn $method(&self, builder: InstrumentBuilder<'_, $ret>) -> $ret {
            let name = builder.name.to_string();
            let mut inner_builder = self.inner_meter.$method(builder.name);
            if let Some(desc) = builder.description {
                inner_builder = inner_builder.with_description(desc);
            }
            if let Some(unit) = builder.unit {
                inner_builder = inner_builder.with_unit(unit);
            }
            let inner = inner_builder.build();
            <$ret>::new(Arc::new(self.wrap_sync(name, self.fixed_spec(), inner)))
        }
    };
}

macro_rules! impl_histogram_instrument {
    ($method:ident, $ret:ty) => {
        fn $method(&self, builder: HistogramBuilder<'_, $ret>) -> $ret {
            let name = builder.name.to_string();
            let spec = self.histogram_spec(&name, builder.boundaries.as_deref());
            let mut inner_builder = self.inner_meter.$method(builder.name);
            if let Some(desc) = builder.description {
                inner_builder = inner_builder.with_description(desc);
            }
            if let Some(unit) = builder.unit {
                inner_builder = inner_builder.with_unit(unit);
            }
            if let Some(boundaries) = builder.boundaries {
                inner_builder = inner_builder.with_boundaries(boundaries);
            }
            let inner = inner_builder.build();
            <$ret>::new(Arc::new(self.wrap_sync(name, spec, inner)))
        }
    };
}

macro_rules! impl_async_instrument {
    ($method:ident, $ret:ty, $val:ty) => {
        fn $method(&self, builder: AsyncInstrumentBuilder<'_, $ret, $val>) -> $ret {
            let mut inner_builder = self.inner_meter.$method(builder.name);
            if let Some(desc) = builder.description {
                inner_builder = inner_builder.with_description(desc);
            }
            if let Some(unit) = builder.unit {
                inner_builder = inner_builder.with_unit(unit);
            }
            for callback in builder.callbacks {
                let policy = self.provider.inner.policy.clone();
                inner_builder = inner_builder.with_callback(move |observer| {
                    let wrapped = ClassifyingObserver {
                        inner: observer,
                        policy: &policy,
                    };
                    callback(&wrapped);
                });
            }
            inner_builder.build()
        }
    };
}

impl InstrumentProvider for Libo11yInstrumentProvider {
    impl_sync_instrument!(u64_counter, Counter<u64>);
    impl_sync_instrument!(f64_counter, Counter<f64>);
    impl_sync_instrument!(i64_up_down_counter, UpDownCounter<i64>);
    impl_sync_instrument!(f64_up_down_counter, UpDownCounter<f64>);
    impl_sync_instrument!(u64_gauge, Gauge<u64>);
    impl_sync_instrument!(i64_gauge, Gauge<i64>);
    impl_sync_instrument!(f64_gauge, Gauge<f64>);

    impl_histogram_instrument!(f64_histogram, Histogram<f64>);
    impl_histogram_instrument!(u64_histogram, Histogram<u64>);

    impl_async_instrument!(u64_observable_counter, ObservableCounter<u64>, u64);
    impl_async_instrument!(f64_observable_counter, ObservableCounter<f64>, f64);
    impl_async_instrument!(
        i64_observable_up_down_counter,
        ObservableUpDownCounter<i64>,
        i64
    );
    impl_async_instrument!(
        f64_observable_up_down_counter,
        ObservableUpDownCounter<f64>,
        f64
    );
    impl_async_instrument!(u64_observable_gauge, ObservableGauge<u64>, u64);
    impl_async_instrument!(i64_observable_gauge, ObservableGauge<i64>, i64);
    impl_async_instrument!(f64_observable_gauge, ObservableGauge<f64>, f64);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wildcard_matching_covers_exact_star_and_question() {
        assert!(wildcard_match(
            "http.server.duration",
            "http.server.duration"
        ));
        assert!(!wildcard_match(
            "http.server.duration",
            "http.client.duration"
        ));
        assert!(wildcard_match("http.*", "http.server.duration"));
        assert!(wildcard_match("*.duration", "http.server.duration"));
        assert!(wildcard_match("*server*", "http.server.duration"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("a?c", "abc"));
        assert!(!wildcard_match("a?c", "abbc"));
        assert!(wildcard_match("a*b*c", "axxxbyyyc"));
        assert!(!wildcard_match("a*b*c", "axxxbyyy"));
    }
}
