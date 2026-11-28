//! Integration and wire tests for libo11y metrics: attribute classification,
//! exemplar filters and reservoirs, OTLP proto exemplar attachment, views and
//! histogram buckets, temporality preferences, OTLP/HTTP and OTLP/gRPC wire
//! export, and Linux process runtime metrics.

mod common;

use opentelemetry::trace::{
    SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
};
use opentelemetry::{Context, Key, KeyValue};
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::metrics::v1::{
    AggregationTemporality, Exemplar, HistogramDataPoint, Metric, NumberDataPoint, exemplar,
    metric::Data,
};
use opentelemetry_sdk::metrics::{Instrument, Stream, Temporality};

use common::hermetic;
use libo11y::{
    AppRegistry, EnvLookup, Environment, Error, ExemplarFilter, MemoryMetricSink, PiiMode, Sdk,
};

const HASH_KEY: [u8; 32] = [7; 32];

fn sampled_cx(trace_id: u128, span_id: u64) -> (Context, [u8; 16], [u8; 8]) {
    let tid = TraceId::from(trace_id);
    let sid = SpanId::from(span_id);
    let sc = SpanContext::new(tid, sid, TraceFlags::SAMPLED, false, TraceState::default());
    (
        Context::new().with_remote_span_context(sc),
        tid.to_bytes(),
        sid.to_bytes(),
    )
}

fn unsampled_cx(trace_id: u128, span_id: u64) -> Context {
    let sc = SpanContext::new(
        TraceId::from(trace_id),
        SpanId::from(span_id),
        TraceFlags::default(),
        false,
        TraceState::default(),
    );
    Context::new().with_remote_span_context(sc)
}

fn find_metrics<'a>(requests: &'a [ExportMetricsServiceRequest], name: &str) -> Vec<&'a Metric> {
    requests
        .iter()
        .flat_map(|r| &r.resource_metrics)
        .flat_map(|rm| &rm.scope_metrics)
        .flat_map(|sm| &sm.metrics)
        .filter(|m| m.name == name)
        .collect()
}

fn last_metric<'a>(requests: &'a [ExportMetricsServiceRequest], name: &str) -> &'a Metric {
    find_metrics(requests, name)
        .last()
        .unwrap_or_else(|| panic!("metric {name:?} not found in {requests:#?}"))
}

fn number_points(metric: &Metric) -> &[NumberDataPoint] {
    match metric.data.as_ref().expect("metric data") {
        Data::Sum(sum) => &sum.data_points,
        Data::Gauge(gauge) => &gauge.data_points,
        other => panic!("expected Sum or Gauge, got {other:?}"),
    }
}

fn histogram_points(metric: &Metric) -> &[HistogramDataPoint] {
    match metric.data.as_ref().expect("metric data") {
        Data::Histogram(hist) => &hist.data_points,
        other => panic!("expected Histogram, got {other:?}"),
    }
}

fn attr_keys(attrs: &[opentelemetry_proto::tonic::common::v1::KeyValue]) -> Vec<&str> {
    let mut keys: Vec<&str> = attrs.iter().map(|kv| kv.key.as_str()).collect();
    keys.sort_unstable();
    keys
}

#[test]
fn metric_attributes_are_classified_and_never_count_violations() {
    let app_yaml = r"
schema: libo11y.app-registry/v1
namespace: billing
attributes:
  billing.card.number:
    type: string
    sensitivity: pii
    cardinality: unbounded
    brief: Card number.
  billing.api.secret:
    type: string
    sensitivity: secret
    cardinality: unbounded
    brief: API secret.
";
    let registry =
        AppRegistry::from_bytes("billing.yaml", app_yaml.as_bytes()).expect("valid registry");

    for (mode, expect_pii) in [
        (PiiMode::Drop, false),
        (PiiMode::Hash, false),
        (PiiMode::Allow, true),
    ] {
        let sink = MemoryMetricSink::new();
        let sdk = hermetic("metric-policy")
            .without_runtime_metrics()
            .app_registry(registry.clone())
            .pii_mode(mode)
            .pii_hash_key(HASH_KEY)
            .with_metric_sink(sink.clone())
            .build()
            .expect("SDK");

        let meter = sdk.meter("orders");
        let counter = meter.u64_counter("orders.count").build();
        let attrs = [
            KeyValue::new("http.request.method", "POST"),
            KeyValue::new("http.request.header.authorization", "Bearer top-secret"),
            KeyValue::new("billing.api.secret", "sk_live_123"),
            KeyValue::new("host.ip", "10.0.0.42"),
            KeyValue::new("billing.card.number", "4111-1111"),
        ];
        counter.add(1, &attrs);

        let _obs = meter
            .i64_observable_gauge("orders.queue")
            .with_callback(move |observer| {
                observer.observe(5, &attrs);
            })
            .build();

        sdk.force_flush().expect("flush");
        let reqs = sink.requests();

        let mut want = vec!["http.request.method"];
        if expect_pii {
            want.push("billing.card.number");
            want.push("host.ip");
            want.sort_unstable();
        }

        for metric_name in ["orders.count", "orders.queue"] {
            let metric = last_metric(&reqs, metric_name);
            let dps = number_points(metric);
            assert_eq!(dps.len(), 1, "{mode:?} {metric_name}");
            assert_eq!(
                attr_keys(&dps[0].attributes),
                want,
                "{mode:?} {metric_name}"
            );
        }

        // Metrics drops must never increment o11y.schema.violations.
        assert!(
            find_metrics(&reqs, libo11y_spec::metric::SCHEMA_VIOLATIONS).is_empty(),
            "{mode:?}: metric drops must not emit schema violations"
        );
        sdk.shutdown().expect("shutdown");
    }
}

