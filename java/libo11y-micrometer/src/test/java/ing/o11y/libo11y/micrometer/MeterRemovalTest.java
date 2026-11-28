package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.FunctionTimer;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.LongTaskTimer;
import io.micrometer.core.instrument.Measurement;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.Statistic;
import io.micrometer.core.instrument.TimeGauge;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiFunction;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** A removed or closed meter stops being sampled and stops exporting. */
class MeterRemovalTest {
    private O11yRecorder rec;
    private O11yMeterRegistry registry;
    private final AtomicInteger samples = new AtomicInteger();

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

    private double sample() {
        samples.incrementAndGet();
        return 1.0;
    }

    @Test
    void removedGaugeIsNotSampled() {
        assertRemovalStopsSampling("g", (name, r) -> Gauge.builder(name, this, MeterRemovalTest::sample).register(r));
    }

    @Test
    void removedTimeGaugeIsNotSampled() {
        assertRemovalStopsSampling("tg", (name, r) ->
                TimeGauge.builder(name, this, TimeUnit.SECONDS, MeterRemovalTest::sample).register(r));
    }

    @Test
    void removedFunctionCounterIsNotSampled() {
        assertRemovalStopsSampling("fc", (name, r) ->
                FunctionCounter.builder(name, this, MeterRemovalTest::sample).register(r));
    }

    @Test
    void removedFunctionTimerIsNotSampled() {
        assertRemovalStopsSampling("ft", (name, r) -> FunctionTimer.builder(
                name, this, t -> (long) t.sample(), MeterRemovalTest::sample, TimeUnit.SECONDS).register(r));
    }

    @Test
    void removedGenericMeterIsNotSampled() {
        assertRemovalStopsSampling("m", (name, r) -> Meter.builder(name, Meter.Type.GAUGE,
                List.of(new Measurement(this::sample, Statistic.VALUE))).register(r));
    }

    @Test
    void removedLongTaskTimerStopsExporting() {
        LongTaskTimer ltt = LongTaskTimer.builder("ltt").register(registry);
        ltt.start();
        assertTrue(CollectedMetrics.collect(rec).find("ltt.active").isPresent());

        registry.remove(ltt);

        CollectedMetrics after = CollectedMetrics.collect(rec);
        assertTrue(after.named("ltt.active").isEmpty(), "removed long task timer still exports");
        assertTrue(after.named("ltt.duration").isEmpty(), "removed long task timer still exports");
    }

    @Test
    void closedRegistryStopsSampling() {
        Gauge.builder("closed.g", this, MeterRemovalTest::sample).register(registry);
        CollectedMetrics.collect(rec);
        assertTrue(samples.get() > 0);

        registry.close();
        samples.set(0);

        CollectedMetrics after = CollectedMetrics.collect(rec);
        assertEquals(0, samples.get(), "a closed registry's gauge is still sampled");
        assertTrue(after.named("closed.g").isEmpty());
    }

    private void assertRemovalStopsSampling(String name, BiFunction<String, O11yMeterRegistry, Meter> register) {
        Meter meter = register.apply(name, registry);
        CollectedMetrics.collect(rec);
        assertTrue(samples.get() > 0, "meter was never sampled");

        registry.remove(meter);
        samples.set(0);

        CollectedMetrics after = CollectedMetrics.collect(rec);
        assertEquals(0, samples.get(), "removed meter " + name + " is still sampled");
        assertTrue(after.named(name).isEmpty() && after.named(name + ".count").isEmpty()
                && after.named(name + ".value").isEmpty(), "removed meter " + name + " still exports");
    }
}
