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
    private boolean enabled = true;
    private String serviceName;
    private String serviceVersion;
    private String serviceNamespace;
    private String environment;
    private Set<String> extraEnvironments = new LinkedHashSet<>();
    private boolean strictIdentity = true;
    private PiiMode piiMode = PiiMode.DROP;
    private String piiHashKey;
    private ExemplarFilterMode exemplarFilter;
    private boolean runtimeMetrics = true;
    private boolean hermetic = false;
    private boolean installGlobal = true;
    private boolean installLogbackAppender = true;
    private boolean consoleEnabled = true;
    private Severity logLevel = Severity.INFO;
    private Duration shutdownTimeout = Duration.ofSeconds(5);
    private List<String> appRegistries = new ArrayList<>();
    private Map<String, String> resourceAttributes = new LinkedHashMap<>();
    private List<String> baggageEgressAllow = new ArrayList<>();
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

    public boolean isConsoleEnabled() {
        return consoleEnabled;
    }

    public void setConsoleEnabled(boolean consoleEnabled) {
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

    public static class Http {
        private boolean enabled = true;
        private boolean publicEndpoint = false;
        private boolean serverTiming = true;
        private boolean canonicalLine = true;
        private List<String> ignorePaths = new ArrayList<>(List.of(
                "/actuator/health", "/actuator/health/*", "/healthz", "/readyz"));

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
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

    public static class Jdbc {
        private boolean enabled = true;
        private String dbSystem;
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
