//! Parsing of the `o11y` helper attribute.
//!
//! The vocabulary is closed: `mask`, `redact`, `omit`, and the synonyms
//! `confidential` (mask) and `secret` (redact), plus `crate = "path"` on
//! the container. Anything else is unknown and fails closed to redact, as
//! Go's struct tags do, and is reported as a compile-time warning, so a
//! typo such as `sercet` is both safe and visible. Several attributes, or
//! several values in one, combine to the strictest.

use proc_macro2::{Span, TokenTree};
use syn::spanned::Spanned;
use syn::{Attribute, LitStr, Meta, Path, Token};

/// The helper attribute's name.
const ATTR: &str = "o11y";

/// A protection level, ordered from weakest to strictest like
/// `libo11y_redact::Protection`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Level {
    #[default]
    Passthrough,
    Mask,
    Redact,
    Omit,
}

impl Level {
    /// Maps one attribute value to its level, or `None` when the value is
    /// not part of the vocabulary.
    fn from_value(value: &str) -> Option<Self> {
        match value {
            "mask" | "confidential" => Some(Self::Mask),
            "redact" | "secret" => Some(Self::Redact),
            "omit" => Some(Self::Omit),
            _ => None,
        }
    }

    /// Reports whether nothing of a value at this level renders.
    pub(crate) fn hides_value(self) -> bool {
        self >= Self::Redact
    }
}

/// An attribute value outside the vocabulary.
pub(crate) struct Unknown {
    /// Where the warning points.
    pub(crate) span: Span,
    /// The attribute as written, for the warning's text.
    pub(crate) text: String,
}

/// What the `o11y` attributes on one item declare.
#[derive(Default)]
pub(crate) struct Declared {
    /// The strictest protection declared, unknown values counting as
    /// redact.
    pub(crate) level: Level,
    /// The `crate = "path"` override, on a container only.
    pub(crate) krate: Option<Path>,
    /// Values outside the vocabulary.
    pub(crate) unknown: Vec<Unknown>,
}

impl Declared {
    fn raise(&mut self, level: Level) {
        self.level = self.level.max(level);
    }

    fn unknown(&mut self, span: Span, text: String) {
        self.raise(Level::Redact);
        self.unknown.push(Unknown { span, text });
    }
}

/// Where an attribute sits, which decides whether `crate = "path"` is
/// accepted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Site {
    Container,
    Member,
}

/// Parses every `o11y` attribute in `attrs`.
///
/// Only a malformed `crate = "path"` is an error: every other mistake
/// fails closed to redact and is recorded in [`Declared::unknown`].
pub(crate) fn parse(attrs: &[Attribute], site: Site) -> syn::Result<Declared> {
    let mut declared = Declared::default();
    for attr in attrs.iter().filter(|attr| attr.path().is_ident(ATTR)) {
        let Meta::List(list) = &attr.meta else {
            declared.unknown(attr.path().span(), render(&attr.meta));
            continue;
        };
        if list.tokens.is_empty() {
            declared.unknown(attr.path().span(), render(&attr.meta));
            continue;
        }
        let mut crate_error = None;
        let parsed = attr.parse_nested_meta(|meta| {
            if site == Site::Container && meta.path.is_ident("crate") {
                let path = meta
                    .value()
                    .and_then(syn::parse::ParseBuffer::parse::<LitStr>)
                    .and_then(|lit| lit.parse::<Path>());
                match path {
                    Ok(path) => declared.krate = Some(path),
                    Err(err) => crate_error = Some(err),
                }
                return skip_to_comma(meta.input);
            }
            let ends = meta.input.is_empty() || meta.input.peek(Token![,]);
            let level = meta
                .path
                .get_ident()
                .and_then(|ident| Level::from_value(&ident.to_string()));
            match level {
                Some(level) if ends => declared.raise(level),
                _ => declared.unknown(meta.path.span(), render(&attr.meta)),
            }
            skip_to_comma(meta.input)
        });
        if let Some(err) = crate_error {
            return Err(err);
        }
        if parsed.is_err() {
            declared.unknown(attr.path().span(), render(&attr.meta));
        }
    }
    Ok(declared)
}

