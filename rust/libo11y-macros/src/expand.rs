//! The code `#[derive(Redact)]` generates.

use proc_macro2::{Span, TokenStream, TokenTree};
use quote::{ToTokens, format_ident, quote, quote_spanned};
use syn::ext::IdentExt;
use syn::spanned::Spanned;
use syn::{Data, DataEnum, DeriveInput, Field, Fields, Ident, Index, Path, Type, parse_quote};

use crate::attr::{self, Declared, Level, Site};

/// Expands the derive for `input`, naming the runtime crate `default_krate`
/// unless the container overrides it with `#[o11y(crate = "...")]`.
pub(crate) fn derive(input: &DeriveInput, default_krate: &Path) -> syn::Result<TokenStream> {
    let container = attr::parse(&input.attrs, Site::Container)?;
    let mut cx = Context {
        krate: container
            .krate
            .clone()
            .unwrap_or_else(|| default_krate.clone()),
        type_name: input.ident.unraw().to_string(),
        floor: container.level,
        warnings: Vec::new(),
        rendered_types: Vec::new(),
    };
    let type_name = cx.type_name.clone();
    warn_unknown(&mut cx.warnings, &container, &type_name);
    let body = match &input.data {
        Data::Struct(data) => cx.struct_body(&data.fields)?,
        Data::Enum(data) => cx.enum_body(data)?,
        Data::Union(data) => {
            return Err(syn::Error::new(
                data.union_token.span,
                "Redact cannot be derived for a union: which field is live is unknown, so \
                 nothing could render safely. Wrap the value in libo11y_redact::Secret instead",
            ));
        }
    };
    Ok(cx.impls(input, &body))
}

/// What one expansion accumulates while it walks the input.
struct Context {
    krate: Path,
    type_name: String,
    /// The container's own level, a floor over every field.
    floor: Level,
    warnings: Vec<TokenStream>,
    /// The types of every rendered field, which decide the bounds.
    rendered_types: Vec<Type>,
}

impl Context {
    fn struct_body(&mut self, fields: &Fields) -> syn::Result<TokenStream> {
        let shape = Shape::new(fields, self.floor, &self.type_name, &mut self.warnings)?;
        shape.collect_rendered_types(&mut self.rendered_types);
        let record = shape.record(&self.krate, &self.type_name, None);
        let pattern = shape.pattern(&quote!(Self));
        Ok(quote! {
            match self {
                #pattern => #record,
            }
        })
    }

