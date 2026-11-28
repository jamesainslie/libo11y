package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Timer;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class MicrometerIntegrationTest {
    private static final byte[] HASH_KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    @Test
    void singlePipelineMicrometerStampsExemplarsAndEnforcesSensitivity() {
        String appRegYaml = """
                schema: libo11y.app-registry/v1
                namespace: shop
                attributes:
                  shop.api_secret:
                    type: string
                    sensitivity: secret
                    cardinality: unbounded
                  shop.customer_email:
                    type: string
                    sensitivity: pii
                    cardinality: unbounded
                  shop.region:
                    type: string
                    sensitivity: public
                    cardinality: bounded
                """;

        try (O11yRecorder rec = O11yRecorder.start(b -> b
                .piiMode(PiiMode.HASH)
                .piiHashKey(HASH_KEY)
                .addAppRegistryYaml(appRegYaml, "shop.yaml"))) {
            Telemetry t = rec.telemetry();
            try (O11yMeterRegistry registry = new O11yMeterRegistry(t)) {
                Span span = t.tracer("shop").spanBuilder("checkout.place").startSpan();
                String traceId = span.getSpanContext().getTraceId();
                try (Scope ignored = span.makeCurrent()) {
                    t.logger().info("order placed", Map.of("shop.region", "us-west"));
                    Counter counter = Counter.builder("shop.orders.placed")
                            .tag("shop.region", "us-west")
                            .tag("shop.api_secret", "shhh")
                            .tag("shop.customer_email", "bob@example.com")
                            .register(registry);
                    counter.increment(2.0);

                    Timer timer = Timer.builder("shop.checkout.duration")
                            .tag("shop.region", "us-west")
                            .register(registry);
                    timer.record(42, TimeUnit.MILLISECONDS);
                } finally {
                    span.end();
                }

                // Verify Micrometer counter & timer arrived on Telemetry's single OTel MeterProvider
                MetricData orders = rec.metrics().stream()
                        .filter(m -> "shop.orders.placed".equals(m.getName()))
                        .findFirst()
                        .orElseThrow();
                PointData pt = orders.getData().getPoints().iterator().next();
                assertEquals("us-west", pt.getAttributes().get(AttributeKey.stringKey("shop.region")));
                // SensitivityMeterFilter stripped SECRET and PII tags even in HASH mode!
                assertNull(pt.getAttributes().get(AttributeKey.stringKey("shop.api_secret")));
                assertNull(pt.getAttributes().get(AttributeKey.stringKey("shop.customer_email")));

                // Verify full 3-signal triangle closed via Micrometer exemplar!
                rec.assertConforms();
                rec.assertTriangle(traceId);
                assertTrue(rec.exemplars().stream()
                        .anyMatch(e -> "shop.checkout.duration".equals(e.metricName()) && traceId.equals(e.traceId())));
            }
        }
    }

    @Test
    void observationRegistryBridgesTracesMetricsExemplarsAndWideEvents() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Telemetry t = rec.telemetry();
            try (O11yMeterRegistry meterRegistry = new O11yMeterRegistry(t)) {
                O11yMicrometerTracing tracing = O11yMicrometerTracing.create(t);
                ObservationRegistry obsRegistry = ObservationRegistry.create();
                tracing.configureObservationRegistry(obsRegistry, t, meterRegistry, false);

                try (O11yRecord wide = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
                    Observation.createNotStarted("payment.charge", obsRegistry)
                            .lowCardinalityKeyValue("payment.provider", "stripe")
                            .highCardinalityKeyValue("order.id", "ord-777")
                            .observe(() -> {
                                t.logger().info("charging card");
                            });
                }

                SpanData span = rec.spans().stream()
                        .filter(s -> "payment.charge".equals(s.getName()))
                        .findFirst()
                        .orElseThrow();
                assertNotNull(span);

                // Canonical wide event enriched by O11yObservationHandler
                var summary = rec.entries().stream()
                        .filter(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName()))
                        .findFirst()
                        .orElseThrow();
                assertEquals("stripe", summary.attributes().get("payment.provider"));
                assertEquals("ord-777", summary.attributes().get("order.id"));
                // The record's owner, not a nested observation, decides the outcome and duration.
                assertFalse(summary.attributes().containsKey(Spec.Attributes.OUTCOME));
                assertFalse(summary.attributes().containsKey(Spec.Attributes.DURATION));

                // This record's owner sets none of the request summary's required attributes, and
                // the nested observation must not set its outcome or duration, so the conformance
                // gate reports exactly that contract and nothing else.
                AssertionError partialSummary = assertThrows(AssertionError.class, rec::assertConforms);
                assertEquals(List.of(
                                "event o11y.request.summary: missing required attribute http.request.method",
                                "event o11y.request.summary: missing required attribute http.response.status_code",
                                "event o11y.request.summary: missing required attribute o11y.outcome",
                                "event o11y.request.summary: missing required attribute o11y.duration"),
                        partialSummary.getMessage().lines()
                                .filter(l -> l.startsWith("  - "))
                                .map(l -> l.substring(4))
                                .toList());

                // Full triangle: Observation created span + correlated log + Micrometer timer with exemplar
                rec.assertTriangle(span.getTraceId());
            }
        }
    }
}
