//! Bounded shutdown and flush.
//!
//! Upstream's providers shut down their processors one after another, each
//! with the whole timeout, the meter provider ignores its timeout, and its
//! flush has none. libo11y runs each signal's provider on a thread of its
//! own and stops waiting at one deadline, so a hung exporter on one signal
//! neither starves the others nor holds the caller past the deadline.

use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use libo11y_spec::Signal;

use crate::export::failures::SharedError;

/// How long shutdown and flush wait when the caller gives no timeout.
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

/// Which call a failure belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Shutdown,
    Flush,
}

impl Op {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Shutdown => "shutdown",
            Self::Flush => "flush",
        }
    }
}

/// How one signal failed to shut down or flush.
#[derive(Debug, Clone)]
pub struct SignalFailure {
    op: Op,
    signal: Signal,
    kind: FailureKind,
}

#[derive(Debug, Clone)]
enum FailureKind {
    /// The provider returned an error, or exports failed while the call
    /// ran, or both.
    Errors(Vec<SharedError>),
    /// The provider was still running at the deadline.
    TimedOut(Duration),
    /// An earlier call's step for the signal was still running, so this
    /// call started none: hung providers do not pile up threads.
    StillRunning,
    /// The provider panicked.
    Panicked,
}

impl SignalFailure {
    /// The signal that failed.
    #[must_use]
    pub fn signal(&self) -> Signal {
        self.signal
    }

    /// Whether the signal's provider was still running at the deadline, or
    /// still running from an earlier call.
    #[must_use]
    pub fn is_timeout(&self) -> bool {
        matches!(
            self.kind,
            FailureKind::TimedOut(_) | FailureKind::StillRunning
        )
    }

    /// Low-cardinality `error.type` classification for `o11y.telemetry.dropped`.
    pub(crate) const fn error_type(&self) -> &'static str {
        match &self.kind {
            FailureKind::Errors(_) => "export_error",
            FailureKind::TimedOut(_) => "timeout",
            FailureKind::StillRunning => "still_running",
            FailureKind::Panicked => "panic",
        }
    }

    /// The errors the provider returned and the export failures recorded
    /// while the call ran, the provider's own first.
    pub fn errors(&self) -> impl Iterator<Item = &(dyn std::error::Error + Send + Sync + 'static)> {
        let errors: &[SharedError] = match &self.kind {
            FailureKind::Errors(errors) => errors,
            FailureKind::TimedOut(_) | FailureKind::StillRunning | FailureKind::Panicked => &[],
        };
        errors.iter().map(AsRef::as_ref)
    }
}

impl fmt::Display for SignalFailure {
    /// Go's `o11y: shutdown <signal>: ...` (or `flush`), with the errors
    /// one per line, as Go's `errors.Join` writes them.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "o11y: {} {}: ", self.op.as_str(), self.signal)?;
        match &self.kind {
            FailureKind::Errors(errors) => {
                for (i, err) in errors.iter().enumerate() {
                    if i > 0 {
                        f.write_str("\n")?;
                    }
                    write!(f, "{err}")?;
                }
                Ok(())
            }
            FailureKind::TimedOut(after) => write!(f, "deadline exceeded after {after:?}"),
            FailureKind::StillRunning => f.write_str("still running from an earlier call"),
            FailureKind::Panicked => f.write_str("the provider panicked"),
        }
    }
}

impl std::error::Error for SignalFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.kind {
            FailureKind::Errors(errors) => errors
                .first()
                .map(|err| err.as_ref() as &(dyn std::error::Error + 'static)),
            FailureKind::TimedOut(_) | FailureKind::StillRunning | FailureKind::Panicked => None,
        }
    }
}

/// Why a shutdown did not finish cleanly: the signals that failed, in
/// logs, metrics, traces order, or a caller that stopped waiting.
///
/// A shutdown error means buffered telemetry may have been lost, never
/// that the application is broken.
#[derive(Debug, Clone)]
pub struct ShutdownError {
    failures: Vec<SignalFailure>,
    wait: Option<WaitFailure>,
}

