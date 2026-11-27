//! Exemplar filtering, per-stream reservoirs, and per-reader exemplar stores.
//!
//! Upstream `opentelemetry_sdk` 0.33.1 records no exemplars, so libo11y
//! samples them in its [`Libo11yMeterProvider`](super::Libo11yMeterProvider)
//! wrapper and joins them onto the OTLP protobuf data points in
//! [`ExemplarMetricExporter`](super::ExemplarMetricExporter).
//!
//! Each metric reader owns an independent [`ExemplarStore`] registered in the
//! provider's [`ExemplarRegistry`], so multiple readers do not steal each
//! other's exemplars and each collection drains only that reader's window.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use opentelemetry::trace::SpanContext;
use opentelemetry::{KeyValue, Value};

use crate::env::EnvLookup;

/// The standard environment variable that chooses the exemplar filter.
pub(crate) const EXEMPLAR_FILTER_ENV: &str = "OTEL_METRICS_EXEMPLAR_FILTER";

/// Maximum default fixed-size reservoir capacity, matching the OpenTelemetry
/// specification and Go SDK.
const MAX_DEFAULT_FIXED_RESERVOIR_SIZE: usize = 20;

/// Controls which measurements are eligible to record exemplars.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ExemplarFilter {
    /// Records an exemplar only when the active OpenTelemetry context carries
    /// a valid, sampled span. The default.
    #[default]
    TraceBased,
    /// Records an exemplar for every measurement, attaching trace and span IDs
    /// when a valid span context is active.
    AlwaysOn,
    /// Never records exemplars.
    AlwaysOff,
}

impl ExemplarFilter {
    /// Resolves the filter from an explicit builder option, else
    /// `OTEL_METRICS_EXEMPLAR_FILTER` through `env`, else [`Self::TraceBased`].
    ///
    /// Recognized environment values (trimmed and lowercased) are
    /// `trace_based`, `always_on`, and `always_off`. Any other value leaves
    /// the default [`Self::TraceBased`], matching Go and the specification.
    #[must_use]
    pub(crate) fn resolve(explicit: Option<Self>, env: &EnvLookup) -> Self {
        if let Some(filter) = explicit {
            return filter;
        }
        let Some(raw) = env.trimmed(EXEMPLAR_FILTER_ENV) else {
            return Self::TraceBased;
        };
        match raw.to_ascii_lowercase().as_str() {
            "always_on" => Self::AlwaysOn,
            "always_off" => Self::AlwaysOff,
            // "trace_based" and any unrecognized value leave the default.
            _ => Self::TraceBased,
        }
    }

    /// Reports whether a measurement under `span_context` passes this filter.
    #[must_use]
    pub(crate) fn should_sample(self, span_context: &SpanContext) -> bool {
        match self {
            Self::TraceBased => span_context.is_valid() && span_context.is_sampled(),
            Self::AlwaysOn => true,
            Self::AlwaysOff => false,
        }
    }
}

impl fmt::Display for ExemplarFilter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TraceBased => "trace_based",
            Self::AlwaysOn => "always_on",
            Self::AlwaysOff => "always_off",
        })
    }
}

/// A numeric measurement value carried by an exemplar.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExemplarValue {
    /// A signed 64-bit integer value.
    Int(i64),
    /// A 64-bit floating-point value.
    Double(f64),
}

impl ExemplarValue {
    /// Converts a `u64` measurement into an integer exemplar value, saturating
    /// at `i64::MAX` because OTLP exemplars encode integers as `sfixed64`.
    #[must_use]
    pub(crate) fn from_u64(value: u64) -> Self {
        Self::Int(i64::try_from(value).unwrap_or(i64::MAX))
    }

    /// Returns the value as `f64` for histogram bucket lookup.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        reason = "histogram bucket boundaries are f64 in OTel"
    )]
    pub(crate) fn as_f64(self) -> f64 {
        match self {
            Self::Int(v) => v as f64,
            Self::Double(v) => v,
        }
    }
}

