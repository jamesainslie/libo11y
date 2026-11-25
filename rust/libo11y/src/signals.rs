//! Shutdown on `SIGINT` and `SIGTERM`.

use std::future::Future;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
    /// default handling too.
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

/// A listener for the first `SIGINT` or `SIGTERM`.
///
/// Each signal gets three actions: an emulation of its default action that
/// runs once `restore` is set, an action that sets `restore`, and the
/// iterator that wakes the waiting thread. On the first signal the
/// emulation sees `restore` unset and does nothing, then `restore` is set,
/// so the second signal terminates the process. Nothing races: `restore`
/// is set inside the signal handler.
pub(crate) struct SignalListener {
    received: oneshot::Receiver<()>,
    handle: Handle,
    restore: Arc<AtomicBool>,
}

impl SignalListener {
    pub(crate) fn install() -> io::Result<Self> {
        let restore = Arc::new(AtomicBool::new(false));
        for signal in [SIGINT, SIGTERM] {
            signal_hook::flag::register_conditional_default(signal, Arc::clone(&restore))?;
            signal_hook::flag::register(signal, Arc::clone(&restore))?;
        }
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
        Ok(Self {
            received,
            handle,
            restore,
        })
    }

    /// Resolves at the first signal.
    pub(crate) async fn wait(mut self) {
        // A closed listener never sends; then the wait ends with it.
        let _ = (&mut self.received).await;
    }
}

impl Drop for SignalListener {
    fn drop(&mut self) {
        // Whether or not a signal came, the default handling is back.
        self.restore.store(true, Ordering::SeqCst);
        self.handle.close();
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

    #[tokio::test]
    async fn a_real_signal_wakes_the_listener() {
        let listener = SignalListener::install().expect("handlers");
        signal_hook::low_level::raise(SIGTERM).expect("raise");
        tokio::time::timeout(Duration::from_secs(5), listener.wait())
            .await
            .expect("woken by SIGTERM");
    }
}
