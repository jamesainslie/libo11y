package ing.o11y.libo11y;

import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.export.LogRecordExporter;
import io.opentelemetry.sdk.metrics.export.MetricReader;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.OutputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Predicate;

/** Configuration options for {@link O11y#setup(O11yOptions)} and {@link O11y#init(O11yOptions)}. */
public final class O11yOptions {
    public record BuildInfo(String version, String vcsRevision, String buildTime, Boolean buildModified) {}

    public sealed interface AppRegistrySource permits AppRegistryFile, AppRegistryYaml {}

    public record AppRegistryFile(Path path) implements AppRegistrySource {}

    public record AppRegistryYaml(String yaml, String source) implements AppRegistrySource {}

    private final String serviceName;
    private final String serviceVersion;
    private final String serviceNamespace;
    private final String environment;
    private final Set<String> extraEnvironments;
    private final boolean strictIdentity;
    private final Map<String, String> resourceAttributes;
    private final PiiMode piiMode;
    private final byte[] piiHashKey;
    private final List<AppRegistrySource> appRegistries;
    private final Map<String, String> env;
    private final Sampler sampler;
    private final ExemplarFilterMode exemplarFilter;
    private final Map<String, List<Double>> histogramBuckets;
    private final List<TextMapPropagator> propagators;
    private final Predicate<String> baggageEgressAllow;
    private final boolean runtimeMetrics;
    private final Severity logLevel;
    private final boolean consoleEnabled;
    private final OutputStream consoleOutput;
    private final BiFunction<String, Object, Object> attrReplacer;
    private final SpanExporter spanExporter;
    private final List<SpanProcessor> spanProcessors;
    private final MetricReader metricReader;
    private final LogRecordExporter logRecordExporter;
    private final List<LogRecordProcessor> logRecordProcessors;
    private final List<Consumer<StructuredLogger.LogEntry>> extraLogSinks;
    private final BuildInfo buildInfo;
    private final boolean buildInfoEnabled;
    private final Duration shutdownTimeout;

    private O11yOptions(Builder b) {
        this.serviceName = b.serviceName;
        this.serviceVersion = b.serviceVersion;
        this.serviceNamespace = b.serviceNamespace;
        this.environment = b.environment;
        this.extraEnvironments = Collections.unmodifiableSet(new LinkedHashSet<>(b.extraEnvironments));
        this.strictIdentity = b.strictIdentity;
        this.resourceAttributes = Collections.unmodifiableMap(new LinkedHashMap<>(b.resourceAttributes));
        this.piiMode = b.piiMode;
        this.piiHashKey = b.piiHashKey == null ? null : b.piiHashKey.clone();
        this.appRegistries = List.copyOf(b.appRegistries);
        this.env = b.env;
        this.sampler = b.sampler;
        this.exemplarFilter = b.exemplarFilter;
        Map<String, List<Double>> bucketsCopy = new LinkedHashMap<>();
        b.histogramBuckets.forEach((k, v) -> bucketsCopy.put(k, List.copyOf(v)));
        this.histogramBuckets = Collections.unmodifiableMap(bucketsCopy);
        this.propagators = b.propagators == null ? null : List.copyOf(b.propagators);
        this.baggageEgressAllow = b.baggageEgressAllow;
        this.runtimeMetrics = b.runtimeMetrics;
        this.logLevel = b.logLevel;
        this.consoleEnabled = b.consoleEnabled;
        this.consoleOutput = b.consoleOutput;
        this.attrReplacer = b.attrReplacer;
        this.spanExporter = b.spanExporter;
        this.spanProcessors = List.copyOf(b.spanProcessors);
        this.metricReader = b.metricReader;
        this.logRecordExporter = b.logRecordExporter;
        this.logRecordProcessors = List.copyOf(b.logRecordProcessors);
        this.extraLogSinks = List.copyOf(b.extraLogSinks);
        this.buildInfo = b.buildInfo;
        this.buildInfoEnabled = b.buildInfoEnabled;
        this.shutdownTimeout = b.shutdownTimeout;
    }

    public static Builder builder() {
        return new Builder();
    }

    public String serviceName() {
        return serviceName;
    }

    public String serviceVersion() {
        return serviceVersion;
    }

    public String serviceNamespace() {
        return serviceNamespace;
    }