impl From<i64> for ExemplarValue {
    fn from(value: i64) -> Self {
        Self::Int(value)
    }
}

impl From<f64> for ExemplarValue {
    fn from(value: f64) -> Self {
        Self::Double(value)
    }
}

/// A single sampled exemplar captured during a measurement.
#[derive(Debug, Clone, PartialEq)]
pub struct ExemplarSample {
    /// When the measurement was recorded.
    pub timestamp: SystemTime,
    /// The measurement value.
    pub value: ExemplarValue,
    /// The active span's trace ID, if a valid span context was present.
    pub trace_id: Option<[u8; 16]>,
    /// The active span's span ID, if a valid span context was present.
    pub span_id: Option<[u8; 8]>,
    /// Measurement attributes dropped by a view's allowed-keys filter, already
    /// classified so secret and disallowed PII attributes never appear here.
    pub filtered_attributes: Vec<KeyValue>,
}

/// A sample stored alongside the classified measurement attributes so export
/// can join it onto the matching OTLP data point and compute any additional
/// view-filtered attributes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct StoredExemplar {
    pub(crate) sample: ExemplarSample,
    /// Classified measurement attributes at recording time.
    pub(crate) attributes: Vec<KeyValue>,
}

/// The reservoir strategy selected for an instrument.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ReservoirSpec {
    /// One slot per explicit histogram bucket (`boundaries.len() + 1` slots).
    AlignedHistogram(Vec<f64>),
    /// Uniform fixed-size reservoir sampling.
    FixedSize(usize),
}

/// Returns the default capacity for a [`FixedSizeReservoir`]:
/// `available_parallelism()` clamped to `1..=20`.
#[must_use]
pub(crate) fn default_fixed_reservoir_size() -> usize {
    std::thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, MAX_DEFAULT_FIXED_RESERVOIR_SIZE)
}

/// Returns the explicit histogram bucket index for `value` given sorted upper
/// `boundaries`, using the OpenTelemetry inclusive upper bound `(-inf, b[0]]`,
/// `(b[0], b[1]]`, ..., `(b[n-1], +inf)`.
#[must_use]
pub(crate) fn bucket_index(boundaries: &[f64], value: f64) -> usize {
    for (idx, &bound) in boundaries.iter().enumerate() {
        if value <= bound {
            return idx;
        }
    }
    boundaries.len()
}

/// An explicit-bucket histogram exemplar reservoir holding at most one sample
/// per bucket in the current collection window.
#[derive(Debug)]
pub(crate) struct AlignedHistogramReservoir {
    boundaries: Vec<f64>,
    slots: Vec<Option<StoredExemplar>>,
}

impl AlignedHistogramReservoir {
    /// Creates a reservoir aligned to `boundaries` (`boundaries.len() + 1`
    /// slots).
    #[must_use]
    pub(crate) fn new(boundaries: Vec<f64>) -> Self {
        let count = boundaries.len() + 1;
        Self {
            boundaries,
            slots: vec![None; count],
        }
    }

    /// Offers a sample, keeping the latest sample observed in its bucket.
    pub(crate) fn offer(&mut self, sample: StoredExemplar) {
        let value = sample.sample.value.as_f64();
        if value.is_nan() {
            return;
        }
        let idx = bucket_index(&self.boundaries, value);
        if let Some(slot) = self.slots.get_mut(idx) {
            *slot = Some(sample);
        }
    }

    /// Drains all collected samples and resets every bucket slot.
    pub(crate) fn collect(&mut self) -> Vec<StoredExemplar> {
        let mut out = Vec::new();
        for slot in &mut self.slots {
            if let Some(sample) = slot.take() {
                out.push(sample);
            }
        }
        out
    }
}

/// Lightweight splitmix64/xorshift64* PRNG for uniform reservoir sampling
/// without external RNG dependencies.
#[derive(Debug)]
struct FastRng {
    state: u64,
}

static RNG_SEED: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);

