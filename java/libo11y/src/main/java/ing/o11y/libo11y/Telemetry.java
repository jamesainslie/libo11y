package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.ExportFailures;
import ing.o11y.libo11y.internal.PolicyBridges;
import ing.o11y.libo11y.internal.SensitivityPolicy;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.logs.LoggerProvider;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.TracerProvider;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Supplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Owned telemetry handle returned by {@link O11y#setup(O11yOptions)} and {@link O11y#init(O11yOptions)}.
 * Implements {@link AutoCloseable} with idempotent, bounded, concurrent per-signal shutdown.
 */
public final class Telemetry implements AutoCloseable {
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(5);
    private static final Logger INTERNAL = Logger.getLogger(Telemetry.class.getName());

    /** Everything {@link O11y} built for one handle. */
    record Parts(
            SdkTracerProvider sdkTracerProvider,
            SdkMeterProvider sdkMeterProvider,
            SdkLoggerProvider sdkLoggerProvider,
            MeterProvider policyMeterProvider,
            ContextPropagators propagators,
            Resource resource,
            SensitivityPolicy policy,
            StructuredLogger logger,
            Map<String, Object> effectiveConfig,
            PolicyBridges.JvmRuntimeMetrics runtimeMetrics,
            Duration defaultShutdownTimeout,
            boolean disabled,
            ExportFailures spanFailures,
            ExportFailures metricFailures,
            ExportFailures logFailures,
            Map<Spec.Signal, List<Supplier<CompletableResultCode>>> unownedParts,
            Consumer<Telemetry> onShutdownComplete) {}

    private final SdkTracerProvider sdkTracerProvider;
    private final TracerProvider tracerProvider;
    private final SdkMeterProvider sdkMeterProvider;
    private final SdkLoggerProvider sdkLoggerProvider;
    private final MeterProvider policyMeterProvider;
    private final ContextPropagators propagators;
    private final OpenTelemetry openTelemetry;
    private final Resource resource;
    private final SensitivityPolicy policy;
    private final StructuredLogger logger;
    private final Map<String, Object> effectiveConfig;
    private final PolicyBridges.JvmRuntimeMetrics runtimeMetrics;
    private final Duration defaultShutdownTimeout;
    private final ExportFailures spanFailures;
    private final ExportFailures metricFailures;
    private final ExportFailures logFailures;
    private final Map<Spec.Signal, List<Supplier<CompletableResultCode>>> unownedParts;
    private final Consumer<Telemetry> onShutdownComplete;

    private final AtomicReference<CompletableFuture<ShutdownReport>> shutdownFuture = new AtomicReference<>();

    Telemetry(Parts parts) {
        this.sdkTracerProvider = parts.sdkTracerProvider();
        // While OTEL_SDK_DISABLED switches the SDK off, the no-op provider is handed out: it
        // records nothing, and a span it starts carries its parent's span context, so context
        // still propagates.
        this.tracerProvider = parts.disabled() ? TracerProvider.noop() : parts.sdkTracerProvider();
        this.sdkMeterProvider = parts.sdkMeterProvider();
        this.sdkLoggerProvider = parts.sdkLoggerProvider();
        this.policyMeterProvider = parts.policyMeterProvider();
        this.propagators = parts.propagators();
        this.resource = parts.resource();
        this.policy = parts.policy();
        this.logger = parts.logger();
        this.effectiveConfig = Collections.unmodifiableMap(new LinkedHashMap<>(parts.effectiveConfig()));
        this.runtimeMetrics = parts.runtimeMetrics();
        this.defaultShutdownTimeout = parts.defaultShutdownTimeout() == null
                ? DEFAULT_TIMEOUT
                : parts.defaultShutdownTimeout();
        this.spanFailures = parts.spanFailures();
        this.metricFailures = parts.metricFailures();
        this.logFailures = parts.logFailures();
        this.unownedParts = parts.unownedParts();
        this.onShutdownComplete = parts.onShutdownComplete();

        TracerProvider tracers = this.tracerProvider;
        this.openTelemetry = new OpenTelemetry() {
            @Override
            public TracerProvider getTracerProvider() {
                return tracers;
            }

            @Override
            public MeterProvider getMeterProvider() {
                return policyMeterProvider;
            }

            @Override
            public LoggerProvider getLogsBridge() {
                return sdkLoggerProvider;
            }

            @Override
            public ContextPropagators getPropagators() {
                return propagators;
            }
        };
    }

    /** Returns an OpenTelemetry facade backed by this handle's single pipeline and policy-enforcing meter provider. */
    public OpenTelemetry openTelemetry() {
        return openTelemetry;
    }

    /**
     * Returns the SDK tracer provider. While {@code OTEL_SDK_DISABLED} switches the SDK off it has
     * no processor and samples nothing, and {@link #tracerProvider()} hands out the no-op provider.
     */
    public SdkTracerProvider sdkTracerProvider() {
        return sdkTracerProvider;
    }

    public SdkLoggerProvider sdkLoggerProvider() {
        return sdkLoggerProvider;
    }

    /**
     * Returns the tracer provider: the SDK's, or the OpenTelemetry no-op provider while
     * {@code OTEL_SDK_DISABLED} switches the SDK off, which records nothing and keeps the
     * parent's span context so context still propagates.
     */
    public TracerProvider tracerProvider() {
        return tracerProvider;
    }

    /**
     * Returns the sensitivity-enforcing {@link MeterProvider}: it drops secret attributes, and PII
     * attributes unless the PII mode is {@link PiiMode#KEEP}, from every measurement before the SDK
     * sees it, so neither data points nor exemplars carry them. This and {@link #openTelemetry()}
     * are the only ways to get a meter; the SDK meter provider itself is not exposed.
     */
    public MeterProvider meterProvider() {
        return policyMeterProvider;
    }

    public LoggerProvider loggerProvider() {
        return sdkLoggerProvider;
    }

    public ContextPropagators propagators() {
        return propagators;
    }

    public Tracer tracer(String instrumentationScopeName) {
        return tracerProvider.get(instrumentationScopeName);
    }

    public Meter meter(String instrumentationScopeName) {
        return policyMeterProvider.get(instrumentationScopeName);
    }

    public StructuredLogger logger() {
        return logger;
    }

    public void event(String eventName, Map<String, Object> attrs) {
        logger.event(eventName, attrs);
    }

    public Resource resource() {
        return resource;
    }

    public SensitivityPolicy policy() {
        return policy;
    }

    public Map<String, Object> effectiveConfig() {
        return effectiveConfig;
    }

    /**
     * Exports everything buffered on every signal without stopping the pipelines, and waits at
     * most {@code timeout} (the shutdown timeout when {@code null}, zero or negative). The report
     * names, per signal, a flush that failed or did not finish in time, and every export that
     * failed while the call ran, including a batch a background worker exported that the call did
     * not start.
     *
     * @param timeout the longest the call waits
     * @return the per-signal result
     */
    public ShutdownReport forceFlush(Duration timeout) {
        long deadlineNanos = System.nanoTime() + budget(timeout).toNanos();
        ExportFailures.Window traces = spanFailures.open();
        ExportFailures.Window metrics = metricFailures.open();
        ExportFailures.Window logs = logFailures.open();
        Throwable[] started = new Throwable[3];
        CompletableResultCode t = start(sdkTracerProvider::forceFlush, started, 0);
        CompletableResultCode m = start(sdkMeterProvider::forceFlush, started, 1);
        CompletableResultCode l = start(sdkLoggerProvider::forceFlush, started, 2);
        return new ShutdownReport(
                flushOutcome(Spec.Signal.TRACES, t, started[0], traces, deadlineNanos),
                flushOutcome(Spec.Signal.METRICS, m, started[1], metrics, deadlineNanos),
                flushOutcome(Spec.Signal.LOGS, l, started[2], logs, deadlineNanos));
    }

    private static CompletableResultCode start(Supplier<CompletableResultCode> call, Throwable[] thrown, int i) {
        try {
            return call.get();
        } catch (RuntimeException ex) {
            thrown[i] = ex;
            return null;
        }
    }

    private static Throwable flushOutcome(
            Spec.Signal signal,
            CompletableResultCode result,
            Throwable thrown,
            ExportFailures.Window window,
            long deadlineNanos) {
        Throwable err = thrown;
        if (result != null) {
            result.join(Math.max(0L, deadlineNanos - System.nanoTime()), TimeUnit.NANOSECONDS);
            if (!result.isDone()) {
                err = new TimeoutException(signal + " flush exceeded deadline");
            } else if (!result.isSuccess()) {
                err = failure(signal + " flush failed", result);
            }
        }
        return combine(err, window.close());
    }

    public ShutdownReport shutdown() {
        return shutdown(defaultShutdownTimeout);
    }

    /**
     * Shuts down traces, metrics and logs concurrently under one deadline, {@code timeout} (the
     * shutdown timeout when {@code null}, zero or negative): each signal starts at once on its own
     * thread, so a hung exporter or processor on one signal cannot delay the others, and the call
     * returns by the deadline whatever they do. The report names, per signal, a shutdown that
     * failed or did not finish in time and every export that failed while it ran, including the
     * final batch. For each failed signal the {@code o11y.telemetry.dropped} event is emitted, best
     * effort, to the log sinks still running (the console and extra sinks).
     *
     * <p>Shutdown is idempotent: the first call performs it, and every later or concurrent call
     * returns the same report, except that a caller still waiting when its own deadline passes
     * gets a report whose every signal is a {@link TimeoutException}.
     *
     * @param timeout the longest the call waits
     * @return the per-signal result
     */
    public ShutdownReport shutdown(Duration timeout) {
        long deadlineNanos = System.nanoTime() + budget(timeout).toNanos();
        CompletableFuture<ShutdownReport> mine = new CompletableFuture<>();
        CompletableFuture<ShutdownReport> existing = shutdownFuture.compareAndExchange(null, mine);
        if (existing != null) {
            return awaitOther(existing, deadlineNanos);
        }
        RuntimeException callbackFailure = null;
        ShutdownReport report = null;
        try {
            report = runShutdown(deadlineNanos);
            if (onShutdownComplete != null) {
                try {
                    onShutdownComplete.accept(this);
                } catch (RuntimeException ex) {
                    callbackFailure = ex;
                }
            }
        } finally {
            // Complete the shared result on every path, so no other caller can wait forever.
            if (report == null) {
                IllegalStateException aborted = new IllegalStateException("telemetry shutdown aborted");
                report = new ShutdownReport(aborted, aborted, aborted);
            }
            mine.complete(report);
        }
        if (callbackFailure != null) {
            throw callbackFailure;
        }
        return report;
    }

    private ShutdownReport runShutdown(long deadlineNanos) {
        Throwable runtimeErr = null;
        if (runtimeMetrics != null) {
            try {
                runtimeMetrics.close();
            } catch (RuntimeException ex) {
                runtimeErr = ex;
            }
        }
        CompletableFuture<Throwable> traces = startShutdown(
                Spec.Signal.TRACES, sdkTracerProvider::shutdown, spanFailures);
        CompletableFuture<Throwable> metrics = startShutdown(
                Spec.Signal.METRICS, sdkMeterProvider::shutdown, metricFailures);
        CompletableFuture<Throwable> logs = startShutdown(
                Spec.Signal.LOGS, sdkLoggerProvider::shutdown, logFailures);

        Throwable traceErr = await(Spec.Signal.TRACES, traces, deadlineNanos);
        Throwable metricErr = combine(runtimeErr, await(Spec.Signal.METRICS, metrics, deadlineNanos));
        Throwable logErr = await(Spec.Signal.LOGS, logs, deadlineNanos);

        // The OTLP log leg is down by now, so the events reach the console and extra sinks only.
        emitDropped(Spec.Signal.TRACES, traceErr);
        emitDropped(Spec.Signal.METRICS, metricErr);
        emitDropped(Spec.Signal.LOGS, logErr);
        return new ShutdownReport(traceErr, metricErr, logErr);
    }

    /**
     * Starts one signal's shutdown on its own daemon thread: the provider, then the injected parts
     * of that signal no provider owns. The future completes with the signal's error, or
     * {@code null}, once every part has finished, however long that takes.
     */
    private CompletableFuture<Throwable> startShutdown(
            Spec.Signal signal, Supplier<CompletableResultCode> provider, ExportFailures failures) {
        CompletableFuture<Throwable> done = new CompletableFuture<>();
        ExportFailures.Window window = failures.open();
        List<Supplier<CompletableResultCode>> steps = new ArrayList<>();
        steps.add(provider);
        steps.addAll(unownedParts.getOrDefault(signal, List.of()));
        Thread.ofPlatform().daemon().name("libo11y-shutdown-" + signal).start(() -> {
            List<CompletableResultCode> results = new ArrayList<>(steps.size());
            Throwable thrown = null;
            for (Supplier<CompletableResultCode> step : steps) {
                try {
                    results.add(step.get());
                } catch (RuntimeException ex) {
                    thrown = combine(thrown, ex);
                }
            }
            Throwable syncErr = thrown;
            CompletableResultCode all = CompletableResultCode.ofAll(results);
            all.whenComplete(() -> {
                Throwable err = syncErr;
                for (CompletableResultCode r : results) {
                    if (!r.isSuccess()) {
                        err = combine(err, failure(signal + " shutdown failed", r));
                    }
                }
                done.complete(combine(err, window.close()));
            });
        });
        return done;
    }

    private static Throwable await(Spec.Signal signal, CompletableFuture<Throwable> step, long deadlineNanos) {
        try {
            return step.get(Math.max(0L, deadlineNanos - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (TimeoutException ex) {
            return new TimeoutException(signal + " shutdown exceeded deadline");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return ex;
        } catch (ExecutionException ex) {
            return ex.getCause();
        }
    }

    private static ShutdownReport awaitOther(CompletableFuture<ShutdownReport> running, long deadlineNanos) {
        try {
            return running.get(Math.max(0L, deadlineNanos - System.nanoTime()), TimeUnit.NANOSECONDS);
        } catch (TimeoutException ex) {
            return new ShutdownReport(waited(Spec.Signal.TRACES), waited(Spec.Signal.METRICS), waited(Spec.Signal.LOGS));
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return new ShutdownReport(ex, ex, ex);
        } catch (ExecutionException ex) {
            return new ShutdownReport(ex.getCause(), ex.getCause(), ex.getCause());
        }
    }

    private static TimeoutException waited(Spec.Signal signal) {
        return new TimeoutException("waiting for the " + signal + " shutdown another caller runs exceeded deadline");
    }

    /** Emits o11y.telemetry.dropped for a signal that failed, as Go does: its signal and the error's type. */
    private void emitDropped(Spec.Signal signal, Throwable err) {
        if (err == null) {
            return;
        }
        Map<String, Object> attrs = new LinkedHashMap<>();
        attrs.put(Spec.Attributes.SIGNAL.getKey(), signal.value());
        attrs.put("error.type", err.getClass().getName());
        try {
            logger.event(Spec.Events.TELEMETRY_DROPPED, attrs);
        } catch (RuntimeException ex) {
            err.addSuppressed(ex);
        }
    }

    private static Throwable failure(String message, CompletableResultCode result) {
        Throwable cause = result.getFailureThrowable();
        return cause != null ? cause : new IllegalStateException(message);
    }

    /** Returns {@code first}, with {@code next} suppressed onto it, or whichever is not {@code null}. */
    private static Throwable combine(Throwable first, Throwable next) {
        if (first == null) {
            return next;
        }
        if (next != null && next != first) {
            first.addSuppressed(next);
        }
        return first;
    }

    private Duration budget(Duration timeout) {
        return (timeout == null || timeout.isNegative() || timeout.isZero()) ? defaultShutdownTimeout : timeout;
    }

    /**
     * Shuts down with the shutdown timeout, for try-with-resources. It never throws for a failed
     * shutdown, because a telemetry library must not fail its host: a failure is written to the
     * console sink, which also receives the {@code o11y.telemetry.dropped} events, or through
     * java.util.logging (standard error by default) when the console sink is off. Call
     * {@link #shutdown(Duration)} to inspect the result.
     */
    @Override
    public void close() {
        ShutdownReport report = shutdown(defaultShutdownTimeout);
        if (!report.isOk()) {
            reportFailure(report);
        }
    }

    /** Writes a failed shutdown where an operator will see it. */
    void reportFailure(ShutdownReport report) {
        reportProblem(report.toException().getMessage());
    }

    /**
     * Writes {@code message}, prefixed with {@code libo11y}, to the console sink as an ERROR record
     * that no level gate hides, or, when the console sink is off, through java.util.logging, the
     * channel the OpenTelemetry SDK reports its own errors on (standard error by default).
     */
    void reportProblem(String message) {
        String line = "libo11y " + message;
        if (logger.consoleEnabled()) {
            logger.emit(Context.root(), Severity.ERROR, line, null, Map.of(), true);
        } else {
            INTERNAL.log(Level.WARNING, line);
        }
    }

    /**
     * Stops a handle that {@link O11y#setup} is discarding because a later step failed, without
     * flushing and without waiting: every provider and unowned injected part is told to stop, and
     * a part that throws is suppressed onto {@code primary}. It claims the one shutdown, so a later
     * {@link #shutdown} reports a clean, finished shutdown, as Go's abandon does.
     */
    void abandon(Throwable primary) {
        if (!shutdownFuture.compareAndSet(null, CompletableFuture.completedFuture(ShutdownReport.OK))) {
            return;
        }
        List<Supplier<CompletableResultCode>> stops = new ArrayList<>();
        if (runtimeMetrics != null) {
            stops.add(() -> {
                runtimeMetrics.close();
                return CompletableResultCode.ofSuccess();
            });
        }
        stops.add(sdkLoggerProvider::shutdown);
        stops.add(sdkTracerProvider::shutdown);
        stops.add(sdkMeterProvider::shutdown);
        unownedParts.values().forEach(stops::addAll);
        for (Supplier<CompletableResultCode> stop : stops) {
            try {
                stop.get();
            } catch (RuntimeException ex) {
                primary.addSuppressed(ex);
            }
        }
    }
}
