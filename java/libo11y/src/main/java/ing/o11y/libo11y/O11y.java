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
import java.util.LinkedHashSet;
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
                telemetry.logger().emitStartupCanary(
                        Context.current(),
                        Spec.Events.TELEMETRY_CONFIGURED,
                        telemetry.effectiveConfig());
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

        boolean spanExporterCounts = false;
        if (!env.sdkDisabled()) {
            if (options.spanExporter() != null) {
                spanExporterCounts = true;
                tracerBuilder.addSpanProcessor(
                        BatchSpanProcessor.builder(new PolicyBridges.PolicySpanExporter(options.spanExporter(), policy))
                                .build());
            } else if ("otlp".equals(env.traces().exporter())) {
                spanExporterCounts = true;
                SpanExporter otlpSpan = buildOtlpSpanExporter(env.traces());
                tracerBuilder.addSpanProcessor(
                        BatchSpanProcessor.builder(new PolicyBridges.PolicySpanExporter(otlpSpan, policy)).build());
            }
            // When an exporter path already counts a span's violations, the injected processors'
            // redaction of the same span records none, so one attribute is one violation.
            SensitivityPolicy processorPolicy = spanExporterCounts ? policy.silent() : policy;
            for (SpanProcessor sp : options.spanProcessors()) {
                tracerBuilder.addSpanProcessor(new PolicyBridges.PolicySpanProcessor(sp, processorPolicy));
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
        // Views see measurements the policy meter already classified, so every stream a view
        // produces, its exemplars included, carries no attribute the policy removes.
        for (O11yOptions.ViewRegistration reg : options.views()) {
            meterBuilder.registerView(reg.selector(), reg.view());
        }

        if (!env.sdkDisabled()) {
            if (options.metricReader() != null) {
                meterBuilder.registerMetricReader(options.metricReader());
            } else if ("otlp".equals(env.metrics().exporter())) {
                MetricExporter otlpMetric = buildOtlpMetricExporter(env.metrics());
                meterBuilder.registerMetricReader(
                        PeriodicMetricReader.builder(otlpMetric)
                                .setInterval(env.metricExportInterval())
                                .build());
            }
        }
        SdkMeterProvider sdkMeterProvider = meterBuilder.build();
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
        if (options.runtimeMetrics() && !env.sdkDisabled()) {
            jvmMetrics = PolicyBridges.JvmRuntimeMetrics.register(policyMeterProvider.get("libo11y.runtime"));
        }

        // 7. Logs pipeline
        SdkLoggerProviderBuilder loggerBuilder = SdkLoggerProvider.builder()
                .setResource(composed.resource());

        if (!env.sdkDisabled()) {
            // One policy processor in front of every log processor, so a record is classified once.
            List<LogRecordProcessor> logProcessors = new ArrayList<>();
            if (options.logRecordExporter() != null) {
                logProcessors.add(BatchLogRecordProcessor.builder(options.logRecordExporter()).build());
            } else if ("otlp".equals(env.logs().exporter())) {
                LogRecordExporter otlpLog = buildOtlpLogExporter(env.logs());
                logProcessors.add(BatchLogRecordProcessor.builder(otlpLog).build());
            }
            logProcessors.addAll(options.logRecordProcessors());
            if (!logProcessors.isEmpty()) {
                loggerBuilder.addLogRecordProcessor(new PolicyBridges.PolicyLogRecordProcessor(
                        policy, LogRecordProcessor.composite(logProcessors)));
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

        Map<String, Object> effectiveConfig = effectiveConfig(options, env, composed, baseProps);

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

    /**
     * Resolves the o11y.config.* attributes of the o11y.telemetry.configured event, the keys the
     * o11y.config group registers, with the values Go reports: what will actually happen once
     * option-over-environment precedence applies.
     */
    private static Map<String, Object> effectiveConfig(
            O11yOptions options,
            O11yEnvParser.ParsedEnv env,
            ResourceComposer.ComposedResource composed,
            List<TextMapPropagator> propagators) {
        boolean disabled = env.sdkDisabled();
        String traces;
        if (disabled) {
            traces = "none";
        } else if (options.spanExporter() != null) {
            traces = "injected";
        } else if (!"otlp".equals(env.traces().exporter()) && !options.spanProcessors().isEmpty()) {
            traces = "injected";
        } else {
            traces = env.traces().exporter();
        }
        String metrics = !disabled && options.metricReader() != null ? "injected" : env.metrics().exporter();
        String logs = !disabled && options.logRecordExporter() != null ? "injected" : env.logs().exporter();
        if (disabled) {
            metrics = "none";
            logs = "none";
        }
        String sampler = options.sampler() != null ? options.sampler().getDescription() : env.samplerName();

        Map<String, Object> cfg = new LinkedHashMap<>();
        String serviceName = composed.resource().getAttribute(AttributeKey.stringKey("service.name"));
        cfg.put("service.name", serviceName == null ? "" : serviceName);
        String serviceVersion = composed.resource().getAttribute(AttributeKey.stringKey("service.version"));
        if (serviceVersion != null && !serviceVersion.isEmpty()) {
            cfg.put("service.version", serviceVersion);
        }
        String prefix = Spec.Attributes.CONFIG + ".";
        cfg.put(prefix + "traces", traces);
        cfg.put(prefix + "metrics", metrics);
        cfg.put(prefix + "logs", logs);
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
        Map<String, String> rawEnv = env.hermetic()
                ? Map.of()
                : options.env() != null ? options.env() : System.getenv();
        String[][] endpoints = {
            {"endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"},
            {"traces_endpoint", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"},
            {"metrics_endpoint", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"},
            {"logs_endpoint", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"},
        };
        for (String[] ep : endpoints) {
            String raw = rawEnv.get(ep[1]);
            if (raw != null && !raw.isEmpty()) {
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
