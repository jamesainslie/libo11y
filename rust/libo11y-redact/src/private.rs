//! Rendering machinery shared by the crate's implementations and the code
//! `#[derive(Redact)]` generates.

use std::cell::Cell;
use std::fmt::{self, Write as _};
use std::panic::{AssertUnwindSafe, catch_unwind};

use crate::{Protected, Protection, Redact};

/// How many nested containers a rendering may enter before the rest
/// renders as `REDACTED`, Go's `maxDepth`. Rust ownership rules out cycles
/// of plain references, but a cycle through `Rc` and `RefCell` would
/// otherwise recurse until the stack overflows: failing closed beats both
/// crashing and leaking.
pub(crate) const MAX_DEPTH: u32 = 32;

thread_local! {
    static DEPTH: Cell<u32> = const { Cell::new(0) };
}

/// Holds one level of the rendering depth on this thread, released on
/// drop, including while a panic unwinds.
pub struct DepthGuard(());

impl Drop for DepthGuard {
    fn drop(&mut self) {
        DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Enters one more level of nesting, or returns `None` when the rendering
/// is already 32 levels deep and the value must render as
/// `REDACTED`. The depth is per thread, so it also bounds a rendering that
/// re-enters through a `Debug` or `Display` implementation.
#[must_use]
pub fn enter() -> Option<DepthGuard> {
    DEPTH.with(|depth| {
        let current = depth.get();
        (current < MAX_DEPTH).then(|| {
            depth.set(current + 1);
            DepthGuard(())
        })
    })
}

/// Counts the characters of `value`'s `Display` text without keeping it,
/// or returns `None` when the text cannot be rendered.
pub(crate) fn char_count(value: &dyn fmt::Display) -> Option<usize> {
    struct Counter(usize);

    impl fmt::Write for Counter {
        fn write_str(&mut self, s: &str) -> fmt::Result {
            self.0 += s.chars().count();
            Ok(())
        }
    }

    catch_unwind(AssertUnwindSafe(|| {
        let mut counter = Counter(0);
        write!(counter, "{value}").ok().map(|()| counter.0)
    }))
    .ok()
    .flatten()
}

/// Renders `write` into a string, or returns `None` when it fails or
/// panics, so a misbehaving `Display` or `Debug` fails closed instead of
/// leaking a partial text or taking the caller down.
fn text_of(write: impl FnOnce(&mut String) -> fmt::Result) -> Option<String> {
    catch_unwind(AssertUnwindSafe(|| {
        let mut text = String::new();
        write(&mut text).ok().map(|()| text)
    }))
    .ok()
    .flatten()
}

/// Renders an opaque value's text, one level deeper: its `Display` or
/// `Debug` may render nested protected values and so re-enter.
fn text_leaf(floor: Protection, write: impl FnOnce(&mut String) -> fmt::Result) -> Protected {
    if floor.hides_value() {
        return Protected::Redacted;
    }
    let Some(_depth) = enter() else {
        return Protected::Redacted;
    };
    text_of(write).map_or(Protected::Redacted, |text| {
        Protected::Text(text).at_floor(floor)
    })
}

/// The receiver of the derive's autoref-specialized dispatch. The
/// generated code calls `(&&&&&Probe(field)).__o11y_render(floor)`, and
/// method resolution picks the first of these impls whose bounds the
/// field's type meets, from the most references down: [`RenderRedact`],
/// [`RenderOptionDisplay`], [`RenderDisplay`], [`RenderOptionDebug`],
/// [`RenderDebug`].
pub struct Probe<'a, T: ?Sized>(pub &'a T);

/// Dispatch to the field's own [`Redact`], which keeps its structure and
/// its own protections.
pub trait RenderRedact {
    /// Renders the probed value under `floor`.
    fn __o11y_render(&self, floor: Protection) -> Protected;
}

impl<T: Redact + ?Sized> RenderRedact for &&&&Probe<'_, T> {
    fn __o11y_render(&self, floor: Protection) -> Protected {
        self.0.redact(floor)
    }
}

/// Dispatch for an `Option` of a type with `Display` only: `None` renders
/// as `Null`, `Some` as the text.
pub trait RenderOptionDisplay {
    /// Renders the probed value under `floor`.
    fn __o11y_render(&self, floor: Protection) -> Protected;
}

impl<T: fmt::Display> RenderOptionDisplay for &&&Probe<'_, Option<T>> {
    fn __o11y_render(&self, floor: Protection) -> Protected {
        match self.0 {
            _ if floor.hides_value() => Protected::Redacted,
            None => Protected::Null,
            Some(value) => text_leaf(floor, |out| write!(out, "{value}")),
        }
    }
}

/// Dispatch to the field's `Display` text, the counterpart of Go rendering
/// a `fmt.Stringer` leaf as its text.
pub trait RenderDisplay {
    /// Renders the probed value under `floor`.
    fn __o11y_render(&self, floor: Protection) -> Protected;
}

impl<T: fmt::Display + ?Sized> RenderDisplay for &&Probe<'_, T> {
    fn __o11y_render(&self, floor: Protection) -> Protected {
        let value = self.0;
        text_leaf(floor, |out| write!(out, "{value}"))
    }
}

/// Dispatch for an `Option` of a type with `Debug` only.
pub trait RenderOptionDebug {
    /// Renders the probed value under `floor`.
    fn __o11y_render(&self, floor: Protection) -> Protected;
}

impl<T: fmt::Debug> RenderOptionDebug for &Probe<'_, Option<T>> {
    fn __o11y_render(&self, floor: Protection) -> Protected {
        match self.0 {
            _ if floor.hides_value() => Protected::Redacted,
            None => Protected::Null,
            Some(value) => text_leaf(floor, |out| write!(out, "{value:?}")),
        }
    }
}

/// Dispatch to the field's `Debug` text, the last resort.
pub trait RenderDebug {
    /// Renders the probed value under `floor`.
    fn __o11y_render(&self, floor: Protection) -> Protected;
}

impl<T: fmt::Debug + ?Sized> RenderDebug for Probe<'_, T> {
    fn __o11y_render(&self, floor: Protection) -> Protected {
        let value = self.0;
        text_leaf(floor, |out| write!(out, "{value:?}"))
    }
}
