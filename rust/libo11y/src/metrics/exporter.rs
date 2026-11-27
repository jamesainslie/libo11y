//! [`PushMetricExporter`] that transforms SDK [`ResourceMetrics`] into an OTLP
//! [`ExportMetricsServiceRequest`], attaches exemplars drained from its
//! reader's [`ExemplarStore`], and hands the request to a [`MetricSink`].

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::common::v1::KeyValue as ProtoKeyValue;
use opentelemetry_proto::tonic::metrics::v1::{
    Exemplar as ProtoExemplar, ExponentialHistogramDataPoint, HistogramDataPoint, NumberDataPoint,
    exemplar, metric::Data,
};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::Temporality;
use opentelemetry_sdk::metrics::data::ResourceMetrics;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;

use crate::metrics::exemplar::{
    ExemplarRegistry, ExemplarStore, ExemplarValue, MetricKey, ScopeKey, StoredExemplar,
    bucket_index, default_fixed_reservoir_size,
};
use crate::metrics::sink::MetricSink;

/// A [`PushMetricExporter`] that converts SDK [`ResourceMetrics`] into OTLP
/// protobuf, attaches exemplars sampled by
/// [`Libo11yMeterProvider`](super::Libo11yMeterProvider), and forwards the
/// request to `S`.
pub(crate) struct ExemplarMetricExporter<S> {
    sink: S,
    store: Arc<ExemplarStore>,
    registry: Arc<ExemplarRegistry>,
}

impl<S: fmt::Debug> fmt::Debug for ExemplarMetricExporter<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExemplarMetricExporter")
            .field("sink", &self.sink)
            .finish_non_exhaustive()
    }
}

impl<S> ExemplarMetricExporter<S> {
    /// Creates an exporter backed by `sink` with its own registered
    /// [`ExemplarStore`] in `registry`.
    pub(crate) fn new(sink: S, registry: Arc<ExemplarRegistry>) -> Self {
        let store = registry.register();
        Self {
            sink,
            store,
            registry,
        }
    }
}

impl<S: MetricSink> PushMetricExporter for ExemplarMetricExporter<S> {
    async fn export(&self, metrics: &ResourceMetrics) -> OTelSdkResult {
        let mut drained = self.store.collect();
        let mut request = ExportMetricsServiceRequest::from(metrics);
        attach_exemplars(&mut request, &mut drained);
        self.sink.export(request).await
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.sink.force_flush()
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.registry.unregister(&self.store);
        self.sink.shutdown_with_timeout(timeout)
    }

    fn temporality(&self) -> Temporality {
        self.sink.temporality()
    }
}

/// Joins drained exemplars into the matching data points of `request`.
pub(crate) fn attach_exemplars(
    request: &mut ExportMetricsServiceRequest,
    drained: &mut HashMap<MetricKey, Vec<StoredExemplar>>,
) {
    if drained.is_empty() {
        return;
    }
    let max_fixed = default_fixed_reservoir_size();
    for rm in &mut request.resource_metrics {
        for sm in &mut rm.scope_metrics {
            let scope = ScopeKey {
                name: sm.scope.as_ref().map_or("", |s| s.name.as_str()).to_owned(),
                version: sm
                    .scope
                    .as_ref()
                    .map_or("", |s| s.version.as_str())
                    .to_owned(),
                schema_url: sm.schema_url.clone(),
            };
            for metric in &mut sm.metrics {
                let key = MetricKey {
                    scope: scope.clone(),
                    name: metric.name.clone(),
                };
                let Some(samples) = drained.remove(&key) else {
                    continue;
                };
                match &mut metric.data {
                    Some(Data::Sum(sum)) => {
                        attach_number_exemplars(&mut sum.data_points, &samples, max_fixed);
                    }
                    Some(Data::Gauge(gauge)) => {
                        attach_number_exemplars(&mut gauge.data_points, &samples, max_fixed);
                    }
                    Some(Data::Histogram(hist)) => {
                        attach_histogram_exemplars(&mut hist.data_points, &samples);
                    }
                    Some(Data::ExponentialHistogram(exp)) => {
                        attach_exp_histogram_exemplars(&mut exp.data_points, &samples, max_fixed);
                    }
                    Some(Data::Summary(_)) | None => {}
                }
            }
        }
    }
}