#[test]
fn exemplar_filters_and_env_resolution() {
    let cases = [
        (None, None, ExemplarFilter::TraceBased),
        (None, Some("always_on"), ExemplarFilter::AlwaysOn),
        (None, Some(" ALWAYS_OFF "), ExemplarFilter::AlwaysOff),
        (None, Some("trace_based"), ExemplarFilter::TraceBased),
        (None, Some("nonsense"), ExemplarFilter::TraceBased),
        (
            Some(ExemplarFilter::AlwaysOff),
            Some("always_on"),
            ExemplarFilter::AlwaysOff,
        ),
    ];

    for (explicit, env_val, want) in cases {
        let mut pairs = vec![
            ("OTEL_TRACES_EXPORTER", "none"),
            ("OTEL_LOGS_EXPORTER", "none"),
            ("OTEL_METRICS_EXPORTER", "none"),
        ];
        if let Some(v) = env_val {
            pairs.push(("OTEL_METRICS_EXEMPLAR_FILTER", v));
        }
        let mut builder = Sdk::builder()
            .service_name("exemplar-filter")
            .environment(Environment::Test)
            .env_lookup(EnvLookup::from_pairs(pairs))
            .without_runtime_metrics()
            .with_error_handler(|_| {});
        if let Some(f) = explicit {
            builder = builder.exemplar_filter(f);
        }
        let sdk = builder.build().expect("SDK");
        assert_eq!(
            sdk.meter_provider().exemplar_filter(),
            want,
            "explicit={explicit:?} env={env_val:?}"
        );
        sdk.shutdown().expect("shutdown");
    }

    // Hermetic mode ignores env and defaults to TraceBased unless overridden.
    let sdk = Sdk::builder()
        .service_name("hermetic-filter")
        .environment(Environment::Test)
        .env_lookup(EnvLookup::from_pairs([(
            "OTEL_METRICS_EXEMPLAR_FILTER",
            "always_on",
        )]))
        .without_otel_env()
        .without_runtime_metrics()
        .build()
        .expect("SDK");
    assert_eq!(
        sdk.meter_provider().exemplar_filter(),
        ExemplarFilter::TraceBased
    );
    sdk.shutdown().expect("shutdown");
}

#[test]
fn exemplar_filter_sampling_behavior_across_contexts() {
    let (sampled, trace_bytes, span_bytes) = sampled_cx(0xaa_u128, 0xbb_u64);
    let unsampled = unsampled_cx(0xcc_u128, 0xdd_u64);

    // TraceBased: only sampled spans record exemplars.
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("tb")
        .without_runtime_metrics()
        .exemplar_filter(ExemplarFilter::TraceBased)
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");
    let counter = sdk.meter("svc").u64_counter("c").build();
    counter.add(1, &[KeyValue::new("case", "none")]);
    {
        let _g = unsampled.clone().attach();
        counter.add(2, &[KeyValue::new("case", "unsampled")]);
    }
    {
        let _g = sampled.clone().attach();
        counter.add(3, &[KeyValue::new("case", "sampled")]);
    }
    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let metric = last_metric(&reqs, "c");
    let mut by_case = std::collections::HashMap::new();
    for dp in number_points(metric) {
        let case = dp.attributes[0]
            .value
            .as_ref()
            .and_then(|v| match &v.value {
                Some(opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(s)) => {
                    Some(s.clone())
                }
                _ => None,
            })
            .expect("case");
        by_case.insert(case, dp.exemplars.clone());
    }
    assert!(by_case["none"].is_empty());
    assert!(by_case["unsampled"].is_empty());
    assert_eq!(by_case["sampled"].len(), 1);
    assert_eq!(by_case["sampled"][0].trace_id, trace_bytes);
    assert_eq!(by_case["sampled"][0].span_id, span_bytes);
    assert_eq!(by_case["sampled"][0].value, Some(exemplar::Value::AsInt(3)));
    sdk.shutdown().expect("shutdown");

    // AlwaysOn: records even without active span.
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("ao")
        .without_runtime_metrics()
        .exemplar_filter(ExemplarFilter::AlwaysOn)
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");
    let counter = sdk.meter("svc").u64_counter("c").build();
    counter.add(4, &[]);
    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let dps = number_points(last_metric(&reqs, "c"));
    assert_eq!(dps[0].exemplars.len(), 1);
    assert!(dps[0].exemplars[0].trace_id.is_empty());
    assert_eq!(dps[0].exemplars[0].value, Some(exemplar::Value::AsInt(4)));
    sdk.shutdown().expect("shutdown");

    // AlwaysOff: never records even with sampled span.
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("aoff")
        .without_runtime_metrics()
        .exemplar_filter(ExemplarFilter::AlwaysOff)
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");
    let counter = sdk.meter("svc").u64_counter("c").build();
    {
        let _g = sampled.attach();
        counter.add(5, &[]);
    }
    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let dps = number_points(last_metric(&reqs, "c"));
    assert!(dps[0].exemplars.is_empty());
    sdk.shutdown().expect("shutdown");
}

