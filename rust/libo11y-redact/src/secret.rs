//! [`Secret`]: a value that never renders.

use std::fmt;

use crate::{Protected, Protection, REDACTED, Redact};

/// A value that must never appear in telemetry.
///
/// `Secret` renders as [`REDACTED`] through `Display`, `Debug` (plain and
/// `{:#?}`), `serde::Serialize`, and so through tracing's
/// `%` and `?` field sigils, and under every [`Protection`] floor. Formatting
/// flags such as a width are ignored, so the output is always the literal.
///
/// The wrapped value comes back only through the explicitly named
/// [`expose`](Self::expose), [`expose_mut`](Self::expose_mut) and
/// [`into_inner`](Self::into_inner), which keeps every read easy to audit.
/// `Secret` does not implement `Deref`, so a method call on it cannot reach
/// the value by accident.
///
/// ```
/// use libo11y_redact::Secret;
///
/// let token = Secret::new(String::from("sk-live-123"));
/// assert_eq!(format!("{token} {token:?}"), "REDACTED REDACTED");
/// assert_eq!(token.expose(), "sk-live-123");
/// ```
///
/// tracing's `Value` trait is sealed, so a `Secret` is recorded through
/// its `Display` or `Debug` with the `%` or `?` sigil. A bare
/// `tracing::info!(token = secret)` does not compile, which keeps the raw
/// value out of that path too:
///
/// ```
/// # let token = libo11y_redact::Secret::new("sk-live-123");
/// tracing::info!(token = %token, "authenticated"); // records token=REDACTED
/// ```
///
/// `Secret` implements neither `PartialEq` nor `Hash`. A derived comparison
/// is not constant-time, and comparing secrets with it invites timing
/// attacks: compare [`expose`](Self::expose)d values with a constant-time
/// comparison instead.
#[derive(Clone, Copy, Default)]
pub struct Secret<T>(T);

impl<T> Secret<T> {
    /// Wraps `value`.
    #[must_use]
    pub const fn new(value: T) -> Self {
        Self(value)
    }

    /// Returns a reference to the wrapped value.
    #[must_use]
    pub const fn expose(&self) -> &T {
        &self.0
    }

    /// Returns a mutable reference to the wrapped value.
    #[must_use]
    pub fn expose_mut(&mut self) -> &mut T {
        &mut self.0
    }

    /// Unwraps the value.
    #[must_use]
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> From<T> for Secret<T> {
    fn from(value: T) -> Self {
        Self(value)
    }
}

impl<T> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl<T> Redact for Secret<T> {
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Redacted
    }
}
