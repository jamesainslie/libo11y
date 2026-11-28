package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.ShutdownReport;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.proto.common.v1.KeyValue;
import io.opentelemetry.proto.logs.v1.LogRecord;
import io.opentelemetry.proto.metrics.v1.Exemplar;
import io.opentelemetry.proto.trace.v1.Span;
import io.opentelemetry.sdk.metrics.InstrumentSelector;
import io.opentelemetry.sdk.metrics.View;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/**
 * Wire-level regression tests: telemetry goes through the real OTLP/HTTP protobuf exporters, with
 * gzip, to the in-process receiver, and the assertions read the decoded payloads.
 */
class OtlpWireTest {
    private static final String SECRET_KEY = "http.request.header.authorization";
    private static final String SECRET_VALUE = "Bearer wire-secret-sentinel";
    private static final String PII_KEY = "device.id";
    private static final String PII_VALUE = "wire-pii-sentinel";
    private static final byte[] HASH_KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    private static Telemetry wireTelemetry(OtlpHttpReceiver receiver, Consumer<O11yOptions.Builder> custom) {
        O11yOptions.Builder b = O11yOptions.builder()
                .serviceName("wire-svc")
                .environment(Spec.DeploymentEnvironment.TEST)
                .env(Map.of(
                        "OTEL_EXPORTER_OTLP_ENDPOINT", receiver.endpoint(),
                        "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf",
                        "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip",
                        "OTEL_METRIC_EXPORT_INTERVAL", "60000"))
                .runtimeMetrics(false)
                .consoleEnabled(false);
        custom.accept(b);
        return O11y.init(b.build());
    }

    private static void shutdown(Telemetry t) {
        ShutdownReport report = t.shutdown(Duration.ofSeconds(5));
        assertTrue(report.isOk(), "shutdown errors: " + report.errors());
    }

    private static Optional<String> attr(List<KeyValue> attrs, String key) {
        return OtlpHttpReceiver.attribute(attrs, key);
    }

    private static LogRecord logWithBody(OtlpHttpReceiver receiver, String body) {
        return receiver.logRecords().stream()
                .filter(lr -> body.equals(lr.getBody().getStringValue()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no exported log record with body " + body));
    }

    private static Attributes sensitive() {
        return Attributes.of(AttributeKey.stringKey(SECRET_KEY), SECRET_VALUE, AttributeKey.stringKey(PII_KEY), PII_VALUE);
    }

    @ParameterizedTest(name = "pii mode {0}")
    @EnumSource(PiiMode.class)
    void bridgeAndStructuredLogRecordsAreClassifiedOnTheWire(PiiMode mode) throws Exception {
        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            Telemetry t = wireTelemetry(receiver, b -> b.piiMode(mode).piiHashKey(HASH_KEY));
            // A logging bridge that is not libo11y's own: it writes straight to the logs API.
            t.loggerProvider().get("thirdparty.bridge").logRecordBuilder()
                    .setBody("bridge login")
                    .setAllAttributes(sensitive())
                    .setAttribute(AttributeKey.stringKey("order.id"), "o-1")
                    .emit();
            t.logger().info("structured login", Map.of(SECRET_KEY, SECRET_VALUE, PII_KEY, PII_VALUE));
            shutdown(t);

            receiver.assertNoAttributeKey(SECRET_KEY);
            receiver.assertNoAttributeValue(SECRET_VALUE);
            for (String body : List.of("bridge login", "structured login")) {
                List<KeyValue> attrs = logWithBody(receiver, body).getAttributesList();
                Optional<String> pii = attr(attrs, PII_KEY);
                switch (mode) {
                    case DROP -> assertEquals(Optional.empty(), pii, body);
                    case HASH -> assertTrue(pii.orElseThrow().startsWith("hmac-sha256:"), body + ": " + pii);
                    case KEEP -> assertEquals(Optional.of(PII_VALUE), pii, body);
                }
            }
            assertEquals(Optional.of("o-1"), attr(logWithBody(receiver, "bridge login").getAttributesList(), "order.id"));
            if (mode != PiiMode.KEEP) {
                receiver.assertNoAttributeValue(PII_VALUE);
            }
            if (mode == PiiMode.DROP) {
                receiver.assertNoAttributeKey(PII_KEY);
            }
        }
    }

    @Test
    void spanAttributesEventsAndLinksAreClassifiedOnTheWire() throws Exception {
        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            Telemetry t = wireTelemetry(receiver, b -> { });
            io.opentelemetry.api.trace.Span upstream = t.tracer("wire").spanBuilder("upstream").startSpan();
            upstream.end();
            io.opentelemetry.api.trace.Span op = t.tracer("wire").spanBuilder("wire.op")
                    .setAllAttributes(sensitive())
                    .setAttribute("order.id", "o-1")
                    .addLink(upstream.getSpanContext(), sensitive().toBuilder().put("link.kind", "follows").build())
                    .startSpan();
            op.addEvent("retry", sensitive().toBuilder().put("attempt", "2").build());
            op.end();
            shutdown(t);

            Span wire = receiver.span("wire.op").orElseThrow();
            assertEquals(op.getSpanContext().getTraceId(), OtlpHttpReceiver.hex(wire.getTraceId()));
            assertEquals(Optional.of("o-1"), attr(wire.getAttributesList(), "order.id"));
            assertEquals(1, wire.getEventsCount());
            assertEquals("retry", wire.getEvents(0).getName());
            assertEquals(Optional.of("2"), attr(wire.getEvents(0).getAttributesList(), "attempt"));
            assertEquals(1, wire.getLinksCount());
            assertEquals(upstream.getSpanContext().getTraceId(), OtlpHttpReceiver.hex(wire.getLinks(0).getTraceId()));
            assertEquals(Optional.of("follows"), attr(wire.getLinks(0).getAttributesList(), "link.kind"));

            receiver.assertNoAttributeKey(SECRET_KEY);
            receiver.assertNoAttributeKey(PII_KEY);
            receiver.assertNoAttributeValue(SECRET_VALUE);
            receiver.assertNoAttributeValue(PII_VALUE);
        }
    }

