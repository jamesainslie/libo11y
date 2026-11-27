//! Conformance assertion tests for [`libo11y_test::Recorder`].

use std::collections::HashMap;

use opentelemetry::logs::AnyValue;
use opentelemetry::trace::{Span as _, Tracer as _};
use opentelemetry::{Key, KeyValue};
use opentelemetry_sdk::trace::InMemorySpanExporter;

use libo11y::{AppRegistry, PiiMode};
use libo11y_spec::{Outcome, attr, event};
use libo11y_test::Recorder;

const HASH_KEY: [u8; 32] = [11; 32];

#[test]
fn clean_service_passes_conformance() {
    let rec = Recorder::start("clean-service");
    rec.in_scope(|| {
        let _span = tracing::info_span!("handle", http.request.method = "GET").entered();
        tracing::info!(safe = "v", "ok");
        rec.sdk().event(
            event::REQUEST_SUMMARY,
            [
                KeyValue::new("http.request.method", "GET"),
                KeyValue::new("http.response.status_code", 200_i64),
                KeyValue::new(attr::OUTCOME, Outcome::Success.as_str()),
                KeyValue::new(attr::DURATION, 0.01_f64),
            ],
        );
        // Unregistered event names have no contract and must pass.
        rec.sdk().event(
            "checkout.order.placed",
            [KeyValue::new("order.id", "ord-1")],
        );
    });

    assert_eq!(rec.check_conforms(), Ok(()));
    rec.assert_conforms();
}

