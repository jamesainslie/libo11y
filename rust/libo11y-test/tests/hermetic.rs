//! Hermeticity, option-precedence, isolation, and reset tests for
//! [`libo11y_test::Recorder`].

use std::process::Command;

use opentelemetry::KeyValue;
use opentelemetry::trace::{Span as _, Tracer as _};
use opentelemetry_sdk::trace::Sampler;

use libo11y::{Environment, ExemplarFilter};
use libo11y_test::Recorder;

const CHILD_ENV: &str = "LIBO11Y_TEST_HERMETIC_CHILD";

const HOSTILE_AMBIENT: &[(&str, &str)] = &[
    ("OTEL_SDK_DISABLED", "true"),
    ("OTEL_TRACES_SAMPLER", "always_off"),
    (
        "OTEL_RESOURCE_ATTRIBUTES",
        "host.name=ambient-host,team=ambient-team,deployment.environment.name=production",
    ),
    ("OTEL_SERVICE_NAME", "ambient-service"),
    ("OTEL_METRICS_EXEMPLAR_FILTER", "always_off"),
    ("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1"),
    ("OTEL_TRACES_EXPORTER", "bogus"),
    ("OTEL_METRICS_EXPORTER", "prometheus"),
    ("OTEL_LOGS_EXPORTER", "bogus"),
    ("OTEL_PROPAGATORS", "bogus"),
];

#[test]
fn recorder_ignores_hostile_ambient_otel_environment() {
    if std::env::var_os(CHILD_ENV).is_some() {
        run_hermetic_child();
        return;
    }
    let mut cmd = Command::new(std::env::current_exe().expect("test binary"));
    cmd.args([
        "--exact",
        "recorder_ignores_hostile_ambient_otel_environment",
        "--test-threads=1",
    ])
    .env(CHILD_ENV, "1");
    for (k, v) in HOSTILE_AMBIENT {
        cmd.env(k, v);
    }
    let output = cmd.output().expect("child process");
    assert!(
        output.status.success(),
        "child failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_hermetic_child() {
    let rec = Recorder::start("hermetic-svc");
    rec.in_scope(|| {
        let _span = tracing::info_span!("op", a = 1_i64, b = 2_i64, c = 3_i64).entered();
        tracing::info!("inside");
        rec.sdk()
            .meter("svc")
            .f64_histogram("work.duration")
            .build()
            .record(1.5, &[]);
    });

    let spans = rec.spans();
    assert_eq!(spans.len(), 1, "ambient sampler/disabled leaked in");
    for key in ["a", "b", "c"] {
        assert!(
            spans[0].attributes.iter().any(|kv| kv.key.as_str() == key),
            "span missing attribute {key} (ambient span attribute limit leaked in): {:?}",
            spans[0].attributes
        );
    }

    let resource = rec.sdk().resource();
    let get = |key: &'static str| {
        resource
            .get(&opentelemetry::Key::from_static_str(key))
            .map(|v| v.to_string())
    };
    assert_eq!(get("service.name").as_deref(), Some("hermetic-svc"));
    assert_eq!(get("deployment.environment.name").as_deref(), Some("test"));
    assert_ne!(get("host.name").as_deref(), Some("ambient-host"));
    assert_eq!(get("team"), None);

    assert!(
        !rec.exemplars("work.duration").is_empty(),
        "ambient exemplar filter leaked in"
    );
    rec.assert_correlated();
    rec.assert_conforms();
}

#[test]
fn caller_options_override_harness_defaults() {
    let rec = Recorder::start_with("default-name", |b| {
        b.service_name("custom-name")
            .environment(Environment::Staging)
            .trace_sampler(Sampler::AlwaysOff)
            .exemplar_filter(ExemplarFilter::AlwaysOff)
            .log_level(tracing::Level::WARN)
    })
    .expect("recorder");

    let res = rec.sdk().resource();
    assert_eq!(
        res.get(&opentelemetry::Key::from_static_str("service.name"))
            .map(|v| v.to_string())
            .as_deref(),
        Some("custom-name")
    );
    assert_eq!(
        res.get(&opentelemetry::Key::from_static_str(
            "deployment.environment.name"
        ))
        .map(|v| v.to_string())
        .as_deref(),
        Some("staging")
    );

    rec.in_scope(|| {
        let _span = tracing::info_span!("dropped").entered();
        tracing::info!("filtered out");
        tracing::warn!("kept");
    });
    assert!(
        rec.spans().is_empty(),
        "caller AlwaysOff sampler must override AlwaysOn"
    );
    let logs = rec.logs();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].message(), "kept");
}

#[test]
fn parallel_recorders_are_isolated_and_touch_no_globals() {
    let handles: Vec<_> = (0_i64..8)
        .map(|i| {
            std::thread::spawn(move || {
                let svc = format!("worker-{i}");
                let rec = Recorder::start(&svc);
                rec.in_scope(|| {
                    let _span = tracing::info_span!("task", worker = i).entered();
                    tracing::debug!(worker = i, "running");
                    let counter = rec.sdk().meter("worker").u64_counter("worker.runs").build();
                    counter.add(1, &[KeyValue::new("worker", i)]);
                });
                let mut api_span = rec.sdk().tracer("worker").start(format!("api-{i}"));
                api_span.end();

                let spans = rec.spans();
                assert_eq!(spans.len(), 2, "worker {i} saw unexpected spans: {spans:?}");
                assert_eq!(spans[0].name, "task");
                assert_eq!(spans[1].name, format!("api-{i}"));

                let logs = rec.logs();
                assert_eq!(logs.len(), 1, "worker {i} saw unexpected logs");
                assert_eq!(logs[0].message(), "running");
                assert_eq!(
                    logs[0].attr_str("worker").as_deref(),
                    Some(i.to_string().as_str())
                );

                assert!(rec.metric_names().contains(&"worker.runs".to_owned()));
                rec.assert_conforms();
                rec.assert_correlated();
                rec.assert_triangle("worker.runs");
            })
        })
        .collect();

    for handle in handles {
        handle.join().expect("worker thread panicked");
    }
}

#[test]
fn debug_logs_captured_by_default_and_reset_clears_buffers() {
    let rec = Recorder::start("reset-test");
    rec.in_scope(|| {
        let _span = tracing::info_span!("first").entered();
        tracing::debug!("verbose detail");
        rec.sdk()
            .meter("svc")
            .u64_counter("events")
            .build()
            .add(1, &[]);
    });

    assert_eq!(rec.spans().len(), 1);
    assert_eq!(rec.logs().len(), 1);
    assert_eq!(rec.logs()[0].message(), "verbose detail");
    assert!(!rec.metrics().is_empty());

    rec.reset();
    assert!(rec.spans().is_empty());
    assert!(rec.logs().is_empty());
    // Note: cumulative metrics re-export on next flush, while cleared batches
    // start empty before any new flush.
    rec.in_scope(|| {
        let _span = tracing::info_span!("second").entered();
        tracing::info!("after reset");
    });
    assert_eq!(rec.spans().len(), 1);
    assert_eq!(rec.spans()[0].name, "second");
    assert_eq!(rec.logs().len(), 1);
    assert_eq!(rec.logs()[0].message(), "after reset");
}

#[test]
#[should_panic(expected = "libo11y-test: building SDK:")]
fn start_panics_with_expected_prefix_on_invalid_service_name() {
    let _ = Recorder::start("   ");
}
