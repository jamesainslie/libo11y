package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MockClock;
import io.micrometer.core.instrument.Timer;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * A timer's and a distribution summary's maximum is exported as the max of their OpenTelemetry
 * histogram points, not as a separate {@code <name>.max} gauge: the OpenTelemetry Micrometer bridge
 * deprecated that gauge (opentelemetry-java-instrumentation#19397) and removed it for 3.0 (#20421),
 * because a metric name that is also the namespace of another metric breaks the naming rules.
 */
class HistogramMaxTest {
    private O11yRecorder rec;
    private O11yMeterRegistry registry;

    @BeforeEach
    void setUp() {
        rec = O11yRecorder.start();
        registry = new O11yMeterRegistry(rec.telemetry(), new MockClock());
    }

    @AfterEach
    void tearDown() {
        registry.close();
        rec.close();
    }

    @Test
    void timerMaxIsTheHistogramMax() {
        Timer timer = Timer.builder("jobs.latency").register(registry);
        timer.record(250, TimeUnit.MILLISECONDS);
        timer.record(2, TimeUnit.SECONDS);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        HistogramPointData p = (HistogramPointData) m.point("jobs.latency");
        assertTrue(p.hasMax());
        assertEquals(2.0, p.getMax(), 1e-9);
        assertTrue(m.named("jobs.latency.max").isEmpty());
    }

    @Test
    void summaryMaxIsTheHistogramMax() {
        DistributionSummary summary = DistributionSummary.builder("jobs.payload").baseUnit("By").register(registry);
        summary.record(512);
        summary.record(4096);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        HistogramPointData p = (HistogramPointData) m.point("jobs.payload");
        assertTrue(p.hasMax());
        assertEquals(4096.0, p.getMax());
        assertTrue(m.named("jobs.payload.max").isEmpty());
    }
}