#[test]
fn exemplars_attach_to_all_sync_instruments_and_aligned_histogram_buckets() {
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("all-sync")
        .without_runtime_metrics()
        .with_histogram_buckets("http.server.duration", vec![0.1, 0.5, 1.0])
        .with_histogram_buckets("rpc.*.duration", vec![10.0, 50.0])
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");

    let meter = sdk.meter("svc");
    let counter = meter.u64_counter("req.count").build();
    let updown = meter.i64_up_down_counter("queue.depth").build();
    let gauge = meter.f64_gauge("cpu.load").build();
    let http_hist = meter.f64_histogram("http.server.duration").build();
    let rpc_hist = meter.f64_histogram("rpc.client.duration").build();

    let (cx1, tid1, sid1) = sampled_cx(0x101, 0x201);
    let (cx2, tid2, sid2) = sampled_cx(0x102, 0x202);
    let (cx3, tid3, sid3) = sampled_cx(0x103, 0x203);

    {
        let _g = cx1.attach();
        counter.add(10, &[KeyValue::new("route", "/a")]);
        updown.add(-3, &[KeyValue::new("queue", "main")]);
        gauge.record(0.75, &[KeyValue::new("core", 0i64)]);
        http_hist.record(0.02, &[]);
        http_hist.record(0.08, &[]); // replaces 0.02 in bucket 0
        rpc_hist.record(5.0, &[]);
    }
    {
        let _g = cx2.attach();
        http_hist.record(0.3, &[]);
        rpc_hist.record(25.0, &[]);
    }
    {
        let _g = cx3.attach();
        http_hist.record(2.5, &[]);
    }

    sdk.force_flush().expect("flush");
    let reqs = sink.requests();

    let c_dps = number_points(last_metric(&reqs, "req.count"));
    assert_eq!(c_dps[0].exemplars.len(), 1);
    assert_eq!(c_dps[0].exemplars[0].trace_id, tid1);
    assert_eq!(c_dps[0].exemplars[0].span_id, sid1);

    let u_dps = number_points(last_metric(&reqs, "queue.depth"));
    assert_eq!(
        u_dps[0].exemplars[0].value,
        Some(exemplar::Value::AsInt(-3))
    );

    let g_dps = number_points(last_metric(&reqs, "cpu.load"));
    assert_eq!(
        g_dps[0].exemplars[0].value,
        Some(exemplar::Value::AsDouble(0.75))
    );

    let h_dps = histogram_points(last_metric(&reqs, "http.server.duration"));
    assert_eq!(h_dps[0].explicit_bounds, vec![0.1, 0.5, 1.0]);
    assert_eq!(h_dps[0].bucket_counts, vec![2, 1, 0, 1]);
    let h_ex: Vec<(f64, &[u8], &[u8])> = h_dps[0]
        .exemplars
        .iter()
        .map(|e: &Exemplar| {
            let Some(exemplar::Value::AsDouble(d)) = e.value else {
                panic!("expected double exemplar");
            };
            (d, e.trace_id.as_slice(), e.span_id.as_slice())
        })
        .collect();
    assert_eq!(
        h_ex,
        vec![
            (0.08, tid1.as_slice(), sid1.as_slice()),
            (0.3, tid2.as_slice(), sid2.as_slice()),
            (2.5, tid3.as_slice(), sid3.as_slice()),
        ]
    );

    let r_dps = histogram_points(last_metric(&reqs, "rpc.client.duration"));
    assert_eq!(r_dps[0].explicit_bounds, vec![10.0, 50.0]);
    assert_eq!(r_dps[0].exemplars.len(), 2);

    sdk.shutdown().expect("shutdown");
}

