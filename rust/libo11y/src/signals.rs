//! Shutdown on `SIGINT` and `SIGTERM`.

use std::future::Future;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use signal_hook::consts::{SIGINT, SIGTERM};
use signal_hook::iterator::{Handle, Signals};
use tokio::sync::oneshot;

use crate::{Sdk, ShutdownError};

impl Sdk {
    /// Waits for `SIGINT` or `SIGTERM`, then shuts the SDK down with the
    /// default five-second deadline and returns the result.
    ///
    /// The first signal restores the default handling of both, so a second
    /// signal terminates the process at once instead of waiting on the
    /// flush. Dropping the future before a signal arrives restores the
    /// default handling too, and it can be called again later.
    ///
    /// The default handling is libo11y's emulation of it, which stays
    /// installed for the life of the process: once this has run, a `SIGINT`
    /// or `SIGTERM` that arrives while no call is waiting terminates the
    /// process even if the application registered its own handler since.
    ///
    /// ```no_run
    /// # async fn serve() {}
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let sdk = libo11y::Sdk::builder()
    ///     .service_name("worker")
    ///     .environment(libo11y::Environment::Production)
    ///     .setup()?;
    /// tokio::spawn(serve());
    /// sdk.shutdown_on_signals().await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// The shutdown's failures, or the error installing the signal
    /// handlers.
    pub async fn shutdown_on_signals(&self) -> Result<(), ShutdownError> {
        let listener = SignalListener::install().map_err(ShutdownError::signals)?;
        self.shutdown_after(listener.wait()).await
    }

    /// Waits for `trigger`, then shuts down, so tests can drive the wait
    /// without a real signal.
    pub(crate) async fn shutdown_after(
        &self,
        trigger: impl Future<Output = ()>,
    ) -> Result<(), ShutdownError> {
        trigger.await;
        self.shutdown_async().await
    }
}

/// The process-wide part of signal handling, registered once: for each of
/// `SIGINT` and `SIGTERM`, an emulation of the default action that runs
/// while `restore` is set, then an action that sets `restore`. Registry
/// actions run in registration order, so the first signal finds `restore`
/// unset and does nothing, then sets it, and the second terminates the
/// process. Nothing races: `restore` is set inside the signal handler.
///
/// signal-hook cannot put the operating system's default handling back
/// without unsafe code (unregistering the last action leaves the signal
/// ignored), so the actions stay registered for the life of the process:
/// with no listener left, `restore` stays set and both signals keep their
/// default action, even over handlers the application registers later
/// through signal-hook or Tokio.
struct Handling {
    restore: Arc<AtomicBool>,
    /// Live listeners.
    listeners: usize,
}

static HANDLING: Mutex<Option<Handling>> = Mutex::new(None);

/// A listener for the first `SIGINT` or `SIGTERM`.
pub(crate) struct SignalListener {
    received: oneshot::Receiver<()>,
    handle: Handle,
}

impl SignalListener {
    pub(crate) fn install() -> io::Result<Self> {
        let mut handling = HANDLING.lock().unwrap_or_else(PoisonError::into_inner);
        let restore = if let Some(existing) = &*handling {
            Arc::clone(&existing.restore)
        } else {
            let restore = Arc::new(AtomicBool::new(true));
            for signal in [SIGINT, SIGTERM] {
                signal_hook::flag::register_conditional_default(signal, Arc::clone(&restore))?;
                signal_hook::flag::register(signal, Arc::clone(&restore))?;
            }
            *handling = Some(Handling {
                restore: Arc::clone(&restore),
                listeners: 0,
            });
            restore
        };
        let mut signals = Signals::new([SIGINT, SIGTERM])?;
        let handle = signals.handle();
        let (tx, received) = oneshot::channel();
        std::thread::Builder::new()
            .name("libo11y-signals".to_owned())
            .spawn(move || {
                if signals.forever().next().is_some() {
                    let _ = tx.send(());
                }
            })?;
        // Listening: the next signal is this listener's, not the default.
        restore.store(false, Ordering::SeqCst);
        if let Some(handling) = handling.as_mut() {
            handling.listeners += 1;
        }
        Ok(Self { received, handle })
    }

    /// Resolves at the first signal.
    pub(crate) async fn wait(mut self) {
        // A closed listener never sends; then the wait ends with it.
        let _ = (&mut self.received).await;
    }
}

impl Drop for SignalListener {
    fn drop(&mut self) {
        self.handle.close();
        let mut handling = HANDLING.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(handling) = handling.as_mut() {
            handling.listeners = handling.listeners.saturating_sub(1);
            if handling.listeners == 0 {
                // Nobody listens: both signals take their default action.
                handling.restore.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::Duration;

    use crate::Environment;

    fn sdk() -> Sdk {
        Sdk::builder()
            .service_name("sig")
            .environment(Environment::Test)
            .without_otel_env()
            .build()
            .expect("hermetic SDK")
    }

    // go/signals_internal_test.go TestShutdownOnChannelSignal.
    #[tokio::test]
    async fn a_trigger_shuts_the_sdk_down() {
        let sdk = sdk();
        let (tx, rx) = oneshot::channel::<()>();
        let task = {
            let sdk = sdk.clone();
            tokio::spawn(async move {
                sdk.shutdown_after(async {
                    let _ = rx.await;
                })
                .await
            })
        };
        tx.send(()).expect("the task waits");
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("shut down after the trigger")
            .expect("joined")
            .expect("clean shutdown");
    }

    // One test, so nothing else in this binary raises a signal while the
    // default action is armed. A dropped listener must not leave an armed
    // default behind for the next one: the signal goes to the listener.
    #[tokio::test]
    async fn a_real_signal_wakes_the_listener_after_an_earlier_one_was_dropped() {
        drop(SignalListener::install().expect("handlers"));
        let listener = SignalListener::install().expect("handlers again");
        signal_hook::low_level::raise(SIGTERM).expect("raise");
        tokio::time::timeout(Duration::from_secs(5), listener.wait())
            .await
            .expect("woken by SIGTERM");
    }
}
