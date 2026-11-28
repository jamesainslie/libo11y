package ing.o11y.libo11y;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

/** Signal-driven graceful shutdown helper running beforeShutdown prior to bounded telemetry flush. */
public final class Signals {
    private Signals() {}

    /**
     * Registers a JVM shutdown hook that runs {@code beforeShutdown} (if provided)
     * and then flushes {@code telemetry} within the remaining share of {@code timeout}.
     * Returns the registered hook thread so callers can unregister it if needed.
     */
    public static Thread shutdownOnSignals(Telemetry telemetry, Duration timeout, Runnable beforeShutdown) {
        Duration budget = (timeout == null || timeout.isNegative() || timeout.isZero())
                ? Duration.ofSeconds(5)
                : timeout;
        AtomicBoolean ran = new AtomicBoolean(false);
        Thread hook = new Thread(() -> {
            if (!ran.compareAndSet(false, true)) {
                return;
            }
            long deadlineNanos = System.nanoTime() + budget.toNanos();
            if (beforeShutdown != null) {
                try {
                    beforeShutdown.run();
                } catch (Throwable ignored) {
                    // still flush telemetry even if beforeShutdown throws
                }
            }
            long remNanos = Math.max(TimeUnitMillis.MIN_FLUSH_NANOS, deadlineNanos - System.nanoTime());
            telemetry.shutdown(Duration.ofNanos(remNanos));
        }, "libo11y-shutdown-hook");
        Runtime.getRuntime().addShutdownHook(hook);
        return hook;
    }

    private static final class TimeUnitMillis {
        static final long MIN_FLUSH_NANOS = 100_000_000L; // 100 ms floor
    }
}
