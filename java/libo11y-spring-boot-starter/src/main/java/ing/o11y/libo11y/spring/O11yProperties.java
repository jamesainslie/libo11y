package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.ExemplarFilterMode;
import ing.o11y.libo11y.PiiMode;
import io.opentelemetry.api.logs.Severity;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Spring Boot configuration properties under {@code libo11y.*}. */
@ConfigurationProperties(prefix = "libo11y")
public class O11yProperties {
    /** Whether the libo11y auto-configuration is active. */
    private boolean enabled = true;

    /** The {@code service.name} resource attribute. Defaults to {@code spring.application.name}. */
    private String serviceName;

    /** The {@code service.version} resource attribute. */
    private String serviceVersion;

    /** The {@code service.namespace} resource attribute. */
    private String serviceNamespace;

    /** The deployment environment ({@code deployment.environment.name}), one of the spec's environment names. */
    private String environment;

    /** Additional environment names accepted besides the spec's own. */
    private Set<String> extraEnvironments = new LinkedHashSet<>();

    /** Whether startup fails when the service name or environment is missing or invalid. */
    private boolean strictIdentity = true;

    /** How attributes classified as personal data are handled. */
    private PiiMode piiMode = PiiMode.DROP;

    /**
     * Key for hashing personal data in {@code hash} mode: raw UTF-8 text, or {@code base64:} or
     * {@code hex:} followed by the encoded key.
     */
    private String piiHashKey;

    /** Exemplar filter for metrics. Unset uses {@code OTEL_METRICS_EXEMPLAR_FILTER} or the trace-based default. */
    private ExemplarFilterMode exemplarFilter;

    /** Whether JVM runtime metrics are recorded. */
    private boolean runtimeMetrics = true;

    /** Whether to ignore the process environment and export nothing unless exporters are configured in code. */
    private boolean hermetic = false;

    /**
     * Whether to install the telemetry as the process-wide global ({@code GlobalOpenTelemetry} and
     * {@code O11y.global()}) and emit the {@code o11y.telemetry.configured} startup event. Only one
     * application context per JVM can do this; others fail with {@code ALREADY_SETUP}.
     */
    private boolean installGlobal = false;

    /** Whether to route SLF4J/Logback logging through libo11y with an appender on the root logger. */
    private boolean installLogbackAppender = true;

    /**
     * Whether libo11y writes its own JSON log lines to standard output. Defaults to off when the
     * Logback appender is installed, since Boot's console appender already prints each line, and
     * to on otherwise.
     */
    private Boolean consoleEnabled;

    /** Minimum severity of records emitted through libo11y's structured logger. */
    private Severity logLevel = Severity.INFO;

    /** Deadline for flushing all signals at shutdown. */
    private Duration shutdownTimeout = Duration.ofSeconds(5);

    /** Application attribute registries (YAML), as resource locations or file paths. */
    private List<String> appRegistries = new ArrayList<>();

    /** Extra resource attributes. */
    private Map<String, String> resourceAttributes = new LinkedHashMap<>();

    /** Baggage keys allowed to leave the process in outgoing requests. Empty sends all baggage. */
    private List<String> baggageEgressAllow = new ArrayList<>();

    /** Whether an observation outside any wide record is emitted as a standalone event. */
    private boolean emitObservationEvents = false;
    private final Http http = new Http();
    private final Jdbc jdbc = new Jdbc();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getServiceName() {
        return serviceName;
    }

    public void setServiceName(String serviceName) {
        this.serviceName = serviceName;
    }

    public String getServiceVersion() {
        return serviceVersion;
    }

    public void setServiceVersion(String serviceVersion) {
        this.serviceVersion = serviceVersion;
    }

    public String getServiceNamespace() {
        return serviceNamespace;
    }

    public void setServiceNamespace(String serviceNamespace) {
        this.serviceNamespace = serviceNamespace;
    }

    public String getEnvironment() {
        return environment;
    }

    public void setEnvironment(String environment) {
        this.environment = environment;
    }

    public Set<String> getExtraEnvironments() {
        return extraEnvironments;
    }

    public void setExtraEnvironments(Set<String> extraEnvironments) {
        this.extraEnvironments = extraEnvironments == null ? new LinkedHashSet<>() : extraEnvironments;
    }

    public boolean isStrictIdentity() {
        return strictIdentity;
    }

    public void setStrictIdentity(boolean strictIdentity) {
        this.strictIdentity = strictIdentity;
    }

    public PiiMode getPiiMode() {
        return piiMode;
    }

    public void setPiiMode(PiiMode piiMode) {
        this.piiMode = piiMode == null ? PiiMode.DROP : piiMode;
    }

    public String getPiiHashKey() {
        return piiHashKey;
    }

    public void setPiiHashKey(String piiHashKey) {
        this.piiHashKey = piiHashKey;
    }

    public ExemplarFilterMode getExemplarFilter() {
        return exemplarFilter;
    }

    public void setExemplarFilter(ExemplarFilterMode exemplarFilter) {
        this.exemplarFilter = exemplarFilter;
    }

    public boolean isRuntimeMetrics() {
        return runtimeMetrics;
    }

    public void setRuntimeMetrics(boolean runtimeMetrics) {
        this.runtimeMetrics = runtimeMetrics;
    }

    public boolean isHermetic() {
        return hermetic;
    }

    public void setHermetic(boolean hermetic) {
        this.hermetic = hermetic;
    }

