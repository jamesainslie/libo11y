package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.Timer;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.ExemplarData;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** The sensitivity filter drops classified tags, and a timer inside a sampled span carries an exemplar. */
class SensitivityAndExemplarTest {
    private static final String REGISTRY = """
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

    private static O11yRecorder start() {
        return O11yRecorder.start(b -> b.addAppRegistryYaml(REGISTRY, "shop.yaml"));
    }

    @Test
    void filterDropsSecretAndPiiTagsAndKeepsPublicOnes() {
        try (O11yRecorder rec = start()) {
            SensitivityMeterFilter filter = new SensitivityMeterFilter(rec.telemetry().policy());
            Meter.Id id = new Meter.Id("shop.orders", Tags.of(
                    "shop.api_secret", "s", "shop.region", "eu", "shop.customer_email", "a@b.c", "other", "x"),
                    null, null, Meter.Type.COUNTER);

            Meter.Id mapped = filter.map(id);

            assertEquals(Tags.of("shop.region", "eu", "other", "x"), Tags.of(mapped.getTags()));
        }
    }

    @Test
    void filterReturnsTheSameIdWhenNothingIsClassified() {
        try (O11yRecorder rec = start()) {
            SensitivityMeterFilter filter = new SensitivityMeterFilter(rec.telemetry().policy());
            Meter.Id id = new Meter.Id("shop.orders", Tags.of("shop.region", "eu"), null, null, Meter.Type.COUNTER);

            assertEquals(id, filter.map(id));
        }
    }

    @Test
    void registryDropsClassifiedTagsFromAsyncMeters() {
        try (O11yRecorder rec = start(); O11yMeterRegistry registry = new O11yMeterRegistry(rec.telemetry())) {
            Gauge.builder("shop.cart.size", new AtomicLong(2), AtomicLong::doubleValue)
                    .tag("shop.region", "eu")
                    .tag("shop.customer_email", "a@b.c")
                    .register(registry);

            assertEquals(Attributes.of(AttributeKey.stringKey("shop.region"), "eu"),
                    CollectedMetrics.collect(rec).point("shop.cart.size").getAttributes());
        }
    }

    @Test
    void timerRecordedInASampledSpanCarriesAnExemplar() {
        try (O11yRecorder rec = start(); O11yMeterRegistry registry = new O11yMeterRegistry(rec.telemetry())) {
            Telemetry t = rec.telemetry();
            Timer timer = Timer.builder("shop.checkout.duration").register(registry);
            Span span = t.tracer("shop").spanBuilder("checkout").startSpan();
            try (Scope ignored = span.makeCurrent()) {
                timer.record(120, TimeUnit.MILLISECONDS);
            } finally {
                span.end();
            }

            HistogramPointData p = (HistogramPointData) CollectedMetrics.collect(rec).point("shop.checkout.duration");
            List<? extends ExemplarData> exemplars = p.getExemplars();
            assertEquals(1, exemplars.size(), () -> "exemplars: " + exemplars);
            assertEquals(span.getSpanContext().getTraceId(), exemplars.get(0).getSpanContext().getTraceId());
            assertEquals(span.getSpanContext().getSpanId(), exemplars.get(0).getSpanContext().getSpanId());
        }
    }

    @Test
    void timerRecordedOutsideASpanCarriesNoExemplar() {
        try (O11yRecorder rec = start(); O11yMeterRegistry registry = new O11yMeterRegistry(rec.telemetry())) {
            Timer.builder("shop.checkout.duration").register(registry).record(120, TimeUnit.MILLISECONDS);

            HistogramPointData p = (HistogramPointData) CollectedMetrics.collect(rec).point("shop.checkout.duration");
            assertTrue(p.getExemplars().isEmpty(), () -> "exemplars: " + p.getExemplars());
        }
    }
}