#[test]
fn missing_tier0_resource_attributes_fail_conformance() {
    let rec = Recorder::start_with("temp", |b| {
        b.service_name("").environment("").without_strict_identity()
    })
    .expect("lax identity builds");

    let problems = rec
        .check_conforms()
        .expect_err("missing service.name and deployment.environment.name");
    let joined = problems.join("\n");
    assert!(
        joined.contains(r#"resource missing required tier-0 attribute "service.name""#),
        "{joined}"
    );
    assert!(
        joined.contains(
            r#"resource missing required tier-0 attribute "deployment.environment.name""#
        ),
        "{joined}"
    );
}

#[test]
fn secret_violations_on_traces_logs_and_resource_fail_conformance() {
    // 1. Secret in a log.
    let rec = Recorder::start("secret-log");
    rec.in_scope(|| {
        tracing::info!(
            http.request.header.authorization = "Bearer secret",
            "logged"
        );
    });
    let problems = rec.check_conforms().expect_err("secret log");
    let joined = problems.join("\n");
    assert!(
        joined.contains("emitted secret-classified attributes on logs"),
        "{joined}"
    );

    // 2. Secret on a span (processor-only path).
    let rec = Recorder::start("secret-span");
    let mut span = rec.sdk().tracer("t").start("op");
    span.set_attribute(KeyValue::new("http.request.header.cookie", "sid=123"));
    span.end();
    let problems = rec.check_conforms().expect_err("secret span");
    let joined = problems.join("\n");
    assert!(
        joined.contains("emitted secret-classified attributes on traces"),
        "{joined}"
    );

    // 3. Secret on an exported span (violations counted on batch export path
    //    and surfaced only after force_flush inside check_conforms).
    let exporter = InMemorySpanExporter::default();
    let rec = Recorder::start_with("secret-exported-span", |b| b.with_span_exporter(exporter))
        .expect("recorder");
    let mut span = rec.sdk().tracer("t").start("op");
    span.set_attribute(KeyValue::new("http.request.header.cookie", "sid=123"));
    span.end();
    let problems = rec.check_conforms().expect_err("exported secret span");
    let joined = problems.join("\n");
    assert!(
        joined.contains("emitted secret-classified attributes on traces"),
        "{joined}"
    );

    // 4. Secret on the resource (distinct message).
    let rec = Recorder::start_with("secret-resource", |b| {
        b.resource_attributes([KeyValue::new(
            "http.request.header.authorization",
            "Bearer secret",
        )])
    })
    .expect("recorder");
    let problems = rec.check_conforms().expect_err("secret resource");
    let joined = problems.join("\n");
    assert!(
        joined
            .contains("options passed to start put a secret-classified attribute on the resource"),
        "{joined}"
    );

    // 5. App-registry secret also fails via o11y.schema.violations.
    let app_yaml = r"
schema: libo11y.app-registry/v1
namespace: billing
attributes:
  billing.api.secret:
    type: string
    sensitivity: secret
    cardinality: unbounded
    brief: API secret.
";
    let registry =
        AppRegistry::from_bytes("billing.yaml", app_yaml.as_bytes()).expect("valid registry");
    let rec = Recorder::start_with("app-secret", |b| b.app_registry(registry)).expect("recorder");
    rec.in_scope(|| {
        tracing::info!(billing.api.secret = "sk_live_123", "charged");
    });
    let problems = rec.check_conforms().expect_err("app registry secret");
    assert!(
        problems
            .join("\n")
            .contains("emitted secret-classified attributes on logs"),
        "{problems:?}"
    );
}

#[test]
fn nested_dotted_secret_in_log_map_is_caught() {
    // Use an AttrReplacer to construct a nested AnyValue::Map mimicking a
    // grouped log structure `http` -> `request.header` -> `authorization`.
    let rec = Recorder::start_with("nested-secret", |b| {
        b.with_attr_replacer(|_groups, key, value| {
            if key.as_str() == "trigger" {
                let mut header = HashMap::new();
                header.insert(Key::from_static_str("authorization"), value);
                let mut req = HashMap::new();
                req.insert(
                    Key::from_static_str("request.header"),
                    AnyValue::Map(Box::new(header)),
                );
                Some((Key::from_static_str("http"), AnyValue::Map(Box::new(req))))
            } else {
                Some((key, value))
            }
        })
    })
    .expect("recorder");

    rec.in_scope(|| {
        tracing::info!(trigger = "Bearer nested-secret", "nested");
    });

    // The secret was stripped from the captured log record AND counted as a
    // secret violation on logs.
    assert!(rec.logs()[0].attr("http").is_none());
    let problems = rec.check_conforms().expect_err("nested secret in log map");
    assert!(
        problems
            .join("\n")
            .contains("emitted secret-classified attributes on logs"),
        "{problems:?}"
    );
}

#[test]
fn pii_violations_do_not_fail_conformance() {
    for mode in [PiiMode::Drop, PiiMode::Hash, PiiMode::Allow] {
        let rec = Recorder::start_with("pii-ok", |b| {
            b.pii_mode(mode)
                .pii_hash_key(HASH_KEY)
                .resource_attributes([KeyValue::new("host.ip", "10.0.0.1")])
        })
        .expect("recorder");

        rec.in_scope(|| {
            let _span = tracing::info_span!("op", host.ip = "10.0.0.2").entered();
            tracing::info!(host.ip = "10.0.0.3", "pii logged");
        });

        assert_eq!(
            rec.check_conforms(),
            Ok(()),
            "PII must not fail conformance under {mode:?}"
        );
    }
}

#[test]
fn registered_event_contract_checks_required_and_template_attributes() {
    // Missing required attributes on o11y.request.summary.
    let rec = Recorder::start("event-missing-req");
    rec.sdk().event(
        event::REQUEST_SUMMARY,
        [KeyValue::new("http.request.method", "GET")],
    );
    let problems = rec.check_conforms().expect_err("missing required attrs");
    let joined = problems.join("\n");
    assert!(
        joined.contains(
            "event o11y.request.summary: missing required attribute http.response.status_code"
        ),
        "{joined}"
    );
    assert!(
        joined.contains("event o11y.request.summary: missing required attribute o11y.outcome"),
        "{joined}"
    );
    assert!(
        joined.contains("event o11y.request.summary: missing required attribute o11y.duration"),
        "{joined}"
    );

    // Missing template attribute on o11y.telemetry.configured.
    let rec = Recorder::start("event-missing-tmpl");
    rec.sdk().event(event::TELEMETRY_CONFIGURED, []);
    let problems = rec.check_conforms().expect_err("missing template attr");
    let joined = problems.join("\n");
    assert!(
        joined.contains(
            "event o11y.telemetry.configured: missing required template attribute o11y.config.<key>"
        ),
        "{joined}"
    );

    // Bare template prefix ("o11y.config.") must NOT satisfy the template.
    let rec = Recorder::start("event-bare-tmpl");
    rec.sdk().event(
        event::TELEMETRY_CONFIGURED,
        [
            KeyValue::new("o11y.config", "x"),
            KeyValue::new("o11y.config.", "y"),
        ],
    );
    let problems = rec
        .check_conforms()
        .expect_err("bare prefix must not satisfy template");
    assert!(
        problems.join("\n").contains(
            "event o11y.telemetry.configured: missing required template attribute o11y.config.<key>"
        ),
        "{problems:?}"
    );

    // Concrete template key satisfies the contract.
    let rec = Recorder::start("event-valid-tmpl");
    rec.sdk().event(
        event::TELEMETRY_CONFIGURED,
        [KeyValue::new("o11y.config.traces", "none")],
    );
    assert_eq!(rec.check_conforms(), Ok(()));
}

#[test]
#[should_panic(expected = "conformance checks failed:")]
fn assert_conforms_panics_on_violation() {
    let rec = Recorder::start("panic-conforms");
    rec.in_scope(|| {
        tracing::info!(http.request.header.authorization = "Bearer x", "bad");
    });
    rec.assert_conforms();
}
