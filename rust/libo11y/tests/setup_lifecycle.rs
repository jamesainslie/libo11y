//! The global lifecycle, in one sequential test because it changes process
//! globals: a failed setup installs nothing and holds no guard, setup
//! installs every global, a second setup fails, shutdown releases the
//! guard, and a later setup takes over the tracing stack.

mod common;

use std::collections::HashMap;

use opentelemetry::trace::{Span as _, TraceContextExt as _, Tracer as _, TracerProvider as _};
use opentelemetry::{Context, KeyValue};

use common::{Spans, hermetic};
use libo11y::{Environment, Error, MemoryMetricSink, Sdk};

/// Whether the global tracer records spans.
fn global_tracer_records() -> bool {
    let span = opentelemetry::global::tracer_provider()
        .tracer("probe")
        .start("probe");
    span.span_context().is_valid()
}

/// What the global propagator injects for a sampled span of `sdk`.
fn global_inject(sdk: &Sdk) -> HashMap<String, String> {
    let span = sdk.tracer("t").start("inject");
    let cx = opentelemetry::Context::new().with_span(span);
    let mut carrier = HashMap::new();
    opentelemetry::global::get_text_map_propagator(|p| p.inject_context(&cx, &mut carrier));
    carrier
}

fn assert_global_metric(metrics: &MemoryMetricSink) {
    let metric = metrics
        .requests()
        .into_iter()
        .flat_map(|r| r.resource_metrics)
        .flat_map(|rm| rm.scope_metrics)
        .flat_map(|sm| sm.metrics)
        .find(|m| m.name == "global.counter")
        .expect("the global meter provider is the SDK's");
    let Some(opentelemetry_proto::tonic::metrics::v1::metric::Data::Sum(sum)) = metric.data else {
        panic!("expected sum");
    };
    let dp = &sum.data_points[0];
    assert_eq!(
        dp.attributes.len(),
        1,
        "secret and PII dropped on global meter"
    );
    assert_eq!(dp.attributes[0].key, "route");
    assert_eq!(dp.exemplars.len(), 1, "exemplar attached via global meter");
    assert!(!dp.exemplars[0].trace_id.is_empty());
}

#[test]
fn the_global_lifecycle() {
    // A failed setup installs nothing and releases the guard.
    let err = Sdk::builder()
        .environment(Environment::Test)
        .without_otel_env()
        .setup()
        .expect_err("no service name");
    assert!(matches!(err, Error::NoServiceName), "{err}");
    assert!(!global_tracer_records(), "no global tracer provider");
    assert!(!tracing::dispatcher::has_been_set(), "no tracing default");
    let probe = hermetic("probe").build().expect("SDK");
    assert!(global_inject(&probe).is_empty(), "no global propagator");

    // Setup installs every global.
    let first_spans = Spans::default();
    let metrics = MemoryMetricSink::new();
    let first = hermetic("first")
        .without_runtime_metrics()
        .with_span_exporter(first_spans.clone())
        .with_metric_sink(metrics.clone())
        .setup()
        .expect("setup after a failed setup");
    assert!(global_tracer_records());
    assert!(tracing::dispatcher::has_been_set());
    assert!(global_inject(&first).contains_key("traceparent"));
    {
        let span = opentelemetry::global::tracer("probe").start("first-global");
        let cx = Context::current_with_span(span);
        let _guard = cx.clone().attach();
        opentelemetry::global::meter("probe")
            .u64_counter("global.counter")
            .build()
            .add(
                1,
                &[
                    KeyValue::new("route", "/ok"),
                    KeyValue::new("http.request.header.authorization", "secret"),
                    KeyValue::new("host.ip", "10.0.0.1"),
                ],
            );
        cx.span().end();
    }
    tracing::info_span!("first-tracing").in_scope(|| {});
    first.force_flush().expect("flush");
    let names = first_spans.names();
    assert!(names.contains(&"first-tracing".to_owned()), "{names:?}");
    assert!(names.contains(&"first-global".to_owned()), "{names:?}");
    assert_global_metric(&metrics);

    // One global SDK at a time.
    let err = hermetic("second").setup().expect_err("already set up");
    assert!(matches!(err, Error::AlreadySetup));

    // A span opened under the first SDK ends under the next one.
    let straddling = tracing::info_span!("straddling");
    let entered = tracing::info_span!("entered-straddling").entered();

    first.shutdown().expect("shutdown");
    let second_spans = Spans::default();
    let second = hermetic("second")
        .with_span_exporter(second_spans.clone())
        .setup()
        .expect("setup after shutdown");
    drop(straddling);
    drop(entered);
    tracing::info_span!("second-tracing").in_scope(|| {});
    second.force_flush().expect("flush");
    let second_names = second_spans.names();
    assert!(
        second_names.contains(&"second-tracing".to_owned()),
        "{second_names:?}"
    );
    assert!(!first_spans.names().contains(&"second-tracing".to_owned()));
    // A span that was never entered starts its OpenTelemetry span when it
    // closes, on the SDK installed then.
    let first_names = first_spans.names();
    assert_eq!(
        usize::from(first_names.contains(&"straddling".to_owned()))
            + usize::from(second_names.contains(&"straddling".to_owned())),
        1,
        "{first_names:?} {second_names:?}"
    );
    second.shutdown().expect("shutdown");

    // A setup that leaves tracing alone still works after one that did not,
    // and the stack that stays installed follows it rather than the SDK
    // that was shut down.
    let third_spans = Spans::default();
    let third = hermetic("third")
        .with_span_exporter(third_spans.clone())
        .without_tracing_default()
        .setup()
        .expect("setup");
    tracing::info_span!("third-tracing").in_scope(|| {});
    third.force_flush().expect("flush");
    assert_eq!(third_spans.names(), ["third-tracing"]);
    third.shutdown().expect("shutdown");
}
