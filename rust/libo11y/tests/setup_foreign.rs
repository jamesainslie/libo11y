//! Setup next to a global `tracing` subscriber libo11y did not install.

mod common;

use opentelemetry::trace::{Span as _, Tracer as _, TracerProvider as _};

use common::hermetic;
use libo11y::Error;

fn global_tracer_records() -> bool {
    opentelemetry::global::tracer_provider()
        .tracer("probe")
        .start("probe")
        .span_context()
        .is_valid()
}

#[test]
fn a_foreign_tracing_default_fails_setup_until_tracing_is_left_alone() {
    tracing::subscriber::set_global_default(tracing_subscriber::registry())
        .expect("the first global subscriber");

    let err = hermetic("foreign").setup().expect_err("foreign subscriber");
    assert!(matches!(err, Error::ForeignTracingSubscriber), "{err}");
    assert!(err.to_string().contains("without_tracing_default"), "{err}");
    assert!(!global_tracer_records(), "a failed setup installs nothing");

    // The failure released the guard, and leaving tracing alone works.
    let sdk = hermetic("foreign")
        .without_tracing_default()
        .setup()
        .expect("setup without the tracing default");
    assert!(global_tracer_records());
    sdk.shutdown().expect("shutdown");
}
