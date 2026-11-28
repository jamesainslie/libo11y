package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.sdk.resources.Resource;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Composes the single schema-stamped OpenTelemetry Resource with tier-0 validation and sensitivity filtering. */
public final class ResourceComposer {
    private static final String UNKNOWN_VERSION = "0.0.0-unknown";
    private static final Pattern CONTAINER_ID_RE = Pattern.compile("([0-9a-fA-F]{64})");

    private ResourceComposer() {}

    public record ComposedResource(Resource resource, List<String> missingIdentity) {}

    public static ComposedResource compose(
            O11yOptions options,
            O11yEnvParser.ParsedEnv env,
            SensitivityPolicy policy) {
        Map<String, String> attrs = new LinkedHashMap<>();

        // 1. Telemetry SDK and runtime defaults
        attrs.put("telemetry.sdk.name", "libo11y");
        attrs.put("telemetry.sdk.language", "java");
        attrs.put("telemetry.sdk.version", "0.1.0");
        attrs.put("process.runtime.name", System.getProperty("java.vm.name", "jvm"));
        attrs.put("process.runtime.version", System.getProperty("java.version", ""));
        attrs.put("process.runtime.description",
                System.getProperty("java.vm.vendor", "") + " " + System.getProperty("java.runtime.version", ""));

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
            missing.add("service.name");
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
            missing.add("deployment.environment.name");
        } else if (!allowedEnvs.contains(deployEnv)) {
            if (options.strictIdentity()) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_ENVIRONMENT,
                        "deployment.environment.name " + deployEnv + " is not in allowed environments " + allowedEnvs);
            }
            missing.add("deployment.environment.name");
        }

        // service.version fallback
        if (attrs.getOrDefault("service.version", "").trim().isEmpty()) {
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

        // 6. Classify resource attributes through SensitivityPolicy (never count violations at init)
        AttributesBuilder builder = Attributes.builder();
        for (Map.Entry<String, String> entry : attrs.entrySet()) {
            String k = entry.getKey();
            String v = entry.getValue();
            if (k == null || k.isEmpty() || v == null) {
                continue;
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
        return new ComposedResource(resource, List.copyOf(missing));
    }

    private static String detectHostName() {
        try {
            String name = InetAddress.getLocalHost().getHostName();
            return name == null ? "" : name;
        } catch (Exception ex) {
            return "";
        }
    }

    private static String detectContainerId() {
        Path cgroup = Path.of("/proc/self/cgroup");
        if (!Files.isReadable(cgroup)) {
            return null;
        }
        try {
            List<String> lines = Files.readAllLines(cgroup, StandardCharsets.UTF_8);
            for (String line : lines) {
                Matcher m = CONTAINER_ID_RE.matcher(line);
                if (m.find()) {
                    return m.group(1);
                }
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }
}