#[test]
fn view_filtered_exemplar_attributes_never_leak_secrets_or_pii() {
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("view-filtered")
        .without_runtime_metrics()
        .with_view(|inst: &Instrument| {
            if inst.name() == "filtered.counter" {
                Stream::builder()
                    .with_allowed_attribute_keys([Key::from_static_str("keep")])
                    .build()
                    .ok()
            } else {
                None
            }
        })
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");

    let (cx, _, _) = sampled_cx(0x301, 0x401);
    {
        let _g = cx.attach();
        sdk.meter("svc")
            .u64_counter("filtered.counter")
            .build()
            .add(
                1,
                &[
                    KeyValue::new("keep", "yes"),
                    KeyValue::new("extra_safe", "visible"),
                    KeyValue::new("http.request.header.authorization", "secret-val"),
                    KeyValue::new("host.ip", "192.0.2.1"),
                ],
            );
    }

    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let f_dps = number_points(last_metric(&reqs, "filtered.counter"));
    assert_eq!(attr_keys(&f_dps[0].attributes), vec!["keep"]);
    assert_eq!(f_dps[0].exemplars.len(), 1);
    assert_eq!(
        attr_keys(&f_dps[0].exemplars[0].filtered_attributes),
        vec!["extra_safe"]
    );
    sdk.shutdown().expect("shutdown");
}

#[test]
fn view_renamed_streams_do_not_attach_exemplars_from_colliding_instrument_names() {
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("view-renamed-collision")
        .without_runtime_metrics()
        .with_view(|inst: &Instrument| match inst.name() {
            "metric.a" => Stream::builder().with_name("metric.b").build().ok(),
            "metric.b" => Stream::builder().with_name("metric.c").build().ok(),
            _ => None,
        })
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");

    let meter = sdk.meter("svc");
    let a = meter.u64_counter("metric.a").build();
    let b = meter.u64_counter("metric.b").build();

    let (cx_a, _, _) = sampled_cx(0x901, 0xa01);
    {
        let _g = cx_a.attach();
        a.add(1, &[]);
    }
    let (cx_b, _, _) = sampled_cx(0x902, 0xa02);
    {
        let _g = cx_b.attach();
        b.add(99, &[]);
    }

    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let b_dps = number_points(last_metric(&reqs, "metric.b"));
    assert_eq!(b_dps.len(), 1);
    assert!(
        b_dps[0].exemplars.is_empty(),
        "exported stream metric.b (renamed from metric.a) must not receive exemplars from original metric.b: {:?}",
        b_dps[0].exemplars
    );
    let c_dps = number_points(last_metric(&reqs, "metric.c"));
    assert_eq!(c_dps.len(), 1);
    assert!(
        c_dps[0].exemplars.is_empty(),
        "renamed stream metric.c must not receive misattached exemplars: {:?}",
        c_dps[0].exemplars
    );
    sdk.shutdown().expect("shutdown");
}

#[test]
fn last_matching_histogram_buckets_rule_wins_for_both_sdk_and_exemplars() {
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("hist-precedence")
        .without_runtime_metrics()
        .with_histogram_buckets("http.*", vec![1.0, 5.0])
        .with_histogram_buckets("http.server.*", vec![0.1, 0.5, 1.0])
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");

    let hist = sdk
        .meter("svc")
        .f64_histogram("http.server.duration")
        .build();
    let (cx1, tid1, _) = sampled_cx(0x701, 0x801);
    let (cx2, tid2, _) = sampled_cx(0x702, 0x802);

    // Under the first rule ([1.0, 5.0]), both 0.05 and 0.3 fall in bucket 0.
    // Under the last matching rule ([0.1, 0.5, 1.0]), they occupy distinct buckets 0 and 1.
    {
        let _g = cx1.attach();
        hist.record(0.05, &[]);
    }
    {
        let _g = cx2.attach();
        hist.record(0.3, &[]);
    }

    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    let dps = histogram_points(last_metric(&reqs, "http.server.duration"));
    assert_eq!(dps[0].explicit_bounds, vec![0.1, 0.5, 1.0]);
    assert_eq!(dps[0].bucket_counts, vec![1, 1, 0, 0]);
    assert_eq!(dps[0].exemplars.len(), 2);
    assert_eq!(dps[0].exemplars[0].trace_id, tid1);
    assert_eq!(dps[0].exemplars[1].trace_id, tid2);
    sdk.shutdown().expect("shutdown");
}

