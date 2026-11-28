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
//! # Deriving `Redact`
//!
//! `#[derive(Redact)]` protects the fields of a struct or enum through
//! `o11y` attributes, and implements [`Redact`], `Debug`, `Display` and
//! `serde::Serialize`, all rendering the protected form. Do not also
//! derive `Debug` or `serde::Serialize`: the derive provides them, and two
//! implementations do not compile, so no surface can print a protected
//! field in the clear.
//!
//! ```
//! use libo11y_redact::Redact;
//!
//! #[derive(Redact)]
//! struct Payment {
//!     #[o11y(mask)]
//!     card: String,
//!     #[o11y(redact)]
//!     cvv: String,
//!     #[o11y(omit)]
//!     pin: String,
//!     merchant: String,
//! }
//!
//! let p = Payment {
//!     card: "4111".into(),
//!     cvv: "123".into(),
//!     pin: "9".into(),
//!     merchant: "acme".into(),
//! };
//! assert_eq!(p.to_string(), "{card:XXXX cvv:REDACTED merchant:acme}");
//! assert_eq!(format!("{p:?}"), r#"Payment { card: "XXXX", cvv: REDACTED, merchant: "acme" }"#);
//! assert_eq!(
//!     serde_json::to_string(&p).unwrap(),
//!     r#"{"card":"XXXX","cvv":"REDACTED","merchant":"acme"}"#,
//! );
//! tracing::info!(payment = %p, "charged"); // records the Display form
//! # assert_eq!(p.pin, "9");
//! ```
//!
//! The attribute values are `mask`, `redact`, `omit`, and the two synonyms
//! from the specification's sensitivity vocabulary: `confidential` masks
//! and `secret` redacts. Any other value, such as a misspelt `sercet`,
//! fails closed to redact and raises a `deprecated` warning at compile
//! time that names the field. Several values on one field combine to the
//! strictest.
//!
//! The strictest protection in scope wins through nesting. A field renders
//! under the strictest of its own attribute and every floor around it: a
//! masked field's nested struct masks every leaf but keeps its own
//! redacted fields `REDACTED`, and a redacted field hides everything it
//! holds. Protection follows values into `Option`, `Box`, `Vec`, maps,
//! tuples and the other standard containers. An attribute on the type or
//! on an enum variant is a floor over all of its fields. Under a mask
//! floor, which variant an enum value is counts as data and is hidden too
//! (see [`Protected::at_floor`]).
//!
//! A field renders through the most capable rendering its type has:
//!
//! 1. its own [`Redact`], derived or hand-written, which keeps its
//!    structure and its own protections;
//! 2. otherwise its `Display` text, as Go renders a `fmt.Stringer`;
//! 3. otherwise its `Debug` text.
//!
//! An `Option` of a type with only `Display` or `Debug` renders `None` as
//! null and `Some` as the text. A redacted or omitted field is never
//! rendered, so its type needs none of these.
//!
//! A `Display` or `Debug` text is trusted as written. Go's `redact.Struct`
//! inspects a `fmt.Stringer` or an `error` by reflection and renders it
//! `REDACTED` when anything inside it carries a tag. Rust has no
//! reflection, so a hand-written `Display` that formats a raw secret, such
//! as an error type whose message includes a token, renders that secret.
//! Give such a type a [`Redact`] implementation, or derive it, so its
//! fields are protected wherever it is formatted. A text rendering whose
//! `Display` or `Debug` returns an error or panics renders `REDACTED`.
//! The panic still reaches the panic hook, which prints its message, and
//! under `panic = "abort"` the process aborts.
//!
//! In a generic type, every rendered field whose type mentions a type
//! parameter is bound by `Redact` as a whole: `Wrap<T>: Redact`,
//! `T::Output: Redact`, `Vec<T>: Redact`. Such a field therefore always
//! renders through its own `Redact` and never falls back to a text form,
//! and the derived impls apply exactly when every such field type has one.
//! `Secret<T>` and `PhantomData<T>` satisfy the bound for any `T`. A
//! redacted or omitted field is never rendered and adds no bound. A field
//! whose type names the deriving type itself, such as
//! `Option<Box<Node<T>>>` or `Vec<Self>`, adds no bound either, so a
//! recursive generic type derives without overflowing the trait solver,
//! and the field renders through the impl being derived.
//!
//! Each derived value, collection and pointer counts one level of
//! nesting, and past 32 levels the rest renders `REDACTED` instead of
//! recursing without bound. That covers a cycle through `Rc` and
//! `RefCell`, and it means a linked list of `Option<Box<Self>>` nodes
//! renders about 16 nodes, since each node and each box count once.
//!
//! The expansion names this crate as `::libo11y_redact`. A crate that
//! re-exports it under another path says so on the type with
//! `#[o11y(crate = "path::to::redact")]`.
//!
//! `serde` is a required dependency rather than a feature: with an
//! optional `Serialize`, a type could derive serde's own `Serialize` beside
//! `Redact` and print every field in the clear in JSON. Users of the derive
//! need no serde dependency of their own.

