//! The protected representation every surface renders from.

use std::fmt::{self, Write as _};

use crate::{Protection, REDACTED};

/// A value with every protection applied, ready to render.
///
/// [`Redact::redact`](crate::Redact::redact) returns this tree, and every
/// surface renders from it, so `Debug`, `Display` and `serde::Serialize`
/// cannot drift apart: a protected leaf is protected on all of them.
///
/// - `Debug` renders the Rust debug form, with struct and variant names,
///   quoted strings, and the `{:#?}` pretty form.
/// - `Display` renders the compact text form Go's `redact.Struct` prints:
///   fields as `name:value` separated by single spaces inside braces, so a
///   struct renders as `{card:XXXX cvv:REDACTED merchant:acme}`.
/// - `serde::Serialize` (feature `serde`) renders the shape serde's own
///   derive would, with protected leaves: structs as maps, sequences as
///   sequences, and [`Protected::Redacted`] as the string `"REDACTED"`.
///
/// ```
/// use libo11y_redact::{Fields, Protected, Record};
///
/// let payment = Protected::Record(Record {
///     name: "Payment",
///     variant: None,
///     fields: Fields::Named(vec![
///         ("card", Protected::Str("XXXX".into())),
///         ("cvv", Protected::Redacted),
///     ]),
/// });
/// assert_eq!(payment.to_string(), "{card:XXXX cvv:REDACTED}");
/// assert_eq!(format!("{payment:?}"), r#"Payment { card: "XXXX", cvv: REDACTED }"#);
/// ```
#[derive(Clone, PartialEq)]
#[non_exhaustive]
pub enum Protected {
    /// An absent value, such as `None`. Renders `None`, and `null` in JSON.
    Null,
    /// A boolean.
    Bool(bool),
    /// A signed integer.
    Int(i128),
    /// An unsigned integer.
    Uint(u128),
    /// A floating-point number. A value JSON cannot hold (`NaN` and the
    /// infinities) serializes as the string `"NaN"`, `"+Inf"` or `"-Inf"`.
    Float(f64),
    /// A string value: quoted by `Debug`.
    Str(String),
    /// The text form of an opaque value, such as a `Duration` or an IP
    /// address: written as is by `Debug` and `Display`, and serialized as a
    /// string.
    Text(String),
    /// A value replaced by the literal [`REDACTED`].
    Redacted,
    /// A sequence, such as a `Vec` or a tuple.
    Seq(Vec<Protected>),
    /// A map, as key and value pairs in rendering order.
    Map(Vec<(Protected, Protected)>),
    /// A struct or an enum variant.
    Record(Record),
}

/// A struct or an enum variant inside a [`Protected`] tree.
#[derive(Clone, PartialEq)]
pub struct Record {
    /// The type's name.
    pub name: &'static str,
    /// The variant, when the type is an enum.
    pub variant: Option<Variant>,
    /// The fields that render. An omitted field is absent.
    pub fields: Fields,
}

/// An enum variant of a [`Record`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Variant {
    /// The variant's position in its enum's declaration, as serde numbers
    /// variants.
    pub index: u32,
    /// The variant's name.
    pub name: &'static str,
}

