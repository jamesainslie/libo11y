//! Integration tests for `httpserver-example` using [`libo11y_test::Recorder`].

use std::path::PathBuf;

use http::{Method, Request, StatusCode};
use http_body_util::BodyExt as _;
use libo11y::AppRegistry;
use libo11y_spec::event;
use libo11y_test::Recorder;
use tower::ServiceExt as _;
use tracing::instrument::WithSubscriber as _;

#[test]
fn app_registry_file_is_valid() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("o11y-registry.yaml");
    let from_disk = AppRegistry::from_path(&path).expect("o11y-registry.yaml is valid");
    let embedded = httpserver_example::load_registry().expect("embedded registry is valid");
    assert_eq!(from_disk.namespace(), "demo");
    assert_eq!(embedded.namespace(), "demo");
}

#[tokio::test]
async fn httpserver_records_route_canonical_line_redaction_and_triangle() {
    let registry = httpserver_example::load_registry().expect("valid registry");
    let rec = Recorder::start_with("httpserver-example", |builder| {
        builder
            .build_info(libo11y::build_info!())
            .app_registry(registry)
    })
    .expect("start recorder");

    let app = httpserver_example::app(rec.sdk());

    async {
        let user_resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/users/42")
                    .body(axum::body::Body::empty())
                    .expect("build user request"),
            )
            .await
            .expect("call /users/42");
        assert_eq!(user_resp.status(), StatusCode::OK);
        let body = user_resp
            .into_body()
            .collect()
            .await
            .expect("collect body")
            .to_bytes();
        assert_eq!(body.as_ref(), b"hello, user 42\n");

        let health_resp = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/healthz")
                    .body(axum::body::Body::empty())
                    .expect("build health request"),
            )
            .await
            .expect("call /healthz");
        assert_eq!(health_resp.status(), StatusCode::OK);
    }
    .with_subscriber(rec.sdk().subscriber())
    .await;

    // Only /users/42 was instrumented; /healthz was ignored.
    let spans = rec.spans();
    assert_eq!(spans.len(), 1, "expected 1 span, got {spans:?}");
    assert_eq!(spans[0].name.as_ref(), "GET /users/{id}");
    assert!(
        spans[0]
            .attributes
            .iter()
            .any(|kv| kv.key.as_str() == "http.route" && kv.value.as_str() == "/users/{id}")
    );

    // Logs contain the handler log and the canonical o11y.request.summary line.
    let logs = rec.logs();
    let handler_log = logs
        .iter()
        .find(|l| l.message() == "serving user")
        .expect("handler log present");

    // Capture-time redaction protected email (masked) and token (REDACTED).
    let user_field = handler_log.attr_str("user").expect("user field present");
    assert!(user_field.contains("42"), "{user_field}");
    assert!(user_field.contains("REDACTED"), "{user_field}");
    assert!(user_field.contains("XXXXX"), "{user_field}");
    assert!(!user_field.contains("alice@example.com"), "{user_field}");
    assert!(!user_field.contains("super-secret-token"), "{user_field}");

    // Internal app-registry attribute passes through cleanly.
    assert_eq!(handler_log.attr_str("demo.user.id").as_deref(), Some("42"));

    // Canonical summary line carries route and record_from_context enrichments.
    let summary = logs
        .iter()
        .find(|l| l.event_name() == Some(event::REQUEST_SUMMARY))
        .expect("canonical o11y.request.summary present");
    assert_eq!(
        summary.attr_str("http.route").as_deref(),
        Some("/users/{id}")
    );
    assert_eq!(summary.attr_str("demo.user.id").as_deref(), Some("42"));
    assert_eq!(summary.attr_str("demo.user.found").as_deref(), Some("true"));

    // Full three-signal conformance, log-to-trace correlation, and exemplar triangle.
    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("http.server.request.duration");
}

#[test]
fn app_registry_policy_drops_pii_and_secret_attributes() {
    let registry = httpserver_example::load_registry().expect("valid registry");
    let rec = Recorder::start_with("httpserver-policy", |builder| {
        builder.app_registry(registry)
    })
    .expect("start recorder");

    rec.in_scope(|| {
        tracing::info!(
            demo.user.id = "42",
            demo.user.email = "alice@example.com",
            demo.user.token = "super-secret-token",
            "policy check",
        );
    });

    let logs = rec.logs();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].attr_str("demo.user.id").as_deref(), Some("42"));
    assert_eq!(logs[0].attr("demo.user.email"), None);
    assert_eq!(logs[0].attr("demo.user.token"), None);
}
