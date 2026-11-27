//! The standard variables, read through an `EnvLookup`: exporter selection
//! and protocols, the certificate files, `OTEL_SDK_DISABLED` and
//! `OTEL_PROPAGATORS`.

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use opentelemetry::metrics::MeterProvider as _;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{
    Span as _, SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
    Tracer as _,
};
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::metrics::InMemoryMetricExporter;

use common::{Ended, Spans};
use libo11y::{Builder, EnvLookup, Environment, Error, Sdk, Signal};

/// A builder that reads only `vars` and injects nothing.
fn with_env(vars: &[(&str, &str)]) -> Builder {
    Sdk::builder()
        .service_name("environment")
        .environment(Environment::Test)
        .env_lookup(EnvLookup::from_pairs(
            vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        ))
        .with_error_handler(|_| {})
}

/// Every signal off, so nothing is built from the environment.
const QUIET: [(&str, &str); 3] = [
    ("OTEL_TRACES_EXPORTER", "none"),
    ("OTEL_METRICS_EXPORTER", "none"),
    ("OTEL_LOGS_EXPORTER", "none"),
];

fn quiet_and(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    QUIET.iter().copied().chain(extra.iter().copied()).collect()
}

#[test]
fn exporter_variables_build_or_fail_as_go_does() {
    let ok: &[&[(&str, &str)]] = &[
        &QUIET,
        &[
            ("OTEL_TRACES_EXPORTER", "console"),
            ("OTEL_LOGS_EXPORTER", "console,otlp"),
        ],
        &[("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")],
        &[("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")],
    ];
    for vars in ok {
        let sdk = with_env(vars)
            .build()
            .unwrap_or_else(|err| panic!("{vars:?}: {err}"));
        sdk.shutdown_with_timeout(std::time::Duration::from_secs(1))
            .unwrap_or_else(|err| panic!("{vars:?}: {err}"));
    }
    let err = with_env(&[("OTEL_TRACES_EXPORTER", "jaeger")])
        .build()
        .expect_err("unknown");
    assert!(matches!(
        err,
        Error::UnknownExporter {
            signal: Signal::Traces,
            ..
        }
    ));
    let err = with_env(&[("OTEL_METRICS_EXPORTER", "prometheus")])
        .build()
        .expect_err("unsupported");
    assert!(matches!(
        err,
        Error::UnsupportedExporter {
            signal: Signal::Metrics,
            ..
        }
    ));
    let err = with_env(&[("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "thrift")])
        .build()
        .expect_err("invalid");
    assert!(matches!(
        err,
        Error::InvalidOtlpProtocol {
            signal: Signal::Logs,
            ..
        }
    ));
}

// go/spanpolicy_test.go TestSpanProcessorAloneBuildsNoEnvExporter.
#[test]
fn a_span_processor_alone_builds_no_exporter_from_the_environment() {
    let _sdk = with_env(&[
        ("OTEL_TRACES_EXPORTER", "no-such-exporter"),
        ("OTEL_METRICS_EXPORTER", "none"),
        ("OTEL_LOGS_EXPORTER", "none"),
    ])
    .with_span_processor(Ended::default())
    .build()
    .expect("the injected processor owns the traces");
}

#[test]
fn an_unreadable_certificate_fails_the_build() {
    let err = with_env(&quiet_and(&[
        ("OTEL_TRACES_EXPORTER", "otlp"),
        ("OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", "/no/such/ca.pem"),
    ]))
    .build()
    .expect_err("unreadable");
    assert!(matches!(err, Error::BuildingSpanExporter(_)), "{err}");
    assert_eq!(
        err.to_string().split(": No such file").next(),
        Some(
            "o11y: building span exporter: reading OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE \"/no/such/ca.pem\""
        )
    );
}

/// A CA and a client identity under a fresh directory, removed on drop.
struct Pki {
    dir: std::path::PathBuf,
}

impl Pki {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "libo11y-environment-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let ca_key = rcgen::KeyPair::generate().expect("key");
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).expect("ca");
        let issuer = rcgen::Issuer::new(ca_params, ca_key);
        let key = rcgen::KeyPair::generate().expect("key");
        let cert = rcgen::CertificateParams::new(vec!["client.test".to_owned()])
            .expect("params")
            .signed_by(&key, &issuer)
            .expect("cert");
        std::fs::write(dir.join("ca.pem"), ca.pem()).expect("write");
        std::fs::write(dir.join("client.pem"), cert.pem()).expect("write");
        std::fs::write(dir.join("client.key"), key.serialize_pem()).expect("write");
        Self { dir }
    }

    fn path(&self, name: &str) -> String {
        self.dir.join(name).display().to_string()
    }
}

impl Drop for Pki {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn the_certificate_files_configure_http_and_grpc_exporters() {
    let pki = Pki::new();
    let (ca, cert, key) = (
        pki.path("ca.pem"),
        pki.path("client.pem"),
        pki.path("client.key"),
    );
    let tls = [
        ("OTEL_EXPORTER_OTLP_CERTIFICATE", ca.as_str()),
        ("OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert.as_str()),
        ("OTEL_EXPORTER_OTLP_CLIENT_KEY", key.as_str()),
        ("OTEL_METRICS_EXPORTER", "none"),
    ];
    let sdk = with_env(&tls).build().expect("HTTP exporters with TLS");
    let _ = sdk.shutdown_with_timeout(std::time::Duration::from_secs(1));

    let grpc: Vec<(&str, &str)> = tls
        .iter()
        .copied()
        .chain([("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")])
        .collect();
    let err = with_env(&grpc).build().expect_err("no runtime");
    assert!(
        err.to_string()
            .starts_with("o11y: building span exporter: OTLP over grpc needs a Tokio runtime"),
        "{err}"
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let sdk = runtime
        .block_on(async { with_env(&grpc).build() })
        .expect("gRPC exporters with TLS");
    let _ = sdk.shutdown_with_timeout(std::time::Duration::from_secs(1));
}

/// An SDK with every signal injected, as the probe of Go's `disabled_test.go`.
struct Probe {
    sdk: Sdk,
    ended: Ended,
    spans: Spans,
    metrics: InMemoryMetricExporter,
    warnings: Arc<Mutex<Vec<String>>>,
}

fn probe(vars: &[(&str, &str)]) -> Probe {
    let ended = Ended::default();
    let spans = Spans::default();
    let metrics = InMemoryMetricExporter::default();
    let warnings: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = Arc::clone(&warnings);
    let sdk = with_env(vars)
        .with_span_processor(ended.clone())
        .with_span_exporter(spans.clone())
        .with_metric_exporter(metrics.clone())
        .with_error_handler(move |err| sink.lock().expect("lock").push(err.to_string()))
        .build()
        .expect("SDK");
    Probe {
        sdk,
        ended,
        spans,
        metrics,
        warnings,
    }
}

fn remote_parent() -> (Context, SpanContext) {
    let sc = SpanContext::new(
        TraceId::from(0xa1_u128),
        SpanId::from(0xb2_u64),
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    );
    (Context::new().with_remote_span_context(sc.clone()), sc)
}

impl Probe {
    fn exercise(&self) {
        let (cx, _) = remote_parent();
        let mut span = self.sdk.tracer("t").start_with_context("op", &cx);
        self.sdk
            .meter_provider()
            .meter("t")
            .u64_counter("c")
            .build()
            .add(1, &[]);
        span.set_attribute(KeyValue::new("k", "v"));
        span.end();
        let _ = self.sdk.force_flush();
    }

    fn metrics_collected(&self) -> bool {
        self.metrics
            .get_finished_metrics()
            .expect("metrics")
            .iter()
            .flat_map(opentelemetry_sdk::metrics::data::ResourceMetrics::scope_metrics)
            .any(|sm| sm.metrics().any(|m| m.name() == "c"))
    }
}

// go/disabled_test.go TestSDKDisabledExportsNothing.
#[test]
fn a_disabled_sdk_exports_nothing() {
    for value in ["true", "TRUE", "True"] {
        let probe = probe(&[("OTEL_SDK_DISABLED", value)]);
        probe.exercise();
        assert!(probe.ended.spans().is_empty(), "{value}");
        assert!(probe.spans.spans().is_empty(), "{value}");
        assert!(!probe.metrics_collected(), "{value}");
        probe.sdk.shutdown().expect("shutdown");
    }
}

// go/injected_test.go TestSDKDisabledOwnsInjectedParts: what was injected
// is shut down, though it receives nothing.
#[test]
fn a_disabled_sdk_shuts_down_what_was_injected() {
    let probe = probe(&[("OTEL_SDK_DISABLED", "true")]);
    assert!(probe.spans.was_shut_down(), "the injected exporter");
    probe.sdk.shutdown().expect("shutdown");
}

// TestSDKDisabledKeepsPropagation.
#[test]
fn a_disabled_sdk_keeps_propagation() {
    let probe = probe(&[("OTEL_SDK_DISABLED", "true")]);
    let (cx, parent) = remote_parent();
    let span = probe.sdk.tracer("t").start_with_context("op", &cx);
    assert!(!span.is_recording());
    let cx = cx.with_span(span);
    let mut carrier = HashMap::new();
    probe.sdk.propagator().inject_context(&cx, &mut carrier);
    assert!(
        carrier["traceparent"].contains(&parent.trace_id().to_string()),
        "{carrier:?}"
    );
}

// TestSDKDisabledKeepsIdentityValidation.
#[test]
fn a_disabled_sdk_still_validates_identity() {
    let err = Sdk::builder()
        .environment(Environment::Test)
        .env_lookup(EnvLookup::from_pairs([("OTEL_SDK_DISABLED", "true")]))
        .build()
        .expect_err("no service name");
    assert!(matches!(err, Error::NoServiceName));
}

// TestSDKDisabledOtherValues.
#[test]
fn only_true_disables_the_sdk() {
    for value in ["false", "1", "yes", " true ", ""] {
        let probe = probe(&[("OTEL_SDK_DISABLED", value)]);
        probe.exercise();
        assert_eq!(probe.ended.spans().len(), 1, "{value:?}");
        assert!(probe.metrics_collected(), "{value:?}");
        probe.sdk.shutdown().expect("shutdown");
        assert_eq!(probe.spans.spans().len(), 1, "{value:?}");
    }
    let probe = {
        let ended = Ended::default();
        let sdk = Sdk::builder()
            .service_name("hermetic")
            .environment(Environment::Test)
            .env_lookup(EnvLookup::from_pairs([("OTEL_SDK_DISABLED", "true")]))
            .without_otel_env()
            .with_span_processor(ended.clone())
            .build()
            .expect("SDK");
        sdk.tracer("t").start("op").end();
        ended
    };
    assert_eq!(probe.spans().len(), 1, "hermetic mode ignores the variable");
}

// TestSDKDisabledWarnsOnUnrecognisedValue.
#[test]
fn an_unrecognised_value_warns_once() {
    for (value, warns) in [
        ("yes", 1),
        ("1", 1),
        (" true ", 1),
        ("true", 0),
        ("FALSE", 0),
        ("false", 0),
        ("", 0),
    ] {
        let probe = probe(&[("OTEL_SDK_DISABLED", value)]);
        let warnings = probe.warnings.lock().expect("lock").clone();
        assert_eq!(warnings.len(), warns, "{value:?}: {warnings:?}");
        if warns > 0 {
            assert_eq!(
                warnings[0],
                format!(
                    "o11y: OTEL_SDK_DISABLED={} is neither true nor false; the SDK stays enabled",
                    libo11y_spec::go_quote(value)
                )
            );
        }
    }
}

#[test]
fn the_propagators_come_from_the_variable() {
    let sdk = with_env(&quiet_and(&[("OTEL_PROPAGATORS", "baggage")]))
        .build()
        .expect("SDK");
    assert_eq!(
        opentelemetry::propagation::TextMapPropagator::fields(sdk.propagator()).collect::<Vec<_>>(),
        ["baggage"]
    );
    let err = with_env(&quiet_and(&[("OTEL_PROPAGATORS", "tracecontext,b3")]))
        .build()
        .expect_err("not shipped");
    assert!(matches!(err, Error::UnsupportedPropagator { .. }));
    let err = with_env(&quiet_and(&[("OTEL_PROPAGATORS", "bogus")]))
        .build()
        .expect_err("unknown");
    assert_eq!(
        err.to_string(),
        "o11y: building propagator: \"bogus\": unknown propagator: bogus"
    );
}
