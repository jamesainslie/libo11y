//! Capture-time redaction for libo11y.
//!
//! Sensitive values are protected by their type, so they render protected
//! wherever they are logged, on every surface: `Debug`, `Display`,
//! `serde::Serialize`, and tracing fields recorded with `%` or `?`. This is
//! the first of libo11y's three redaction layers. The emit-time replacer
//! and the key-based sensitivity policy of the `libo11y` crate catch what
//! reaches telemetry under a classified key. A value typed as a secret
//! stays protected even under a key no policy classifies.
//!
//! Three protections exist, from weakest to strictest ([`Protection`]):
//!
//! - mask: a run of `X` of equal character count, preserving only the
//!   value's shape ([`Masked`]);
//! - redact: the literal [`REDACTED`] ([`Secret`]);
//! - omit: the field is absent.
//!
//! ```
//! use libo11y_redact::{Masked, Secret};
//!
//! let token = Secret::new("sk-live-123");
//! let card = Masked::new("4111111111111111");
//! assert_eq!(format!("{token} {card}"), "REDACTED XXXXXXXXXXXXXXXX");
//! ```
//!
//! # Features
//!
//! - `serde` (default): `serde::Serialize` for [`Secret`], [`Masked`] and
//!   [`Protected`], writing the protected form.

mod masked;
mod private;
mod protected;
mod protection;
mod secret;
#[cfg(feature = "serde")]
mod serialize;
mod values;

pub use masked::Masked;
pub use protected::{Fields, Protected, Record, Variant};
pub use protection::{Protection, REDACTED, Redact};
pub use secret::Secret;