    public String environment() {
        return environment;
    }

    public Set<String> extraEnvironments() {
        return extraEnvironments;
    }

    public boolean strictIdentity() {
        return strictIdentity;
    }

    public Map<String, String> resourceAttributes() {
        return resourceAttributes;
    }

    public PiiMode piiMode() {
        return piiMode;
    }

    public byte[] piiHashKey() {
        return piiHashKey == null ? null : piiHashKey.clone();
    }

    public List<AppRegistrySource> appRegistries() {
        return appRegistries;
    }

    public Map<String, String> env() {
        return env;
    }

    public Sampler sampler() {
        return sampler;
    }

    public ExemplarFilterMode exemplarFilter() {
        return exemplarFilter;
    }

    public Map<String, List<Double>> histogramBuckets() {
        return histogramBuckets;
    }

    public List<TextMapPropagator> propagators() {
        return propagators;
    }

    public Predicate<String> baggageEgressAllow() {
        return baggageEgressAllow;
    }

    public boolean runtimeMetrics() {
        return runtimeMetrics;
    }

    public Severity logLevel() {
        return logLevel;
    }

    public boolean consoleEnabled() {
        return consoleEnabled;
    }

    public OutputStream consoleOutput() {
        return consoleOutput;
    }

    public BiFunction<String, Object, Object> attrReplacer() {
        return attrReplacer;
    }

    public SpanExporter spanExporter() {
        return spanExporter;
    }

    public List<SpanProcessor> spanProcessors() {
        return spanProcessors;
    }

    public MetricReader metricReader() {
        return metricReader;
    }

    public LogRecordExporter logRecordExporter() {
        return logRecordExporter;
    }

    public List<LogRecordProcessor> logRecordProcessors() {
        return logRecordProcessors;
    }

    public List<Consumer<StructuredLogger.LogEntry>> extraLogSinks() {
        return extraLogSinks;
    }

    public BuildInfo buildInfo() {
        return buildInfo;
    }

    public boolean buildInfoEnabled() {
        return buildInfoEnabled;
    }

    public Duration shutdownTimeout() {
        return shutdownTimeout;
    }

    public static final class Builder {
        private String serviceName;
        private String serviceVersion;
        private String serviceNamespace;
        private String environment;
        private final Set<String> extraEnvironments = new LinkedHashSet<>();
        private boolean strictIdentity = true;
        private final Map<String, String> resourceAttributes = new LinkedHashMap<>();
        private PiiMode piiMode = PiiMode.DROP;
        private byte[] piiHashKey;
        private final List<AppRegistrySource> appRegistries = new ArrayList<>();
        private Map<String, String> env;
        private Sampler sampler;
        private ExemplarFilterMode exemplarFilter;
        private final Map<String, List<Double>> histogramBuckets = new LinkedHashMap<>();
        private List<TextMapPropagator> propagators;
        private Predicate<String> baggageEgressAllow;
        private boolean runtimeMetrics = true;
        private Severity logLevel = Severity.INFO;
        private boolean consoleEnabled = true;
        private OutputStream consoleOutput;
        private BiFunction<String, Object, Object> attrReplacer;
        private SpanExporter spanExporter;
        private final List<SpanProcessor> spanProcessors = new ArrayList<>();
        private MetricReader metricReader;
        private LogRecordExporter logRecordExporter;
        private final List<LogRecordProcessor> logRecordProcessors = new ArrayList<>();
        private final List<Consumer<StructuredLogger.LogEntry>> extraLogSinks = new ArrayList<>();
        private BuildInfo buildInfo;
        private boolean buildInfoEnabled = true;
        private Duration shutdownTimeout = Duration.ofSeconds(5);

        public Builder serviceName(String serviceName) {
            this.serviceName = serviceName;
            return this;
        }

        public Builder serviceVersion(String serviceVersion) {
            this.serviceVersion = serviceVersion;
            return this;
        }

        public Builder serviceNamespace(String serviceNamespace) {
            this.serviceNamespace = serviceNamespace;
            return this;
        }

        public Builder environment(String environment) {
            this.environment = environment;
            return this;
        }

        public Builder addExtraEnvironment(String envName) {
            if (envName != null && !envName.isEmpty()) {
                this.extraEnvironments.add(envName);
            }
            return this;
        }

