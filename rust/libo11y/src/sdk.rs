//! The SDK handle: the providers, the resource, the policy and the
//! propagator one configuration builds, and their lifecycle.

use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::SdkLoggerProvider;
use opentelemetry_sdk::metrics::SdkMeterProvider;
use opentelemetry_sdk::trace::{SdkTracer, SdkTracerProvider};
use tracing::Subscriber;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::registry::LookupSpan;

use libo11y_spec::Signal;

use crate::export::Selection;
use crate::export::failures::ExportFailures;
use crate::layer::{Parts, PartsCell, layers};
use crate::lifecycle::{
    DEFAULT_SHUTDOWN_TIMEOUT, FlushError, Op, ShutdownCell, ShutdownError, SignalFailure, Step,
    run_steps,
};
use crate::log_layer::LogPipeline;
use crate::propagation::Propagator;
use crate::summary::Summary;
use crate::{Builder, Policy, Violations};

/// A configured libo11y SDK: tracer and meter providers that share one
/// resource, one sensitivity policy and one propagator, and the `tracing`
/// layers that feed them.
///
/// Build one with [`Builder::build`], which touches no process-global
/// state, or install one for the whole process with [`Builder::setup`].
/// Cloning is cheap: clones share the providers and the one shutdown.
#[derive(Clone)]
#[must_use = "keep the Sdk and shut it down before exit, or buffered telemetry is lost"]
pub struct Sdk(pub(crate) Arc<Inner>);

/// Everything one SDK owns.
pub(crate) struct Inner {
    pub(crate) resource: Resource,
    pub(crate) resource_violations: Violations,
    pub(crate) version_fallback: bool,
    pub(crate) policy: Policy,
    pub(crate) propagator: Propagator,
    /// Each signal's resolved export, which the metric exporter reads.
    #[allow(dead_code, reason = "the metric exporter reads it")]
    pub(crate) selection: Selection,
    pub(crate) summary: Summary,
    pub(crate) startup_summary: bool,
    pub(crate) tracer_provider: SdkTracerProvider,
    pub(crate) span_failures: ExportFailures,
    pub(crate) meter_provider: SdkMeterProvider,
    pub(crate) metric_failures: ExportFailures,
    pub(crate) logger_provider: Option<SdkLoggerProvider>,
    pub(crate) log_failures: ExportFailures,
    pub(crate) log_pipeline: Arc<LogPipeline>,
    /// What the `tracing` layers read.
    pub(crate) parts: Arc<Parts>,
    /// Whether setup installs the global `tracing` default.
    pub(crate) tracing_default: bool,
    /// Whether this SDK is the process's global one, whose shutdown
    /// releases the setup guard.
    pub(crate) global: AtomicBool,
    pub(crate) shutdown: ShutdownCell,
    /// Per signal (logs, metrics, traces), whether a shutdown or flush step
    /// is still running, so calls against a hung provider add no threads.
    pub(crate) busy: [Arc<AtomicBool>; 3],
}

impl Sdk {
    /// Starts building an SDK.
    pub fn builder() -> Builder {
        Builder::default()
    }

    /// The telemetry resource, stamped with the libo11y schema URL.
    #[must_use]
    pub fn resource(&self) -> &Resource {
        &self.0.resource
    }

    /// How many resource attributes the policy dropped or tokenized, and the
    /// identity rules broken under [`Builder::without_strict_identity`], per
    /// rule. These count on the resource signal of `o11y.schema.violations`.
    #[must_use]
    pub fn resource_violations(&self) -> &Violations {
        &self.0.resource_violations
    }

    /// Whether `service.version` fell back to `0.0.0-unknown` because no
    /// version resolved.
    #[must_use]
    pub fn service_version_fallback(&self) -> bool {
        self.0.version_fallback
    }

    /// The sensitivity policy.
    #[must_use]
    pub fn policy(&self) -> &Policy {
        &self.0.policy
    }

    /// The propagator, wrapped by the baggage egress filter.
    #[must_use]
    pub fn propagator(&self) -> &Propagator {
        &self.0.propagator
    }

