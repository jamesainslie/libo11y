//! OpenTelemetry tracing and metrics Tower layers for `tonic` gRPC servers and
//! clients, following the libo11y specification and OpenTelemetry RPC semantic
//! conventions (v1.41.0).
//!
//! Both [`ServerLayer`] and [`ClientLayer`] bind explicitly to a [`libo11y::Sdk`]
//! handle and never read process globals. They operate on standard
//! `http::Request` / `http::Response` Tower services so they plug directly into
//! `tonic::transport::Server::builder().layer(...)` and
//! `tower::ServiceBuilder::new().layer(...).service(channel)`.
//!
//! ```no_run
//! use libo11y::{Environment, Sdk};
//! use libo11y_tonic::{ClientLayer, ServerLayer};
//!
//! # fn example() -> Result<(), libo11y::Error> {
//! let sdk = Sdk::builder()
//!     .service_name("checkout")
//!     .environment(Environment::Test)
//!     .without_otel_env()
//!     .build()?;
//!
//! let server_layer = ServerLayer::new(&sdk)
//!     .with_ignore_health_checks()
//!     .with_public_endpoint();
//! let client_layer = ClientLayer::new(&sdk).with_ignore_health_checks();
//! # let _ = (server_layer, client_layer);
//! # Ok(())
//! # }
//! ```

mod body;
mod error;
mod layer;
mod semconv;

pub use body::{InstrumentedBody, ResponseFuture};
pub use layer::{ClientLayer, ClientService, MethodFilter, ServerLayer, ServerService};