#[test]
fn scopes_with_same_name_but_different_version_or_schema_keep_distinct_exemplars() {
    use opentelemetry::InstrumentationScope;
    use opentelemetry::metrics::MeterProvider as _;

    let sink = MemoryMetricSink::new();
    let sdk = hermetic("scope-identity")
        .without_runtime_metrics()
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");

    let scope_v1 = InstrumentationScope::builder("shared")
        .with_version("1.0")
        .with_schema_url("https://example.test/v1")
        .build();
    let scope_v2 = InstrumentationScope::builder("shared")
        .with_version("2.0")
        .with_schema_url("https://example.test/v2")
        .build();

    let c1 = sdk
        .meter_provider()
        .meter_with_scope(scope_v1)
        .u64_counter("hits")
        .build();
    let c2 = sdk
        .meter_provider()
        .meter_with_scope(scope_v2)
        .u64_counter("hits")
        .build();

    let (cx1, tid1, _) = sampled_cx(0x901, 0xa01);
    let (cx2, tid2, _) = sampled_cx(0x902, 0xa02);
    {
        let _g = cx1.attach();
        c1.add(1, &[]);
    }
    {
        let _g = cx2.attach();
        c2.add(2, &[]);
    }

    sdk.force_flush().expect("flush");
    let reqs = sink.requests();

    let mut seen = std::collections::HashMap::new();
    for sm in reqs
        .iter()
        .flat_map(|r| &r.resource_metrics)
        .flat_map(|rm| &rm.scope_metrics)
    {
        let scope = sm.scope.as_ref().expect("scope");
        if scope.name == "shared" {
            let metric = sm.metrics.iter().find(|m| m.name == "hits").expect("hits");
            let dps = number_points(metric);
            assert_eq!(dps[0].exemplars.len(), 1);
            seen.insert(
                (scope.version.clone(), sm.schema_url.clone()),
                dps[0].exemplars[0].trace_id.clone(),
            );
        }
    }
    assert_eq!(
        seen.get(&("1.0".to_owned(), "https://example.test/v1".to_owned()))
            .map(Vec::as_slice),
        Some(tid1.as_slice())
    );
    assert_eq!(
        seen.get(&("2.0".to_owned(), "https://example.test/v2".to_owned()))
            .map(Vec::as_slice),
        Some(tid2.as_slice())
    );
    sdk.shutdown().expect("shutdown");
}

#[test]
fn multiple_readers_have_independent_exemplar_stores() {
    let sink_a = MemoryMetricSink::new();
    let sink_b = MemoryMetricSink::new();
    let sdk = hermetic("multi-reader")
        .without_runtime_metrics()
        .with_metric_sink(sink_a.clone())
        .with_extra_metric_sink(sink_b.clone())
        .build()
        .expect("SDK");

    let (cx, tid, sid) = sampled_cx(0x999, 0x888);
    {
        let _g = cx.attach();
        sdk.meter("svc").u64_counter("shared").build().add(1, &[]);
    }
    sdk.force_flush().expect("flush");

    for (name, sink) in [("reader_a", &sink_a), ("reader_b", &sink_b)] {
        let reqs = sink.requests();
        let dps = number_points(last_metric(&reqs, "shared"));
        assert_eq!(dps[0].exemplars.len(), 1, "{name} lost its exemplar");
        assert_eq!(dps[0].exemplars[0].trace_id, tid, "{name}");
        assert_eq!(dps[0].exemplars[0].span_id, sid, "{name}");
    }

    sdk.shutdown().expect("shutdown");
}