    /// The tracer provider. While `OTEL_SDK_DISABLED` switches the SDK off
    /// it samples nothing and exports nothing, so spans record nothing and
    /// context still propagates.
    #[must_use]
    pub fn tracer_provider(&self) -> &SdkTracerProvider {
        &self.0.tracer_provider
    }

    /// A tracer on the SDK's tracer provider, for spans built with the
    /// OpenTelemetry API.
    #[must_use]
    pub fn tracer(&self, name: impl Into<Cow<'static, str>>) -> SdkTracer {
        self.0.tracer_provider.tracer(name)
    }

    /// The meter provider. While `OTEL_SDK_DISABLED` switches the SDK off it
    /// has no reader: instruments work and nothing is collected.
    #[must_use]
    pub fn meter_provider(&self) -> &SdkMeterProvider {
        &self.0.meter_provider
    }

    /// The logger provider behind the OTLP log leg, when logs are exported.
    #[must_use]
    pub fn logger_provider(&self) -> Option<&SdkLoggerProvider> {
        self.0.logger_provider.as_ref()
    }

    /// libo11y's `tracing` layers, to compose into a subscriber of your
    /// own: the diagnostics layer, which takes the OpenTelemetry crates'
    /// own diagnostics out of the stack and reports them to the error
    /// handler; the span layer, which turns `tracing` spans into
    /// OpenTelemetry spans on this SDK's tracer and sets a span's status
    /// from an `ERROR` event inside it; and the log layer, which
    /// classifies, correlates and fans `tracing` events out to the console,
    /// OTLP and extra log sinks.
    ///
    /// ```
    /// use tracing_subscriber::layer::SubscriberExt as _;
    ///
    /// let sdk = libo11y::Sdk::builder()
    ///     .service_name("checkout")
    ///     .environment(libo11y::Environment::Test)
    ///     .without_otel_env()
    ///     .build()?;
    /// let subscriber = tracing_subscriber::registry().with(sdk.tracing_layer());
    /// tracing::subscriber::with_default(subscriber, || {
    ///     let _span = tracing::info_span!("work").entered();
    /// });
    /// # Ok::<(), libo11y::Error>(())
    /// ```
    #[must_use]
    pub fn tracing_layer<S>(&self) -> impl Layer<S> + Send + Sync + 'static
    where
        S: Subscriber + for<'span> LookupSpan<'span> + Send + Sync,
    {
        layers::<S>(&Arc::new(PartsCell::new(Arc::clone(&self.0.parts))))
    }

    /// A subscriber of libo11y's layers alone, for
    /// `tracing::subscriber::set_default` and the like.
    #[must_use]
    pub fn subscriber(&self) -> impl Subscriber + for<'span> LookupSpan<'span> + Send + Sync {
        tracing_subscriber::registry().with(self.tracing_layer())
    }

    /// Shuts every signal down with the default five-second deadline; see
    /// [`Sdk::shutdown_with_timeout`].
    ///
    /// # Errors
    ///
    /// The signals that failed to shut down, as [`ShutdownError`] lists them.
    pub fn shutdown(&self) -> Result<(), ShutdownError> {
        self.shutdown_with_timeout(DEFAULT_SHUTDOWN_TIMEOUT)
    }

