//! Process-global setup and its guard.
//!
//! Upstream's global setters silently replace whatever was installed, so
//! libo11y keeps its own guard: one global SDK at a time, claimed before
//! construction and released when construction fails or the global SDK
//! shuts down.

use std::sync::atomic::Ordering;
use std::sync::{Mutex, PoisonError};

use crate::builder::{Settings, build_sdk};
use crate::layer::{check_tracing_default, follow_tracing_default, install_tracing_default};
use crate::{Error, Sdk};

/// Whether a global SDK is active or being set up.
static ACTIVE: Mutex<bool> = Mutex::new(false);

/// The claim on the guard. Dropping it unclaimed releases the guard, so
/// every failure, a panic included, lets a later setup run.
struct Claim {
    keep: bool,
}

impl Claim {
    /// Claims the guard, or fails while it is held. The lock is held only
    /// for the claim: construction runs user code, which must never run
    /// under it, and a racing setup fails fast instead of queueing.
    fn take() -> Result<Self, Error> {
        let mut active = ACTIVE.lock().unwrap_or_else(PoisonError::into_inner);
        if *active {
            return Err(Error::AlreadySetup);
        }
        *active = true;
        Ok(Self { keep: false })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        if !self.keep {
            release_guard();
        }
    }
}

/// Releases the guard.
pub(crate) fn release_guard() {
    *ACTIVE.lock().unwrap_or_else(PoisonError::into_inner) = false;
}

/// Releases the guard when dropped.
pub(crate) struct ReleaseOnDrop;

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        release_guard();
    }
}

/// Builds the SDK and installs it as the process default, in Go's order.
pub(crate) fn setup(settings: Settings) -> Result<Sdk, Error> {
    let mut claim = Claim::take()?;
    if settings.tracing_default {
        // Some other code may own the one global subscriber; find out before
        // anything is built or installed.
        check_tracing_default()?;
    }
    let sdk = build_sdk(settings)?;
    startup_canary(&sdk)?;
    if sdk.0.tracing_default {
        // The tracing default is claimed before any OpenTelemetry global is
        // installed, so a setup that loses it installs nothing.
        install_tracing_default(std::sync::Arc::clone(&sdk.0.parts)).inspect_err(|_| {
            sdk.abandon();
        })?;
    } else {
        // libo11y's stack, once installed, is the global subscriber for
        // good; it follows the SDK installed last.
        follow_tracing_default(std::sync::Arc::clone(&sdk.0.parts));
    }
    sdk.0.global.store(true, Ordering::Release);
    opentelemetry::global::set_tracer_provider(sdk.0.tracer_provider.clone());
    opentelemetry::global::set_meter_provider(sdk.0.meter_provider.clone());
    opentelemetry::global::set_text_map_propagator(sdk.0.propagator.clone());
    claim.keep = true;
    Ok(sdk)
}

/// The startup canary: the effective configuration, forced through every
/// log sink before any global is installed, so a sink that rejects it fails
/// setup instead of dropping records later. A rejection abandons `sdk` and
/// returns [`Error::StartupCanary`].
fn startup_canary(sdk: &Sdk) -> Result<(), Error> {
    if !sdk.0.startup_summary {
        return Ok(());
    }
    if let Err(err) = sdk.emit_startup_summary() {
        sdk.abandon();
        return Err(Error::StartupCanary(err));
    }
    Ok(())
}