#[test]
fn temporality_preferences_match_otel_spec() {
    for (temporality, want_counter, want_updown, want_hist) in [
        (
            Temporality::Cumulative,
            AggregationTemporality::Cumulative as i32,
            AggregationTemporality::Cumulative as i32,
            AggregationTemporality::Cumulative as i32,
        ),
        (
            Temporality::Delta,
            AggregationTemporality::Delta as i32,
            AggregationTemporality::Cumulative as i32,
            AggregationTemporality::Delta as i32,
        ),
        (
            Temporality::LowMemory,
            AggregationTemporality::Delta as i32,
            AggregationTemporality::Cumulative as i32,
            AggregationTemporality::Delta as i32,
        ),
    ] {
        let sink = MemoryMetricSink::with_temporality(temporality);
        let sdk = hermetic("temp")
            .without_runtime_metrics()
            .with_metric_sink(sink.clone())
            .build()
            .expect("SDK");
        let meter = sdk.meter("svc");
        meter.u64_counter("c").build().add(1, &[]);
        meter.i64_up_down_counter("u").build().add(1, &[]);
        meter.f64_histogram("h").build().record(1.0, &[]);
        sdk.force_flush().expect("flush");
        let reqs = sink.requests();

        let Data::Sum(c) = last_metric(&reqs, "c").data.as_ref().expect("sum") else {
            panic!("expected sum");
        };
        assert_eq!(c.aggregation_temporality, want_counter, "{temporality:?}");

        let Data::Sum(u) = last_metric(&reqs, "u").data.as_ref().expect("sum") else {
            panic!("expected sum");
        };
        assert_eq!(u.aggregation_temporality, want_updown, "{temporality:?}");

        let Data::Histogram(h) = last_metric(&reqs, "h").data.as_ref().expect("hist") else {
            panic!("expected hist");
        };
        assert_eq!(h.aggregation_temporality, want_hist, "{temporality:?}");
        sdk.shutdown().expect("shutdown");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn process_runtime_metrics_emit_by_default_and_can_be_disabled() {
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("proc-on")
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");
    sdk.force_flush().expect("flush");
    let reqs = sink.requests();

    for name in [
        "process.cpu.time",
        "process.memory.usage",
        "process.memory.virtual",
        "process.thread.count",
        "process.unix.file_descriptor.count",
    ] {
        let metric = last_metric(&reqs, name);
        let dps = number_points(metric);
        assert!(!dps.is_empty(), "{name} should have data points");
        for dp in dps {
            match dp.value {
                Some(opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsInt(
                    v,
                )) => {
                    assert!(v > 0, "{name} expected > 0, got {v}");
                }
                Some(
                    opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsDouble(v),
                ) => {
                    assert!(v >= 0.0, "{name} expected >= 0.0, got {v}");
                }
                None => panic!("{name} missing value"),
            }
        }
    }
    sdk.shutdown().expect("shutdown");

    // Disabled with without_runtime_metrics().
    let sink = MemoryMetricSink::new();
    let sdk = hermetic("proc-off")
        .without_runtime_metrics()
        .with_metric_sink(sink.clone())
        .build()
        .expect("SDK");
    sdk.meter("svc")
        .u64_counter("only.mine")
        .build()
        .add(1, &[]);
    sdk.force_flush().expect("flush");
    let reqs = sink.requests();
    assert!(!find_metrics(&reqs, "only.mine").is_empty());
    assert!(find_metrics(&reqs, "process.memory.usage").is_empty());
    assert!(find_metrics(&reqs, "process.cpu.time").is_empty());
    sdk.shutdown().expect("shutdown");
}

#[test]
fn unreadable_metrics_certificate_fails_with_building_metric_reader() {
    let err = Sdk::builder()
        .service_name("bad-cert")
        .environment(Environment::Test)
        .env_lookup(EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "none"),
            ("OTEL_LOGS_EXPORTER", "none"),
            ("OTEL_METRICS_EXPORTER", "otlp"),
            ("OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE", "/no/such/ca.pem"),
        ]))
        .without_runtime_metrics()
        .build()
        .expect_err("bad cert");
    assert!(matches!(err, Error::BuildingMetricReader(_)), "{err}");
    assert!(
        err.to_string().starts_with(
            "o11y: building metric reader: reading OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE"
        ),
        "{err}"
    );
}

