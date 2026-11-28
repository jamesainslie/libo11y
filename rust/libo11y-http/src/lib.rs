//! Tower HTTP server and client instrumentation layers for [`libo11y`].
//!
//! Both [`ServerLayer`] and [`ClientLayer`] bind explicitly to a
//! [`libo11y::Sdk`] handle without relying on process globals, follow
//! OpenTelemetry HTTP semantic conventions 1.41.0, and record HTTP duration
//! histograms through the SDK's exemplar-aware meter.
//!
//! # Server instrumentation
//!
//! ```
//! use libo11y::{Environment, Sdk};
//! use libo11y_http::ServerLayer;
//!
//! let sdk = Sdk::builder()
//!     .service_name("orders")
//!     .environment(Environment::Test)
//!     .without_otel_env()
//!     .build()?;
//!
//! let layer = ServerLayer::new(&sdk)
//!     .with_ignore_paths(["/healthz", "/debug/*"])
//!     .with_canonical_line();
//! # let _ = layer;
//! # Ok::<(), libo11y::Error>(())
//! ```
//!
//! Enable the optional `axum` Cargo feature to extract route templates from
//! `axum::extract::MatchedPath` automatically when no custom route extractor
//! matches.

mod carrier;
mod client;
mod error_type;
mod method;
mod path_match;
mod server;
mod url;

pub use carrier::{HeaderExtractor, HeaderInjector};
pub use client::{ClientFuture, ClientLayer, ClientService};
pub use method::{METHOD_OTHER, default_span_name, normalize_method, route_only, span_method};
pub use path_match::path_match;
pub use server::{ServerBody, ServerFuture, ServerLayer, ServerService};
pub use url::{
    extract_scheme, extract_server_address_port, percent_decode_or_raw, redact_query,
    sanitize_url_full, strip_ipv6_brackets,
};

/// Instrumentation scope name for meters and tracers created by `libo11y-http`.
pub const SCOPE_NAME: &str = "libo11y-http";

/// Explicit advisory histogram bucket boundaries (in seconds) for
/// `http.server.request.duration` and `http.client.request.duration` per
/// OpenTelemetry HTTP semantic conventions 1.41.0.
pub const HTTP_DURATION_BOUNDARIES: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];
