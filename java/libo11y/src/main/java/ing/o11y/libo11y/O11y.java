package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.BaggageEgressPropagator;
import ing.o11y.libo11y.internal.EndpointSanitizer;
import ing.o11y.libo11y.internal.ExportFailures;
import ing.o11y.libo11y.internal.O11yEnvParser;
import ing.o11y.libo11y.internal.PolicyBridges;
import ing.o11y.libo11y.internal.ResourceComposer;
import ing.o11y.libo11y.internal.SensitivityPolicy;
import ing.o11y.libo11y.spec.AppRegistryValidator;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.LoggerProvider;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.trace.TracerProvider;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.exporter.logging.LoggingMetricExporter;
import io.opentelemetry.exporter.logging.LoggingSpanExporter;
import io.opentelemetry.exporter.logging.SystemOutLogRecordExporter;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporter;
import io.opentelemetry.exporter.otlp.http.logs.OtlpHttpLogRecordExporterBuilder;
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporter;
import io.opentelemetry.exporter.otlp.http.metrics.OtlpHttpMetricExporterBuilder;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter;
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporterBuilder;
import io.opentelemetry.exporter.otlp.logs.OtlpGrpcLogRecordExporter;
import io.opentelemetry.exporter.otlp.logs.OtlpGrpcLogRecordExporterBuilder;
import io.opentelemetry.exporter.otlp.metrics.OtlpGrpcMetricExporter;
import io.opentelemetry.exporter.otlp.metrics.OtlpGrpcMetricExporterBuilder;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporter;
import io.opentelemetry.exporter.otlp.trace.OtlpGrpcSpanExporterBuilder;
import io.opentelemetry.extension.trace.propagation.B3Propagator;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.LogLimits;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.SdkLoggerProviderBuilder;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessorBuilder;
import io.opentelemetry.sdk.logs.export.LogRecordExporter;
import io.opentelemetry.sdk.metrics.Aggregation;
import io.opentelemetry.sdk.metrics.ExemplarFilter;
import io.opentelemetry.sdk.metrics.InstrumentSelector;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.SdkMeterProviderBuilder;
import io.opentelemetry.sdk.metrics.View;
import io.opentelemetry.sdk.metrics.export.MetricExporter;
import io.opentelemetry.sdk.metrics.export.MetricReader;
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReader;
import io.opentelemetry.sdk.metrics.export.PeriodicMetricReaderBuilder;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.SdkTracerProviderBuilder;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessorBuilder;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.IOException;
import java.io.OutputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Entry points for initializing libo11y ({@link #setup(O11yOptions)} and {@link #init(O11yOptions)}). */
public final class O11y {
    /** Guards {@link #globalClaimed}, {@link #installedGlobal} and writes of {@link #globalTelemetry}. */
    private static final Object GLOBAL_LOCK = new Object();

    /** Set from the moment a setup claims the global until its handle shuts down or the setup fails. */
    private static boolean globalClaimed;

    /** The instance libo11y registered with {@link GlobalOpenTelemetry}, once one setup has succeeded. */
    private static GlobalDelegate installedGlobal;

    private static volatile Telemetry globalTelemetry;

    private O11y() {}

    /** Returns the currently installed global {@link Telemetry} handle, or {@code null} if {@link #setup} was not called. */
    public static Telemetry global() {
        return globalTelemetry;
    }

    /**
     * Initializes telemetry, runs the {@code o11y.telemetry.configured} startup canary, and installs
     * the handle as the process global, so instrumentation that reads {@link GlobalOpenTelemetry}
     * works untouched.
     *
     * <p>Only one libo11y global may be active at a time. A second call, including one racing a
     * setup that has not finished, fails with {@link O11yException.ErrorCode#ALREADY_SETUP}, and
     * so does a call while {@link GlobalOpenTelemetry} holds an instance libo11y did not install:
     * one from the OpenTelemetry Java agent or another library, or the no-op instance
     * {@code GlobalOpenTelemetry.get()} installs when it is called before any setup. libo11y never
     * replaces a foreign global. Either way the parts {@code options} injected are shut down, since
     * the caller handed them over.
     *
     * <p>The OpenTelemetry API sets its global once and has no supported way to unset it, so the
     * first successful setup registers a libo11y-owned instance that delegates to the active
     * handle. {@link Telemetry#shutdown} releases the guard but leaves that instance pointing at the
     * shut-down handle, whose providers record nothing while its propagators keep working, as Go
     * leaves the previous providers installed. The next setup points it at the new handle; tracers
     * and meters obtained from the global before then stay bound to the handle they came from.
     *
     * @param options the configuration; {@code null} uses the defaults
     * @return the installed handle
     * @throws O11yException on any configuration error, with nothing left running or installed
     */
    public static Telemetry setup(O11yOptions options) {
        O11yOptions opts = options == null ? O11yOptions.builder().build() : options;
        String conflict;
        synchronized (GLOBAL_LOCK) {
            conflict = globalClaimed ? "libo11y global telemetry is already set up" : foreignGlobal();
            if (conflict == null) {
                globalClaimed = true;
            }
        }
        if (conflict != null) {
            O11yException ex = new O11yException(O11yException.ErrorCode.ALREADY_SETUP, conflict);
            Owned.injected(opts).abandon(ex);
            throw ex;
        }
        Telemetry telemetry = null;
        try {
            telemetry = build(opts, O11y::releaseIfGlobal);
            runCanary(telemetry);
            install(telemetry);
            return telemetry;
        } catch (RuntimeException | Error ex) {
            if (telemetry != null) {
                telemetry.abandon(ex);
            }
            synchronized (GLOBAL_LOCK) {
                globalClaimed = false;
            }
            throw ex;
        }
    }

    /** Runs the startup canary before any global is installed, so a rejecting sink fails setup cleanly. */
    private static void runCanary(Telemetry telemetry) {
        try {
            telemetry.logger().emitStartupCanary(
                    Context.current(),
                    Spec.Events.TELEMETRY_CONFIGURED,
                    telemetry.effectiveConfig());
        } catch (O11yException ex) {
            if (ex.code() == O11yException.ErrorCode.CANARY_REJECTED) {
                throw ex;
            }
            throw new O11yException(
                    O11yException.ErrorCode.CANARY_REJECTED, "startup canary rejected: " + ex.getMessage(), ex);
        } catch (RuntimeException ex) {
            throw new O11yException(
                    O11yException.ErrorCode.CANARY_REJECTED, "startup canary rejected: " + ex.getMessage(), ex);
        }
    }

    /** Describes a {@link GlobalOpenTelemetry} instance libo11y did not install, or returns {@code null}. Holds the lock. */
    private static String foreignGlobal() {
        if (installedGlobal == null && GlobalOpenTelemetry.isSet()) {
            return "GlobalOpenTelemetry already holds an instance libo11y did not install"
                    + " (the OpenTelemetry Java agent, another library, or a GlobalOpenTelemetry.get() call before setup);"
                    + " libo11y does not replace it. Use O11y.init for a handle that installs no global.";
        }
        return null;
    }

    private static void install(Telemetry telemetry) {
        synchronized (GLOBAL_LOCK) {
            if (installedGlobal == null) {
                String conflict = foreignGlobal();
                if (conflict != null) {
                    throw new O11yException(O11yException.ErrorCode.ALREADY_SETUP, conflict);
                }
                GlobalDelegate delegate = new GlobalDelegate(telemetry.openTelemetry());
                try {
                    GlobalOpenTelemetry.set(delegate);
                } catch (IllegalStateException ex) {
                    throw new O11yException(
                            O11yException.ErrorCode.ALREADY_SETUP,
                            "GlobalOpenTelemetry was set by another caller during setup",
                            ex);
                }
                installedGlobal = delegate;
            } else {
                installedGlobal.delegate = telemetry.openTelemetry();
            }
            globalTelemetry = telemetry;
        }
    }

    /** The shutdown callback of a setup handle: releases the guard if {@code telemetry} still holds it. */
    private static void releaseIfGlobal(Telemetry telemetry) {
        synchronized (GLOBAL_LOCK) {
            if (globalTelemetry == telemetry) {
                globalTelemetry = null;
                globalClaimed = false;
            }
        }
    }

    /**
     * Initializes an isolated {@link Telemetry} handle without installing process globals or
     * running the startup canary. Ideal for tests and dependency injection.
     *
     * @param options the configuration; {@code null} uses the defaults
     * @return the handle
     * @throws O11yException on any configuration error, with nothing left running; the parts
     *     {@code options} injected are shut down too, since the caller handed them over
     */
    public static Telemetry init(O11yOptions options) {
        return build(options == null ? O11yOptions.builder().build() : options, null);
    }

    /**
     * Resets global state in tests: shuts the global handle down and clears
     * {@link GlobalOpenTelemetry} with its test-only reset, the one place libo11y uses it.
     */
    public static void resetForTesting() {
        Telemetry current;
        synchronized (GLOBAL_LOCK) {
            current = globalTelemetry;
            globalTelemetry = null;
        }
        if (current != null) {
            current.shutdown();
        }
        synchronized (GLOBAL_LOCK) {
            globalClaimed = false;
            installedGlobal = null;
            GlobalOpenTelemetry.resetForTest();
        }
    }

    /** The instance registered with {@link GlobalOpenTelemetry}: it forwards to the active setup handle. */
    private static final class GlobalDelegate implements OpenTelemetry {
        private volatile OpenTelemetry delegate;

        GlobalDelegate(OpenTelemetry delegate) {
            this.delegate = delegate;
        }

        @Override
        public TracerProvider getTracerProvider() {
            return delegate.getTracerProvider();
        }

        @Override
        public MeterProvider getMeterProvider() {
            return delegate.getMeterProvider();
        }

        @Override
        public LoggerProvider getLogsBridge() {
            return delegate.getLogsBridge();
        }

        @Override
        public ContextPropagators getPropagators() {
            return delegate.getPropagators();
        }
    }

    /**
     * What construction owns so far, by signal. Each part is stopped, without waiting, if a later
     * step fails; a part handed to an owner (a processor, a reader or a provider) leaves the list.
     * What is left when construction succeeds is an injected part no provider took, because
     * {@code OTEL_SDK_DISABLED} switched the SDK off, and the handle stops it at shutdown.
     */
    private static final class Owned {
        private record Part(String signal, Object part, Supplier<CompletableResultCode> stop) {}

        private final List<Part> parts = new ArrayList<>();

        /** Owns every part {@code options} injected. */
        static Owned injected(O11yOptions options) {
            Owned owned = new Owned();
            if (options.spanExporter() != null) {
                owned.own(Spec.Signal.TRACES, options.spanExporter(), options.spanExporter()::shutdown);
            }
            for (SpanProcessor p : options.spanProcessors()) {
                owned.own(Spec.Signal.TRACES, p, p::shutdown);
            }
            if (options.metricReader() != null) {
                owned.own(Spec.Signal.METRICS, options.metricReader(), options.metricReader()::shutdown);
            }
            if (options.logRecordExporter() != null) {
                owned.own(Spec.Signal.LOGS, options.logRecordExporter(), options.logRecordExporter()::shutdown);
            }
            for (LogRecordProcessor p : options.logRecordProcessors()) {
                owned.own(Spec.Signal.LOGS, p, p::shutdown);
            }
            return owned;
        }

        <T> T own(String signal, T part, Supplier<CompletableResultCode> stop) {
            parts.add(new Part(signal, part, stop));
            return part;
        }

        void handOver(Object part) {
            parts.removeIf(p -> p.part() == part);
        }

        void handOverAll(List<?> handed) {
            handed.forEach(this::handOver);
        }

        /** Stops every owned part; a part's failure is suppressed onto {@code primary}. */
        void abandon(Throwable primary) {
            for (Part p : parts) {
                try {
                    p.stop().get();
                } catch (RuntimeException ex) {
                    primary.addSuppressed(ex);
                }
            }
            parts.clear();
        }

        /** Returns the parts still owned, by signal, for the handle to stop at shutdown. */
        Map<String, List<Supplier<CompletableResultCode>>> unowned() {
            Map<String, List<Supplier<CompletableResultCode>>> out = new LinkedHashMap<>();
            for (Part p : parts) {
                out.computeIfAbsent(p.signal(), s -> new ArrayList<>()).add(p.stop());
            }
            out.replaceAll((s, l) -> List.copyOf(l));
            return Map.copyOf(out);
        }
    }

    /**
     * What one signal exports to, resolved before anything is built.
     *
     * @param reported the o11y.config value: {@code injected}, {@code none} or the exporter list
     * @param exporters the environment exporters to build, {@code otlp} and {@code console}
     * @param otlp the OTLP settings when {@code exporters} lists {@code otlp}
     */
    private record Plan(String reported, List<String> exporters, O11yEnvParser.SignalConfig otlp) {
        static final Plan NONE = new Plan(O11yEnvParser.NONE, List.of(), null);
        static final Plan INJECTED = new Plan("injected", List.of(), null);

        /** Code options first: an injected part or the kill switch means the environment is not read. */
        static Plan resolve(boolean disabled, boolean injected, O11yEnvParser.ParsedEnv env, String signal) {
            if (disabled) {
                return NONE;
            }
            if (injected) {
                return INJECTED;
            }
            List<String> exporters = env.exporters(signal);
            if (exporters.equals(List.of(O11yEnvParser.NONE))) {
                return NONE;
            }
            O11yEnvParser.SignalConfig otlp = exporters.contains(O11yEnvParser.OTLP) ? env.otlp(signal) : null;
            return new Plan(String.join(",", exporters), exporters, otlp);
        }
    }

    private static Telemetry build(O11yOptions options, Consumer<Telemetry> onShutdownComplete) {
        Owned owned = Owned.injected(options);
        try {
            return assemble(options, owned, onShutdownComplete);
        } catch (RuntimeException | Error ex) {
            owned.abandon(ex);
            throw ex;
        }
    }

    private static Telemetry assemble(O11yOptions options, Owned owned, Consumer<Telemetry> onShutdownComplete) {
        O11yEnvParser.ParsedEnv env = O11yEnvParser.parse(options.env());
        boolean disabled = env.sdkDisabled();

        // 1. Validate & compile application registries
        List<AppRegistryValidator.CompiledAppRegistry> compiledRegs = new ArrayList<>();
        for (O11yOptions.AppRegistrySource src : options.appRegistries()) {
            try {
                if (src instanceof O11yOptions.AppRegistryFile f) {
                    compiledRegs.add(AppRegistryValidator.loadFile(f.path()));
                } else if (src instanceof O11yOptions.AppRegistryYaml y) {
                    compiledRegs.add(AppRegistryValidator.compile(
                            AppRegistryValidator.parse(y.yaml()), y.source()));
                }
            } catch (AppRegistryValidator.AppRegistryParseException
                    | AppRegistryValidator.AppRegistryValidationException
                    | IOException ex) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_APP_REGISTRY,
                        "invalid application registry: " + ex.getMessage(),
                        ex);
            }
        }

        // 2. Single SensitivityPolicy across all signals
        SensitivityPolicy policy = new SensitivityPolicy(options.piiMode(), options.piiHashKey(), compiledRegs);

        // 3. Compose schema-stamped Resource with tier-0 enforcement
        ResourceComposer.ComposedResource composed = ResourceComposer.compose(options, env, policy);

        // 4. Propagators wrapped with BaggageEgressPropagator; the propagators option beats OTEL_PROPAGATORS
        List<TextMapPropagator> baseProps = options.propagators() != null
                ? options.propagators()
                : envPropagators(env.propagators());
        TextMapPropagator composite = TextMapPropagator.composite(baseProps);
        TextMapPropagator wrappedPropagator = new BaggageEgressPropagator(composite, options.baggageEgressAllow());
        ContextPropagators propagators = ContextPropagators.create(wrappedPropagator);

        // 5. Resolve and validate every remaining setting before anything starts. A code option
        // means the variable it overrides is never parsed.
        Plan traces = Plan.resolve(disabled,
                options.spanExporter() != null || !options.spanProcessors().isEmpty(), env, O11yEnvParser.TRACES);
        Plan metrics = Plan.resolve(disabled, options.metricReader() != null, env, O11yEnvParser.METRICS);
        Plan logs = Plan.resolve(disabled,
                options.logRecordExporter() != null || !options.logRecordProcessors().isEmpty(),
                env, O11yEnvParser.LOGS);
        Sampler sampler;
        if (disabled) {
            sampler = Sampler.alwaysOff();
        } else {
            sampler = options.sampler() != null ? options.sampler() : env.sampler();
        }
        ExemplarFilterMode exemplarMode = options.exemplarFilter() != null
                ? options.exemplarFilter()
                : disabled ? ExemplarFilterMode.TRACE_BASED : env.exemplarFilter();

        // 6. Build the environment exporters; nothing has a worker thread yet.
        SpanExporter envSpanExporter = buildSpanExporter(traces, owned);
        List<MetricExporter> envMetricExporters = buildMetricExporters(metrics, owned);
        LogRecordExporter envLogExporter = buildLogExporter(logs, owned);

        // 7. Traces pipeline
        ExportFailures spanFailures = new ExportFailures(Spec.Signal.TRACES);
        SdkTracerProviderBuilder tracerBuilder = SdkTracerProvider.builder()
                .setResource(composed.resource())
                .setSampler(sampler);
        List<Object> tracePartsHanded = new ArrayList<>();
        if (!disabled) {
            tracerBuilder.setSpanLimits(env.spanLimits());
            SpanExporter spanExporter = options.spanExporter() != null ? options.spanExporter() : envSpanExporter;
            if (spanExporter != null) {
                BatchSpanProcessor batch = spanBatch(
                        BatchSpanProcessor.builder(spanFailures.observe(
                                new PolicyBridges.PolicySpanExporter(spanExporter, policy))),
                        env.spanBatch()).build();
                owned.own(Spec.Signal.TRACES, batch, batch::shutdown);
                owned.handOver(spanExporter);
                tracerBuilder.addSpanProcessor(batch);
                tracePartsHanded.add(batch);
            }
            // When an exporter path already counts a span's violations, the injected processors'
            // redaction of the same span records none, so one attribute is one violation.
            SensitivityPolicy processorPolicy = spanExporter != null ? policy.silent() : policy;
            for (SpanProcessor sp : options.spanProcessors()) {
                tracerBuilder.addSpanProcessor(new PolicyBridges.PolicySpanProcessor(sp, processorPolicy));
                tracePartsHanded.add(sp);
            }
        }
        SdkTracerProvider tracerProvider = tracerBuilder.build();
        owned.own(Spec.Signal.TRACES, tracerProvider, tracerProvider::shutdown);
        owned.handOverAll(tracePartsHanded);

        // 8. Metrics pipeline (exemplar filter + custom histogram buckets)
        ExportFailures metricFailures = new ExportFailures(Spec.Signal.METRICS);
        ExemplarFilter otelExemplarFilter = switch (exemplarMode) {
            case TRACE_BASED -> ExemplarFilter.traceBased();
            case ALWAYS_ON -> ExemplarFilter.alwaysOn();
            case ALWAYS_OFF -> ExemplarFilter.alwaysOff();
        };
        SdkMeterProviderBuilder meterBuilder = SdkMeterProvider.builder()
                .setResource(composed.resource())
                .setExemplarFilter(otelExemplarFilter);
        for (Map.Entry<String, List<Double>> bucketEntry : options.histogramBuckets().entrySet()) {
            @SuppressWarnings("deprecation")
            Aggregation bucketAgg = Aggregation.explicitBucketHistogram(bucketEntry.getValue());
            meterBuilder.registerView(
                    InstrumentSelector.builder().setName(bucketEntry.getKey()).build(),
                    View.builder()
                            .setAggregation(bucketAgg)
                            .build());
        }
        // Views see measurements the policy meter already classified, so every stream a view
        // produces, its exemplars included, carries no attribute the policy removes.
        for (O11yOptions.ViewRegistration reg : options.views()) {
            meterBuilder.registerView(reg.selector(), reg.view());
        }
        List<Object> metricPartsHanded = new ArrayList<>();
        if (!disabled) {
            if (options.metricReader() != null) {
                meterBuilder.registerMetricReader(options.metricReader());
                metricPartsHanded.add(options.metricReader());
            }
            Duration exportTimeout = envMetricExporters.isEmpty() ? null : env.metricExportTimeout();
            for (MetricExporter exporter : envMetricExporters) {
                PeriodicMetricReaderBuilder rb = PeriodicMetricReader.builder(metricFailures.observe(exporter))
                        .setInterval(env.metricExportInterval());
                if (exportTimeout != null) {
                    rb.setExporterTimeout(exportTimeout);
                }
                PeriodicMetricReader reader = rb.build();
                owned.own(Spec.Signal.METRICS, reader, reader::shutdown);
                owned.handOver(exporter);
                meterBuilder.registerMetricReader(reader);
                metricPartsHanded.add(reader);
            }
        }
        SdkMeterProvider sdkMeterProvider = meterBuilder.build();
        owned.own(Spec.Signal.METRICS, sdkMeterProvider, sdkMeterProvider::shutdown);
        owned.handOverAll(metricPartsHanded);
        MeterProvider policyMeterProvider = new PolicyBridges.PolicyMeterProvider(sdkMeterProvider, policy);

        // Attach the o11y.schema.violations counter, then count what composing the resource
        // found before the counter existed: classified resource attributes and, under lenient
        // identity, each unmet identity rule.
        LongCounter violationCounter = sdkMeterProvider.get("libo11y")
                .counterBuilder(Spec.Metrics.SCHEMA_VIOLATIONS)
                .setDescription("Telemetry records that violated the libo11y specification.")
                .setUnit("{violation}")
                .build();
        policy.attachViolationCounter(violationCounter);
        composed.classificationViolations().forEach((rule, n) ->
                policy.recordViolations(Spec.Signal.RESOURCE, rule, n));
        for (String rule : composed.identityViolations()) {
            policy.recordViolations(Spec.Signal.RESOURCE, rule, 1L);
        }

        // Optional JVM runtime metrics
        PolicyBridges.JvmRuntimeMetrics jvmMetrics = null;
        if (options.runtimeMetrics() && !disabled) {
            jvmMetrics = PolicyBridges.JvmRuntimeMetrics.register(policyMeterProvider.get("libo11y.runtime"));
            PolicyBridges.JvmRuntimeMetrics registered = jvmMetrics;
            owned.own(Spec.Signal.METRICS, registered, () -> {
                registered.close();
                return CompletableResultCode.ofSuccess();
            });
        }

        // 9. Logs pipeline
        ExportFailures logFailures = new ExportFailures(Spec.Signal.LOGS);
        SdkLoggerProviderBuilder loggerBuilder = SdkLoggerProvider.builder()
                .setResource(composed.resource());
        List<Object> logPartsHanded = new ArrayList<>();
        if (!disabled) {
            LogLimits limits = env.logLimits();
            loggerBuilder.setLogLimits(() -> limits);
            // One policy processor in front of every log processor, so a record is classified once.
            List<LogRecordProcessor> logProcessors = new ArrayList<>();
            LogRecordExporter logExporter = options.logRecordExporter() != null
                    ? options.logRecordExporter()
                    : envLogExporter;
            if (logExporter != null) {
                BatchLogRecordProcessor batch = logBatch(
                        BatchLogRecordProcessor.builder(logFailures.observe(logExporter)), env.logBatch()).build();
                owned.own(Spec.Signal.LOGS, batch, batch::shutdown);
                owned.handOver(logExporter);
                logProcessors.add(batch);
            }
            logProcessors.addAll(options.logRecordProcessors());
            if (!logProcessors.isEmpty()) {
                loggerBuilder.addLogRecordProcessor(new PolicyBridges.PolicyLogRecordProcessor(
                        policy, LogRecordProcessor.composite(logProcessors)));
            }
            logPartsHanded.addAll(logProcessors);
        }
        SdkLoggerProvider sdkLoggerProvider = loggerBuilder.build();
        owned.own(Spec.Signal.LOGS, sdkLoggerProvider, sdkLoggerProvider::shutdown);
        owned.handOverAll(logPartsHanded);

        OutputStream consoleOut = options.consoleOutput() != null ? options.consoleOutput() : System.err;
        StructuredLogger structuredLogger = new StructuredLogger(
                sdkLoggerProvider.get("libo11y"),
                policy,
                options.logLevel(),
                options.consoleEnabled(),
                consoleOut,
                options.attrReplacer(),
                options.extraLogSinks(),
                Map.of());

        String samplerName = options.sampler() != null ? options.sampler().getDescription() : env.samplerName();
        Map<String, Object> effectiveConfig = effectiveConfig(
                options, env, composed, baseProps, traces, metrics, logs, samplerName, disabled);

        // The handle owns the providers and the runtime metrics from here on.
        owned.handOverAll(Arrays.asList(tracerProvider, sdkMeterProvider, sdkLoggerProvider, jvmMetrics));
        return new Telemetry(new Telemetry.Parts(
                tracerProvider,
                sdkMeterProvider,
                sdkLoggerProvider,
                policyMeterProvider,
                propagators,
                composed.resource(),
                policy,
                structuredLogger,
                effectiveConfig,
                jvmMetrics,
                options.shutdownTimeout(),
                disabled,
                spanFailures,
                metricFailures,
                logFailures,
                owned.unowned(),
                onShutdownComplete));
    }

    /** Builds the propagators {@code OTEL_PROPAGATORS} names; none listed means the W3C default, {@code none} means nothing. */
    private static List<TextMapPropagator> envPropagators(List<String> names) {
        if (names.isEmpty()) {
            return List.of(W3CTraceContextPropagator.getInstance(), W3CBaggagePropagator.getInstance());
        }
        if (names.contains(O11yEnvParser.NONE)) {
            return List.of();
        }
        List<TextMapPropagator> out = new ArrayList<>(names.size());
        for (String name : names) {
            out.add(switch (name) {
                case "tracecontext" -> W3CTraceContextPropagator.getInstance();
                case "baggage" -> W3CBaggagePropagator.getInstance();
                case "b3" -> B3Propagator.injectingSingleHeader();
                case "b3multi" -> B3Propagator.injectingMultiHeaders();
                default -> throw new IllegalStateException("unvalidated propagator " + name);
            });
        }
        return List.copyOf(out);
    }

    private static BatchSpanProcessorBuilder spanBatch(BatchSpanProcessorBuilder b, O11yEnvParser.BatchConfig c) {
        if (c.scheduleDelay() != null) {
            b.setScheduleDelay(c.scheduleDelay());
        }
        if (c.exportTimeout() != null) {
            b.setExporterTimeout(c.exportTimeout());
        }
        if (c.maxQueueSize() != null) {
            b.setMaxQueueSize(c.maxQueueSize());
        }
        if (c.maxExportBatchSize() != null) {
            b.setMaxExportBatchSize(c.maxExportBatchSize());
        }
        return b;
    }

    private static BatchLogRecordProcessorBuilder logBatch(BatchLogRecordProcessorBuilder b, O11yEnvParser.BatchConfig c) {
        if (c.scheduleDelay() != null) {
            b.setScheduleDelay(c.scheduleDelay());
        }
        if (c.exportTimeout() != null) {
            b.setExporterTimeout(c.exportTimeout());
        }
        if (c.maxQueueSize() != null) {
            b.setMaxQueueSize(c.maxQueueSize());
        }
        if (c.maxExportBatchSize() != null) {
            b.setMaxExportBatchSize(c.maxExportBatchSize());
        }
        return b;
    }

    /**
     * Resolves the o11y.config.* attributes of the o11y.telemetry.configured event, the keys the
     * o11y.config group registers, with the values Go reports: what will actually happen once
     * option-over-environment precedence applies.
     */
    private static Map<String, Object> effectiveConfig(
            O11yOptions options,
            O11yEnvParser.ParsedEnv env,
            ResourceComposer.ComposedResource composed,
            List<TextMapPropagator> propagators,
            Plan traces,
            Plan metrics,
            Plan logs,
            String sampler,
            boolean disabled) {
        Map<String, Object> cfg = new LinkedHashMap<>();
        String serviceName = composed.resource().getAttribute(AttributeKey.stringKey("service.name"));
        cfg.put("service.name", serviceName == null ? "" : serviceName);
        String serviceVersion = composed.resource().getAttribute(AttributeKey.stringKey("service.version"));
        if (serviceVersion != null && !serviceVersion.isEmpty()) {
            cfg.put("service.version", serviceVersion);
        }
        String prefix = Spec.Attributes.CONFIG + ".";
        cfg.put(prefix + "traces", traces.reported());
        cfg.put(prefix + "metrics", metrics.reported());
        cfg.put(prefix + "logs", logs.reported());
        cfg.put(prefix + "console", options.consoleEnabled() ? "json" : "off");
        cfg.put(prefix + "level", levelName(options.logLevel()));
        cfg.put(prefix + "sampler", sampler);
        cfg.put(prefix + "propagators", propagatorFields(propagators));
        cfg.put(prefix + "runtime_metrics", Boolean.toString(options.runtimeMetrics() && !disabled));
        if (composed.serviceVersionFallback()) {
            cfg.put(prefix + "service_version_fallback", "true");
        }
        // Endpoints come from the environment as given, sanitized: a URL may carry credentials in
        // its userinfo or query, and the event reaches every sink. Hermetic mode reads none.
        String[][] endpoints = {
            {"endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"},
            {"traces_endpoint", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"},
            {"metrics_endpoint", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"},
            {"logs_endpoint", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"},
        };
        for (String[] ep : endpoints) {
            String raw = env.raw(ep[1]);
            if (!raw.isEmpty()) {
                cfg.put(prefix + ep[0], EndpointSanitizer.sanitize(raw));
            }
        }
        return cfg;
    }

    /** Names a log level as Go's slog does: DEBUG, INFO, WARN, ERROR, and DEBUG-4 below DEBUG. */
    private static String levelName(Severity level) {
        int n = level == null ? Severity.INFO.getSeverityNumber() : level.getSeverityNumber();
        if (n <= Severity.TRACE4.getSeverityNumber()) {
            return "DEBUG-4";
        }
        if (n <= Severity.DEBUG4.getSeverityNumber()) {
            return "DEBUG";
        }
        if (n <= Severity.INFO4.getSeverityNumber()) {
            return "INFO";
        }
        if (n <= Severity.WARN4.getSeverityNumber()) {
            return "WARN";
        }
        return "ERROR";
    }

    /**
     * Lists the propagators' fields in their configured order, each field once, as Go does:
     * {@code none} when no propagator is configured, {@code custom} when the configured ones name no
     * fields.
     */
    private static String propagatorFields(List<TextMapPropagator> propagators) {
        if (propagators.isEmpty()) {
            return "none";
        }
        LinkedHashSet<String> fields = new LinkedHashSet<>();
        for (TextMapPropagator p : propagators) {
            fields.addAll(p.fields());
        }
        return fields.isEmpty() ? "custom" : String.join(",", fields);
    }

    /**
     * Builds what {@code build} returns, translating an SDK failure (an invalid certificate, for
     * example) into an {@code EXPORTER} error.
     */
    private static <T> T exporter(String signal, Supplier<T> build) {
        try {
            return build.get();
        } catch (O11yException ex) {
            throw ex;
        } catch (RuntimeException ex) {
            throw new O11yException(
                    O11yException.ErrorCode.EXPORTER,
                    "building the " + signal + " exporter: " + ex.getMessage(),
                    ex);
        }
    }

    private static SpanExporter buildSpanExporter(Plan plan, Owned owned) {
        List<SpanExporter> built = new ArrayList<>();
        for (String name : plan.exporters()) {
            SpanExporter e = exporter(Spec.Signal.TRACES, () -> O11yEnvParser.OTLP.equals(name)
                    ? otlpSpanExporter(plan.otlp())
                    : LoggingSpanExporter.create());
            built.add(owned.own(Spec.Signal.TRACES, e, e::shutdown));
        }
        if (built.size() <= 1) {
            return built.isEmpty() ? null : built.get(0);
        }
        SpanExporter all = SpanExporter.composite(built);
        owned.own(Spec.Signal.TRACES, all, all::shutdown);
        owned.handOverAll(built);
        return all;
    }

    private static List<MetricExporter> buildMetricExporters(Plan plan, Owned owned) {
        List<MetricExporter> built = new ArrayList<>();
        for (String name : plan.exporters()) {
            MetricExporter e = exporter(Spec.Signal.METRICS, () -> O11yEnvParser.OTLP.equals(name)
                    ? otlpMetricExporter(plan.otlp())
                    : LoggingMetricExporter.create());
            built.add(owned.own(Spec.Signal.METRICS, e, e::shutdown));
        }
        return built;
    }

    private static LogRecordExporter buildLogExporter(Plan plan, Owned owned) {
        List<LogRecordExporter> built = new ArrayList<>();
        for (String name : plan.exporters()) {
            LogRecordExporter e = exporter(Spec.Signal.LOGS, () -> O11yEnvParser.OTLP.equals(name)
                    ? otlpLogExporter(plan.otlp())
                    : SystemOutLogRecordExporter.create());
            built.add(owned.own(Spec.Signal.LOGS, e, e::shutdown));
        }
        if (built.size() <= 1) {
            return built.isEmpty() ? null : built.get(0);
        }
        LogRecordExporter all = LogRecordExporter.composite(built);
        owned.own(Spec.Signal.LOGS, all, all::shutdown);
        owned.handOverAll(built);
        return all;
    }

    /** Applies the settings every OTLP exporter builder shares. */
    private static void applyOtlp(
            O11yEnvParser.SignalConfig cfg,
            Consumer<String> endpoint,
            Consumer<Duration> timeout,
            BiConsumer<String, String> header,
            Consumer<String> compression,
            Consumer<byte[]> trustedCertificates,
            BiConsumer<byte[], byte[]> clientTls) {
        endpoint.accept(cfg.endpoint());
        timeout.accept(cfg.timeout());
        cfg.headers().forEach(header);
        if ("gzip".equals(cfg.compression())) {
            compression.accept("gzip");
        }
        O11yEnvParser.TlsConfig tls = cfg.tls();
        if (tls != null) {
            if (tls.trustedCertificates() != null) {
                trustedCertificates.accept(tls.trustedCertificates());
            }
            if (tls.clientKey() != null) {
                clientTls.accept(tls.clientKey(), tls.clientCertificate());
            }
        }
    }

    private static SpanExporter otlpSpanExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcSpanExporterBuilder b = OtlpGrpcSpanExporter.builder();
            applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                    b::setTrustedCertificates, b::setClientTls);
            return b.build();
        }
        OtlpHttpSpanExporterBuilder b = OtlpHttpSpanExporter.builder();
        applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                b::setTrustedCertificates, b::setClientTls);
        return b.build();
    }

    private static MetricExporter otlpMetricExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcMetricExporterBuilder b = OtlpGrpcMetricExporter.builder()
                    .setAggregationTemporalitySelector(cfg.temporality());
            applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                    b::setTrustedCertificates, b::setClientTls);
            return b.build();
        }
        OtlpHttpMetricExporterBuilder b = OtlpHttpMetricExporter.builder()
                .setAggregationTemporalitySelector(cfg.temporality());
        applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                b::setTrustedCertificates, b::setClientTls);
        return b.build();
    }

    private static LogRecordExporter otlpLogExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcLogRecordExporterBuilder b = OtlpGrpcLogRecordExporter.builder();
            applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                    b::setTrustedCertificates, b::setClientTls);
            return b.build();
        }
        OtlpHttpLogRecordExporterBuilder b = OtlpHttpLogRecordExporter.builder();
        applyOtlp(cfg, b::setEndpoint, b::setTimeout, b::addHeader, b::setCompression,
                b::setTrustedCertificates, b::setClientTls);
        return b.build();
    }
}