    /// Flushes and stops every signal's provider, each on a thread of its
    /// own under one deadline, `timeout` from now: a hung exporter on one
    /// signal neither starves the others nor holds this call past the
    /// deadline.
    ///
    /// Shutdown happens once. The first caller runs it; a later caller gets
    /// the same result, and one that arrives while it runs waits no longer
    /// than its own `timeout`. The error reports each failed signal with
    /// every export that failed while the call ran, including the final
    /// batch that upstream's processors would otherwise report as success.
    /// Shutting down the global SDK lets [`Builder::setup`] run again; its
    /// providers stay installed until then.
    ///
    /// # Errors
    ///
    /// The signals that failed or were still running at the deadline, or,
    /// for a caller that did not run the shutdown, its own timeout.
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), ShutdownError> {
        self.0.shutdown.run(timeout, || {
            // The global SDK's shutdown releases the setup guard however it
            // ends, a panic included.
            let _release = self
                .0
                .global
                .load(Ordering::Acquire)
                .then_some(crate::setup::ReleaseOnDrop);
            let failures = run_steps(Op::Shutdown, self.steps(Op::Shutdown), timeout);
            for failure in &failures {
                self.emit_dropped(failure);
            }
            ShutdownError::from_failures(failures).map_or(Ok(()), Err)
        })
    }

    /// Exports everything buffered with the default five-second deadline;
    /// see [`Sdk::force_flush_with_timeout`].
    ///
    /// # Errors
    ///
    /// The signals that failed to flush, as [`FlushError`] lists them.
    pub fn force_flush(&self) -> Result<(), FlushError> {
        self.force_flush_with_timeout(DEFAULT_SHUTDOWN_TIMEOUT)
    }

    /// Exports everything buffered without stopping the pipelines, each
    /// signal on a thread of its own under one deadline, `timeout` from now.
    ///
    /// # Errors
    ///
    /// The signals whose flush failed, or whose exports failed while the
    /// call ran, or that were still flushing at the deadline.
    pub fn force_flush_with_timeout(&self, timeout: Duration) -> Result<(), FlushError> {
        FlushError::from_failures(run_steps(Op::Flush, self.steps(Op::Flush), timeout))
            .map_or(Ok(()), Err)
    }

    /// The steps of a shutdown or a flush, in Go's order: logs (when they
    /// are exported), metrics, traces.
    fn steps(&self, op: Op) -> Vec<Step> {
        let busy = &self.0.busy;
        let mut steps = Vec::with_capacity(3);
        if let Some(provider) = self.0.logger_provider.clone() {
            let failures = self.0.log_failures.clone();
            steps.push(Step {
                signal: Signal::Logs,
                busy: Arc::clone(&busy[0]),
                run: Box::new(move |timeout| {
                    failures.during(|| match op {
                        Op::Shutdown => provider.shutdown_with_timeout(timeout),
                        Op::Flush => provider.force_flush(),
                    })
                }),
            });
        }
        let meters = self.0.meter_provider.clone();
        let failures = self.0.metric_failures.clone();
        steps.push(Step {
            signal: Signal::Metrics,
            busy: Arc::clone(&busy[1]),
            run: Box::new(move |timeout| {
                failures.during(|| match op {
                    Op::Shutdown => meters.shutdown_with_timeout(timeout),
                    Op::Flush => meters.force_flush(),
                })
            }),
        });
        let tracers = self.0.tracer_provider.clone();
        let failures = self.0.span_failures.clone();
        steps.push(Step {
            signal: Signal::Traces,
            busy: Arc::clone(&busy[2]),
            run: Box::new(move |timeout| {
                failures.during(|| match op {
                    Op::Shutdown => tracers.shutdown_with_timeout(timeout),
                    Op::Flush => tracers.force_flush(),
                })
            }),
        });
        steps
    }

    /// Reports a signal that failed to shut down as an
    /// `o11y.telemetry.dropped` event to the log sinks still running.
    fn emit_dropped(&self, failure: &SignalFailure) {
        self.emit_dropped_event(failure);
    }

    /// Stops an SDK that setup is discarding: nothing in it is worth
    /// flushing, so the providers are told to stop at once, on a detached
    /// thread so the caller does not wait, and a later shutdown reports a
    /// clean, finished one.
    pub(crate) fn abandon(&self) {
        if !self.0.shutdown.claim_finished() {
            return;
        }
        let inner = Arc::clone(&self.0);
        let _ = std::thread::Builder::new()
            .name("libo11y-abandon".to_owned())
            .spawn(move || {
                if let Some(logs) = &inner.logger_provider {
                    let _ = logs.shutdown_with_timeout(Duration::ZERO);
                }
                let _ = inner.tracer_provider.shutdown_with_timeout(Duration::ZERO);
                let _ = inner.meter_provider.shutdown_with_timeout(Duration::ZERO);
            });
    }

    /// Shuts every signal down on a blocking thread with the default
    /// five-second deadline; see [`Sdk::shutdown_with_timeout`].
    ///
    /// # Errors
    ///
    /// As [`Sdk::shutdown_with_timeout`], or the blocking task's failure.
    #[cfg(feature = "tokio")]
    pub async fn shutdown_async(&self) -> Result<(), ShutdownError> {
        self.shutdown_with_timeout_async(DEFAULT_SHUTDOWN_TIMEOUT)
            .await
    }

    /// Runs [`Sdk::shutdown_with_timeout`] on a thread of its own and
    /// awaits it, so an async caller does not block its worker thread. It
    /// needs no particular runtime.
    ///
    /// # Errors
    ///
    /// As [`Sdk::shutdown_with_timeout`], or the shutdown thread's failure.
    #[cfg(feature = "tokio")]
    pub async fn shutdown_with_timeout_async(
        &self,
        timeout: Duration,
    ) -> Result<(), ShutdownError> {
        let sdk = self.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("libo11y-shutdown".to_owned())
            .spawn(move || {
                // The caller may have stopped waiting; the shutdown still ran.
                let _ = tx.send(sdk.shutdown_with_timeout(timeout));
            })
            .map_err(|err| ShutdownError::task(format!("starting the shutdown thread: {err}")))?;
        rx.await.unwrap_or_else(|_| {
            Err(ShutdownError::task(
                "the shutdown thread stopped".to_owned(),
            ))
        })
    }
}