/// Finds the data point whose `attributes` are a subset of `sample_attrs`
/// with the largest attribute count (so exact matches always beat strict
/// subsets).
fn best_matching_point(
    dp_attr_lists: &[&[ProtoKeyValue]],
    sample_attrs: &[ProtoKeyValue],
) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for (idx, dp_attrs) in dp_attr_lists.iter().enumerate() {
        if is_attr_subset(dp_attrs, sample_attrs)
            && best.is_none_or(|(_, best_len)| dp_attrs.len() > best_len)
        {
            best = Some((idx, dp_attrs.len()));
        }
    }
    best.map(|(idx, _)| idx)
}

fn is_attr_subset(subset: &[ProtoKeyValue], superset: &[ProtoKeyValue]) -> bool {
    subset.iter().all(|need| {
        superset
            .iter()
            .any(|have| have.key == need.key && have.value == need.value)
    })
}

/// Converts measurement attributes to proto form with last-value-wins
/// deduplication on duplicate keys, matching OpenTelemetry attribute sets.
fn dedup_proto_attrs(attrs: &[opentelemetry::KeyValue]) -> Vec<ProtoKeyValue> {
    let mut out: Vec<ProtoKeyValue> = Vec::with_capacity(attrs.len());
    for kv in attrs {
        let proto = ProtoKeyValue::from(kv);
        if let Some(existing) = out.iter_mut().find(|e| e.key == proto.key) {
            *existing = proto;
        } else {
            out.push(proto);
        }
    }
    out
}

fn to_proto_exemplar(
    stored: &StoredExemplar,
    sample_attrs: &[ProtoKeyValue],
    dp_attrs: &[ProtoKeyValue],
) -> ProtoExemplar {
    let mut filtered = dedup_proto_attrs(&stored.sample.filtered_attributes);
    for attr in sample_attrs {
        let in_dp = dp_attrs.iter().any(|dp| dp.key == attr.key);
        let already_filtered = filtered.iter().any(|f| f.key == attr.key);
        if !in_dp && !already_filtered {
            filtered.push(attr.clone());
        }
    }
    let time_unix_nano = stored
        .sample
        .timestamp
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX));
    let value = match stored.sample.value {
        ExemplarValue::Int(i) => exemplar::Value::AsInt(i),
        ExemplarValue::Double(d) => exemplar::Value::AsDouble(d),
    };
    ProtoExemplar {
        filtered_attributes: filtered,
        time_unix_nano,
        span_id: stored
            .sample
            .span_id
            .map_or_else(Vec::new, |id| id.to_vec()),
        trace_id: stored
            .sample
            .trace_id
            .map_or_else(Vec::new, |id| id.to_vec()),
        value: Some(value),
    }
}

fn attach_number_exemplars(
    data_points: &mut [NumberDataPoint],
    samples: &[StoredExemplar],
    max_per_point: usize,
) {
    if data_points.is_empty() {
        return;
    }
    let attr_lists: Vec<&[ProtoKeyValue]> = data_points
        .iter()
        .map(|dp| dp.attributes.as_slice())
        .collect();
    let mut assigned: Vec<Vec<ProtoExemplar>> = vec![Vec::new(); data_points.len()];

    for stored in samples {
        let sample_attrs = dedup_proto_attrs(&stored.attributes);
        let Some(idx) = best_matching_point(&attr_lists, &sample_attrs) else {
            continue;
        };
        let proto = to_proto_exemplar(stored, &sample_attrs, attr_lists[idx]);
        if assigned[idx].len() < max_per_point {
            assigned[idx].push(proto);
        }
    }

    for (dp, exemplars) in data_points.iter_mut().zip(assigned) {
        dp.exemplars = exemplars;
    }
}

fn attach_exp_histogram_exemplars(
    data_points: &mut [ExponentialHistogramDataPoint],
    samples: &[StoredExemplar],
    max_per_point: usize,
) {
    if data_points.is_empty() {
        return;
    }
    let attr_lists: Vec<&[ProtoKeyValue]> = data_points
        .iter()
        .map(|dp| dp.attributes.as_slice())
        .collect();
    let mut assigned: Vec<Vec<ProtoExemplar>> = vec![Vec::new(); data_points.len()];

    for stored in samples {
        let sample_attrs = dedup_proto_attrs(&stored.attributes);
        let Some(idx) = best_matching_point(&attr_lists, &sample_attrs) else {
            continue;
        };
        let proto = to_proto_exemplar(stored, &sample_attrs, attr_lists[idx]);
        if assigned[idx].len() < max_per_point {
            assigned[idx].push(proto);
        }
    }

    for (dp, exemplars) in data_points.iter_mut().zip(assigned) {
        dp.exemplars = exemplars;
    }
}

