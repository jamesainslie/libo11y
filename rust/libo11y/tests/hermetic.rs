//! Hermetic mode against a hostile process environment. The variables are
//! set on a child process running this test again, since the test cannot
//! change its own environment safely.

mod common;

use std::process::Command;

use opentelemetry::KeyValue;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{Span as _, Tracer as _};

use common::{Ended, hermetic};
use libo11y::{Environment, Error, Sdk};

/// Marks the child run.
const CHILD: &str = "HERMETIC_TEST_CHILD";

/// The ambient variables, each of which would change the SDK if it were
/// read.
const AMBIENT: &[(&str, &str)] = &[
    ("OTEL_SDK_DISABLED", "true"),
    ("OTEL_TRACES_SAMPLER", "always_off"),
    ("OTEL_PROPAGATORS", "bogus"),
    ("OTEL_TRACES_EXPORTER", "bogus"),
    ("OTEL_METRICS_EXPORTER", "prometheus"),
    ("OTEL_LOGS_EXPORTER", "bogus"),
    ("OTEL_EXPORTER_OTLP_PROTOCOL", "bogus"),
    ("OTEL_EXPORTER_OTLP_CERTIFICATE", "/no/such/ca.pem"),
    ("OTEL_SERVICE_NAME", "ambient"),
    (
        "OTEL_RESOURCE_ATTRIBUTES",
        "team=ambient,deployment.environment.name=nowhere",
    ),
    ("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1"),
    ("OTEL_BSP_MAX_QUEUE_SIZE", "0"),
    ("OTEL_METRICS_EXEMPLAR_FILTER", "always_on"),
    ("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "delta"),
];

#[test]
fn hermetic_mode_ignores_ambient_otel_variables() {
    if std::env::var_os(CHILD).is_some() {
        child();
        return;
    }
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .args([
            "--exact",
            "hermetic_mode_ignores_ambient_otel_variables",
            "--test-threads=1",
        ])
        .env(CHILD, "1");
    for (key, value) in AMBIENT {
        command.env(key, value);
    }
    let output = command.output().expect("child runs");
    assert!(
        output.status.success(),
        "child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child() {
    let ended = Ended::default();
    let sdk = hermetic("hermetic")
        .with_span_processor(ended.clone())
        .build()
        .expect("hermetic mode reads none of the broken variables");

    let mut span = sdk.tracer("t").start("op");
    span.set_attributes([
        KeyValue::new("a", 1),
        KeyValue::new("b", 2),
        KeyValue::new("c", 3),
    ]);
    span.end();
    let spans = ended.spans();
    assert_eq!(spans.len(), 1, "neither disabled nor sampled out");
    assert_eq!(spans[0].attributes.len(), 3, "span limits are the defaults");

    assert_eq!(
        sdk.propagator().fields().collect::<Vec<_>>(),
        ["traceparent", "tracestate", "baggage"]
    );
    let resource = sdk.resource();
    let get = |key: &'static str| {
        resource
            .get(&opentelemetry::Key::from_static_str(key))
            .map(|v| v.to_string())
    };
    assert_eq!(get("service.name").as_deref(), Some("hermetic"));
    assert_eq!(get("team"), None);
    assert_eq!(get("deployment.environment.name").as_deref(), Some("test"));
    sdk.shutdown().expect("shutdown");

    // Without hermetic mode the process environment is read.
    let err = Sdk::builder()
        .environment(Environment::Test)
        .with_span_processor(Ended::default())
        .with_error_handler(|_| {})
        .build()
        .expect_err("the ambient propagators are read");
    assert!(matches!(err, Error::UnknownPropagator { .. }), "{err}");
}