impl FastRng {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(0));
        let counter = RNG_SEED.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
        let seed = (nanos ^ counter).max(1);
        Self { state: seed }
    }

    #[cfg(test)]
    fn from_seed(seed: u64) -> Self {
        Self { state: seed.max(1) }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

/// A fixed-capacity uniform reservoir (Algorithm R) across a collection
/// window.
#[derive(Debug)]
pub(crate) struct FixedSizeReservoir {
    slots: Vec<Option<StoredExemplar>>,
    seen: u64,
    rng: FastRng,
}

impl FixedSizeReservoir {
    /// Creates a reservoir with `capacity` slots (at least 1).
    #[must_use]
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            slots: vec![None; capacity.max(1)],
            seen: 0,
            rng: FastRng::new(),
        }
    }

    #[cfg(test)]
    fn with_seed(capacity: usize, seed: u64) -> Self {
        Self {
            slots: vec![None; capacity.max(1)],
            seen: 0,
            rng: FastRng::from_seed(seed),
        }
    }

    /// Offers a sample using uniform reservoir sampling across the collection
    /// window.
    pub(crate) fn offer(&mut self, sample: StoredExemplar) {
        let count = self.seen;
        self.seen = self.seen.saturating_add(1);
        let capacity = self.slots.len();
        if let Ok(index) = usize::try_from(count)
            && index < capacity
        {
            self.slots[index] = Some(sample);
            return;
        }
        let pick = self.rng.next_u64() % count.saturating_add(1);
        if let Ok(index) = usize::try_from(pick)
            && index < capacity
        {
            self.slots[index] = Some(sample);
        }
    }

    /// Drains all collected samples and resets the reservoir for the next
    /// collection window.
    pub(crate) fn collect(&mut self) -> Vec<StoredExemplar> {
        self.seen = 0;
        let mut out = Vec::new();
        for slot in &mut self.slots {
            if let Some(sample) = slot.take() {
                out.push(sample);
            }
        }
        out
    }
}

#[derive(Debug)]
enum Reservoir {
    AlignedHistogram(AlignedHistogramReservoir),
    FixedSize(FixedSizeReservoir),
}

impl Reservoir {
    fn from_spec(spec: &ReservoirSpec) -> Self {
        match spec {
            ReservoirSpec::AlignedHistogram(bounds) => {
                Self::AlignedHistogram(AlignedHistogramReservoir::new(bounds.clone()))
            }
            ReservoirSpec::FixedSize(cap) => Self::FixedSize(FixedSizeReservoir::new(*cap)),
        }
    }

    fn offer(&mut self, sample: StoredExemplar) {
        match self {
            Self::AlignedHistogram(r) => r.offer(sample),
            Self::FixedSize(r) => r.offer(sample),
        }
    }

    fn collect(&mut self) -> Vec<StoredExemplar> {
        match self {
            Self::AlignedHistogram(r) => r.collect(),
            Self::FixedSize(r) => r.collect(),
        }
    }
}

/// Identifies an instrumentation scope by name, version, and schema URL.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub(crate) struct ScopeKey {
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) schema_url: String,
}

/// Identifies a metric stream within a reader's exemplar store.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct MetricKey {
    pub(crate) scope: ScopeKey,
    pub(crate) name: String,
}

/// Canonical, hashable representation of a metric attribute set so distinct
/// data points on the same metric get independent reservoirs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AttrKey(Vec<(String, String)>);

impl AttrKey {
    fn from_slice(attrs: &[KeyValue]) -> Self {
        let mut pairs: Vec<(String, String)> = attrs
            .iter()
            .map(|kv| (kv.key.as_str().to_owned(), canonical_attr_value(&kv.value)))
            .collect();
        // Stable key-only sort keeps duplicate keys in insertion order so the
        // last value wins below, matching OpenTelemetry attribute set semantics.
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let mut deduped: Vec<(String, String)> = Vec::with_capacity(pairs.len());
        for (k, v) in pairs {
            if let Some(last) = deduped.last_mut()
                && last.0 == k
            {
                last.1 = v;
            } else {
                deduped.push((k, v));
            }
        }
        Self(deduped)
    }
}