    public boolean isInstallGlobal() {
        return installGlobal;
    }

    public void setInstallGlobal(boolean installGlobal) {
        this.installGlobal = installGlobal;
    }

    public boolean isInstallLogbackAppender() {
        return installLogbackAppender;
    }

    public void setInstallLogbackAppender(boolean installLogbackAppender) {
        this.installLogbackAppender = installLogbackAppender;
    }

    /** Returns the configured console setting, or {@code null} when it is left to the default. */
    public Boolean getConsoleEnabled() {
        return consoleEnabled;
    }

    public void setConsoleEnabled(Boolean consoleEnabled) {
        this.consoleEnabled = consoleEnabled;
    }

    public Severity getLogLevel() {
        return logLevel;
    }

    public void setLogLevel(Severity logLevel) {
        this.logLevel = logLevel == null ? Severity.INFO : logLevel;
    }

    public Duration getShutdownTimeout() {
        return shutdownTimeout;
    }

    public void setShutdownTimeout(Duration shutdownTimeout) {
        if (shutdownTimeout != null) {
            this.shutdownTimeout = shutdownTimeout;
        }
    }

    public List<String> getAppRegistries() {
        return appRegistries;
    }

    public void setAppRegistries(List<String> appRegistries) {
        this.appRegistries = appRegistries == null ? new ArrayList<>() : appRegistries;
    }

    public Map<String, String> getResourceAttributes() {
        return resourceAttributes;
    }

    public void setResourceAttributes(Map<String, String> resourceAttributes) {
        this.resourceAttributes = resourceAttributes == null ? new LinkedHashMap<>() : resourceAttributes;
    }

    public List<String> getBaggageEgressAllow() {
        return baggageEgressAllow;
    }

    public void setBaggageEgressAllow(List<String> baggageEgressAllow) {
        this.baggageEgressAllow = baggageEgressAllow == null ? new ArrayList<>() : baggageEgressAllow;
    }

    public boolean isEmitObservationEvents() {
        return emitObservationEvents;
    }

    public void setEmitObservationEvents(boolean emitObservationEvents) {
        this.emitObservationEvents = emitObservationEvents;
    }

    public Http getHttp() {
        return http;
    }

    public Jdbc getJdbc() {
        return jdbc;
    }

    /** HTTP server and client instrumentation, under {@code libo11y.http.*}. */
    public static class Http {
        /**
         * Whether libo11y instruments HTTP server requests. While it does, Spring's own HTTP server
         * observation is switched off so each request has one SERVER span; set this to false to
         * leave the signal to Spring.
         */
        private boolean enabled = true;

        /**
         * Whether libo11y instruments outgoing {@code RestClient} and {@code RestTemplate} calls.
         * While it does, Spring's own HTTP client observation is switched off so each call has one
         * CLIENT span; set this to false to leave the signal to Spring.
         */
        private boolean clientEnabled = true;

        /** Whether inbound trace context is linked rather than adopted as the parent, for internet-facing servers. */
        private boolean publicEndpoint = false;

        /**
         * Whether HTML responses get a {@code Server-Timing: traceparent;desc="..."} entry naming the
         * server span, for browser instrumentation to join the backend trace.
         */
        private boolean serverTiming = false;

        /** Whether each request emits one {@code o11y.request.summary} wide event. */
        private boolean canonicalLine = false;

        /**
         * Request paths that are not traced, measured or summarised, as Go {@code path.Match}
         * patterns matched against the decoded path within the application (without the context
         * path). Malformed patterns fail startup.
         */
        private List<String> ignorePaths = new ArrayList<>(List.of(
                "/actuator/health", "/actuator/health/*", "/healthz", "/readyz"));

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public boolean isClientEnabled() {
            return clientEnabled;
        }

        public void setClientEnabled(boolean clientEnabled) {
            this.clientEnabled = clientEnabled;
        }

        public boolean isPublicEndpoint() {
            return publicEndpoint;
        }

        public void setPublicEndpoint(boolean publicEndpoint) {
            this.publicEndpoint = publicEndpoint;
        }

        public boolean isServerTiming() {
            return serverTiming;
        }

        public void setServerTiming(boolean serverTiming) {
            this.serverTiming = serverTiming;
        }

        public boolean isCanonicalLine() {
            return canonicalLine;
        }

        public void setCanonicalLine(boolean canonicalLine) {
            this.canonicalLine = canonicalLine;
        }

        public List<String> getIgnorePaths() {
            return ignorePaths;
        }

        public void setIgnorePaths(List<String> ignorePaths) {
            this.ignorePaths = ignorePaths == null ? new ArrayList<>() : ignorePaths;
        }
    }

    /** JDBC instrumentation, under {@code libo11y.jdbc.*}. */
    public static class Jdbc {
        /** Whether DataSource beans are wrapped with libo11y's JDBC instrumentation. */
        private boolean enabled = true;

        /** The {@code db.system.name} attribute. Unset detects it from the connection. */
        private String dbSystem;

        /** The {@code db.namespace} attribute, for example the database name. */
        private String dbNamespace;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public String getDbSystem() {
            return dbSystem;
        }

        public void setDbSystem(String dbSystem) {
            this.dbSystem = dbSystem;
        }

        public String getDbNamespace() {
            return dbNamespace;
        }

        public void setDbNamespace(String dbNamespace) {
            this.dbNamespace = dbNamespace;
        }
    }
}
