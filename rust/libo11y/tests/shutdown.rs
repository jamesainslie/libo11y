//! Bounded shutdown and flush through the public API, with exporters that
//! hang.

mod common;

use std::time::{Duration, Instant};

use opentelemetry::metrics::MeterProvider as _;
use opentelemetry::trace::{Span as _, Tracer as _};
use opentelemetry_sdk::metrics::InMemoryMetricExporter;

use common::{Gate, HangingMetrics, HangingSpans, Release, Spans, hermetic};
use libo11y::{Sdk, Signal};

/// Wide on purpose: it catches a call that ignores its deadline, not a
/// slow machine.
const BOUND: Duration = Duration::from_secs(10);

fn emit(sdk: &Sdk) {
    sdk.tracer("t").start("op").end();
    sdk.meter_provider()
        .meter("t")
        .u64_counter("c")
        .build()
        .add(1, &[]);
}

fn collected(metrics: &InMemoryMetricExporter) -> bool {
    metrics
        .get_finished_metrics()
        .expect("metrics")
        .iter()
        .flat_map(opentelemetry_sdk::metrics::data::ResourceMetrics::scope_metrics)
        .any(|sm| sm.metrics().any(|m| m.name() == "c"))
}

#[test]
fn a_hung_span_export_does_not_starve_metrics() {
    let gate = Gate::default();
    let _release = Release(gate.clone());
    let metrics = InMemoryMetricExporter::default();
    let sdk = hermetic("hung-spans")
        .with_span_exporter(HangingSpans(gate))
        .with_metric_exporter(metrics.clone())
        .build()
        .expect("SDK");
    emit(&sdk);
    let start = Instant::now();
    let err = sdk
        .shutdown_with_timeout(Duration::from_secs(1))
        .expect_err("the span export hangs");
    assert!(start.elapsed() < BOUND, "{:?}", start.elapsed());
    assert_eq!(err.failures().len(), 1, "{err}");
    assert_eq!(err.failures()[0].signal(), Signal::Traces);
    assert!(
        err.to_string().starts_with("o11y: shutdown traces: "),
        "{err}"
    );
    assert!(collected(&metrics), "the metric flush ran");
}

#[test]
fn a_hung_metric_export_does_not_starve_traces_or_hold_the_caller() {
    let gate = Gate::default();
    let _release = Release(gate.clone());
    let spans = Spans::default();
    let sdk = hermetic("hung-metrics")
        .with_span_exporter(spans.clone())
        .with_metric_exporter(HangingMetrics(gate))
        .build()
        .expect("SDK");
    emit(&sdk);

    // Upstream's meter provider flush has no deadline of its own.
    let start = Instant::now();
    let err = sdk
        .force_flush_with_timeout(Duration::from_millis(500))
        .expect_err("the metric export hangs");
    assert!(start.elapsed() < BOUND, "{:?}", start.elapsed());
    assert_eq!(err.failures()[0].signal(), Signal::Metrics);
    assert!(err.failures()[0].is_timeout());
    assert_eq!(
        err.to_string(),
        "o11y: flush metrics: deadline exceeded after 500ms"
    );

    let start = Instant::now();
    let err = sdk
        .shutdown_with_timeout(Duration::from_secs(1))
        .expect_err("the metric export still hangs");
    assert!(start.elapsed() < BOUND, "{:?}", start.elapsed());
    assert_eq!(err.failures().len(), 1, "{err}");
    assert_eq!(err.failures()[0].signal(), Signal::Metrics);
    assert_eq!(spans.names(), ["op"], "the trace flush ran");
}

#[test]
fn clones_share_the_one_shutdown() {
    let sdk = hermetic("clones").build().expect("SDK");
    let clone = sdk.clone();
    sdk.shutdown().expect("clean");
    clone
        .shutdown_with_timeout(Duration::ZERO)
        .expect("the stored result");
}

#[tokio::test]
async fn the_async_shutdown_is_bounded_too() {
    let gate = Gate::default();
    let _release = Release(gate.clone());
    let sdk = hermetic("async")
        .with_span_exporter(HangingSpans(gate))
        .build()
        .expect("SDK");
    emit(&sdk);
    let start = Instant::now();
    let err = sdk
        .shutdown_with_timeout_async(Duration::from_millis(500))
        .await
        .expect_err("the span export hangs");
    assert!(start.elapsed() < BOUND);
    assert!(err.failures()[0].is_timeout(), "{err}");
    let again = sdk.shutdown_async().await.expect_err("the stored result");
    assert_eq!(again.to_string(), err.to_string());
}