fn canonical_attr_value(value: &Value) -> String {
    match value {
        Value::Bool(b) => format!("b:{b}"),
        Value::I64(i) => format!("i:{i}"),
        Value::F64(f) => format!("f:{:016x}", f.to_bits()),
        Value::String(s) => format!("s:{}", s.as_str()),
        Value::Array(arr) => format!("a:{arr}"),
        other => format!("o:{other}"),
    }
}

/// Per-reader exemplar store. Each reader drains only its own store on
/// collection.
#[derive(Debug, Default)]
pub(crate) struct ExemplarStore {
    streams: Mutex<HashMap<MetricKey, HashMap<AttrKey, Reservoir>>>,
}

impl ExemplarStore {
    /// Creates an empty store.
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Offers a sample for `(scope, name)` with the given reservoir strategy.
    ///
    /// Bounds distinct attribute sets per stream in a collection window to
    /// [`DEFAULT_CARDINALITY_LIMIT`](crate::metrics::DEFAULT_CARDINALITY_LIMIT);
    /// existing attribute sets continue updating when at capacity.
    pub(crate) fn offer(
        &self,
        scope: &ScopeKey,
        name: &str,
        spec: &ReservoirSpec,
        sample: StoredExemplar,
    ) {
        let attr_key = AttrKey::from_slice(&sample.attributes);
        let metric_key = MetricKey {
            scope: scope.clone(),
            name: name.to_owned(),
        };
        let mut streams = self.streams.lock().unwrap_or_else(PoisonError::into_inner);
        let by_attr = streams.entry(metric_key).or_default();
        if let Some(reservoir) = by_attr.get_mut(&attr_key) {
            reservoir.offer(sample);
        } else if by_attr.len() < crate::metrics::DEFAULT_CARDINALITY_LIMIT {
            let mut reservoir = Reservoir::from_spec(spec);
            reservoir.offer(sample);
            by_attr.insert(attr_key, reservoir);
        }
    }

    /// Drains all exemplars collected since the last call, grouped by
    /// `(scope, metric_name)`, and clears all stream entries so memory does
    /// not grow across collection windows.
    pub(crate) fn collect(&self) -> HashMap<MetricKey, Vec<StoredExemplar>> {
        let drained = {
            let mut streams = self.streams.lock().unwrap_or_else(PoisonError::into_inner);
            std::mem::take(&mut *streams)
        };
        let mut out: HashMap<MetricKey, Vec<StoredExemplar>> = HashMap::new();
        for (metric_key, mut by_attr) in drained {
            let mut collected = Vec::new();
            for reservoir in by_attr.values_mut() {
                collected.extend(reservoir.collect());
            }
            if !collected.is_empty() {
                out.insert(metric_key, collected);
            }
        }
        out
    }

    #[cfg(test)]
    fn tracked_attr_count(&self, scope: &ScopeKey, name: &str) -> usize {
        let streams = self.streams.lock().unwrap_or_else(PoisonError::into_inner);
        let key = MetricKey {
            scope: scope.clone(),
            name: name.to_owned(),
        };
        streams.get(&key).map_or(0, HashMap::len)
    }

    #[cfg(test)]
    fn stream_count(&self) -> usize {
        self.streams
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// Registry of per-reader [`ExemplarStore`] instances attached to one
/// [`Libo11yMeterProvider`](super::Libo11yMeterProvider).
#[derive(Debug, Default)]
pub(crate) struct ExemplarRegistry {
    stores: Mutex<Vec<Arc<ExemplarStore>>>,
}

impl ExemplarRegistry {
    /// Creates a new reader store, registers it, and returns the handle.
    #[must_use]
    pub(crate) fn register(&self) -> Arc<ExemplarStore> {
        let store = Arc::new(ExemplarStore::new());
        self.stores
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Arc::clone(&store));
        store
    }

    /// Removes a reader store from the registry (e.g. when its exporter shuts
    /// down).
    pub(crate) fn unregister(&self, store: &Arc<ExemplarStore>) {
        self.stores
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|existing| !Arc::ptr_eq(existing, store));
    }