/// Consumes the rest of one attribute value, whatever it is, so the next
/// value still parses.
fn skip_to_comma(input: syn::parse::ParseStream<'_>) -> syn::Result<()> {
    while !input.is_empty() && !input.peek(Token![,]) {
        input.parse::<TokenTree>()?;
    }
    Ok(())
}

/// Renders an attribute's meta as the user wrote it, near enough for a
/// warning: `#[o11y(encrypt)]`.
fn render(meta: &Meta) -> String {
    match meta {
        Meta::List(list) => format!("#[{ATTR}({})]", list.tokens).replace(" ,", ","),
        Meta::Path(_) => format!("#[{ATTR}]"),
        Meta::NameValue(nv) => {
            let value = &nv.value;
            format!("#[{ATTR} = {}]", quote::quote!(#value))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use syn::parse_quote;

    fn declared(attrs: &[Attribute]) -> Declared {
        parse(attrs, Site::Member).unwrap()
    }

    #[test]
    fn vocabulary_maps_to_levels() {
        let cases: [(Attribute, Level); 5] = [
            (parse_quote!(#[o11y(mask)]), Level::Mask),
            (parse_quote!(#[o11y(confidential)]), Level::Mask),
            (parse_quote!(#[o11y(redact)]), Level::Redact),
            (parse_quote!(#[o11y(secret)]), Level::Redact),
            (parse_quote!(#[o11y(omit)]), Level::Omit),
        ];
        for (attr, want) in cases {
            let got = declared(&[attr]);
            assert_eq!(got.level, want);
            assert!(got.unknown.is_empty());
        }
    }

    #[test]
    fn no_attribute_is_passthrough() {
        let attrs: [Attribute; 1] = [parse_quote!(#[serde(skip)])];
        assert_eq!(declared(&attrs).level, Level::Passthrough);
    }

    #[test]
    fn strictest_of_several_wins() {
        let attrs: [Attribute; 2] = [parse_quote!(#[o11y(mask)]), parse_quote!(#[o11y(omit)])];
        assert_eq!(declared(&attrs).level, Level::Omit);
        let attrs: [Attribute; 1] = [parse_quote!(#[o11y(secret, mask)])];
        assert_eq!(declared(&attrs).level, Level::Redact);
    }

    #[test]
    fn unknown_values_fail_closed_to_redact() {
        let cases: [Attribute; 8] = [
            parse_quote!(#[o11y(encrypt)]),
            parse_quote!(#[o11y(public)]),
            parse_quote!(#[o11y(mask = "yes")]),
            parse_quote!(#[o11y(mask(x))]),
            parse_quote!(#[o11y()]),
            parse_quote!(#[o11y]),
            parse_quote!(#[o11y = "mask"]),
            parse_quote!(#[o11y(1)]),
        ];
        for attr in cases {
            let got = declared(std::slice::from_ref(&attr));
            assert_eq!(got.level, Level::Redact, "{}", quote::quote!(#attr));
            assert_eq!(got.unknown.len(), 1, "{}", quote::quote!(#attr));
        }
    }

    #[test]
    fn an_unknown_value_never_weakens_a_stricter_one() {
        let attrs: [Attribute; 1] = [parse_quote!(#[o11y(omit, sercet)])];
        let got = declared(&attrs);
        assert_eq!(got.level, Level::Omit);
        assert_eq!(got.unknown[0].text, "#[o11y(omit, sercet)]");
    }

    #[test]
    fn crate_path_is_a_container_option() {
        let attrs: [Attribute; 1] = [parse_quote!(#[o11y(crate = "libo11y::redact")])];
        let got = parse(&attrs, Site::Container).unwrap();
        assert_eq!(got.level, Level::Passthrough);
        let path = got.krate.unwrap();
        assert_eq!(quote::quote!(#path).to_string(), "libo11y :: redact");

        let on_field = declared(&attrs);
        assert_eq!(on_field.level, Level::Redact);
        assert!(on_field.krate.is_none());
    }

    #[test]
    fn malformed_crate_path_is_an_error() {
        let attrs: [Attribute; 1] = [parse_quote!(#[o11y(crate = 5)])];
        assert!(parse(&attrs, Site::Container).is_err());
    }
}