        public Builder extraEnvironments(Set<String> envs) {
            this.extraEnvironments.clear();
            if (envs != null) {
                this.extraEnvironments.addAll(envs);
            }
            return this;
        }

        public Builder strictIdentity(boolean strictIdentity) {
            this.strictIdentity = strictIdentity;
            return this;
        }

        public Builder resourceAttribute(String key, String value) {
            this.resourceAttributes.put(key, value);
            return this;
        }

        public Builder resourceAttributes(Map<String, String> attrs) {
            if (attrs != null) {
                this.resourceAttributes.putAll(attrs);
            }
            return this;
        }

        public Builder piiMode(PiiMode piiMode) {
            this.piiMode = piiMode == null ? PiiMode.DROP : piiMode;
            return this;
        }

        public Builder piiHashKey(byte[] piiHashKey) {
            this.piiHashKey = piiHashKey == null ? null : piiHashKey.clone();
            return this;
        }

        public Builder addAppRegistryFile(Path path) {
            this.appRegistries.add(new AppRegistryFile(path));
            return this;
        }

        public Builder addAppRegistryYaml(String yaml, String source) {
            this.appRegistries.add(new AppRegistryYaml(yaml, source));
            return this;
        }

        public Builder env(Map<String, String> env) {
            this.env = env;
            return this;
        }

        public Builder hermetic() {
            this.env = O11yEnv.HERMETIC;
            return this;
        }

        public Builder sampler(Sampler sampler) {
            this.sampler = sampler;
            return this;
        }

        public Builder exemplarFilter(ExemplarFilterMode exemplarFilter) {
            this.exemplarFilter = exemplarFilter;
            return this;
        }

        public Builder histogramBuckets(String instrumentName, List<Double> boundaries) {
            this.histogramBuckets.put(instrumentName, List.copyOf(boundaries));
            return this;
        }

        public Builder propagators(List<TextMapPropagator> propagators) {
            this.propagators = propagators == null ? null : List.copyOf(propagators);
            return this;
        }

        public Builder baggageEgressAllow(Predicate<String> allowKey) {
            this.baggageEgressAllow = allowKey;
            return this;
        }

        public Builder runtimeMetrics(boolean runtimeMetrics) {
            this.runtimeMetrics = runtimeMetrics;
            return this;
        }

        public Builder logLevel(Severity logLevel) {
            this.logLevel = logLevel == null ? Severity.INFO : logLevel;
            return this;
        }

        public Builder consoleEnabled(boolean consoleEnabled) {
            this.consoleEnabled = consoleEnabled;
            return this;
        }

        public Builder consoleOutput(OutputStream consoleOutput) {
            this.consoleOutput = consoleOutput;
            return this;
        }

        public Builder attrReplacer(BiFunction<String, Object, Object> attrReplacer) {
            this.attrReplacer = attrReplacer;
            return this;
        }

        public Builder spanExporter(SpanExporter spanExporter) {
            this.spanExporter = spanExporter;
            return this;
        }

        public Builder addSpanProcessor(SpanProcessor processor) {
            this.spanProcessors.add(processor);
            return this;
        }

        public Builder metricReader(MetricReader metricReader) {
            this.metricReader = metricReader;
            return this;
        }

        public Builder logRecordExporter(LogRecordExporter logRecordExporter) {
            this.logRecordExporter = logRecordExporter;
            return this;
        }

        public Builder addLogRecordProcessor(LogRecordProcessor processor) {
            this.logRecordProcessors.add(processor);
            return this;
        }

        public Builder addExtraLogSink(Consumer<StructuredLogger.LogEntry> sink) {
            this.extraLogSinks.add(sink);
            return this;
        }

        public Builder buildInfo(BuildInfo buildInfo) {
            this.buildInfo = buildInfo;
            return this;
        }

        public Builder buildInfoEnabled(boolean buildInfoEnabled) {
            this.buildInfoEnabled = buildInfoEnabled;
            return this;
        }

        public Builder shutdownTimeout(Duration shutdownTimeout) {
            if (shutdownTimeout != null && !shutdownTimeout.isNegative() && !shutdownTimeout.isZero()) {
                this.shutdownTimeout = shutdownTimeout;
            }
            return this;
        }

        public O11yOptions build() {
            return new O11yOptions(this);
        }
    }
}