    /// Offers a sample to every registered reader store.
    pub(crate) fn offer(
        &self,
        scope: &ScopeKey,
        name: &str,
        spec: &ReservoirSpec,
        sample: &StoredExemplar,
    ) {
        let stores = self
            .stores
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for store in stores {
            store.offer(scope, name, spec, sample.clone());
        }
    }

    /// Reports whether any reader store is registered.
    #[must_use]
    pub(crate) fn is_empty(&self) -> bool {
        self.stores
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanId, TraceFlags, TraceId, TraceState};

    fn sampled_context() -> SpanContext {
        SpanContext::new(
            TraceId::from(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10_u128),
            SpanId::from(0x1112_1314_1516_1718_u64),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        )
    }

    fn unsampled_context() -> SpanContext {
        SpanContext::new(
            TraceId::from(0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10_u128),
            SpanId::from(0x1112_1314_1516_1718_u64),
            TraceFlags::default(),
            false,
            TraceState::default(),
        )
    }

    fn stored(value: ExemplarValue, attrs: Vec<KeyValue>) -> StoredExemplar {
        StoredExemplar {
            sample: ExemplarSample {
                timestamp: SystemTime::now(),
                value,
                trace_id: Some([1; 16]),
                span_id: Some([2; 8]),
                filtered_attributes: Vec::new(),
            },
            attributes: attrs,
        }
    }

    #[test]
    fn filter_env_resolution_and_precedence() {
        let env = |v: &str| EnvLookup::from_pairs([(EXEMPLAR_FILTER_ENV, v)]);
        assert_eq!(
            ExemplarFilter::resolve(None, &EnvLookup::empty()),
            ExemplarFilter::TraceBased
        );
        assert_eq!(
            ExemplarFilter::resolve(None, &env("  ALWAYS_ON  ")),
            ExemplarFilter::AlwaysOn
        );
        assert_eq!(
            ExemplarFilter::resolve(None, &env("always_off")),
            ExemplarFilter::AlwaysOff
        );
        assert_eq!(
            ExemplarFilter::resolve(None, &env("trace_based")),
            ExemplarFilter::TraceBased
        );
        assert_eq!(
            ExemplarFilter::resolve(None, &env("unknown_value")),
            ExemplarFilter::TraceBased
        );
        // Explicit option overrides environment.
        assert_eq!(
            ExemplarFilter::resolve(Some(ExemplarFilter::AlwaysOff), &env("always_on")),
            ExemplarFilter::AlwaysOff
        );
    }

    #[test]
    fn filter_decisions_match_spec() {
        let sampled = sampled_context();
        let unsampled = unsampled_context();
        let invalid = SpanContext::empty_context();

        assert!(ExemplarFilter::TraceBased.should_sample(&sampled));
        assert!(!ExemplarFilter::TraceBased.should_sample(&unsampled));
        assert!(!ExemplarFilter::TraceBased.should_sample(&invalid));

        assert!(ExemplarFilter::AlwaysOn.should_sample(&sampled));
        assert!(ExemplarFilter::AlwaysOn.should_sample(&unsampled));
        assert!(ExemplarFilter::AlwaysOn.should_sample(&invalid));

        assert!(!ExemplarFilter::AlwaysOff.should_sample(&sampled));
        assert!(!ExemplarFilter::AlwaysOff.should_sample(&unsampled));
        assert!(!ExemplarFilter::AlwaysOff.should_sample(&invalid));
    }