#[derive(Debug, Clone)]
enum WaitFailure {
    /// The caller's timeout passed while another caller's shutdown ran.
    TimedOut(Duration),
    /// The task running the shutdown failed.
    #[cfg_attr(
        not(feature = "tokio"),
        allow(dead_code, reason = "only the async shutdown runs a task")
    )]
    Task(String),
    /// The shutdown panicked, in code the log legs run after the providers.
    Panicked,
    /// The signal handlers could not be installed.
    #[cfg_attr(
        not(all(feature = "tokio", unix)),
        allow(dead_code, reason = "only shutdown on signals installs handlers")
    )]
    Signals(Arc<std::io::Error>),
}

impl ShutdownError {
    pub(crate) fn from_failures(failures: Vec<SignalFailure>) -> Option<Self> {
        (!failures.is_empty()).then_some(Self {
            failures,
            wait: None,
        })
    }

    fn panicked() -> Self {
        Self {
            failures: Vec::new(),
            wait: Some(WaitFailure::Panicked),
        }
    }

    fn waiting(timeout: Duration) -> Self {
        Self {
            failures: Vec::new(),
            wait: Some(WaitFailure::TimedOut(timeout)),
        }
    }

    #[cfg(feature = "tokio")]
    pub(crate) fn task(detail: String) -> Self {
        Self {
            failures: Vec::new(),
            wait: Some(WaitFailure::Task(detail)),
        }
    }

    #[cfg(all(feature = "tokio", unix))]
    pub(crate) fn signals(err: std::io::Error) -> Self {
        Self {
            failures: Vec::new(),
            wait: Some(WaitFailure::Signals(Arc::new(err))),
        }
    }

    /// The signals that failed, in logs, metrics, traces order.
    #[must_use]
    pub fn failures(&self) -> &[SignalFailure] {
        &self.failures
    }

    /// Whether this caller stopped waiting at its own timeout while a
    /// shutdown another caller started was still running.
    #[must_use]
    pub fn is_wait_timeout(&self) -> bool {
        matches!(self.wait, Some(WaitFailure::TimedOut(_)))
    }
}

impl fmt::Display for ShutdownError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut sep = "";
        for failure in &self.failures {
            write!(f, "{sep}{failure}")?;
            sep = "\n";
        }
        match &self.wait {
            None => Ok(()),
            Some(WaitFailure::TimedOut(after)) => {
                write!(
                    f,
                    "{sep}o11y: waiting for shutdown: deadline exceeded after {after:?}"
                )
            }
            Some(WaitFailure::Task(detail)) => {
                write!(f, "{sep}o11y: waiting for shutdown: {detail}")
            }
            Some(WaitFailure::Panicked) => write!(f, "{sep}o11y: shutdown panicked"),
            Some(WaitFailure::Signals(err)) => {
                write!(f, "{sep}o11y: listening for shutdown signals: {err}")
            }
        }
    }
}

impl std::error::Error for ShutdownError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.wait {
            Some(WaitFailure::Signals(err)) => Some(err.as_ref()),
            _ => self
                .failures
                .first()
                .map(|failure| failure as &(dyn std::error::Error + 'static)),
        }
    }
}

/// Why a flush did not finish cleanly: the signals that failed, in logs,
/// metrics, traces order.
#[derive(Debug, Clone)]
pub struct FlushError {
    failures: Vec<SignalFailure>,
}

impl FlushError {
    pub(crate) fn from_failures(failures: Vec<SignalFailure>) -> Option<Self> {
        (!failures.is_empty()).then_some(Self { failures })
    }

    /// The signals that failed, in logs, metrics, traces order.
    #[must_use]
    pub fn failures(&self) -> &[SignalFailure] {
        &self.failures
    }
}

impl fmt::Display for FlushError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut sep = "";
        for failure in &self.failures {
            write!(f, "{sep}{failure}")?;
            sep = "\n";
        }
        Ok(())
    }
}

impl std::error::Error for FlushError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.failures
            .first()
            .map(|failure| failure as &(dyn std::error::Error + 'static))
    }
}

/// One signal's part of a shutdown or flush.
pub(crate) struct Step {
    pub(crate) signal: Signal,
    /// Set while a step of this signal runs, across calls.
    pub(crate) busy: Arc<AtomicBool>,
    /// Given the timeout, returns the errors to report, none on success.
    pub(crate) run: Box<dyn FnOnce(Duration) -> Vec<SharedError> + Send + 'static>,
}

