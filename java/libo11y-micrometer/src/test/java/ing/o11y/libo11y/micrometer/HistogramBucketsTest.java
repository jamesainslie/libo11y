package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Timer;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Timer and summary histograms take their buckets from the Micrometer distribution configuration. */
class HistogramBucketsTest {
    private O11yRecorder rec;
    private O11yMeterRegistry registry;

    @BeforeEach
    void setUp() {
        rec = O11yRecorder.start();
        registry = new O11yMeterRegistry(rec.telemetry());
    }

    @AfterEach
    void tearDown() {
        registry.close();
        rec.close();
    }

    private List<Double> boundaries(String name) {
        return ((HistogramPointData) CollectedMetrics.collect(rec).point(name)).getBoundaries();
    }

    @Test
    void timerWithoutObjectivesUsesTheSemconvSecondsBuckets() {
        Timer.builder("t.default").register(registry).record(30, TimeUnit.MILLISECONDS);

        assertEquals(List.of(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0),
                boundaries("t.default"));
    }

    @Test
    void timerObjectivesBecomeSecondsBuckets() {
        Timer.builder("t.slo")
                .serviceLevelObjectives(Duration.ofMillis(100), Duration.ofMillis(500), Duration.ofSeconds(2))
                .register(registry)
                .record(30, TimeUnit.MILLISECONDS);

        assertEquals(List.of(0.1, 0.5, 2.0), boundaries("t.slo"));
    }

    @Test
    void timerPercentileHistogramStaysInsideTheExpectedRange() {
        Timer.builder("t.pct")
                .publishPercentileHistogram()
                .minimumExpectedValue(Duration.ofMillis(10))
                .maximumExpectedValue(Duration.ofSeconds(1))
                .register(registry)
                .record(30, TimeUnit.MILLISECONDS);

        List<Double> b = boundaries("t.pct");
        assertTrue(b.size() > 5, () -> "too few buckets: " + b);
        assertTrue(b.get(0) >= 0.01, () -> "first bucket below the minimum: " + b);
        assertTrue(b.get(b.size() - 1) <= 1.0, () -> "last bucket above the maximum: " + b);
    }

    @Test
    void summaryObjectivesBecomeBuckets() {
        DistributionSummary.builder("s.slo")
                .baseUnit("By")
                .serviceLevelObjectives(1024, 65536)
                .register(registry)
                .record(2000);

        assertEquals(List.of(1024.0, 65536.0), boundaries("s.slo"));
    }
}