    fn enum_body(&mut self, data: &DataEnum) -> syn::Result<TokenStream> {
        if data.variants.is_empty() {
            return Ok(quote!(match *self {}));
        }
        let krate = self.krate.clone();
        let mut arms = Vec::with_capacity(data.variants.len());
        for (index, variant) in data.variants.iter().enumerate() {
            let declared = attr::parse(&variant.attrs, Site::Member)?;
            let variant_name = variant.ident.unraw().to_string();
            let path = format!("{}::{variant_name}", self.type_name);
            warn_unknown(&mut self.warnings, &declared, &path);
            let floor = self.floor.max(declared.level);
            let ident = &variant.ident;
            if floor.hides_value() {
                arms.push(quote!(Self::#ident { .. } => #krate::Protected::Redacted,));
                continue;
            }
            let shape = Shape::new(&variant.fields, floor, &path, &mut self.warnings)?;
            shape.collect_rendered_types(&mut self.rendered_types);
            let index = u32::try_from(index).map_err(|_| {
                syn::Error::new(variant.span(), "Redact supports at most u32::MAX variants")
            })?;
            let record = shape.record(&krate, &self.type_name, Some((index, &variant_name)));
            let floor = level_tokens(&krate, declared.level);
            let pattern = shape.pattern(&quote!(Self::#ident));
            arms.push(quote! {
                #pattern => {
                    let __o11y_floor = ::core::cmp::max(__o11y_floor, #floor);
                    #record
                }
            });
        }
        Ok(quote! {
            match self {
                #(#arms)*
            }
        })
    }

    /// The four implementations, every surface rendering through
    /// `Redact::redact`, and the warnings.
    fn impls(&self, input: &DeriveInput, body: &TokenStream) -> TokenStream {
        let krate = &self.krate;
        let generics = bounded_generics(input, krate, &self.rendered_types);
        let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
        let ident = &input.ident;
        let container_floor = level_tokens(krate, self.floor);
        let warnings = &self.warnings;
        quote! {
            #(#warnings)*

            #[automatically_derived]
            impl #impl_generics #krate::Redact for #ident #ty_generics #where_clause {
                fn redact(&self, __o11y_floor: #krate::Protection) -> #krate::Protected {
                    #[allow(unused_imports)]
                    use #krate::__private::{
                        RenderDebug as _, RenderDisplay as _, RenderOptionDebug as _,
                        RenderOptionDisplay as _, RenderRedact as _,
                    };
                    let __o11y_floor = ::core::cmp::max(__o11y_floor, #container_floor);
                    if #krate::Protection::hides_value(__o11y_floor) {
                        return #krate::Protected::Redacted;
                    }
                    let ::core::option::Option::Some(_o11y_depth) = #krate::__private::enter()
                    else {
                        return #krate::Protected::Redacted;
                    };
                    #body
                }
            }

            #[automatically_derived]
            impl #impl_generics ::core::fmt::Debug for #ident #ty_generics #where_clause {
                fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                    ::core::fmt::Debug::fmt(
                        &#krate::Redact::redact(self, #krate::Protection::Passthrough),
                        f,
                    )
                }
            }

            #[automatically_derived]
            impl #impl_generics ::core::fmt::Display for #ident #ty_generics #where_clause {
                fn fmt(&self, f: &mut ::core::fmt::Formatter<'_>) -> ::core::fmt::Result {
                    ::core::fmt::Display::fmt(
                        &#krate::Redact::redact(self, #krate::Protection::Passthrough),
                        f,
                    )
                }
            }

            #[automatically_derived]
            impl #impl_generics #krate::__private::serde::Serialize
                for #ident #ty_generics #where_clause
            {
                fn serialize<__O11yS>(
                    &self,
                    serializer: __O11yS,
                ) -> ::core::result::Result<__O11yS::Ok, __O11yS::Error>
                where
                    __O11yS: #krate::__private::serde::Serializer,
                {
                    #krate::__private::serde::Serialize::serialize(
                        &#krate::Redact::redact(self, #krate::Protection::Passthrough),
                        serializer,
                    )
                }
            }
        }
    }
}

/// The fields of a struct or variant, each with its declared level.
struct Shape<'a> {
    kind: ShapeKind,
    members: Vec<Member<'a>>,
}

#[derive(Clone, Copy)]
enum ShapeKind {
    Named,
    Unnamed,
    Unit,
}

struct Member<'a> {
    field: &'a Field,
    /// The field's name in the rendering, or its position.
    name: String,
    /// How the field is reached in a pattern: its name or its index.
    access: TokenStream,
    /// The local the pattern binds the field to.
    binding: Ident,
    /// The field's own level combined with every floor known at compile
    /// time around it.
    level: Level,
}

impl<'a> Shape<'a> {
    fn new(
        fields: &'a Fields,
        floor: Level,
        owner: &str,
        warnings: &mut Vec<TokenStream>,
    ) -> syn::Result<Self> {
        let kind = match fields {
            Fields::Named(_) => ShapeKind::Named,
            Fields::Unnamed(_) => ShapeKind::Unnamed,
            Fields::Unit => ShapeKind::Unit,
        };
        let mut members = Vec::with_capacity(fields.len());
        for (index, field) in fields.iter().enumerate() {
            let declared = attr::parse(&field.attrs, Site::Member)?;
            let (name, access) = match &field.ident {
                Some(ident) => (ident.unraw().to_string(), ident.to_token_stream()),
                None => (index.to_string(), Index::from(index).to_token_stream()),
            };
            warn_unknown(warnings, &declared, &format!("{owner}.{name}"));
            members.push(Member {
                field,
                name,
                access,
                binding: format_ident!("__o11y_f{index}"),
                level: floor.max(declared.level),
            });
        }
        Ok(Self { kind, members })
    }

