//! Opinionated OpenTelemetry setup for Rust services, following the libo11y
//! specification.

mod canonical;
mod env;
mod error;
mod policy;
mod sanitize;

pub use env::EnvLookup;
pub use error::{BoxError, Error};
pub use policy::{Classified, Decision, MIN_PII_HASH_KEY_LEN, PiiMode, Policy, Rule, Violations};