    @Test
    void metricPointsAndExemplarsAreClassifiedOnTheWire() throws Exception {
        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            // Keep only region on the point, so the other measurement attributes become the
            // exemplar's filtered attributes and cross the wire there.
            Telemetry t = wireTelemetry(receiver, b -> b.addView(
                    InstrumentSelector.builder().setName("wire.latency").build(),
                    View.builder().setAttributeFilter(Set.of("region")).build()));
            io.opentelemetry.api.trace.Span op = t.tracer("wire").spanBuilder("wire.op").startSpan();
            try (Scope ignored = op.makeCurrent()) {
                Attributes measured = sensitive().toBuilder().put("region", "eu").put("order.id", "o-1").build();
                t.meter("wire").histogramBuilder("wire.latency").build().record(0.25, measured, Context.current());
                t.meter("wire").counterBuilder("wire.count").build().add(1L, measured, Context.current());
            } finally {
                op.end();
            }
            shutdown(t);

            List<OtlpHttpReceiver.MetricPoint> latency = receiver.metricPoints("wire.latency");
            assertEquals(1, latency.size());
            assertEquals(Optional.of("eu"), attr(latency.get(0).attributes(), "region"));
            assertEquals(1, latency.get(0).attributes().size());
            assertEquals(1, latency.get(0).exemplars().size());
            Exemplar ex = latency.get(0).exemplars().get(0);
            assertEquals(op.getSpanContext().getTraceId(), OtlpHttpReceiver.hex(ex.getTraceId()));
            assertEquals(op.getSpanContext().getSpanId(), OtlpHttpReceiver.hex(ex.getSpanId()));
            assertEquals(Optional.of("o-1"), attr(ex.getFilteredAttributesList(), "order.id"));

            List<OtlpHttpReceiver.MetricPoint> count = receiver.metricPoints("wire.count");
            assertEquals(1, count.size());
            assertEquals(Optional.of("o-1"), attr(count.get(0).attributes(), "order.id"));
            assertFalse(count.get(0).exemplars().isEmpty());

            receiver.assertNoAttributeKey(SECRET_KEY);
            receiver.assertNoAttributeKey(PII_KEY);
            receiver.assertNoAttributeValue(SECRET_VALUE);
            receiver.assertNoAttributeValue(PII_VALUE);
        }
    }

    @Test
    void logRecordsCarryTheTraceAndSpanIdsOfTheirSpanOnTheWire() throws Exception {
        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            Telemetry t = wireTelemetry(receiver, b -> { });
            t.logger().info("outside");
            io.opentelemetry.api.trace.Span op = t.tracer("wire").spanBuilder("wire.op").startSpan();
            try (Scope ignored = op.makeCurrent()) {
                t.logger().info("inside");
                t.loggerProvider().get("thirdparty.bridge").logRecordBuilder().setBody("bridge inside").emit();
            } finally {
                op.end();
            }
            shutdown(t);

            String traceId = op.getSpanContext().getTraceId();
            String spanId = op.getSpanContext().getSpanId();
            for (String body : List.of("inside", "bridge inside")) {
                LogRecord lr = logWithBody(receiver, body);
                assertEquals(traceId, OtlpHttpReceiver.hex(lr.getTraceId()), body);
                assertEquals(spanId, OtlpHttpReceiver.hex(lr.getSpanId()), body);
            }
            assertTrue(logWithBody(receiver, "outside").getTraceId().isEmpty());
            receiver.assertLogsCorrelated();
        }
    }
}
