package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import ing.o11y.libo11y.TestReaders.CollectingSpanExporter;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

class ViolationCounterTest {
    private static final String SECRET = "http.request.header.authorization";
    private static final String PII = "host.ip";
    private static final byte[] KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    private static void endSpan(Telemetry t, String key, String value) {
        Span span = t.tracer("violations").spanBuilder("op").setAttribute(key, value).startSpan();
        span.end();
        t.forceFlush(Duration.ofSeconds(5));
    }

    @Test
    void spanDropsUseTheRegisteredRuleIdsAndOnlyTheRegisteredDimensions() {
        CollectingReader reader = new CollectingReader();
        CollectingSpanExporter spans = new CollectingSpanExporter();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader).spanExporter(spans).build());
        try {
            endSpan(t, SECRET, "Bearer x");
            endSpan(t, PII, "10.0.0.1");
            assertEquals(1, TestReaders.violations(reader, "traces", "secret_attribute"));
            assertEquals(1, TestReaders.violations(reader, "traces", "pii_attribute"));
            List<PointData> pts = TestReaders.points(reader, "o11y.schema.violations");
            assertFalse(pts.isEmpty());
            for (PointData p : pts) {
                Set<String> keys = new java.util.TreeSet<>();
                p.getAttributes().forEach((k, v) -> keys.add(k.getKey()));
                assertEquals(Set.of("o11y.rule", "o11y.signal"), keys, "dimensions: " + p.getAttributes());
            }
        } finally {
            t.shutdown();
        }
    }

    @Test
    void aHashRewriteIsCounted() {
        CollectingReader reader = new CollectingReader();
        CollectingSpanExporter spans = new CollectingSpanExporter();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .piiMode(PiiMode.HASH)
                .piiHashKey(KEY)
                .spanExporter(spans)
                .build());
        try {
            endSpan(t, PII, "10.0.0.1");
            String token = spans.spans.get(0).getAttributes().get(AttributeKey.stringKey(PII));
            assertTrue(token.startsWith("hmac-sha256:"), token);
            assertEquals(1, TestReaders.violations(reader, "traces", "pii_attribute"));
        } finally {
            t.shutdown();
        }
    }

    @Test
    void resourceClassificationIsCountedOnTheResourceSignal() {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .resourceAttribute(PII, "10.0.0.1")
                .resourceAttribute(SECRET, "Bearer x")
                .build());
        try {
            assertEquals(null, t.resource().getAttribute(AttributeKey.stringKey(PII)));
            assertEquals(1, TestReaders.violations(reader, "resource", "pii_attribute"));
            assertEquals(1, TestReaders.violations(reader, "resource", "secret_attribute"));
        } finally {
            t.shutdown();
        }
    }

    @Test
    void lenientIdentityCountsTheSpecIdentityRules() {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .serviceName(null)
                .environment(null)
                .strictIdentity(false)
                .build());
        try {
            assertEquals(1, TestReaders.violations(reader, "resource", "identity_service_name"));
            assertEquals(1, TestReaders.violations(reader, "resource", "identity_environment"));
            assertEquals(0, TestReaders.violations(reader, "resource", "identity_environment_invalid"));
        } finally {
            t.shutdown();
        }

        CollectingReader reader2 = new CollectingReader();
        Telemetry t2 = O11y.init(TestReaders.baseOptions(reader2)
                .environment("moon")
                .strictIdentity(false)
                .build());
        try {
            assertEquals(1, TestReaders.violations(reader2, "resource", "identity_environment_invalid"));
            assertEquals(0, TestReaders.violations(reader2, "resource", "identity_environment"));
            assertEquals(0, TestReaders.violations(reader2, "resource", "identity_service_name"));
        } finally {
            t2.shutdown();
        }
    }

    @Test
    void anExporterAndAnInjectedProcessorCountOneSpanViolationOnce() {
        CollectingReader reader = new CollectingReader();
        CollectingSpanExporter exported = new CollectingSpanExporter();
        CollectingSpanExporter processed = new CollectingSpanExporter();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .spanExporter(exported)
                .addSpanProcessor(SimpleSpanProcessor.create(processed))
                .build());
        try {
            endSpan(t, SECRET, "Bearer x");
            assertEquals(1, exported.spans.size());
            assertEquals(1, processed.spans.size());
            assertEquals(null, processed.spans.get(0).getAttributes().get(AttributeKey.stringKey(SECRET)));
            assertEquals(1, TestReaders.violations(reader, "traces", "secret_attribute"));
        } finally {
            t.shutdown();
        }
    }

    @Test
    void anInjectedProcessorAloneStillCounts() {
        CollectingReader reader = new CollectingReader();
        CollectingSpanExporter processed = new CollectingSpanExporter();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .addSpanProcessor(SimpleSpanProcessor.create(processed))
                .build());
        try {
            endSpan(t, SECRET, "Bearer x");
            assertEquals(1, TestReaders.violations(reader, "traces", "secret_attribute"));
        } finally {
            t.shutdown();
        }
    }
}
