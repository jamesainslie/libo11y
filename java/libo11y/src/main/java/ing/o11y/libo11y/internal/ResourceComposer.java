package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.sdk.resources.Resource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Composes the single schema-stamped OpenTelemetry Resource with tier-0 validation and sensitivity filtering. */
public final class ResourceComposer {
    private static final String UNKNOWN_VERSION = "0.0.0-unknown";
    /** The OpenTelemetry Go container detector's pattern, applied to each /proc/self/cgroup line. */
    private static final Pattern CONTAINER_ID_RE = Pattern.compile("^.*/(?:.*[-:])?([0-9a-f]+)(?:\\.|[\\t\\n\\f\\r ]*$)");
    private static final Path CGROUP_PATH = Path.of("/proc/self/cgroup");

    /** Rule counted when no usable service.name resolves under lenient identity. */
    public static final String RULE_IDENTITY_SERVICE_NAME = "identity_service_name";
    /** Rule counted when no deployment.environment.name resolves under lenient identity. */
    public static final String RULE_IDENTITY_ENVIRONMENT = "identity_environment";
    /** Rule counted when deployment.environment.name is not an allowed value under lenient identity. */
    public static final String RULE_IDENTITY_ENVIRONMENT_INVALID = "identity_environment_invalid";

    private ResourceComposer() {}

    /**
     * The composed resource and what composing it found.
     *
     * @param resource the classified, schema-stamped resource
     * @param identityViolations the identity rules not met under lenient identity, in check order
     * @param classificationViolations how many resource attributes the policy dropped or tokenized,
     *     per violation rule, for the caller to count once the violation counter exists
     * @param serviceVersionFallback whether service.version fell back to {@code 0.0.0-unknown}
     */
    public record ComposedResource(
            Resource resource,
            List<String> identityViolations,
            Map<String, Long> classificationViolations,
            boolean serviceVersionFallback) {}