mod masked;
mod private;
mod protected;
mod protection;
mod secret;
mod serialize;
mod values;

pub use masked::Masked;
pub use protected::{Fields, Protected, Record, Variant};
pub use protection::{Protection, REDACTED, Redact};
pub use secret::Secret;

#[doc(inline)]
pub use libo11y_macros::Redact;

/// The runtime the code `#[derive(Redact)]` generates calls. Not public
/// API: it may change in any release, and only the derive may use it.
#[doc(hidden)]
pub mod __private {
    pub use crate::private::{
        DepthGuard, Probe, RenderDebug, RenderDisplay, RenderOptionDebug, RenderOptionDisplay,
        RenderRedact, enter,
    };
    pub use serde;
    pub use std::boxed::Box;
    pub use std::vec;
}

/// Compile-time guarantees, pinned as `compile_fail` doc tests.
///
/// An unknown attribute value warns, so `deny(deprecated)` rejects it:
///
/// ```compile_fail
/// #![deny(deprecated)]
/// #[derive(libo11y_redact::Redact)]
/// struct Bad {
///     #[o11y(sercet)]
///     token: String,
/// }
/// ```
///
/// The same type compiles, and fails closed, once the warning is allowed:
///
/// ```
/// #![allow(deprecated)]
/// #[derive(libo11y_redact::Redact)]
/// struct Bad {
///     #[o11y(sercet)]
///     token: String,
/// }
/// assert_eq!(Bad { token: "t".into() }.to_string(), "{token:REDACTED}");
/// ```
///
/// A derived type cannot also derive the surfaces in the clear:
///
/// ```compile_fail,E0119
/// #[derive(libo11y_redact::Redact, Debug)]
/// struct Twice {
///     #[o11y(secret)]
///     token: String,
/// }
/// ```
///
/// A rendered field must have a rendering, while a redacted one need not:
///
/// ```compile_fail,E0599
/// struct Opaque;
/// #[derive(libo11y_redact::Redact)]
/// struct Holder {
///     value: Opaque,
/// }
/// ```
///
/// ```
/// struct Opaque;
/// #[derive(libo11y_redact::Redact)]
/// struct Holder {
///     #[o11y(secret)]
///     value: Opaque,
/// }
/// assert_eq!(Holder { value: Opaque }.to_string(), "{value:REDACTED}");
/// ```
///
/// A union has no field known to be live, so it cannot derive `Redact`:
///
/// ```compile_fail
/// #[derive(libo11y_redact::Redact)]
/// union Bits {
///     a: u32,
///     b: f32,
/// }
/// ```
///
/// A `Secret` has no `Deref`, and tracing cannot record it without a sigil:
///
/// ```compile_fail,E0599
/// let token = libo11y_redact::Secret::new(String::from("sk-live"));
/// let _ = token.len();
/// ```
///
/// ```compile_fail,E0277
/// let token = libo11y_redact::Secret::new("sk-live");
/// tracing::info!(token = token);
/// ```
///
/// Secrets cannot be compared with `==`, which would not be constant-time:
///
/// ```compile_fail,E0369
/// let a = libo11y_redact::Secret::new("x");
/// let _ = a == libo11y_redact::Secret::new("x");
/// ```
///
/// A malformed `crate` path is an error rather than a guess:
///
/// ```compile_fail
/// #[derive(libo11y_redact::Redact)]
/// #[o11y(crate = 5)]
/// struct Holder {
///     name: String,
/// }
/// ```
#[cfg(doctest)]
pub struct CompileTests;

/// The README's examples, compiled and run as doc tests.
#[doc = include_str!("../README.md")]
#[cfg(doctest)]
pub struct ReadmeDoctests;
