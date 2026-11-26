//! A `Display` that panics renders `REDACTED` instead of taking the caller
//! down. This test replaces the process-wide panic hook to keep the
//! expected panic quiet, so it runs in its own test binary, away from
//! tests whose failure output the hook would swallow.

use std::fmt;

use libo11y_redact::{Masked, Redact};

struct PanicDisplay;

impl fmt::Display for PanicDisplay {
    fn fmt(&self, _f: &mut fmt::Formatter<'_>) -> fmt::Result {
        panic!("boom")
    }
}

#[derive(Redact)]
struct Holder {
    p: PanicDisplay,
    #[o11y(mask)]
    masked: PanicDisplay,
}

#[test]
fn panicking_display_fails_closed() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let derived = Holder {
        p: PanicDisplay,
        masked: PanicDisplay,
    }
    .to_string();
    let wrapped = Masked::new(PanicDisplay).to_string();
    std::panic::set_hook(previous);
    assert_eq!(derived, "{p:REDACTED masked:REDACTED}");
    assert_eq!(wrapped, "REDACTED");
}
