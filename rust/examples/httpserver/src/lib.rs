//! Complete, tested HTTP service demonstrating [`libo11y`] with `axum`.
//!
//! Shows:
//! - Application attribute registry validation (`o11y-registry.yaml`)
//! - Capture-time redaction via `#[derive(libo11y::redact::Redact)]`
//! - Compile-time build metadata via [`libo11y::build_info!`]
//! - Route-aware HTTP server instrumentation via [`libo11y_http::ServerLayer`]
//!   with canonical request summaries (`o11y.request.summary`) and ignored
//!   health checks (`/healthz`)
//! - Wide-event enrichment via [`libo11y::record_from_context`]

use axum::Router;
use axum::extract::Path;
use axum::routing::get;
use libo11y::opentelemetry::Context as OtelContext;
use libo11y::redact::Redact;
use libo11y::{AppRegistry, Error, Sdk, record_from_context};
use libo11y_http::ServerLayer;

/// Embedded application attribute registry validated at startup.
pub const APP_REGISTRY_YAML: &str = include_str!("../o11y-registry.yaml");

/// User record demonstrating capture-time redaction: `email` renders masked
/// (`XXXX...`) and `token` renders as `REDACTED` on every `Display`, `Debug`,
/// and `tracing` surface.
#[derive(Redact)]
pub struct UserProfile {
    /// Non-sensitive identifier shown in the clear.
    pub id: String,
    /// PII field masked at capture time.
    #[o11y(mask)]
    pub email: String,
    /// Secret credential redacted at capture time.
    #[o11y(redact)]
    pub token: String,
}

/// Parses and validates the example's embedded `o11y-registry.yaml`.
///
/// # Errors
///
/// Returns a [`libo11y::Error`] if the YAML fails to decode or breaks any
/// registry rule.
pub fn load_registry() -> Result<AppRegistry, Error> {
    AppRegistry::from_bytes("o11y-registry.yaml", APP_REGISTRY_YAML.as_bytes())
}

/// Builds the instrumented `axum::Router` bound to `sdk`.
pub fn app(sdk: &Sdk) -> Router {
    let layer = ServerLayer::new(sdk)
        .with_canonical_line()
        .with_ignore_paths(["/healthz"]);

    Router::new()
        .route("/users/{id}", get(get_user))
        .route("/healthz", get(healthz))
        .layer(layer)
}

async fn get_user(Path(id): Path<String>) -> String {
    let profile = UserProfile {
        id: id.clone(),
        email: "alice@example.com".to_owned(),
        token: "super-secret-token".to_owned(),
    };

    // Correlated with the active HTTP server span:
    // `user` renders masked email + REDACTED token via `#[derive(Redact)]`.
    // Sensitive fields are protected at capture time rather than logged under
    // secret or PII keys.
    tracing::info!(
        user = %profile,
        demo.user.id = %profile.id,
        "serving user",
    );

    // Enrich the request's canonical `o11y.request.summary` wide event.
    let record = record_from_context(&OtelContext::current());
    record.set("demo.user.id", id.clone());
    record.set("demo.user.found", true);

    format!("hello, user {id}\n")
}

async fn healthz() -> &'static str {
    "ok\n"
}
