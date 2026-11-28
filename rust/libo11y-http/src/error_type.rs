//! A bounded `error.type` for a Rust error type.

use std::borrow::Cow;

/// The `error.type` value semantic conventions reserve for an error whose
/// type is not known or cannot be named usefully.
pub(crate) const ERROR_TYPE_OTHER: &str = "_OTHER";

/// Returns the `error.type` for an error of type `E`: its type name with the
/// module paths stripped, such as `DownstreamErr` for
/// `my_crate::errors::DownstreamErr` or `Wrap<Inner>` for
/// `a::Wrap<b::Inner>`.
///
/// A trait object or a boxed error, such as
/// `alloc::boxed::Box<dyn core::error::Error + Send + Sync>`, names the
/// wrapper and not the error inside it, so it reads [`ERROR_TYPE_OTHER`], as
/// does a name with nothing usable in it, such as a closure's.
pub(crate) fn short_error_type<E: ?Sized>() -> Cow<'static, str> {
    short_type_name(std::any::type_name::<E>())
}

fn short_type_name(full: &'static str) -> Cow<'static, str> {
    if full.contains("dyn ") {
        return Cow::Borrowed(ERROR_TYPE_OTHER);
    }
    let short = strip_paths(full);
    if short.starts_with("Box<")
        || short.contains("<Box<")
        || short.contains(", Box<")
        || short.contains('{')
        || !short.chars().any(char::is_alphanumeric)
    {
        return Cow::Borrowed(ERROR_TYPE_OTHER);
    }
    short
}

/// Drops every path prefix in `full`, module or enclosing function alike,
/// keeping the last segment of each path and the punctuation between paths.
fn strip_paths(full: &'static str) -> Cow<'static, str> {
    if !full.contains("::") {
        return Cow::Borrowed(full);
    }
    let mut out = String::with_capacity(full.len());
    // Where the path segment being written started in `out`.
    let mut segment = 0;
    let mut rest = full;
    while let Some(c) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix("::") {
            out.truncate(segment);
            rest = after;
            continue;
        }
        out.push(c);
        // A segment is an identifier or a `{{closure}}`-style marker, so
        // only the punctuation between paths starts a new one.
        if !(c.is_alphanumeric() || matches!(c, '_' | '{' | '}')) {
            segment = out.len();
        }
        rest = &rest[c.len_utf8()..];
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    mod nested {
        #[derive(Debug)]
        pub(super) struct DownstreamErr;

        #[derive(Debug)]
        pub(super) struct Wrap<T>(pub(super) T);
    }

    #[test]
    fn strips_module_paths() {
        assert_eq!(short_error_type::<nested::DownstreamErr>(), "DownstreamErr");
        assert_eq!(short_error_type::<std::io::Error>(), "Error");
        assert_eq!(
            short_error_type::<nested::Wrap<std::fmt::Error>>(),
            "Wrap<Error>"
        );
        assert_eq!(short_error_type::<u32>(), "u32");
        assert_eq!(short_type_name("a::b::Pair<c::X, d::e::Y>"), "Pair<X, Y>");
        assert_eq!(
            short_type_name("mail::MailBox<std::io::Error>"),
            "MailBox<Error>"
        );
    }

    #[test]
    fn trait_objects_and_boxes_read_other() {
        assert_eq!(
            short_error_type::<Box<dyn std::error::Error + Send + Sync>>(),
            ERROR_TYPE_OTHER
        );
        assert_eq!(
            short_error_type::<dyn std::error::Error>(),
            ERROR_TYPE_OTHER
        );
        assert_eq!(short_error_type::<Box<std::io::Error>>(), ERROR_TYPE_OTHER);
        assert_eq!(
            short_type_name("alloc::boxed::Box<dyn core::error::Error + core::marker::Send>"),
            ERROR_TYPE_OTHER
        );
    }

    #[test]
    fn unusable_names_read_other() {
        assert_eq!(short_type_name(""), ERROR_TYPE_OTHER);
        assert_eq!(short_type_name("()"), ERROR_TYPE_OTHER);
        assert_eq!(short_type_name("my::f::{{closure}}"), ERROR_TYPE_OTHER);
    }

    #[test]
    fn types_inside_functions_and_closures_keep_their_name() {
        assert_eq!(
            short_type_name("integration::case::{{closure}}::DownstreamErr"),
            "DownstreamErr"
        );
        assert_eq!(
            short_type_name("a::f::{{closure}}::Wrap<b::g::{{closure}}::E>"),
            "Wrap<E>"
        );
    }
}
