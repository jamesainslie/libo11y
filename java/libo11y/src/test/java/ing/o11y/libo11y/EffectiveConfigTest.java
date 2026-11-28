package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import ing.o11y.libo11y.TestReaders.CollectingSpanExporter;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

class EffectiveConfigTest {
    private static Map<String, Object> config(O11yOptions.Builder b) {
        Telemetry t = O11y.init(b.build());
        try {
            return new LinkedHashMap<>(t.effectiveConfig());
        } finally {
            t.shutdown();
        }
    }

    private static Map<String, Object> config(Consumer<O11yOptions.Builder> customize) {
        O11yOptions.Builder b = TestReaders.baseOptions(new CollectingReader());
        customize.accept(b);
        return config(b);
    }

    @Test
    void hermeticDefaultsMatchGo() {
        Map<String, Object> want = new LinkedHashMap<>();
        want.put("service.name", "policy-test");
        want.put("service.version", "1.2.3");
        want.put("o11y.config.traces", "none");
        want.put("o11y.config.metrics", "injected");
        want.put("o11y.config.logs", "none");
        want.put("o11y.config.console", "json");
        want.put("o11y.config.level", "INFO");
        want.put("o11y.config.sampler", "parentbased_always_on");
        want.put("o11y.config.propagators", "traceparent,tracestate,baggage");
        want.put("o11y.config.runtime_metrics", "false");
        assertEquals(want, config(b -> { }));
    }

    @Test
    void injectedPipelinesCodeSamplerLevelConsoleAndRuntimeMetrics() {
        Map<String, Object> cfg = config(b -> b
                .spanExporter(new CollectingSpanExporter())
                .logRecordExporter(io.opentelemetry.sdk.logs.export.LogRecordExporter.composite())
                .sampler(Sampler.alwaysOff())
                .logLevel(Severity.WARN)
                .consoleEnabled(false)
                .runtimeMetrics(true));
        assertEquals("injected", cfg.get("o11y.config.traces"));
        assertEquals("injected", cfg.get("o11y.config.logs"));
        assertEquals(Sampler.alwaysOff().getDescription(), cfg.get("o11y.config.sampler"));
        assertEquals("WARN", cfg.get("o11y.config.level"));
        assertEquals("off", cfg.get("o11y.config.console"));
        assertEquals("true", cfg.get("o11y.config.runtime_metrics"));
        assertEquals("DEBUG", config(b -> b.logLevel(Severity.DEBUG)).get("o11y.config.level"));
        assertEquals("ERROR", config(b -> b.logLevel(Severity.FATAL)).get("o11y.config.level"));
    }

    @Test
    void anInjectedProcessorAloneReportsInjectedTraces() {
        Map<String, Object> cfg = config(b -> b.addSpanProcessor(SimpleSpanProcessor.create(new CollectingSpanExporter())));
        assertEquals("injected", cfg.get("o11y.config.traces"));
    }

    @Test
    void versionFallbackIsFlagged() {
        Map<String, Object> cfg = config(b -> b.serviceVersion(null).buildInfoEnabled(false));
        assertEquals("0.0.0-unknown", cfg.get("service.version"));
        assertEquals("true", cfg.get("o11y.config.service_version_fallback"));
        assertFalse(config(b -> { }).containsKey("o11y.config.service_version_fallback"));
    }

    @Test
    void environmentEndpointsAreSanitizedUnderTheirRegisteredKeys() {
        Map<String, String> env = Map.of(
                "OTEL_TRACES_EXPORTER", "none",
                "OTEL_METRICS_EXPORTER", "none",
                "OTEL_LOGS_EXPORTER", "none",
                "OTEL_EXPORTER_OTLP_ENDPOINT", "https://user:pw@collector.example:4318/v1?token=x",
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "collector.example:4317",
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "https://metrics.example:4318/v1/metrics",
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://logs.example:4318/v1/logs");
        Map<String, Object> cfg = config(O11yOptions.builder()
                .env(env)
                .serviceName("policy-test")
                .environment("test")
                .serviceVersion("1.2.3")
                .consoleOutput(new java.io.ByteArrayOutputStream())
                .runtimeMetrics(false));
        assertEquals("none", cfg.get("o11y.config.traces"));
        assertEquals("none", cfg.get("o11y.config.metrics"));
        assertEquals("none", cfg.get("o11y.config.logs"));
        assertEquals("https://collector.example:4318/v1", cfg.get("o11y.config.endpoint"));
        assertEquals("collector.example:4317", cfg.get("o11y.config.traces_endpoint"));
        assertEquals("https://metrics.example:4318/v1/metrics", cfg.get("o11y.config.metrics_endpoint"));
        assertEquals("https://logs.example:4318/v1/logs", cfg.get("o11y.config.logs_endpoint"));
        assertEquals(Set.of(), unregistered(cfg));
    }

    @Test
    void everyEmittedKeyIsRegistered() {
        assertTrue(SpecTables.SENSITIVITY_OF.containsKey(Spec.Attributes.CONFIG));
        assertEquals(Set.of(), unregistered(config(b -> { })));
        assertEquals(Set.of(), unregistered(config(b -> b.serviceVersion(null).buildInfoEnabled(false))));
    }

    private static Set<String> unregistered(Map<String, Object> cfg) {
        Set<String> registered = registeredConfigKeys();
        Set<String> bad = new TreeSet<>();
        for (String key : cfg.keySet()) {
            boolean ok = key.startsWith(Spec.Attributes.CONFIG + ".")
                    ? registered.contains(key)
                    : SpecTables.SENSITIVITY_OF.containsKey(key);
            if (!ok) {
                bad.add(key);
            }
        }
        return bad;
    }

    /** The o11y.config.* keys the o11y.config template group's brief registers. */
    private static Set<String> registeredConfigKeys() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("spec/registry/attributes/o11y.yaml"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("spec/registry/attributes/o11y.yaml not found");
        }
        String yaml;
        try {
            yaml = Files.readString(dir.resolve("spec/registry/attributes/o11y.yaml"), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
        int start = yaml.indexOf("- id: o11y.config\n");
        int end = yaml.indexOf("- id:", start + 1);
        assertTrue(start >= 0 && end > start, "o11y.config group not found");
        Set<String> keys = new TreeSet<>();
        Matcher m = Pattern.compile("o11y\\.config\\.[a-z_]+").matcher(yaml.substring(start, end));
        while (m.find()) {
            keys.add(m.group());
        }
        assertTrue(keys.contains("o11y.config.service_version_fallback"), keys.toString());
        return keys;
    }
}
