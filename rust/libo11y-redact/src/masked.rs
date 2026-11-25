//! [`Masked`]: a value that renders as its shape only.

use std::fmt;

use crate::private::char_count;
use crate::{Protected, Protection, Redact};

/// A value that renders as a run of `X`, one per character of its text,
/// preserving only its shape.
///
/// The text is the wrapped value's `Display` form, so a string, a number
/// or an address can be masked alike. Characters are Unicode scalar
/// values, which is Go's rune count: `"Jürgen"` masks to `XXXXXX`.
/// `Display` writes the mask, `Debug` writes it quoted as a string, and
/// `serde::Serialize` (feature `serde`) writes it as a string. Under a
/// [`Protection::Redact`] or stricter floor the value renders as
/// [`REDACTED`](crate::REDACTED). A `Display` implementation that fails or
/// panics renders `REDACTED` too.
///
/// ```
/// use libo11y_redact::Masked;
///
/// let card = Masked::new("4111111111111111");
/// assert_eq!(card.to_string(), "XXXXXXXXXXXXXXXX");
/// assert_eq!(format!("{card:?}"), r#""XXXXXXXXXXXXXXXX""#);
/// assert_eq!(*card.expose(), "4111111111111111");
/// ```
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Masked<T>(T);

impl<T> Masked<T> {
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

impl<T> From<T> for Masked<T> {
    fn from(value: T) -> Self {
        Self(value)
    }
}

impl<T: fmt::Display> Redact for Masked<T> {
    fn redact(&self, floor: Protection) -> Protected {
        if floor.hides_value() {
            return Protected::Redacted;
        }
        char_count(&self.0).map_or(Protected::Redacted, |n| Protected::Str("X".repeat(n)))
    }
}

impl<T: fmt::Display> fmt::Display for Masked<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.redact(Protection::Passthrough), f)
    }
}

impl<T: fmt::Display> fmt::Debug for Masked<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.redact(Protection::Passthrough), f)
    }
}