    #[test]
    fn aligned_histogram_reservoir_keeps_one_per_bucket_and_drains() {
        let mut res = AlignedHistogramReservoir::new(vec![1.0, 5.0, 10.0]);
        // Bucket 0: (-inf, 1.0]
        res.offer(stored(ExemplarValue::Double(0.2), vec![]));
        res.offer(stored(ExemplarValue::Double(1.0), vec![]));
        // Bucket 1: (1.0, 5.0]
        res.offer(stored(ExemplarValue::Double(3.5), vec![]));
        // Bucket 3: (10.0, +inf)
        res.offer(stored(ExemplarValue::Double(42.0), vec![]));
        // NaN ignored
        res.offer(stored(ExemplarValue::Double(f64::NAN), vec![]));

        let collected = res.collect();
        let values: Vec<f64> = collected.iter().map(|s| s.sample.value.as_f64()).collect();
        assert_eq!(values, vec![1.0, 3.5, 42.0]);
        // Drained reservoir is empty on next collect.
        assert!(res.collect().is_empty());
    }

    #[test]
    fn fixed_size_reservoir_caps_capacity_and_resets_on_collect() {
        let mut res = FixedSizeReservoir::with_seed(3, 12345);
        for i in 0..50 {
            res.offer(stored(ExemplarValue::Int(i), vec![]));
        }
        let first = res.collect();
        assert_eq!(first.len(), 3);
        assert!(res.collect().is_empty());

        res.offer(stored(ExemplarValue::Int(99), vec![]));
        let second = res.collect();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].sample.value, ExemplarValue::Int(99));
    }

    fn scope(name: &str) -> ScopeKey {
        ScopeKey {
            name: name.to_owned(),
            ..ScopeKey::default()
        }
    }

    #[test]
    fn per_reader_registry_stores_are_independent() {
        let registry = ExemplarRegistry::default();
        let store_a = registry.register();
        let store_b = registry.register();
        let spec = ReservoirSpec::FixedSize(4);
        let scope = scope("svc");
        let sample = stored(ExemplarValue::Int(7), vec![KeyValue::new("k", "v")]);
        registry.offer(&scope, "requests", &spec, &sample);

        let a_collected = store_a.collect();
        assert_eq!(a_collected.len(), 1);
        assert!(store_a.collect().is_empty());

        // Reader B still has its own copy.
        let b_collected = store_b.collect();
        assert_eq!(b_collected.len(), 1);
        assert!(store_b.collect().is_empty());

        registry.unregister(&store_a);
        registry.offer(&scope, "requests", &spec, &sample);
        assert!(store_a.collect().is_empty());
        assert_eq!(store_b.collect().len(), 1);
    }

    #[test]
    fn store_clears_streams_on_collect_and_bounds_cardinality() {
        let store = ExemplarStore::new();
        let scope = scope("svc");
        let spec = ReservoirSpec::FixedSize(2);
        let limit = crate::metrics::DEFAULT_CARDINALITY_LIMIT;

        for i in 0..(limit + 50) {
            store.offer(
                &scope,
                "high_card",
                &spec,
                stored(
                    ExemplarValue::Int(i64::try_from(i).expect("fits")),
                    vec![KeyValue::new("id", i.to_string())],
                ),
            );
        }
        assert_eq!(store.tracked_attr_count(&scope, "high_card"), limit);

        // Existing attribute set still updates even when at cardinality limit.
        store.offer(
            &scope,
            "high_card",
            &spec,
            stored(ExemplarValue::Int(999_999), vec![KeyValue::new("id", "0")]),
        );
        assert_eq!(store.tracked_attr_count(&scope, "high_card"), limit);

        let drained = store.collect();
        assert_eq!(store.stream_count(), 0);
        let samples = &drained[&MetricKey {
            scope: scope.clone(),
            name: "high_card".to_owned(),
        }];
        assert!(
            samples
                .iter()
                .any(|s| s.sample.value == ExemplarValue::Int(999_999)),
            "existing key must still receive samples at capacity"
        );
    }

    #[test]
    fn attr_key_uses_last_value_wins_for_duplicate_keys() {
        // Lexicographically "z" > "a", so a full-tuple sort would wrongly keep "z".
        let dup = AttrKey::from_slice(&[KeyValue::new("k", "z"), KeyValue::new("k", "a")]);
        let single = AttrKey::from_slice(&[KeyValue::new("k", "a")]);
        assert_eq!(dup, single);
    }
}
