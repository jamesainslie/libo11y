package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.PolicyBridges;
import ing.o11y.libo11y.internal.SensitivityPolicy;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.logs.LoggerProvider;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.TracerProvider;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Owned telemetry handle returned by {@link O11y#setup(O11yOptions)} and {@link O11y#init(O11yOptions)}.
 * Implements {@link AutoCloseable} with idempotent, bounded, concurrent per-signal shutdown.
 */
public final class Telemetry implements AutoCloseable {
    private final SdkTracerProvider sdkTracerProvider;
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
    private final Runnable onShutdownComplete;

    private final AtomicReference<CompletableFuture<ShutdownReport>> shutdownFuture = new AtomicReference<>();

    Telemetry(
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
            Runnable onShutdownComplete) {
        this.sdkTracerProvider = sdkTracerProvider;
        this.sdkMeterProvider = sdkMeterProvider;
        this.sdkLoggerProvider = sdkLoggerProvider;
        this.policyMeterProvider = policyMeterProvider;
        this.propagators = propagators;
        this.resource = resource;
        this.policy = policy;
        this.logger = logger;
        this.effectiveConfig = Collections.unmodifiableMap(new LinkedHashMap<>(effectiveConfig));
        this.runtimeMetrics = runtimeMetrics;
        this.defaultShutdownTimeout = defaultShutdownTimeout == null ? Duration.ofSeconds(5) : defaultShutdownTimeout;
        this.onShutdownComplete = onShutdownComplete;

        this.openTelemetry = new OpenTelemetry() {
            @Override
            public TracerProvider getTracerProvider() {
                return sdkTracerProvider;
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

    /** Returns an {@link OpenTelemetrySdk} wrapper backed by the underlying SDK providers (for bridges requiring Sdk types). */
    public OpenTelemetrySdk openTelemetrySdk() {
        return OpenTelemetrySdk.builder()
                .setTracerProvider(sdkTracerProvider)
                .setMeterProvider(sdkMeterProvider)
                .setLoggerProvider(sdkLoggerProvider)
                .setPropagators(propagators)
                .build();
    }

    public SdkTracerProvider sdkTracerProvider() {
        return sdkTracerProvider;
    }

    public SdkMeterProvider sdkMeterProvider() {
        return sdkMeterProvider;
    }

    public SdkLoggerProvider sdkLoggerProvider() {
        return sdkLoggerProvider;
    }

    public TracerProvider tracerProvider() {
        return sdkTracerProvider;
    }

    /** Returns the sensitivity-enforcing {@link MeterProvider} (drops SECRET and PII attributes). */
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
        return sdkTracerProvider.get(instrumentationScopeName);
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

    /** Forces a flush of traces, metrics, and logs concurrently within the given timeout. */
    public void forceFlush(Duration timeout) {
        long ms = Math.max(1L, (timeout == null ? defaultShutdownTimeout : timeout).toMillis());
        CompletableResultCode t = sdkTracerProvider.forceFlush();
        CompletableResultCode m = sdkMeterProvider.forceFlush();
        CompletableResultCode l = sdkLoggerProvider.forceFlush();
        CompletableResultCode.ofAll(java.util.List.of(t, m, l)).join(ms, TimeUnit.MILLISECONDS);
    }

    public ShutdownReport shutdown() {
        return shutdown(defaultShutdownTimeout);
    }

    /**
     * Idempotent, bounded, concurrent shutdown across traces, metrics, and logs under one shared deadline.
     * Concurrent and subsequent callers receive the same {@link ShutdownReport}.
     */
    public ShutdownReport shutdown(Duration timeout) {
        CompletableFuture<ShutdownReport> existing = shutdownFuture.get();
        if (existing != null) {
            return existing.join();
        }
        CompletableFuture<ShutdownReport> mine = new CompletableFuture<>();
        if (!shutdownFuture.compareAndSet(null, mine)) {
            return shutdownFuture.get().join();
        }

        Duration budget = (timeout == null || timeout.isNegative() || timeout.isZero())
                ? defaultShutdownTimeout
                : timeout;
        long deadlineNanos = System.nanoTime() + budget.toNanos();

        if (runtimeMetrics != null) {
            runtimeMetrics.close();
        }

        CompletableFuture<Throwable> traceTask = CompletableFuture.supplyAsync(() ->
                awaitResult("traces", sdkTracerProvider.shutdown(), deadlineNanos));
        CompletableFuture<Throwable> metricTask = CompletableFuture.supplyAsync(() ->
                awaitResult("metrics", sdkMeterProvider.shutdown(), deadlineNanos));
        CompletableFuture<Throwable> logTask = CompletableFuture.supplyAsync(() ->
                awaitResult("logs", sdkLoggerProvider.shutdown(), deadlineNanos));

        Throwable traceErr = traceTask.join();
        Throwable metricErr = metricTask.join();
        Throwable logErr = logTask.join();

        if (onShutdownComplete != null) {
            onShutdownComplete.run();
        }

        ShutdownReport report = new ShutdownReport(traceErr, metricErr, logErr);
        mine.complete(report);
        return report;
    }

    private static Throwable awaitResult(String signal, CompletableResultCode result, long deadlineNanos) {
        try {
            long remNanos = Math.max(1L, deadlineNanos - System.nanoTime());
            CompletableResultCode done = result.join(remNanos, TimeUnit.NANOSECONDS);
            if (!done.isDone()) {
                return new TimeoutException(signal + " shutdown exceeded deadline");
            }
            if (!done.isSuccess()) {
                Throwable cause = done.getFailureThrowable();
                return cause != null
                        ? cause
                        : new IllegalStateException(signal + " shutdown failed");
            }
            return null;
        } catch (Throwable t) {
            return t;
        }
    }

    @Override
    public void close() {
        shutdown(defaultShutdownTimeout);
    }
}
