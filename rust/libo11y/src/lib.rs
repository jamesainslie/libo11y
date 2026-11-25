//! Opinionated OpenTelemetry setup for Rust services, following the libo11y
//! specification.

pub mod appregistry;
mod canonical;
mod env;
mod error;
mod policy;
mod propagation;
mod sanitize;

pub use appregistry::AppRegistry;
pub use env::EnvLookup;
pub use error::{BoxError, Error};
pub use policy::{Classified, Decision, MIN_PII_HASH_KEY_LEN, PiiMode, Policy, Rule, Violations};
pub use propagation::{BoxedPropagator, Propagator};
