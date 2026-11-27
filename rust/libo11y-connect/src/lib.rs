//! OpenTelemetry tracing, metrics, and canonical log line instrumentation for
//! `connectrpc` servers and clients, following the libo11y specification and
//! OpenTelemetry RPC semantic conventions (v1.41.0).
//!
//! All constructors take an explicit [`libo11y::Sdk`] handle and never read
//! process globals:
//!
//! - [`ServerInterceptor`] implements [`connectrpc::Interceptor`] for direct
//!   use with `ConnectRpcService::with_interceptor`.
//! - [`ServerLayer`] wraps a `ConnectRpcService` (or any HTTP Tower service)
//!   at the Tower layer boundary.
//! - [`ClientLayer`] wraps a client Tower service or wraps any
//!   [`connectrpc::client::ClientTransport`] via
//!   [`ClientLayer::wrap_transport`].
//!
//! ```no_run
//! use libo11y::{Environment, Sdk};
//! use libo11y_connect::{ClientLayer, ServerInterceptor, ServerLayer};
//!
//! # fn example() -> Result<(), libo11y::Error> {
//! let sdk = Sdk::builder()
//!     .service_name("checkout")
//!     .environment(Environment::Test)
//!     .without_otel_env()
//!     .build()?;
//!
//! let interceptor = ServerInterceptor::new(&sdk)
//!     .with_ignore_health_checks()
//!     .with_canonical_line();
//! let server_layer = ServerLayer::new(&sdk).with_public_endpoint();
//! let client_layer = ClientLayer::new(&sdk).with_ignore_health_checks();
//! # let _ = (interceptor, server_layer, client_layer);
//! # Ok(())
//! # }
//! ```

mod body;
mod canonical;
mod interceptor;
mod layer;
mod semconv;

pub use body::{InstrumentedBody, ResponseFuture};
pub use interceptor::ServerInterceptor;
pub use layer::{
    ClientLayer, ClientService, InstrumentedTransport, MethodFilter, ServerLayer, ServerService,
};