#[cfg(feature = "otlp-http")]
mod http_wire {
    use super::*;
    use flate2::read::GzDecoder;
    use prost::Message as _;
    use std::collections::HashMap;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    struct CapturedHttp {
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    fn spawn_http_server(
        statuses: Vec<u16>,
    ) -> (
        String,
        Arc<Mutex<Vec<CapturedHttp>>>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let captured = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&captured);

        let handle = std::thread::spawn(move || {
            for status in statuses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let header_end;
                loop {
                    let n = stream.read(&mut tmp).expect("read");
                    assert!(n > 0, "unexpected EOF reading headers");
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = pos + 4;
                        break;
                    }
                }
                let header_str = String::from_utf8_lossy(&buf[..header_end]);
                let mut headers = HashMap::new();
                for line in header_str.lines().skip(1) {
                    if let Some((k, v)) = line.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
                    }
                }
                let content_len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                while buf.len() < header_end + content_len {
                    let n = stream.read(&mut tmp).expect("read body");
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body = buf[header_end..header_end + content_len].to_vec();
                sink.lock()
                    .expect("lock")
                    .push(CapturedHttp { headers, body });

                let reason = if status == 200 {
                    "OK"
                } else {
                    "Service Unavailable"
                };
                let resp = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
                stream.write_all(resp.as_bytes()).expect("write resp");
            }
        });

        (format!("http://{addr}/v1/metrics"), captured, handle)
    }

    #[test]
    fn otlp_http_protobuf_gzip_headers_and_retry_wire_test() {
        // First attempt returns 503 (triggers retry), second returns 200.
        let (endpoint, captured, server) = spawn_http_server(vec![503, 200]);

        let sdk = Sdk::builder()
            .service_name("http-proto-wire")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/protobuf"),
                ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", endpoint.as_str()),
                ("OTEL_EXPORTER_OTLP_METRICS_COMPRESSION", "gzip"),
                (
                    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
                    "x-api-key=sec%20ret, x-tenant=acme",
                ),
                ("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta"),
            ]))
            .with_error_handler(|_| {})
            .build()
            .expect("SDK");

        let (cx, tid, sid) = sampled_cx(0x42, 0x24);
        {
            let _g = cx.attach();
            sdk.meter("wire")
                .u64_counter("wire.hits")
                .build()
                .add(7, &[KeyValue::new("env", "test")]);
        }
        sdk.force_flush().expect("flush succeeded after retry");
        sdk.shutdown().expect("shutdown");
        server.join().expect("server");

        let reqs = captured.lock().expect("lock");
        assert_eq!(reqs.len(), 2, "expected 1 retry after 503");
        let last = &reqs[1];
        assert_eq!(
            last.headers.get("content-type").map(String::as_str),
            Some("application/x-protobuf")
        );
        assert_eq!(
            last.headers.get("content-encoding").map(String::as_str),
            Some("gzip")
        );
        assert_eq!(
            last.headers.get("x-api-key").map(String::as_str),
            Some("sec ret")
        );
        assert_eq!(
            last.headers.get("x-tenant").map(String::as_str),
            Some("acme")
        );

        let mut raw = Vec::new();
        GzDecoder::new(last.body.as_slice())
            .read_to_end(&mut raw)
            .expect("gunzip");
        let decoded = [ExportMetricsServiceRequest::decode(raw.as_slice()).expect("decode proto")];
        let metric = last_metric(&decoded, "wire.hits");
        let Data::Sum(sum) = metric.data.as_ref().expect("sum") else {
            panic!("expected sum");
        };
        assert_eq!(
            sum.aggregation_temporality,
            AggregationTemporality::Delta as i32
        );
        assert_eq!(sum.data_points[0].exemplars.len(), 1);
        assert_eq!(sum.data_points[0].exemplars[0].trace_id, tid);
        assert_eq!(sum.data_points[0].exemplars[0].span_id, sid);
    }

    #[test]
    fn otlp_http_json_wire_test() {
        // Cumulative temporality exports on force_flush and again on shutdown.
        let (endpoint, captured, server) = spawn_http_server(vec![200, 200]);

        let sdk = Sdk::builder()
            .service_name("http-json-wire")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/json"),
                ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", endpoint.as_str()),
            ]))
            .with_error_handler(|_| {})
            .build()
            .expect("SDK");

        let (cx, tid, sid) = sampled_cx(0x77, 0x88);
        {
            let _g = cx.attach();
            sdk.meter("wire")
                .f64_histogram("wire.latency")
                .build()
                .record(12.5, &[]);
        }
        sdk.force_flush().expect("flush");
        sdk.shutdown().expect("shutdown");
        server.join().expect("server");

        let reqs = captured.lock().expect("lock");
        assert_eq!(reqs.len(), 2);
        assert_eq!(
            reqs[0].headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        let decoded: [ExportMetricsServiceRequest; 1] =
            [serde_json::from_slice(&reqs[0].body).expect("decode OTLP/JSON")];
        let dps = histogram_points(last_metric(&decoded, "wire.latency"));
        assert_eq!(dps[0].exemplars.len(), 1);
        assert_eq!(dps[0].exemplars[0].trace_id, tid);
        assert_eq!(dps[0].exemplars[0].span_id, sid);
    }
}

#[cfg(feature = "otlp-grpc")]
mod grpc_wire {
    use super::*;
    use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceResponse;
    use opentelemetry_proto::tonic::collector::metrics::v1::metrics_service_server::{
        MetricsService, MetricsServiceServer,
    };
    use std::sync::{Arc, Mutex};
    use tonic::{Request, Response, Status};

    type CapturedGrpc = Arc<Mutex<Vec<(ExportMetricsServiceRequest, Option<String>)>>>;

    #[derive(Clone, Default)]
    struct MockMetricsService {
        received: CapturedGrpc,
    }

    #[tonic::async_trait]
    impl MetricsService for MockMetricsService {
        async fn export(
            &self,
            request: Request<ExportMetricsServiceRequest>,
        ) -> Result<Response<ExportMetricsServiceResponse>, Status> {
            let token = request
                .metadata()
                .get("x-grpc-token")
                .and_then(|v| v.to_str().ok())
                .map(ToOwned::to_owned);
            self.received
                .lock()
                .expect("lock")
                .push((request.into_inner(), token));
            Ok(Response::new(ExportMetricsServiceResponse {
                partial_success: None,
            }))
        }
    }