fn attach_histogram_exemplars(data_points: &mut [HistogramDataPoint], samples: &[StoredExemplar]) {
    if data_points.is_empty() {
        return;
    }
    let attr_lists: Vec<&[ProtoKeyValue]> = data_points
        .iter()
        .map(|dp| dp.attributes.as_slice())
        .collect();
    // Enforce at most one exemplar per explicit bucket on each data point even
    // when a view merges multiple attribute sets into one data point.
    let mut buckets_by_dp: Vec<Vec<Option<ProtoExemplar>>> = data_points
        .iter()
        .map(|dp| vec![None; dp.explicit_bounds.len() + 1])
        .collect();

    for stored in samples {
        let value_f64 = stored.sample.value.as_f64();
        if value_f64.is_nan() {
            continue;
        }
        let sample_attrs = dedup_proto_attrs(&stored.attributes);
        let Some(dp_idx) = best_matching_point(&attr_lists, &sample_attrs) else {
            continue;
        };
        let b_idx = bucket_index(&data_points[dp_idx].explicit_bounds, value_f64);
        let proto = to_proto_exemplar(stored, &sample_attrs, attr_lists[dp_idx]);
        if let Some(slot) = buckets_by_dp[dp_idx].get_mut(b_idx) {
            let replace = slot
                .as_ref()
                .is_none_or(|prev| proto.time_unix_nano >= prev.time_unix_nano);
            if replace {
                *slot = Some(proto);
            }
        }
    }

    for (dp, slots) in data_points.iter_mut().zip(buckets_by_dp) {
        dp.exemplars = slots.into_iter().flatten().collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::exemplar::ExemplarSample;
    use opentelemetry::KeyValue;
    use opentelemetry_proto::tonic::common::v1::InstrumentationScope;
    use opentelemetry_proto::tonic::metrics::v1::{
        Histogram, Metric, ResourceMetrics as ProtoResourceMetrics,
        ScopeMetrics as ProtoScopeMetrics, Sum,
    };
    use std::time::SystemTime;

    fn sample(value: ExemplarValue, attrs: Vec<KeyValue>) -> StoredExemplar {
        StoredExemplar {
            sample: ExemplarSample {
                timestamp: SystemTime::now(),
                value,
                trace_id: Some([0xaa; 16]),
                span_id: Some([0xbb; 8]),
                filtered_attributes: Vec::new(),
            },
            attributes: attrs,
        }
    }

    fn wrap_metrics(metrics: Vec<Metric>) -> ExportMetricsServiceRequest {
        ExportMetricsServiceRequest {
            resource_metrics: vec![ProtoResourceMetrics {
                resource: None,
                scope_metrics: vec![ProtoScopeMetrics {
                    scope: Some(InstrumentationScope {
                        name: "svc".to_owned(),
                        ..Default::default()
                    }),
                    metrics,
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        }
    }

    fn scope(name: &str) -> ScopeKey {
        ScopeKey {
            name: name.to_owned(),
            ..ScopeKey::default()
        }
    }

    #[test]
    fn exact_match_beats_subset_and_view_filtered_attrs_populate() {
        let kv_a = ProtoKeyValue::from(&KeyValue::new("a", "1"));
        let kv_b = ProtoKeyValue::from(&KeyValue::new("b", "2"));
        let mut request = wrap_metrics(vec![
            Metric {
                name: "exact_vs_subset".to_owned(),
                data: Some(Data::Sum(Sum {
                    data_points: vec![
                        NumberDataPoint {
                            attributes: vec![kv_a.clone()],
                            ..Default::default()
                        },
                        NumberDataPoint {
                            attributes: vec![kv_a.clone(), kv_b],
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                })),
                ..Default::default()
            },
            Metric {
                name: "projected".to_owned(),
                data: Some(Data::Histogram(Histogram {
                    data_points: vec![HistogramDataPoint {
                        attributes: vec![kv_a],
                        explicit_bounds: vec![1.0, 10.0],
                        bucket_counts: vec![1, 1, 0],
                        count: 2,
                        ..Default::default()
                    }],
                    ..Default::default()
                })),
                ..Default::default()
            },
        ]);

        let mut drained = HashMap::from([
            (
                MetricKey {
                    scope: scope("svc"),
                    name: "exact_vs_subset".to_owned(),
                },
                vec![
                    sample(ExemplarValue::Int(1), vec![KeyValue::new("a", "1")]),
                    sample(
                        ExemplarValue::Int(2),
                        vec![KeyValue::new("a", "1"), KeyValue::new("b", "2")],
                    ),
                ],
            ),
            (
                MetricKey {
                    scope: scope("svc"),
                    name: "projected".to_owned(),
                },
                vec![
                    sample(
                        ExemplarValue::Double(0.5),
                        vec![KeyValue::new("a", "1"), KeyValue::new("extra", "keep")],
                    ),
                    sample(
                        ExemplarValue::Double(5.0),
                        vec![KeyValue::new("a", "1"), KeyValue::new("extra", "keep2")],
                    ),
                ],
            ),
        ]);

        attach_exemplars(&mut request, &mut drained);

        let metrics = &request.resource_metrics[0].scope_metrics[0].metrics;
        let Some(Data::Sum(sum)) = &metrics[0].data else {
            panic!("expected sum");
        };
        assert_eq!(
            sum.data_points[0].exemplars[0].value,
            Some(exemplar::Value::AsInt(1))
        );
        assert!(
            sum.data_points[0].exemplars[0]
                .filtered_attributes
                .is_empty()
        );
        assert_eq!(
            sum.data_points[1].exemplars[0].value,
            Some(exemplar::Value::AsInt(2))
        );
        assert!(
            sum.data_points[1].exemplars[0]
                .filtered_attributes
                .is_empty()
        );

        let Some(Data::Histogram(hist)) = &metrics[1].data else {
            panic!("expected histogram");
        };
        assert_eq!(hist.data_points[0].exemplars.len(), 2);
        assert_eq!(
            hist.data_points[0].exemplars[0].filtered_attributes[0].key,
            "extra"
        );
        assert_eq!(hist.data_points[0].exemplars[0].trace_id, vec![0xaa; 16]);
        assert_eq!(hist.data_points[0].exemplars[0].span_id, vec![0xbb; 8]);
    }

    #[test]
    fn duplicate_attribute_keys_match_and_filter_with_last_value_wins() {
        let kv_z = ProtoKeyValue::from(&KeyValue::new("k", "z"));
        let kv_a = ProtoKeyValue::from(&KeyValue::new("k", "a"));
        let mut request = wrap_metrics(vec![Metric {
            name: "dup".to_owned(),
            data: Some(Data::Sum(Sum {
                data_points: vec![
                    NumberDataPoint {
                        attributes: vec![kv_z],
                        ..Default::default()
                    },
                    NumberDataPoint {
                        attributes: vec![kv_a],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            })),
            ..Default::default()
        }]);

        let mut drained = HashMap::from([(
            MetricKey {
                scope: ScopeKey {
                    name: "svc".to_owned(),
                    ..ScopeKey::default()
                },
                name: "dup".to_owned(),
            },
            vec![sample(
                ExemplarValue::Int(11),
                vec![
                    KeyValue::new("k", "z"),
                    KeyValue::new("k", "a"),
                    KeyValue::new("extra", "first"),
                    KeyValue::new("extra", "last"),
                ],
            )],
        )]);

        attach_exemplars(&mut request, &mut drained);

        let Some(Data::Sum(sum)) = &request.resource_metrics[0].scope_metrics[0].metrics[0].data
        else {
            panic!("expected sum");
        };
        assert!(
            sum.data_points[0].exemplars.is_empty(),
            "superseded value k=z must not match"
        );
        assert_eq!(sum.data_points[1].exemplars.len(), 1);
        let filtered = &sum.data_points[1].exemplars[0].filtered_attributes;
        assert_eq!(filtered.len(), 1);
        assert_eq!(
            filtered[0],
            ProtoKeyValue::from(&KeyValue::new("extra", "last"))
        );
    }
}
