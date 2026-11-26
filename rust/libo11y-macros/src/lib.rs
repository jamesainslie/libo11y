//! The `#[derive(Redact)]` procedural macro of libo11y.
//!
//! Depend on [`libo11y-redact`](https://docs.rs/libo11y-redact), which
//! re-exports the derive together with the runtime it expands to, rather
//! than on this crate directly. The derive's documentation lives on
//! `libo11y_redact::Redact`.

mod attr;
mod expand;

use proc_macro::TokenStream;
use syn::{DeriveInput, Path, parse_macro_input, parse_quote};

/// Derives `Redact`, `Debug`, `Display` and `serde::Serialize` for a
/// struct or enum, each rendering the protected form its `o11y` field
/// attributes declare.
///
/// Field attributes: `#[o11y(mask)]`, `#[o11y(redact)]`, `#[o11y(omit)]`,
/// `#[o11y(confidential)]` (mask) and `#[o11y(secret)]` (redact). Any
/// other value fails closed to redact and raises a `deprecated` warning.
/// The strictest protection in scope wins through nesting, and an
/// attribute on the type or on a variant is a floor over its fields.
///
/// The expansion names the runtime through `::libo11y_redact`, or the path
/// a container `#[o11y(crate = "...")]` attribute gives. The
/// `libo11y_redact` crate documentation, section "Deriving `Redact`",
/// describes the rendering in full, with examples.
#[proc_macro_derive(Redact, attributes(o11y))]
pub fn derive_redact(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand_with(&input, &parse_quote!(::libo11y_redact))
}

/// The derive as the `libo11y` crate re-exports it: identical to
/// [`derive_redact`] except that the expansion names the runtime through
/// `::libo11y::redact`, so a crate that depends only on `libo11y` can use
/// it. `libo11y` re-exports it as `libo11y::redact::Redact`.
#[doc(hidden)]
#[proc_macro_derive(__RedactInLibo11y, attributes(o11y))]
pub fn derive_redact_in_libo11y(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    expand_with(&input, &parse_quote!(::libo11y::redact))
}

fn expand_with(input: &DeriveInput, krate: &Path) -> TokenStream {
    expand::derive(input, krate)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}
