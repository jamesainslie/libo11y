package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;

import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MockClock;
import io.micrometer.core.instrument.Timer;
import java.time.Duration;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Timer and summary statistics follow Micrometer's documented semantics. */
class TimerAndSummaryStatisticsTest {
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
    void timerConvertsTotalAndMaxToCoarseUnits() {
        Timer timer = Timer.builder("t").register(registry);
        timer.record(90, TimeUnit.SECONDS);

        assertEquals(1.5, timer.totalTime(TimeUnit.MINUTES), 1e-9);
        assertEquals(1.5, timer.max(TimeUnit.MINUTES), 1e-9);
        assertEquals(0.025, timer.totalTime(TimeUnit.HOURS), 1e-9);
        assertEquals(90_000.0, timer.totalTime(TimeUnit.MILLISECONDS), 1e-6);
        assertEquals(90e9, timer.max(TimeUnit.NANOSECONDS), 1.0);
    }

    @Test
    void timerMaxDecaysAfterTheExpiry() {
        // Micrometer keeps a sample for one expiry per ring buffer slot: 1 minute x 3 slots.
        Timer timer = Timer.builder("t")
                .distributionStatisticExpiry(Duration.ofMinutes(1))
                .distributionStatisticBufferLength(3)
                .register(registry);
        timer.record(5, TimeUnit.SECONDS);
        assertEquals(5.0, timer.max(TimeUnit.SECONDS), 1e-9);

        clock.add(Duration.ofMinutes(2));
        assertEquals(5.0, timer.max(TimeUnit.SECONDS), 1e-9, "max kept inside the window");
        clock.add(Duration.ofMinutes(2));

        assertEquals(0.0, timer.max(TimeUnit.SECONDS), "timer max never decays");
        assertEquals(5.0, timer.totalTime(TimeUnit.SECONDS), 1e-9);
    }

    @Test
    void summaryMaxDecaysAfterTheExpiry() {
        DistributionSummary summary = DistributionSummary.builder("s")
                .distributionStatisticExpiry(Duration.ofMinutes(1))
                .distributionStatisticBufferLength(3)
                .register(registry);
        summary.record(40);
        assertEquals(40.0, summary.max());

        clock.add(Duration.ofMinutes(2));
        assertEquals(40.0, summary.max(), "max kept inside the window");
        clock.add(Duration.ofMinutes(2));

        assertEquals(0.0, summary.max(), "summary max never decays");
        assertEquals(40.0, summary.totalAmount());
    }

    @Test
    void summaryMaxIsTheLargestOfConcurrentRecordings() throws InterruptedException {
        DistributionSummary summary = DistributionSummary.builder("s").register(registry);
        Thread[] threads = new Thread[4];
        for (int t = 0; t < threads.length; t++) {
            int offset = t;
            threads[t] = new Thread(() -> {
                for (int i = 0; i < 10_000; i++) {
                    summary.record(i * threads.length + offset);
                }
            });
            threads[t].start();
        }
        for (Thread thread : threads) {
            thread.join();
        }
        assertEquals(39_999.0, summary.max());
    }
}