    public static ComposedResource compose(
            O11yOptions options,
            O11yEnvParser.ParsedEnv env,
            SensitivityPolicy policy) {
        Map<String, String> attrs = new LinkedHashMap<>();

        // 1. Telemetry SDK identity (the OpenTelemetry SDK's own, as in Go) and runtime defaults
        Resource otelDefault = Resource.getDefault();
        for (String key : List.of("telemetry.sdk.name", "telemetry.sdk.language", "telemetry.sdk.version")) {
            String value = otelDefault.getAttribute(AttributeKey.stringKey(key));
            if (value != null && !value.isEmpty()) {
                attrs.put(key, value);
            }
        }
        attrs.put("process.runtime.name", System.getProperty("java.vm.name", "jvm"));
        attrs.put("process.runtime.version", System.getProperty("java.version", ""));

        String hostName = detectHostName();
        if (!hostName.isEmpty()) {
            attrs.put("host.name", hostName);
        }
        String containerId = detectContainerId();
        if (containerId != null && !containerId.isEmpty()) {
            attrs.put("container.id", containerId);
        }

        // 2. Build info (if supplied and enabled)
        if (options.buildInfoEnabled() && options.buildInfo() != null) {
            O11yOptions.BuildInfo bi = options.buildInfo();
            if (bi.version() != null && !bi.version().isEmpty()) {
                attrs.put("service.version", bi.version());
            }
            if (bi.vcsRevision() != null && !bi.vcsRevision().isEmpty()) {
                attrs.put("vcs.ref.head.revision", bi.vcsRevision());
            }
            if (bi.buildTime() != null && !bi.buildTime().isEmpty()) {
                attrs.put(Spec.Attributes.BUILD_TIME, bi.buildTime());
            }
            if (bi.buildModified() != null) {
                attrs.put(Spec.Attributes.BUILD_MODIFIED, Boolean.toString(bi.buildModified()));
            }
        }

        // 3. OTEL_RESOURCE_ATTRIBUTES and OTEL_SERVICE_NAME (only when not hermetic)
        if (!env.hermetic()) {
            attrs.putAll(env.resourceAttributes());
            if (!env.serviceName().isEmpty()) {
                attrs.put("service.name", env.serviceName());
            }
        }

        // 4. Explicit resourceAttributes and code-level options (highest precedence)
        if (options.resourceAttributes() != null) {
            attrs.putAll(options.resourceAttributes());
        }
        if (options.serviceName() != null && !options.serviceName().isEmpty()) {
            attrs.put("service.name", options.serviceName());
        }
        if (options.serviceVersion() != null && !options.serviceVersion().isEmpty()) {
            attrs.put("service.version", options.serviceVersion());
        }
        if (options.serviceNamespace() != null && !options.serviceNamespace().isEmpty()) {
            attrs.put("service.namespace", options.serviceNamespace());
        }
        if (options.environment() != null && !options.environment().isEmpty()) {
            attrs.put("deployment.environment.name", options.environment());
        }

        // 5. Tier-0 required identity validation
        List<String> missing = new java.util.ArrayList<>();
        String serviceName = attrs.getOrDefault("service.name", "").trim();
        if (serviceName.isEmpty() || "unknown_service".equals(serviceName) || serviceName.startsWith("unknown_service:")) {
            if (options.strictIdentity()) {
                throw new O11yException(
                        O11yException.ErrorCode.NO_SERVICE_NAME,
                        "service.name is required and must not be empty or unknown_service");
            }
            missing.add(RULE_IDENTITY_SERVICE_NAME);
        }

        String deployEnv = attrs.getOrDefault("deployment.environment.name", "").trim();
        Set<String> allowedEnvs = new HashSet<>(SpecTables.ENVIRONMENT_VALUES);
        if (options.extraEnvironments() != null) {
            allowedEnvs.addAll(options.extraEnvironments());
        }
        if (deployEnv.isEmpty()) {
            if (options.strictIdentity()) {
                throw new O11yException(
                        O11yException.ErrorCode.NO_ENVIRONMENT,
                        "deployment.environment.name is required");
            }
            missing.add(RULE_IDENTITY_ENVIRONMENT);
        } else if (!allowedEnvs.contains(deployEnv)) {
            if (options.strictIdentity()) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_ENVIRONMENT,
                        "deployment.environment.name " + deployEnv + " is not in allowed environments " + allowedEnvs);
            }
            missing.add(RULE_IDENTITY_ENVIRONMENT_INVALID);
        }

        // service.version fallback, flagged in the effective configuration
        boolean versionFallback = attrs.getOrDefault("service.version", "").trim().isEmpty();
        if (versionFallback) {
            attrs.put("service.version", UNKNOWN_VERSION);
        }

        // service.instance.id derivation
        if (attrs.getOrDefault("service.instance.id", "").trim().isEmpty()) {
            String derived = InstanceId.derive(
                    attrs.getOrDefault("k8s.pod.uid", ""),
                    attrs.getOrDefault("k8s.pod.name", ""),
                    attrs.getOrDefault("k8s.namespace.name", ""));
            attrs.put("service.instance.id", derived != null ? derived : InstanceId.random());
        }

        // 6. Classify resource attributes through SensitivityPolicy. The violation counter does
        // not exist yet, so the drops and rewrites are returned for the caller to count.
        AttributesBuilder builder = Attributes.builder();
        Map<String, Long> counts = new TreeMap<>();
        for (Map.Entry<String, String> entry : attrs.entrySet()) {
            String k = entry.getKey();
            String v = entry.getValue();
            if (k == null || k.isEmpty() || v == null) {
                continue;
            }
            SpecTables.Sensitivity sens = policy.sensitivityOf(k);
            if (sens == SpecTables.Sensitivity.SECRET
                    || (sens == SpecTables.Sensitivity.PII && policy.piiMode() != PiiMode.KEEP)) {
                counts.merge(SensitivityPolicy.ruleFor(sens), 1L, Long::sum);
            }
            if (Spec.Attributes.BUILD_MODIFIED.equals(k)) {
                boolean b = Boolean.parseBoolean(v);
                SensitivityPolicy.Decision d = policy.classifyScalar(k, b, null, false);
                if (!d.drop()) {
                    builder.put(AttributeKey.booleanKey(k), (Boolean) d.value());
                }
                continue;
            }
            SensitivityPolicy.Decision d = policy.classifyScalar(k, v, null, false);
            if (!d.drop() && d.value() != null) {
                builder.put(AttributeKey.stringKey(k), String.valueOf(d.value()));
            }
        }

        Resource resource = Resource.create(builder.build(), Spec.SCHEMA_URL);
        return new ComposedResource(resource, List.copyOf(missing), Map.copyOf(counts), versionFallback);
    }

    private static String detectHostName() {
        try {
            String name = InetAddress.getLocalHost().getHostName();
            return name == null ? "" : name;
        } catch (Exception ex) {
            return "";
        }
    }

    /**
     * Extracts the container ID from /proc/self/cgroup content the way the OpenTelemetry Go
     * container detector does: the first line whose last path segment ends in a hex run (after an
     * optional prefix ending in '-' or ':') followed by '.' or the end of the line. Returns null when
     * no line matches.
     */
    public static String containerIdFromCgroup(String cgroup) {
        for (String line : cgroup.split("\\r?\\n")) {
            Matcher m = CONTAINER_ID_RE.matcher(line);
            if (m.find()) {
                return m.group(1);
            }
        }
        return null;
    }

    private static String detectContainerId() {
        if (!Files.isReadable(CGROUP_PATH)) {
            return null;
        }
        try {
            return containerIdFromCgroup(Files.readString(CGROUP_PATH, StandardCharsets.UTF_8));
        } catch (IOException | UncheckedIOException ex) {
            // A missing container ID degrades telemetry identity; it never blocks startup.
            return null;
        }
    }
}
