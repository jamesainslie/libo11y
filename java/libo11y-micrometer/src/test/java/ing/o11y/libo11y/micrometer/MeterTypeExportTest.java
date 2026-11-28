package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.FunctionTimer;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.LongTaskTimer;
import io.micrometer.core.instrument.Measurement;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.MockClock;
import io.micrometer.core.instrument.Statistic;
import io.micrometer.core.instrument.TimeGauge;
import io.micrometer.core.instrument.Timer;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.sdk.metrics.data.DoublePointData;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.MetricDataType;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Each Micrometer meter type exports through the libo11y meter with the expected name, unit, kind and attributes. */
class MeterTypeExportTest {
    private static final Attributes REGION = Attributes.of(AttributeKey.stringKey("region"), "eu");

    private O11yRecorder rec;
    private MockClock clock;
    private O11yMeterRegistry registry;

    @BeforeEach
    void setUp() {
        rec = O11yRecorder.start();
        clock = new MockClock();
        registry = new O11yMeterRegistry(rec.telemetry(), clock);
    }

    @AfterEach
    void tearDown() {
        registry.close();
        rec.close();
    }

    @Test
    void counterExportsAMonotonicDoubleSum() {
        Counter.builder("jobs.done").baseUnit("{job}").description("Jobs done.").tag("region", "eu")
                .register(registry).increment(3);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.done");
        assertEquals(MetricDataType.DOUBLE_SUM, md.getType());
        assertTrue(md.getDoubleSumData().isMonotonic());
        assertEquals("{job}", md.getUnit());
        assertEquals("Jobs done.", md.getDescription());
        DoublePointData p = (DoublePointData) m.point("jobs.done");
        assertEquals(3.0, p.getValue());
        assertEquals(REGION, p.getAttributes());
    }

    @Test
    void timerExportsASecondsHistogram() {
        Timer.builder("jobs.latency").tag("region", "eu").register(registry).record(250, TimeUnit.MILLISECONDS);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.latency");
        assertEquals(MetricDataType.HISTOGRAM, md.getType());
        assertEquals("s", md.getUnit());
        HistogramPointData p = (HistogramPointData) m.point("jobs.latency");
        assertEquals(1, p.getCount());
        assertEquals(0.25, p.getSum(), 1e-9);
        assertEquals(REGION, p.getAttributes());
    }

    @Test
    void distributionSummaryExportsAHistogramInItsBaseUnit() {
        DistributionSummary.builder("jobs.payload").baseUnit("By").tag("region", "eu").register(registry).record(512);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.payload");
        assertEquals(MetricDataType.HISTOGRAM, md.getType());
        assertEquals("By", md.getUnit());
        HistogramPointData p = (HistogramPointData) m.point("jobs.payload");
        assertEquals(512.0, p.getSum());
        assertEquals(REGION, p.getAttributes());
    }

    @Test
    void gaugeExportsADoubleGauge() {
        AtomicLong depth = new AtomicLong(7);
        Gauge.builder("jobs.queue.depth", depth, AtomicLong::doubleValue).baseUnit("{job}").tag("region", "eu")
                .register(registry);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.queue.depth");
        assertEquals(MetricDataType.DOUBLE_GAUGE, md.getType());
        assertEquals("{job}", md.getUnit());
        DoublePointData p = (DoublePointData) m.point("jobs.queue.depth");
        assertEquals(7.0, p.getValue());
        assertEquals(REGION, p.getAttributes());
    }

    @Test
    void timeGaugeRegistersOneSecondsCallback() {
        AtomicInteger samples = new AtomicInteger();
        AtomicLong ageMillis = new AtomicLong(1500);
        TimeGauge.builder("jobs.oldest.age", ageMillis, TimeUnit.MILLISECONDS, v -> {
                    samples.incrementAndGet();
                    return v.doubleValue();
                })
                .tag("region", "eu")
                .register(registry);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.oldest.age");
        assertEquals(MetricDataType.DOUBLE_GAUGE, md.getType());
        assertEquals("s", md.getUnit());
        DoublePointData p = (DoublePointData) m.point("jobs.oldest.age");
        assertEquals(1.5, p.getValue(), 1e-9);
        assertEquals(REGION, p.getAttributes());
        assertEquals(1, samples.get(), "one collection must sample the time gauge once");
    }

    @Test
    void functionCounterExportsAMonotonicDoubleSum() {
        AtomicLong total = new AtomicLong(11);
        FunctionCounter.builder("jobs.retried", total, AtomicLong::doubleValue).tag("region", "eu").register(registry);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData md = m.only("jobs.retried");
        assertEquals(MetricDataType.DOUBLE_SUM, md.getType());
        assertTrue(md.getDoubleSumData().isMonotonic());
        DoublePointData p = (DoublePointData) m.point("jobs.retried");
        assertEquals(11.0, p.getValue());
        assertEquals(REGION, p.getAttributes());
    }

