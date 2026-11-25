//! The protection levels and the [`Redact`] trait.

use crate::Protected;

/// The literal that replaces a redacted value on every surface.
pub const REDACTED: &str = "REDACTED";

/// How strongly a value is protected, ordered from weakest to strictest.
///
/// The order is what makes the strictest protection win through nesting:
/// a value rendered under a floor is protected at least that much, so the
/// effective protection of a field is the maximum of its own tag and every
/// floor around it.
///
/// ```
/// use libo11y_redact::Protection;
///
/// assert_eq!(Protection::Mask.max(Protection::Redact), Protection::Redact);
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Protection {
    /// No protection: the value renders as itself, though nested values
    /// keep their own protection.
    #[default]
    Passthrough,
    /// A run of `X` with one `X` per character of the value's text,
    /// preserving only its shape. Nested values are masked at least.
    Mask,
    /// The literal [`REDACTED`] in place of the whole value.
    Redact,
    /// The field is absent. A value that cannot be absent, such as the
    /// value being rendered itself, renders as [`REDACTED`] instead.
    Omit,
}

impl Protection {
    /// Reports whether nothing of a value under this floor may render:
    /// true for [`Protection::Redact`] and [`Protection::Omit`].
    #[must_use]
    pub const fn hides_value(self) -> bool {
        matches!(self, Self::Redact | Self::Omit)
    }
}

/// A type that renders its protected form.
///
/// `redact` returns the value as a [`Protected`] tree with every protection
/// applied, under the `floor` the caller imposes: a value rendered under a
/// [`Protection::Mask`] floor masks every leaf it holds, and one under a
/// [`Protection::Redact`] or stricter floor renders as
/// [`Protected::Redacted`]. Stricter protections the value carries itself,
/// such as a [`Secret`](crate::Secret) field, are kept.
///
/// `#[derive(Redact)]` implements it, together with `Debug`, `Display` and
/// `serde::Serialize`, for structs and enums whose fields carry `o11y`
/// attributes. The crate implements it for [`Secret`](crate::Secret),
/// [`Masked`](crate::Masked), and the standard library's scalars, strings,
/// collections and smart pointers.
///
/// A hand-written implementation should honor the floor, and the derive
/// enforces it on the result regardless:
///
/// ```
/// use libo11y_redact::{Protected, Protection, Redact};
///
/// struct ApiKey(String);
///
/// impl Redact for ApiKey {
///     fn redact(&self, _floor: Protection) -> Protected {
///         Protected::Redacted
///     }
/// }
///
/// assert_eq!(ApiKey("sk-live".into()).redact(Protection::Passthrough), Protected::Redacted);
/// ```
pub trait Redact {
    /// Renders the protected form of `self` under `floor`.
    fn redact(&self, floor: Protection) -> Protected;
}
