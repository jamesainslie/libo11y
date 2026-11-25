//! Rendering machinery shared by the crate's implementations and the code
//! `#[derive(Redact)]` generates.

use std::cell::Cell;
use std::fmt::{self, Write as _};
use std::panic::{AssertUnwindSafe, catch_unwind};

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
/// is already [`MAX_DEPTH`] levels deep and the value must render as
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