    /// The members whose value renders, so their types need a bound.
    fn rendered(&self) -> impl Iterator<Item = &Member<'a>> {
        self.members.iter().filter(|m| !m.level.hides_value())
    }

    fn collect_rendered_types(&self, types: &mut Vec<Type>) {
        types.extend(self.rendered().map(|m| m.field.ty.clone()));
    }

    /// A braced pattern binding every rendered field, which works for
    /// named, tuple and unit shapes alike: `Self { card: __o11y_f0, .. }`.
    fn pattern(&self, path: &TokenStream) -> TokenStream {
        let bindings = self.rendered().map(|m| {
            let access = &m.access;
            let binding = &m.binding;
            quote!(#access: #binding)
        });
        quote!(#path { #(#bindings,)* .. })
    }

    /// The expression building this shape's `Protected::Record`.
    fn record(&self, krate: &Path, type_name: &str, variant: Option<(u32, &str)>) -> TokenStream {
        let variant = variant.map_or_else(
            || quote!(::core::option::Option::None),
            |(index, name)| quote!(::core::option::Option::Some(#krate::Variant::new(#index, #name))),
        );
        let values = self
            .members
            .iter()
            .filter(|m| m.level != Level::Omit)
            .map(|m| (m, m.value(krate)));
        let fields = match self.kind {
            ShapeKind::Named => {
                let entries = values.map(|(m, value)| {
                    let name = &m.name;
                    quote!((#name, #value))
                });
                quote!(#krate::Fields::Named(#krate::__private::vec![#(#entries),*]))
            }
            // A newtype is decided by the declared fields, so omitting one of
            // two fields keeps a tuple a tuple.
            ShapeKind::Unnamed
                if self.members.len() == 1 && self.members[0].level != Level::Omit =>
            {
                let value = values.map(|(_, value)| value);
                quote!(#krate::Fields::Newtype(#krate::__private::Box::new(#(#value)*)))
            }
            ShapeKind::Unnamed => {
                let entries = values.map(|(_, value)| value);
                quote!(#krate::Fields::Unnamed(#krate::__private::vec![#(#entries),*]))
            }
            ShapeKind::Unit => quote!(#krate::Fields::Unit),
        };
        quote! {
            #krate::Protected::Record(#krate::Record::new(#type_name, #variant, #fields))
        }
    }
}

impl Member<'_> {
    /// The expression rendering this member under the floor in scope.
    ///
    /// The probe picks the most capable rendering the field's type allows,
    /// by autoref specialization: its own `Redact`, then for an `Option`
    /// its inner `Display`, then `Display`, then for an `Option` its inner
    /// `Debug`, then `Debug`. A type with none of them is a compile error
    /// unless the field is redacted or omitted. The floor is enforced on
    /// the result whatever the rendering returned.
    fn value(&self, krate: &Path) -> TokenStream {
        if self.level.hides_value() {
            return quote!(#krate::Protected::Redacted);
        }
        let binding = &self.binding;
        let floor = match self.level {
            Level::Passthrough => quote!(__o11y_floor),
            level => {
                let level = level_tokens(krate, level);
                quote!(::core::cmp::max(__o11y_floor, #level))
            }
        };
        // Errors point at the field's type, while names resolve at the call
        // site like the rest of the expansion: a type written inside a
        // `macro_rules!` body must not hide the locals from the probe.
        let span = Span::call_site().located_at(self.field.ty.span());
        let probe = quote_spanned! {span=>
            (&&&&&#krate::__private::Probe(#binding)).__o11y_render(__o11y_field_floor)
        };
        quote! {{
            let __o11y_field_floor = #floor;
            #krate::Protected::at_floor(#probe, __o11y_field_floor)
        }}
    }
}

fn level_tokens(krate: &Path, level: Level) -> TokenStream {
    match level {
        Level::Passthrough => quote!(#krate::Protection::Passthrough),
        Level::Mask => quote!(#krate::Protection::Mask),
        Level::Redact => quote!(#krate::Protection::Redact),
        Level::Omit => quote!(#krate::Protection::Omit),
    }
}

/// Adds `FieldType: Redact` for every rendered field whose type mentions a
/// type parameter. Inside the generic impl the probe can only use what the
/// where clause proves, so without the bound a type such as `Wrap<T>` with
/// a hand-written `Redact` would fall back to its `Display`. Bounding the
/// whole field type, rather than `T` as serde does, also covers associated
/// types (`T::Output`) and lets `Secret<T>` or `PhantomData<T>` hold any
/// `T`. Fields that are redacted or omitted are never rendered and add no
/// bound.
fn bounded_generics(input: &DeriveInput, krate: &Path, rendered: &[Type]) -> syn::Generics {
    let params: Vec<&Ident> = input.generics.type_params().map(|p| &p.ident).collect();
    let mut generics = input.generics.clone();
    let mut seen: Vec<String> = Vec::new();
    for ty in rendered {
        if !mentions(ty.to_token_stream(), &params) {
            continue;
        }
        // syn compares types only with its extra-traits feature, so the
        // tokens deduplicate the bounds.
        let text = ty.to_token_stream().to_string();
        if seen.contains(&text) {
            continue;
        }
        seen.push(text);
        generics
            .make_where_clause()
            .predicates
            .push(parse_quote!(#ty: #krate::Redact));
    }
    generics
}

fn mentions(tokens: TokenStream, params: &[&Ident]) -> bool {
    tokens.into_iter().any(|token| match token {
        TokenTree::Ident(ident) => params.iter().any(|param| **param == ident),
        TokenTree::Group(group) => mentions(group.stream(), params),
        TokenTree::Punct(_) | TokenTree::Literal(_) => false,
    })
}

/// Emits a compile-time warning for every unknown attribute value. Stable
/// Rust has no warning API for procedural macros, so each warning is the
/// `deprecated` lint on a use, spanned at the attribute, of an item whose
/// deprecation note explains the fallback.
fn warn_unknown(warnings: &mut Vec<TokenStream>, declared: &Declared, owner: &str) {
    for unknown in &declared.unknown {
        let note = format!(
            "libo11y: `{}` is not a protection, so `{owner}` fails closed to redact. Use one of \
             mask, redact, omit, confidential or secret",
            unknown.text,
        );
        warnings.push(warning(unknown.span, &note));
    }
}

fn warning(span: Span, note: &str) -> TokenStream {
    let item = Ident::new("UnknownO11yAttribute", span);
    quote_spanned! {span=>
        const _: () = {
            #[deprecated(note = #note)]
            struct UnknownO11yAttribute;
            let _ = #item;
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(input: &DeriveInput) -> String {
        derive(input, &parse_quote!(::libo11y_redact))
            .unwrap()
            .to_string()
    }

    #[test]
    fn bounds_only_parameters_of_rendered_fields() {
        let out = expand(&parse_quote! {
            struct Creds<T, U> {
                #[o11y(secret)]
                token: T,
                user: Vec<U>,
            }
        });
        assert!(
            out.contains("Vec < U > : :: libo11y_redact :: Redact"),
            "{out}"
        );
        assert!(!out.contains("T : :: libo11y_redact :: Redact"), "{out}");
    }

    #[test]
    fn omitted_fields_are_never_bound() {
        let out = expand(&parse_quote! {
            struct Payment {
                #[o11y(omit)]
                pin: String,
                merchant: String,
            }
        });
        assert!(!out.contains("pin"), "{out}");
        assert!(out.contains("\"merchant\""), "{out}");
    }

    #[test]
    fn unknown_attribute_emits_a_deprecation_warning() {
        let out = expand(&parse_quote! {
            struct Bad {
                #[o11y(encrypt)]
                field: String,
            }
        });
        assert!(out.contains("deprecated"), "{out}");
        assert!(out.contains("Bad.field"), "{out}");
    }

    #[test]
    fn crate_override_changes_every_path() {
        let out = expand(&parse_quote! {
            #[o11y(crate = "libo11y::redact")]
            struct Holder {
                name: String,
            }
        });
        assert!(out.contains("libo11y :: redact :: Redact"), "{out}");
        assert!(!out.contains("libo11y_redact"), "{out}");
    }

    #[test]
    fn unions_are_rejected() {
        let input: DeriveInput = parse_quote! {
            union Bits {
                a: u32,
                b: f32,
            }
        };
        let err = derive(&input, &parse_quote!(::libo11y_redact)).unwrap_err();
        assert!(err.to_string().contains("union"), "{err}");
    }
}
