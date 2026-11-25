//! Opinionated OpenTelemetry setup for Rust services, following the libo11y
//! specification.
//!
//! [`Sdk::builder`] takes the service identity, the sensitivity settings,
//! the application registries and the propagators, and builds an [`Sdk`]
//! that holds the telemetry resource, the sensitivity [`Policy`] and the
//! [`Propagator`] every signal shares.
//!
//! ```
//! use libo11y::{Environment, PiiMode, Sdk};
//!
//! let sdk = Sdk::builder()
//!     .service_name("checkout")
//!     .environment(Environment::Production)
//!     .build_info(libo11y::build_info!())
//!     .pii_mode(PiiMode::Drop)
//!     .without_otel_env()
//!     .build()?;
//! assert_eq!(sdk.resource().schema_url(), Some(libo11y_spec::SCHEMA_URL));
//! # Ok::<(), libo11y::Error>(())
//! ```

pub mod appregistry;
mod builder;
mod buildinfo;
mod canonical;
mod detect;
mod env;
mod error;
mod policy;
mod propagation;
mod resource;
mod sanitize;

pub use appregistry::AppRegistry;
pub use builder::{Builder, Sdk};
pub use buildinfo::BuildInfo;
pub use env::EnvLookup;
pub use error::{BoxError, Error};
pub use libo11y_spec::Environment;
pub use policy::{Classified, Decision, MIN_PII_HASH_KEY_LEN, PiiMode, Policy, Rule, Violations};
pub use propagation::{BoxedPropagator, Propagator};