/// Runs every step on a thread of its own under one deadline, `timeout`
/// from now, and returns the failures in step order. A step still running
/// at the deadline is reported as timed out and left to finish on its own;
/// until it does, a later call starts no step for that signal. A timeout too
/// large to add to the clock waits without a deadline.
pub(crate) fn run_steps(op: Op, steps: Vec<Step>, timeout: Duration) -> Vec<SignalFailure> {
    let deadline = Instant::now().checked_add(timeout);
    let (tx, rx) = mpsc::channel();
    let mut outcomes: Vec<Option<FailureKind>> = Vec::with_capacity(steps.len());
    let signals: Vec<Signal> = steps.iter().map(|step| step.signal).collect();
    let mut pending = 0;
    for (i, step) in steps.into_iter().enumerate() {
        if step.busy.swap(true, Ordering::AcqRel) {
            outcomes.push(Some(FailureKind::StillRunning));
            continue;
        }
        let tx = tx.clone();
        let busy = Arc::clone(&step.busy);
        let run = step.run;
        let spawned = std::thread::Builder::new()
            .name(format!("libo11y-{}-{}", op.as_str(), step.signal))
            .spawn(move || {
                let outcome = match catch_unwind(AssertUnwindSafe(|| run(timeout))) {
                    Ok(errors) if errors.is_empty() => None,
                    Ok(errors) => Some(FailureKind::Errors(errors)),
                    Err(_) => Some(FailureKind::Panicked),
                };
                busy.store(false, Ordering::Release);
                // The caller may have stopped waiting; then nobody listens.
                let _ = tx.send((i, outcome));
            });
        match spawned {
            Ok(_) => {
                outcomes.push(Some(FailureKind::TimedOut(timeout)));
                pending += 1;
            }
            Err(err) => {
                step.busy.store(false, Ordering::Release);
                outcomes.push(Some(FailureKind::Errors(vec![Arc::new(err)])));
            }
        }
    }
    drop(tx);
    while pending > 0 {
        let received = match deadline {
            Some(deadline) => rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .ok(),
            None => rx.recv().ok(),
        };
        let Some((i, outcome)) = received else { break };
        outcomes[i] = outcome;
        pending -= 1;
    }
    outcomes
        .into_iter()
        .zip(signals)
        .filter_map(|(outcome, signal)| outcome.map(|kind| SignalFailure { op, signal, kind }))
        .collect()
}

/// The one shutdown of an SDK: the first caller runs it, every other
/// caller shares its result, waiting no longer than its own timeout.
#[derive(Debug, Default)]
pub(crate) struct ShutdownCell {
    state: Mutex<State>,
    done: Condvar,
}

#[derive(Debug, Default)]
enum State {
    #[default]
    Idle,
    Running,
    Done(Result<(), ShutdownError>),
}

impl ShutdownCell {
    /// Runs `shutdown` if no caller has, else waits up to `timeout` for the
    /// result of the caller that did. A finished shutdown's result wins over
    /// an expired timeout.
    pub(crate) fn run(
        &self,
        timeout: Duration,
        shutdown: impl FnOnce() -> Result<(), ShutdownError>,
    ) -> Result<(), ShutdownError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        match &*state {
            State::Idle => {
                *state = State::Running;
                drop(state);
                // A panic in `shutdown` still finishes the shutdown, so no
                // caller waits on it forever.
                let mut unwinding = Unwinding(Some(self));
                let result = shutdown();
                unwinding.0 = None;
                self.finish(result.clone());
                result
            }
            State::Done(result) => result.clone(),
            State::Running => {
                let (state, _) = self
                    .done
                    .wait_timeout_while(state, timeout, |s| matches!(s, State::Running))
                    .unwrap_or_else(PoisonError::into_inner);
                match &*state {
                    State::Done(result) => result.clone(),
                    State::Idle | State::Running => Err(ShutdownError::waiting(timeout)),
                }
            }
        }
    }

    /// Records the result and wakes every waiting caller.
    pub(crate) fn finish(&self, result: Result<(), ShutdownError>) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = State::Done(result);
        self.done.notify_all();
    }

    /// Claims the shutdown for an SDK being discarded, so a later
    /// `shutdown` reports a clean, finished one. Returns whether the claim
    /// succeeded.
    pub(crate) fn claim_finished(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(*state, State::Idle) {
            *state = State::Done(Ok(()));
            true
        } else {
            false
        }
    }
}

/// Finishes the shutdown as panicked when dropped while armed.
struct Unwinding<'a>(Option<&'a ShutdownCell>);