    @Test
    void functionTimerExportsACountAndATotalTimeInSeconds() {
        long[] state = {3, 4500};
        FunctionTimer.builder("cache.load", state, s -> s[0], s -> s[1], TimeUnit.MILLISECONDS)
                .description("Cache loads.")
                .tag("region", "eu")
                .register(registry);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData count = m.only("cache.load.count");
        assertEquals(MetricDataType.LONG_SUM, count.getType());
        assertTrue(count.getLongSumData().isMonotonic());
        assertEquals("{invocation}", count.getUnit());
        assertEquals("Cache loads.", count.getDescription());
        LongPointData countPoint = (LongPointData) m.point("cache.load.count");
        assertEquals(3, countPoint.getValue());
        assertEquals(REGION, countPoint.getAttributes());

        MetricData sum = m.only("cache.load.sum");
        assertEquals(MetricDataType.DOUBLE_SUM, sum.getType());
        assertTrue(sum.getDoubleSumData().isMonotonic());
        assertEquals("s", sum.getUnit());
        DoublePointData sumPoint = (DoublePointData) m.point("cache.load.sum");
        assertEquals(4.5, sumPoint.getValue(), 1e-9);
        assertEquals(REGION, sumPoint.getAttributes());
    }

    @Test
    void longTaskTimerExportsActiveTasksAndDuration() {
        LongTaskTimer ltt = LongTaskTimer.builder("jobs.import").tag("region", "eu").register(registry);
        LongTaskTimer.Sample sample = ltt.start();
        clock.add(Duration.ofSeconds(2));

        CollectedMetrics m = CollectedMetrics.collect(rec);
        MetricData active = m.only("jobs.import.active");
        assertEquals(MetricDataType.LONG_SUM, active.getType());
        assertFalse(active.getLongSumData().isMonotonic());
        assertEquals("{tasks}", active.getUnit());
        LongPointData activePoint = (LongPointData) m.point("jobs.import.active");
        assertEquals(1, activePoint.getValue());
        assertEquals(REGION, activePoint.getAttributes());

        MetricData duration = m.only("jobs.import.duration");
        assertEquals(MetricDataType.DOUBLE_SUM, duration.getType());
        assertFalse(duration.getDoubleSumData().isMonotonic());
        assertEquals("s", duration.getUnit());
        assertEquals(2.0, ((DoublePointData) m.point("jobs.import.duration")).getValue(), 1e-9);

        sample.stop();
        CollectedMetrics after = CollectedMetrics.collect(rec);
        assertEquals(0, ((LongPointData) after.point("jobs.import.active")).getValue());
    }

    @Test
    void genericMeterExportsOneInstrumentPerMeasurement() {
        Meter.builder("pool", Meter.Type.OTHER, List.of(
                        new Measurement(() -> 5.0, Statistic.TOTAL),
                        new Measurement(() -> 1.5, Statistic.TOTAL_TIME),
                        new Measurement(() -> 9.0, Statistic.COUNT),
                        new Measurement(() -> 2.0, Statistic.ACTIVE_TASKS),
                        new Measurement(() -> 4.0, Statistic.VALUE),
                        new Measurement(() -> 8.0, Statistic.MAX),
                        new Measurement(() -> 3.0, Statistic.DURATION),
                        new Measurement(() -> 6.0, Statistic.UNKNOWN)))
                .baseUnit("{conn}")
                .tag("region", "eu")
                .register(registry);

        CollectedMetrics m = CollectedMetrics.collect(rec);
        assertMonotonicSum(m, "pool.total", 5.0);
        assertMonotonicSum(m, "pool.total_time", 1.5);
        assertMonotonicSum(m, "pool.count", 9.0);
        MetricData active = m.only("pool.active");
        assertEquals(MetricDataType.DOUBLE_SUM, active.getType());
        assertFalse(active.getDoubleSumData().isMonotonic());
        assertEquals(2.0, ((DoublePointData) m.point("pool.active")).getValue());
        assertGauge(m, "pool.value", 4.0);
        assertGauge(m, "pool.max", 8.0);
        assertGauge(m, "pool.duration", 3.0);
        assertGauge(m, "pool.unknown", 6.0);
        assertEquals("{conn}", m.only("pool.value").getUnit());
        assertEquals(REGION, m.point("pool.value").getAttributes());
    }

    @Test
    void observationActiveLongTaskTimerExports() {
        ObservationRegistry observations = ObservationRegistry.create();
        O11yMicrometerTracing.create(rec.telemetry())
                .configureObservationRegistry(observations, rec.telemetry(), registry, false);
        Observation obs = Observation.start("report.render", observations);
        try {
            CollectedMetrics m = CollectedMetrics.collect(rec);
            assertEquals(1, ((LongPointData) m.point("report.render.active.active")).getValue());
        } finally {
            obs.stop();
        }
    }

    private static void assertMonotonicSum(CollectedMetrics m, String name, double value) {
        MetricData md = m.only(name);
        assertEquals(MetricDataType.DOUBLE_SUM, md.getType(), name);
        assertTrue(md.getDoubleSumData().isMonotonic(), name);
        assertEquals(value, ((DoublePointData) m.point(name)).getValue(), name);
    }

    private static void assertGauge(CollectedMetrics m, String name, double value) {
        assertEquals(MetricDataType.DOUBLE_GAUGE, m.only(name).getType(), name);
        assertEquals(value, ((DoublePointData) m.point(name)).getValue(), name);
    }
}
