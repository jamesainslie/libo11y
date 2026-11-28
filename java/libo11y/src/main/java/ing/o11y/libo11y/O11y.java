package ing.o11y.libo11y;

import ing.o11y.libo11y.internal.BaggageEgressPropagator;
import ing.o11y.libo11y.internal.EndpointSanitizer;
import ing.o11y.libo11y.internal.O11yEnvParser;
import ing.o11y.libo11y.internal.PolicyBridges;
import ing.o11y.libo11y.internal.ResourceComposer;
import ing.o11y.libo11y.internal.SensitivityPolicy;
import ing.o11y.libo11y.spec.AppRegistryValidator;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.baggage.propagation.W3CBaggagePropagator;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.ContextPropagators;
import io.opentelemetry.context.propagation.TextMapPropagator;
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
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.SdkLoggerProvider;
import io.opentelemetry.sdk.logs.SdkLoggerProviderBuilder;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
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
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.SdkTracerProviderBuilder;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Entry points for initializing libo11y ({@link #setup(O11yOptions)} and {@link #init(O11yOptions)}). */
public final class O11y {
    private static final AtomicBoolean GLOBAL_ACTIVE = new AtomicBoolean(false);
    private static final AtomicReference<Telemetry> GLOBAL_TELEMETRY = new AtomicReference<>();

    private O11y() {}

    /** Returns the currently installed global {@link Telemetry} handle, or {@code null} if {@link #setup} was not called. */
    public static Telemetry global() {
        return GLOBAL_TELEMETRY.get();
    }

    /**
     * Initializes telemetry, runs the {@code o11y.telemetry.configured} startup canary, and installs
     * process globals ({@link GlobalOpenTelemetry}). Rejects double setup with {@code ALREADY_SETUP}.
     */
    public static Telemetry setup(O11yOptions options) {
        if (!GLOBAL_ACTIVE.compareAndSet(false, true)) {
            throw new O11yException(
                    O11yException.ErrorCode.ALREADY_SETUP,
                    "libo11y global telemetry is already set up");
        }
        Telemetry telemetry = null;
        try {
            telemetry = build(options, true, () -> {
                GLOBAL_TELEMETRY.set(null);
                GLOBAL_ACTIVE.set(false);
                GlobalOpenTelemetry.resetForTest();
            });
            // Run startup canary BEFORE installing globals so a rejecting sink fails setup cleanly.
            try {
                telemetry.logger().emit(
                        Context.current(),
                        Severity.INFO,
                        Spec.Events.TELEMETRY_CONFIGURED,
                        Spec.Events.TELEMETRY_CONFIGURED,
                        telemetry.effectiveConfig(),
                        true);
            } catch (O11yException ex) {
                if (ex.code() == O11yException.ErrorCode.CANARY_REJECTED) {
                    throw ex;
                }
                throw new O11yException(
                        O11yException.ErrorCode.CANARY_REJECTED,
                        "startup canary rejected: " + ex.getMessage(),
                        ex);
            } catch (RuntimeException ex) {
                throw new O11yException(
                        O11yException.ErrorCode.CANARY_REJECTED,
                        "startup canary rejected: " + ex.getMessage(),
                        ex);
            }
            GlobalOpenTelemetry.resetForTest();
            GlobalOpenTelemetry.set(telemetry.openTelemetry());
            GLOBAL_TELEMETRY.set(telemetry);
            return telemetry;
        } catch (Throwable t) {
            if (telemetry != null) {
                telemetry.shutdown();
            } else {
                GLOBAL_TELEMETRY.set(null);
                GLOBAL_ACTIVE.set(false);
            }
            throw t;
        }
    }

    /**
     * Initializes an isolated {@link Telemetry} handle without installing process globals or
     * running the startup canary. Ideal for tests and dependency injection.
     */
    public static Telemetry init(O11yOptions options) {
        return build(options, false, null);
    }

    /** Resets global state in tests. */
    public static void resetForTesting() {
        Telemetry current = GLOBAL_TELEMETRY.getAndSet(null);
        if (current != null) {
            current.shutdown();
        }
        GLOBAL_ACTIVE.set(false);
        GlobalOpenTelemetry.resetForTest();
    }

    private static Telemetry build(O11yOptions optsInput, boolean isSetup, Runnable onShutdownComplete) {
        O11yOptions options = optsInput == null ? O11yOptions.builder().build() : optsInput;
        O11yEnvParser.ParsedEnv env = O11yEnvParser.parse(options.env());

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

        // 4. Propagators wrapped with BaggageEgressPropagator
        List<TextMapPropagator> baseProps = options.propagators() != null
                ? options.propagators()
                : List.of(W3CTraceContextPropagator.getInstance(), W3CBaggagePropagator.getInstance());
        TextMapPropagator composite = TextMapPropagator.composite(baseProps);
        TextMapPropagator wrappedPropagator = new BaggageEgressPropagator(composite, options.baggageEgressAllow());
        ContextPropagators propagators = ContextPropagators.create(wrappedPropagator);

        // 5. Traces pipeline
        Sampler sampler = options.sampler() != null ? options.sampler() : env.sampler();
        SdkTracerProviderBuilder tracerBuilder = SdkTracerProvider.builder()
                .setResource(composed.resource())
                .setSampler(sampler);

        String traceExporterLabel = env.traces().exporter();
        String traceEndpointSanitized = "";
        if (!env.sdkDisabled()) {
            if (options.spanExporter() != null) {
                traceExporterLabel = "custom";
                tracerBuilder.addSpanProcessor(
                        BatchSpanProcessor.builder(new PolicyBridges.PolicySpanExporter(options.spanExporter(), policy))
                                .build());
            } else if ("otlp".equals(env.traces().exporter())) {
                traceEndpointSanitized = EndpointSanitizer.sanitize(env.traces().endpoint());
                SpanExporter otlpSpan = buildOtlpSpanExporter(env.traces());
                tracerBuilder.addSpanProcessor(
                        BatchSpanProcessor.builder(new PolicyBridges.PolicySpanExporter(otlpSpan, policy)).build());
            }
            for (SpanProcessor sp : options.spanProcessors()) {
                tracerBuilder.addSpanProcessor(new PolicyBridges.PolicySpanProcessor(sp, policy));
            }
        }
        SdkTracerProvider tracerProvider = tracerBuilder.build();

        // 6. Metrics pipeline (exemplar filter + custom histogram buckets)
        ExemplarFilterMode exemplarMode = options.exemplarFilter() != null
                ? options.exemplarFilter()
                : env.exemplarFilter();
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

        String metricExporterLabel = env.metrics().exporter();
        String metricEndpointSanitized = "";
        if (!env.sdkDisabled()) {
            if (options.metricReader() != null) {
                metricExporterLabel = "custom";
                meterBuilder.registerMetricReader(options.metricReader());
            } else if ("otlp".equals(env.metrics().exporter())) {
                metricEndpointSanitized = EndpointSanitizer.sanitize(env.metrics().endpoint());
                MetricExporter otlpMetric = buildOtlpMetricExporter(env.metrics());
                meterBuilder.registerMetricReader(
                        PeriodicMetricReader.builder(otlpMetric)
                                .setInterval(env.metricExportInterval())
                                .build());
            }
        }
        SdkMeterProvider sdkMeterProvider = meterBuilder.build();
        MeterProvider policyMeterProvider = new PolicyBridges.PolicyMeterProvider(sdkMeterProvider, policy);

        // Attach o11y.schema.violations counter to SensitivityPolicy
        LongCounter violationCounter = sdkMeterProvider.get("libo11y")
                .counterBuilder(Spec.Metrics.SCHEMA_VIOLATIONS)
                .setDescription("Count of libo11y schema and sensitivity policy violations.")
                .setUnit("{violation}")
                .build();
        policy.attachViolationCounter(violationCounter);

        // Count missing tier-0 attributes if strictIdentity=false
        for (String missingKey : composed.missingIdentity()) {
            violationCounter.add(1L, Attributes.of(
                    AttributeKey.stringKey(Spec.Attributes.RULE), "identity_missing",
                    AttributeKey.stringKey(Spec.Attributes.SIGNAL), Spec.Signal.RESOURCE,
                    AttributeKey.stringKey("o11y.attribute.key"), missingKey));
        }

        // Optional JVM runtime metrics
        PolicyBridges.JvmRuntimeMetrics jvmMetrics = null;
        if (options.runtimeMetrics() && !env.sdkDisabled()) {
            jvmMetrics = PolicyBridges.JvmRuntimeMetrics.register(policyMeterProvider.get("libo11y.runtime"));
        }

        // 7. Logs pipeline
        SdkLoggerProviderBuilder loggerBuilder = SdkLoggerProvider.builder()
                .setResource(composed.resource());

        String logExporterLabel = env.logs().exporter();
        String logEndpointSanitized = "";
        if (!env.sdkDisabled()) {
            if (options.logRecordExporter() != null) {
                logExporterLabel = "custom";
                loggerBuilder.addLogRecordProcessor(
                        new PolicyBridges.PolicyLogRecordProcessor(
                                policy,
                                BatchLogRecordProcessor.builder(options.logRecordExporter()).build()));
            } else if ("otlp".equals(env.logs().exporter())) {
                logEndpointSanitized = EndpointSanitizer.sanitize(env.logs().endpoint());
                LogRecordExporter otlpLog = buildOtlpLogExporter(env.logs());
                loggerBuilder.addLogRecordProcessor(
                        new PolicyBridges.PolicyLogRecordProcessor(
                                policy,
                                BatchLogRecordProcessor.builder(otlpLog).build()));
            }
            for (LogRecordProcessor lp : options.logRecordProcessors()) {
                loggerBuilder.addLogRecordProcessor(new PolicyBridges.PolicyLogRecordProcessor(policy, lp));
            }
        }
        SdkLoggerProvider sdkLoggerProvider = loggerBuilder.build();

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

        Map<String, Object> effectiveConfig = new LinkedHashMap<>();
        effectiveConfig.put(Spec.Attributes.CONFIG + ".traces.exporter", traceExporterLabel);
        effectiveConfig.put(Spec.Attributes.CONFIG + ".metrics.exporter", metricExporterLabel);
        effectiveConfig.put(Spec.Attributes.CONFIG + ".logs.exporter", logExporterLabel);
        if (!traceEndpointSanitized.isEmpty()) {
            effectiveConfig.put(Spec.Attributes.CONFIG + ".traces.endpoint", traceEndpointSanitized);
        }
        if (!metricEndpointSanitized.isEmpty()) {
            effectiveConfig.put(Spec.Attributes.CONFIG + ".metrics.endpoint", metricEndpointSanitized);
        }
        if (!logEndpointSanitized.isEmpty()) {
            effectiveConfig.put(Spec.Attributes.CONFIG + ".logs.endpoint", logEndpointSanitized);
        }
        effectiveConfig.put(Spec.Attributes.CONFIG + ".sampler", env.samplerName());
        effectiveConfig.put(Spec.Attributes.CONFIG + ".pii_mode", options.piiMode().name().toLowerCase(java.util.Locale.ROOT));
        effectiveConfig.put(Spec.Attributes.CONFIG + ".exemplar_filter", exemplarMode.name().toLowerCase(java.util.Locale.ROOT));
        effectiveConfig.put(Spec.Attributes.CONFIG + ".hermetic", env.hermetic());
        effectiveConfig.put(Spec.Attributes.CONFIG + ".setup", isSetup);

        return new Telemetry(
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
                onShutdownComplete);
    }

    private static SpanExporter buildOtlpSpanExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcSpanExporterBuilder b = OtlpGrpcSpanExporter.builder()
                    .setEndpoint(cfg.endpoint())
                    .setTimeout(cfg.timeout());
            cfg.headers().forEach(b::addHeader);
            if ("gzip".equals(cfg.compression())) {
                b.setCompression("gzip");
            }
            return b.build();
        }
        OtlpHttpSpanExporterBuilder b = OtlpHttpSpanExporter.builder()
                .setEndpoint(cfg.endpoint())
                .setTimeout(cfg.timeout());
        cfg.headers().forEach(b::addHeader);
        if ("gzip".equals(cfg.compression())) {
            b.setCompression("gzip");
        }
        return b.build();
    }

    private static MetricExporter buildOtlpMetricExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcMetricExporterBuilder b = OtlpGrpcMetricExporter.builder()
                    .setEndpoint(cfg.endpoint())
                    .setTimeout(cfg.timeout());
            cfg.headers().forEach(b::addHeader);
            if ("gzip".equals(cfg.compression())) {
                b.setCompression("gzip");
            }
            return b.build();
        }
        OtlpHttpMetricExporterBuilder b = OtlpHttpMetricExporter.builder()
                .setEndpoint(cfg.endpoint())
                .setTimeout(cfg.timeout());
        cfg.headers().forEach(b::addHeader);
        if ("gzip".equals(cfg.compression())) {
            b.setCompression("gzip");
        }
        return b.build();
    }

    private static LogRecordExporter buildOtlpLogExporter(O11yEnvParser.SignalConfig cfg) {
        if ("grpc".equals(cfg.protocol())) {
            OtlpGrpcLogRecordExporterBuilder b = OtlpGrpcLogRecordExporter.builder()
                    .setEndpoint(cfg.endpoint())
                    .setTimeout(cfg.timeout());
            cfg.headers().forEach(b::addHeader);
            if ("gzip".equals(cfg.compression())) {
                b.setCompression("gzip");
            }
            return b.build();
        }
        OtlpHttpLogRecordExporterBuilder b = OtlpHttpLogRecordExporter.builder()
                .setEndpoint(cfg.endpoint())
                .setTimeout(cfg.timeout());
        cfg.headers().forEach(b::addHeader);
        if ("gzip".equals(cfg.compression())) {
            b.setCompression("gzip");
        }
        return b.build();
    }
}