impl Drop for Unwinding<'_> {
    fn drop(&mut self) {
        if let Some(cell) = self.0 {
            cell.finish(Err(ShutdownError::panicked()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use opentelemetry_sdk::error::OTelSdkError;

    type Run = Box<dyn FnOnce(Duration) -> Vec<SharedError> + Send + 'static>;

    fn step(signal: Signal, run: Run) -> Step {
        Step {
            signal,
            busy: Arc::default(),
            run,
        }
    }

    fn ok() -> Run {
        Box::new(|_| Vec::new())
    }

    fn failing(message: &'static str) -> Run {
        Box::new(move |_| {
            vec![Arc::new(OTelSdkError::InternalFailure(message.to_owned())) as SharedError]
        })
    }

    /// A step that blocks until `release` drops its sender.
    fn hanging() -> (Run, mpsc::Sender<()>) {
        let (tx, rx) = mpsc::channel::<()>();
        (
            Box::new(move |_| {
                let _ = rx.recv();
                Vec::new()
            }),
            tx,
        )
    }

    #[test]
    fn every_signal_succeeds() {
        let failures = run_steps(
            Op::Shutdown,
            vec![
                step(Signal::Logs, ok()),
                step(Signal::Metrics, ok()),
                step(Signal::Traces, ok()),
            ],
            Duration::from_secs(5),
        );
        assert!(failures.is_empty());
    }

    #[test]
    fn failures_keep_step_order_with_gos_messages() {
        let failures = run_steps(
            Op::Shutdown,
            vec![
                step(Signal::Logs, failing("logs down")),
                step(Signal::Metrics, ok()),
                step(Signal::Traces, failing("traces down")),
            ],
            Duration::from_secs(5),
        );
        let err = ShutdownError::from_failures(failures).expect("two failed");
        assert_eq!(
            err.to_string(),
            "o11y: shutdown logs: Operation failed: logs down\no11y: shutdown traces: Operation failed: traces down"
        );
        let flush = FlushError::from_failures(run_steps(
            Op::Flush,
            vec![step(Signal::Metrics, failing("m"))],
            Duration::from_secs(5),
        ))
        .expect("failed");
        assert_eq!(
            flush.to_string(),
            "o11y: flush metrics: Operation failed: m"
        );
    }

    // go/shutdown_test.go TestHungLogExportDoesNotStarveTraces, at the step
    // level.
    #[test]
    fn a_hung_step_does_not_starve_the_others_or_the_caller() {
        let (hung, release) = hanging();
        let start = Instant::now();
        let failures = run_steps(
            Op::Shutdown,
            vec![
                step(Signal::Logs, hung),
                step(Signal::Metrics, ok()),
                step(Signal::Traces, failing("rejected")),
            ],
            Duration::from_millis(200),
        );
        let elapsed = start.elapsed();
        drop(release);
        assert!(elapsed < Duration::from_secs(5), "waited {elapsed:?}");
        assert_eq!(failures.len(), 2, "{failures:?}");
        assert_eq!(failures[0].signal(), Signal::Logs);
        assert!(failures[0].is_timeout());
        assert_eq!(
            failures[0].to_string(),
            "o11y: shutdown logs: deadline exceeded after 200ms"
        );
        assert_eq!(failures[1].signal(), Signal::Traces);
        assert!(!failures[1].is_timeout());
    }

    #[test]
    fn a_panicking_step_is_a_failure() {
        let failures = run_steps(
            Op::Flush,
            vec![step(
                Signal::Traces,
                Box::new(|_| -> Vec<SharedError> { panic!("exporter bug") }),
            )],
            Duration::from_secs(5),
        );
        assert_eq!(
            failures[0].to_string(),
            "o11y: flush traces: the provider panicked"
        );
    }

    #[test]
    fn a_timeout_too_large_for_the_clock_waits_without_a_deadline() {
        let failures = run_steps(
            Op::Shutdown,
            vec![step(Signal::Traces, failing("x")), step(Signal::Logs, ok())],
            Duration::MAX,
        );
        assert_eq!(failures.len(), 1);
        assert!(!failures[0].is_timeout());
    }

    #[test]
    fn a_hung_step_blocks_only_its_signal_in_a_later_call() {
        let busy = Arc::new(AtomicBool::new(false));
        let (hung, release) = hanging();
        let first = run_steps(
            Op::Flush,
            vec![Step {
                signal: Signal::Metrics,
                busy: Arc::clone(&busy),
                run: hung,
            }],
            Duration::from_millis(50),
        );
        assert!(first[0].is_timeout());
        let second = run_steps(
            Op::Flush,
            vec![
                Step {
                    signal: Signal::Metrics,
                    busy: Arc::clone(&busy),
                    run: Box::new(|_| unreachable!("no second thread")),
                },
                step(Signal::Traces, ok()),
            ],
            Duration::from_secs(5),
        );
        assert_eq!(second.len(), 1);
        assert_eq!(
            second[0].to_string(),
            "o11y: flush metrics: still running from an earlier call"
        );
        drop(release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while busy.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            run_steps(
                Op::Flush,
                vec![Step {
                    signal: Signal::Metrics,
                    busy,
                    run: ok(),
                }],
                Duration::from_secs(5),
            )
            .is_empty(),
            "the signal runs again once the hung step ends"
        );
    }

    #[test]
    fn a_panicking_shutdown_still_finishes() {
        let cell = ShutdownCell::default();
        let panicked = catch_unwind(AssertUnwindSafe(|| {
            cell.run(Duration::from_secs(1), || panic!("a log leg bug"))
        }));
        assert!(panicked.is_err());
        let err = cell
            .run(Duration::ZERO, || unreachable!("finished"))
            .expect_err("panicked");
        assert_eq!(err.to_string(), "o11y: shutdown panicked");
        assert!(!err.is_wait_timeout());
    }

    #[test]
    fn failures_expose_their_sources() {
        use std::error::Error as _;

        let err = ShutdownError::from_failures(run_steps(
            Op::Shutdown,
            vec![step(Signal::Traces, failing("rejected"))],
            Duration::from_secs(1),
        ))
        .expect("failed");
        let failure = err.source().expect("the failed signal");
        assert_eq!(
            failure.to_string(),
            "o11y: shutdown traces: Operation failed: rejected"
        );
        assert_eq!(
            failure.source().map(ToString::to_string).as_deref(),
            Some("Operation failed: rejected")
        );
    }

    // TestShutdownAfterCompletionIgnoresCallerContext.
    #[test]
    fn a_finished_result_is_shared_and_wins_over_a_zero_timeout() {
        let cell = ShutdownCell::default();
        let first = cell.run(Duration::from_secs(1), || {
            Err(ShutdownError::from_failures(run_steps(
                Op::Shutdown,
                vec![step(Signal::Traces, failing("x"))],
                Duration::from_secs(1),
            ))
            .expect("failed"))
        });
        let want = first.expect_err("failed").to_string();
        for _ in 0..20 {
            let again = cell.run(Duration::ZERO, || unreachable!("runs once"));
            assert_eq!(again.expect_err("shared").to_string(), want);
        }
    }

    // TestConcurrentShutdownHonorsEachCallersDeadline.
    #[test]
    fn a_waiting_caller_honors_its_own_timeout() {
        let cell = Arc::new(ShutdownCell::default());
        let (release, gate) = mpsc::channel::<()>();
        let (started_tx, started) = mpsc::channel();
        let first = {
            let cell = Arc::clone(&cell);
            std::thread::spawn(move || {
                cell.run(Duration::from_secs(20), || {
                    let _ = started_tx.send(());
                    let _ = gate.recv();
                    Ok(())
                })
            })
        };
        started.recv().expect("the first caller runs");
        let start = Instant::now();
        let second = cell.run(Duration::from_millis(100), || unreachable!("runs once"));
        assert!(start.elapsed() < Duration::from_secs(10));
        let err = second.expect_err("timed out");
        assert!(err.is_wait_timeout());
        assert_eq!(
            err.to_string(),
            "o11y: waiting for shutdown: deadline exceeded after 100ms"
        );
        drop(release);
        first
            .join()
            .expect("joined")
            .expect("the first caller finished");
        cell.run(Duration::ZERO, || unreachable!("runs once"))
            .expect("the finished result");
    }

    #[test]
    fn a_claimed_shutdown_reports_clean() {
        let cell = ShutdownCell::default();
        assert!(cell.claim_finished());
        assert!(!cell.claim_finished());
        cell.run(Duration::ZERO, || unreachable!("already finished"))
            .expect("clean");
    }
}