/// The fields of a [`Record`].
#[derive(Clone, PartialEq)]
pub enum Fields {
    /// Named fields, in declaration order.
    Named(Vec<(&'static str, Protected)>),
    /// Positional fields, in declaration order.
    Unnamed(Vec<Protected>),
    /// No fields.
    Unit,
}

impl Protected {
    /// Returns a [`Protected::Str`] of one `X` per character of `text`,
    /// the masked form of a string.
    ///
    /// ```
    /// use libo11y_redact::Protected;
    ///
    /// assert_eq!(Protected::masked("Jürgen"), Protected::Str("XXXXXX".into()));
    /// ```
    #[must_use]
    pub fn masked(text: &str) -> Self {
        Self::Str(mask_text(text))
    }

    /// Enforces `floor` on an already protected value.
    ///
    /// Under [`Protection::Passthrough`] the value is unchanged. Under
    /// [`Protection::Mask`] every leaf is masked: strings, text and numbers
    /// become a run of `X` of their character count, while names, field
    /// names, `Null` and [`Protected::Redacted`] keep their stricter or
    /// structural rendering. Under [`Protection::Redact`] and
    /// [`Protection::Omit`] the whole value becomes [`Protected::Redacted`].
    /// Enforcing a floor twice changes nothing more.
    ///
    /// ```
    /// use libo11y_redact::{Protected, Protection};
    ///
    /// let value = Protected::Seq(vec![Protected::Int(1234), Protected::Redacted]);
    /// assert_eq!(
    ///     value.at_floor(Protection::Mask),
    ///     Protected::Seq(vec![Protected::Str("XXXX".into()), Protected::Redacted]),
    /// );
    /// ```
    #[must_use]
    pub fn at_floor(self, floor: Protection) -> Self {
        match floor {
            Protection::Passthrough => self,
            Protection::Mask => self.mask_leaves(),
            Protection::Redact | Protection::Omit => Self::Redacted,
        }
    }

    fn mask_leaves(self) -> Self {
        match self {
            Self::Null => Self::Null,
            Self::Redacted => Self::Redacted,
            Self::Bool(b) => Self::masked(if b { "true" } else { "false" }),
            Self::Int(n) => Self::Str(mask_display(&n)),
            Self::Uint(n) => Self::Str(mask_display(&n)),
            Self::Float(x) => Self::Str(mask_display(&x)),
            Self::Str(s) => Self::Str(mask_text(&s)),
            Self::Text(s) => Self::Text(mask_text(&s)),
            Self::Seq(items) => Self::Seq(items.into_iter().map(Self::mask_leaves).collect()),
            Self::Map(entries) => Self::Map(
                entries
                    .into_iter()
                    .map(|(k, v)| (k.mask_leaves(), v.mask_leaves()))
                    .collect(),
            ),
            Self::Record(record) => Self::Record(Record {
                fields: match record.fields {
                    Fields::Named(fields) => Fields::Named(
                        fields
                            .into_iter()
                            .map(|(name, v)| (name, v.mask_leaves()))
                            .collect(),
                    ),
                    Fields::Unnamed(fields) => {
                        Fields::Unnamed(fields.into_iter().map(Self::mask_leaves).collect())
                    }
                    Fields::Unit => Fields::Unit,
                },
                ..record
            }),
        }
    }
}

/// One `X` per character of `text`: Go counts runes, and a Rust `char` is
/// a Unicode scalar value, the same unit for valid UTF-8.
pub(crate) fn mask_text(text: &str) -> String {
    "X".repeat(text.chars().count())
}

fn mask_display(value: &dyn fmt::Display) -> String {
    mask_text(&value.to_string())
}

impl fmt::Display for Protected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Null => f.write_str("None"),
            Self::Bool(b) => write!(f, "{b}"),
            Self::Int(n) => write!(f, "{n}"),
            Self::Uint(n) => write!(f, "{n}"),
            Self::Float(x) => write!(f, "{x}"),
            Self::Str(s) | Self::Text(s) => f.write_str(s),
            Self::Redacted => f.write_str(REDACTED),
            Self::Seq(items) => {
                f.write_char('[')?;
                write_spaced(f, items.iter().map(|item| (None, item)))?;
                f.write_char(']')
            }
            Self::Map(entries) => {
                f.write_char('{')?;
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        f.write_char(' ')?;
                    }
                    write!(f, "{key}:{value}")?;
                }
                f.write_char('}')
            }
            Self::Record(record) => fmt::Display::fmt(record, f),
        }
    }
}

impl fmt::Display for Record {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let variant = self.variant.map(|v| v.name);
        match &self.fields {
            Fields::Named(fields) => {
                f.write_str(variant.unwrap_or_default())?;
                f.write_char('{')?;
                write_spaced(f, fields.iter().map(|(name, value)| (Some(*name), value)))?;
                f.write_char('}')
            }
            // A newtype struct is transparent, as serde renders it.
            Fields::Unnamed(fields) if variant.is_none() && fields.len() == 1 => {
                fmt::Display::fmt(&fields[0], f)
            }
            Fields::Unnamed(fields) => {
                f.write_str(variant.unwrap_or_default())?;
                f.write_char('(')?;
                write_spaced(f, fields.iter().map(|value| (None, value)))?;
                f.write_char(')')
            }
            Fields::Unit => f.write_str(variant.unwrap_or(self.name)),
        }
    }
}

fn write_spaced<'a>(
    f: &mut fmt::Formatter<'_>,
    members: impl Iterator<Item = (Option<&'a str>, &'a Protected)>,
) -> fmt::Result {
    for (i, (name, value)) in members.enumerate() {
        if i > 0 {
            f.write_char(' ')?;
        }
        if let Some(name) = name {
            write!(f, "{name}:")?;
        }
        write!(f, "{value}")?;
    }
    Ok(())
}

impl fmt::Debug for Protected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Null => f.write_str("None"),
            Self::Bool(b) => fmt::Debug::fmt(b, f),
            Self::Int(n) => fmt::Debug::fmt(n, f),
            Self::Uint(n) => fmt::Debug::fmt(n, f),
            Self::Float(x) => fmt::Debug::fmt(x, f),
            Self::Str(s) => fmt::Debug::fmt(s, f),
            Self::Text(s) => f.write_str(s),
            Self::Redacted => f.write_str(REDACTED),
            Self::Seq(items) => f.debug_list().entries(items).finish(),
            Self::Map(entries) => f
                .debug_map()
                .entries(entries.iter().map(|(k, v)| (k, v)))
                .finish(),
            Self::Record(record) => fmt::Debug::fmt(record, f),
        }
    }
}

impl fmt::Debug for Record {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = self.variant.map_or(self.name, |v| v.name);
        match &self.fields {
            Fields::Named(fields) => {
                let mut s = f.debug_struct(label);
                for (name, value) in fields {
                    s.field(name, value);
                }
                s.finish()
            }
            Fields::Unnamed(fields) => {
                let mut t = f.debug_tuple(label);
                for value in fields {
                    t.field(value);
                }
                t.finish()
            }
            Fields::Unit => f.write_str(label),
        }
    }
}

impl fmt::Debug for Fields {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Named(fields) => f
                .debug_map()
                .entries(fields.iter().map(|(k, v)| (k, v)))
                .finish(),
            Self::Unnamed(fields) => f.debug_list().entries(fields).finish(),
            Self::Unit => f.write_str("Unit"),
        }
    }
}