impl fmt::Debug for Sdk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sdk")
            .field("resource", &self.0.resource)
            .field("policy", &self.0.policy)
            .field("propagator", &self.0.propagator)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::AtomicUsize;
    use std::sync::{Condvar, Mutex};
    use std::time::Instant;

    use opentelemetry::logs::{LogRecord as _, Logger as _, LoggerProvider as _};
    use opentelemetry::metrics::MeterProvider as _;
    use opentelemetry::trace::{Span as _, Tracer as _};
    use opentelemetry_sdk::error::{OTelSdkError, OTelSdkResult};
    use opentelemetry_sdk::logs::{LogBatch, LogExporter};
    use opentelemetry_sdk::metrics::Temporality;
    use opentelemetry_sdk::metrics::data::ResourceMetrics;
    use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SpanData, SpanExporter};

    use crate::Environment;

    /// A gate exports wait on until a test opens it.
    #[derive(Debug, Default, Clone)]
    struct Gate(Arc<(Mutex<bool>, Condvar)>);

    impl Gate {
        fn wait(&self) {
            let (open, cv) = &*self.0;
            let guard = open.lock().expect("gate");
            let _open = cv.wait_while(guard, |open| !*open).expect("gate");
        }

        fn open(&self) {
            let (open, cv) = &*self.0;
            *open.lock().expect("gate") = true;
            cv.notify_all();
        }
    }

    /// Opens the gate when the test ends, so hung exports finish.
    struct OpenOnDrop(Gate);

    impl Drop for OpenOnDrop {
        fn drop(&mut self) {
            self.0.open();
        }
    }

    /// A log exporter whose exports block until the gate opens.
    #[derive(Debug)]
    struct HangingLogs(Gate);

    impl LogExporter for HangingLogs {
        fn export(&self, _: LogBatch<'_>) -> impl Future<Output = OTelSdkResult> + Send {
            self.0.wait();
            std::future::ready(Ok(()))
        }
    }

    /// A span exporter that keeps what it received through shutdown, which
    /// the in-memory exporter clears.
    #[derive(Debug, Clone, Default)]
    struct KeptSpans(InMemorySpanExporter);

    impl SpanExporter for KeptSpans {
        fn export(&self, batch: Vec<SpanData>) -> impl Future<Output = OTelSdkResult> + Send {
            self.0.export(batch)
        }
    }

    /// Fails the exports it is told to: every one when `always`, else only
    /// the first.
    #[derive(Debug, Default)]
    struct FailGate {
        always: bool,
        calls: AtomicUsize,
        /// When set, the first export waits until this SDK records failures.
        window: Mutex<Option<(Sdk, Signal)>>,
    }

    impl FailGate {
        fn export(&self) -> OTelSdkResult {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let window = self.window.lock().expect("window").clone();
            if let Some((sdk, signal)) = window {
                if n != 0 {
                    return Ok(());
                }
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline && !sdk.window_open(signal) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                return Err(rejected());
            }
            if self.always || n == 0 {
                Err(rejected())
            } else {
                Ok(())
            }
        }
    }

    fn rejected() -> OTelSdkError {
        OTelSdkError::InternalFailure("collector rejected the export".to_owned())
    }

    #[derive(Debug)]
    struct FailingSpans(Arc<FailGate>);

    impl SpanExporter for FailingSpans {
        fn export(&self, _: Vec<SpanData>) -> impl Future<Output = OTelSdkResult> + Send {
            std::future::ready(self.0.export())
        }
    }

    #[derive(Debug)]
    struct FailingLogs(Arc<FailGate>);

    impl LogExporter for FailingLogs {
        fn export(&self, _: LogBatch<'_>) -> impl Future<Output = OTelSdkResult> + Send {
            std::future::ready(self.0.export())
        }
    }

    #[derive(Debug)]
    struct FailingMetrics(Arc<FailGate>);

    impl PushMetricExporter for FailingMetrics {
        fn export(&self, _: &ResourceMetrics) -> impl Future<Output = OTelSdkResult> + Send {
            std::future::ready(self.0.export())
        }

        fn force_flush(&self) -> OTelSdkResult {
            Ok(())
        }

        fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
            Ok(())
        }

        fn temporality(&self) -> Temporality {
            Temporality::Cumulative
        }
    }

    impl Sdk {
        /// Whether a shutdown or flush is recording `signal`'s failures.
        fn window_open(&self, signal: Signal) -> bool {
            match signal {
                Signal::Logs => self.0.log_failures.window_open(),
                _ => self.0.span_failures.window_open(),
            }
        }
    }

    fn hermetic() -> Builder {
        Sdk::builder()
            .service_name("lifecycle")
            .environment(Environment::Test)
            .without_otel_env()
            .with_error_handler(|_| {})
    }

    fn emit(sdk: &Sdk, signal: Signal, n: usize) {
        match signal {
            Signal::Traces => {
                let tracer = sdk.tracer("t");
                for _ in 0..n {
                    tracer.start("op").end();
                }
            }
            Signal::Logs => {
                let logger = sdk.logger_provider().expect("log export").logger("t");
                for _ in 0..n {
                    let mut record = logger.create_log_record();
                    record.set_body("record".into());
                    logger.emit(record);
                }
            }
            _ => {
                let counter = sdk.meter_provider().meter("t").u64_counter("c").build();
                counter.add(u64::try_from(n).expect("small"), &[]);
            }
        }
    }

    fn failing(signal: Signal, gate: &Arc<FailGate>) -> Sdk {
        let gate = Arc::clone(gate);
        match signal {
            Signal::Traces => hermetic().with_span_exporter(FailingSpans(gate)),
            Signal::Logs => hermetic().with_log_exporter(FailingLogs(gate)),
            _ => hermetic().with_metric_exporter(FailingMetrics(gate)),
        }
        .build()
        .expect("SDK")
    }

    const SIGNALS: [Signal; 3] = [Signal::Traces, Signal::Logs, Signal::Metrics];

    // go/shutdown_test.go TestHungLogExportDoesNotStarveTraces.
    #[test]
    fn a_hung_log_export_does_not_starve_traces() {
        let gate = Gate::default();
        let _release = OpenOnDrop(gate.clone());
        let spans = KeptSpans::default();
        let sdk = hermetic()
            .with_log_exporter(HangingLogs(gate))
            .with_span_exporter(spans.clone())
            .build()
            .expect("SDK");
        emit(&sdk, Signal::Logs, 1);
        emit(&sdk, Signal::Traces, 1);
        let start = Instant::now();
        let err = sdk
            .shutdown_with_timeout(Duration::from_secs(1))
            .expect_err("the log export hangs");
        // Wide on purpose: it catches a shutdown that ignores its deadline,
        // not a slow machine.
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "{:?}",
            start.elapsed()
        );
        assert!(err.to_string().contains("o11y: shutdown logs"), "{err}");
        assert_eq!(err.failures()[0].signal(), Signal::Logs);
        assert_eq!(
            spans.0.get_finished_spans().expect("spans").len(),
            1,
            "a hung log exporter starved the trace flush"
        );
    }

    // TestConcurrentShutdownHonorsEachCallersDeadline.
    #[test]
    fn a_concurrent_caller_honors_its_own_deadline() {
        let gate = Gate::default();
        let release = OpenOnDrop(gate.clone());
        let sdk = hermetic()
            .with_log_exporter(HangingLogs(gate))
            .build()
            .expect("SDK");
        emit(&sdk, Signal::Logs, 1);
        let first = {
            let sdk = sdk.clone();
            std::thread::spawn(move || sdk.shutdown_with_timeout(Duration::from_secs(20)))
        };
        while !sdk.window_open(Signal::Logs) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let start = Instant::now();
        let err = sdk
            .shutdown_with_timeout(Duration::from_millis(100))
            .expect_err("still running");
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(err.is_wait_timeout(), "{err}");
        drop(release);
        first
            .join()
            .expect("joined")
            .expect("finished once released");
    }

    // TestShutdownAfterCompletionIgnoresCallerContext.
    #[test]
    fn the_completed_result_wins() {
        let sdk = hermetic().build().expect("SDK");
        sdk.shutdown().expect("clean");
        for _ in 0..20 {
            sdk.clone()
                .shutdown_with_timeout(Duration::ZERO)
                .expect("the stored result");
        }
    }

    // go/exportfail_test.go TestShutdownReportsRejectedFinalExport.
    #[test]
    fn shutdown_reports_a_rejected_final_export() {
        for signal in SIGNALS {
            let gate = Arc::new(FailGate {
                always: true,
                ..FailGate::default()
            });
            let sdk = failing(signal, &gate);
            emit(&sdk, signal, 1);
            let err = sdk.shutdown().expect_err("rejected");
            let text = err.to_string();
            assert!(text.contains(&format!("o11y: shutdown {signal}")), "{text}");
            assert!(text.contains("collector rejected the export"), "{text}");
            assert_eq!(err.failures().len(), 1, "{text}");
        }
    }

    // TestForceFlushReportsRejectedExport.
    #[test]
    fn flush_reports_a_rejected_export() {
        for signal in SIGNALS {
            let gate = Arc::new(FailGate {
                always: true,
                ..FailGate::default()
            });
            let sdk = failing(signal, &gate);
            emit(&sdk, signal, 1);
            let err = sdk.force_flush().expect_err("rejected");
            let text = err.to_string();
            assert!(text.contains(&format!("o11y: flush {signal}")), "{text}");
            assert!(text.contains("collector rejected the export"), "{text}");
            let _ = sdk.shutdown();
        }
    }

    // TestForceFlushWindowEndsWithTheCall.
    #[test]
    fn a_failure_is_reported_only_by_its_call() {
        for signal in SIGNALS {
            let gate = Arc::new(FailGate::default());
            let sdk = failing(signal, &gate);
            emit(&sdk, signal, 1);
            sdk.force_flush().expect_err("the first export fails");
            emit(&sdk, signal, 1);
            sdk.force_flush()
                .unwrap_or_else(|err| panic!("{signal}: a later clean flush failed: {err}"));
            let _ = sdk.shutdown();
        }
    }

    // TestForceFlushReportsBatchExportFailedDuringCall: more than one batch
    // is emitted, so the processor exports a full batch on its own thread,
    // which fails while the flush runs; the flush's own export succeeds.
    #[test]
    fn flush_reports_a_batch_export_failed_during_the_call() {
        for signal in [Signal::Traces, Signal::Logs] {
            let gate = Arc::new(FailGate::default());
            let sdk = failing(signal, &gate);
            *gate.window.lock().expect("window") = Some((sdk.clone(), signal));
            emit(&sdk, signal, 513);
            let err = sdk.force_flush().expect_err("the batch export failed");
            assert!(
                err.to_string().contains("collector rejected the export"),
                "{signal}: {err}"
            );
            *gate.window.lock().expect("window") = None;
            let _ = sdk.shutdown();
        }
    }
}