    #[test]
    fn otlp_grpc_metrics_outside_tokio_fails_with_building_metric_reader() {
        let err = Sdk::builder()
            .service_name("grpc-no-rt")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"),
            ]))
            .build()
            .expect_err("no tokio runtime");
        assert!(matches!(err, Error::BuildingMetricReader(_)), "{err}");
        assert!(
            err.to_string()
                .starts_with("o11y: building metric reader: OTLP over grpc needs a Tokio runtime"),
            "{err}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn otlp_grpc_metrics_wire_test_with_exemplars_headers_and_gzip() {
        let service = MockMetricsService::default();
        let received = Arc::clone(&service.received);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let incoming = tokio_stream_from_listener(listener);

        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(
                    MetricsServiceServer::new(service)
                        .accept_compressed(tonic::codec::CompressionEncoding::Gzip),
                )
                .serve_with_incoming(incoming)
                .await
                .expect("serve");
        });

        let endpoint = format!("http://{addr}");
        let sdk = Sdk::builder()
            .service_name("grpc-wire")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"),
                ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", endpoint.as_str()),
                ("OTEL_EXPORTER_OTLP_METRICS_COMPRESSION", "gzip"),
                (
                    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
                    "x-grpc-token=abc%20123",
                ),
            ]))
            .with_error_handler(|_| {})
            .build()
            .expect("SDK");

        let (cx, tid, sid) = sampled_cx(0x555, 0x666);
        {
            let _g = cx.attach();
            sdk.meter("grpc-svc")
                .u64_counter("grpc.calls")
                .build()
                .add(3, &[]);
        }

        let sdk_for_flush = sdk.clone();
        tokio::task::spawn_blocking(move || sdk_for_flush.force_flush())
            .await
            .expect("join")
            .expect("flush");
        sdk.shutdown_async().await.expect("shutdown");
        server.abort();

        let captured = received.lock().expect("lock");
        assert!(!captured.is_empty(), "expected gRPC export");
        let (req, token) = &captured[0];
        assert_eq!(token.as_deref(), Some("abc 123"));
        let dps = number_points(last_metric(std::slice::from_ref(req), "grpc.calls"));
        assert_eq!(dps[0].exemplars.len(), 1);
        assert_eq!(dps[0].exemplars[0].trace_id, tid);
        assert_eq!(dps[0].exemplars[0].span_id, sid);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn otlp_grpc_schemeless_endpoint_honors_insecure_flag() {
        let service = MockMetricsService::default();
        let received = Arc::clone(&service.received);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let incoming = tokio_stream_from_listener(listener);

        let server = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(MetricsServiceServer::new(service))
                .serve_with_incoming(incoming)
                .await
                .expect("serve");
        });

        // Schemeless host:port + INSECURE=true must normalize to http:// and connect plaintext.
        let schemeless = addr.to_string();
        let sdk = Sdk::builder()
            .service_name("grpc-schemeless")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"),
                ("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", schemeless.as_str()),
                ("OTEL_EXPORTER_OTLP_METRICS_INSECURE", "true"),
            ]))
            .with_error_handler(|_| {})
            .build()
            .expect("SDK");

        sdk.meter("grpc-svc")
            .u64_counter("grpc.schemeless")
            .build()
            .add(1, &[]);

        let sdk_for_flush = sdk.clone();
        tokio::task::spawn_blocking(move || sdk_for_flush.force_flush())
            .await
            .expect("join")
            .expect("flush");
        sdk.shutdown_async().await.expect("shutdown");
        server.abort();

        assert!(
            !received.lock().expect("lock").is_empty(),
            "expected gRPC export on schemeless endpoint"
        );

        // Schemeless endpoint without INSECURE builds lazily with https:// + TLS.
        let tls_sdk = Sdk::builder()
            .service_name("grpc-schemeless-tls")
            .environment(Environment::Test)
            .without_runtime_metrics()
            .env_lookup(EnvLookup::from_pairs([
                ("OTEL_TRACES_EXPORTER", "none"),
                ("OTEL_LOGS_EXPORTER", "none"),
                ("OTEL_METRICS_EXPORTER", "otlp"),
                ("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "grpc"),
                (
                    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                    "collector.example:4317",
                ),
            ]))
            .with_error_handler(|_| {})
            .build()
            .expect("schemeless TLS gRPC SDK builds lazily");
        tls_sdk.shutdown_async().await.expect("shutdown");
    }

    /// Minimal `futures_core::Stream` wrapper over `tokio::net::TcpListener` so
    /// tests need no `tokio-stream` dependency.
    struct TcpIncoming(tokio::net::TcpListener);

    fn tokio_stream_from_listener(listener: tokio::net::TcpListener) -> TcpIncoming {
        TcpIncoming(listener)
    }

    impl tonic::codegen::tokio_stream::Stream for TcpIncoming {
        type Item = std::io::Result<tokio::net::TcpStream>;

        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            match self.0.poll_accept(cx) {
                std::task::Poll::Ready(Ok((stream, _))) => std::task::Poll::Ready(Some(Ok(stream))),
                std::task::Poll::Ready(Err(err)) => std::task::Poll::Ready(Some(Err(err))),
                std::task::Poll::Pending => std::task::Poll::Pending,
            }
        }
    }
}
