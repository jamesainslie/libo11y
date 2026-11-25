//! Opinionated OpenTelemetry setup for Rust services, following the libo11y
//! specification.

mod env;
mod error;
mod sanitize;

pub use env::EnvLookup;
pub use error::{BoxError, Error};
