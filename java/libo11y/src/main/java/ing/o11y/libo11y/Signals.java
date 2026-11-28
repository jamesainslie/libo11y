package ing.o11y.libo11y;

import java.time.Duration;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Signal-driven graceful shutdown helper running beforeShutdown prior to bounded telemetry flush. */
public final class Signals {
    private static final Duration DEFAULT_BUDGET = Duration.ofSeconds(5);

    private Signals() {}

    /**
     * Registers a JVM shutdown hook that runs {@code beforeShutdown} (if provided) and then shuts
     * {@code telemetry} down, the whole hook bounded by {@code timeout} (5 seconds when
     * {@code null}, zero or negative). Returns the registered hook thread so callers can
     * unregister it if needed.
     *
     * <p>{@code beforeShutdown} runs on its own daemon thread and may use at most half of the
     * budget; the hook stops waiting for it then, so a hung callback cannot stall JVM exit, and
     * the telemetry shutdown gets whatever budget remains. Telemetry is shut down even when the
     * callback fails or hangs. A failed callback and a failed shutdown are written to the console
     * sink, or through java.util.logging when it is off, as {@link Telemetry#close()} does; an
     * {@link Error} the callback throws, such as {@link OutOfMemoryError}, is rethrown from the
     * hook after the shutdown.
     */
    public static Thread shutdownOnSignals(Telemetry telemetry, Duration timeout, Runnable beforeShutdown) {
        Duration budget = (timeout == null || timeout.isNegative() || timeout.isZero())
                ? DEFAULT_BUDGET
                : timeout;
        AtomicBoolean ran = new AtomicBoolean(false);
        Thread hook = new Thread(() -> {
            if (!ran.compareAndSet(false, true)) {
                return;
            }
            long deadlineNanos = System.nanoTime() + budget.toNanos();
            AtomicReference<Throwable> callbackFailure = new AtomicReference<>();
            boolean callbackDone = true;
            if (beforeShutdown != null) {
                Thread before = Thread.ofPlatform().daemon().name("libo11y-before-shutdown").start(() -> {
                    try {
                        beforeShutdown.run();
                    } catch (Throwable t) {
                        callbackFailure.set(t);
                    }
                });
                try {
                    TimeUnit.NANOSECONDS.timedJoin(before, budget.toNanos() / 2);
                    callbackDone = !before.isAlive();
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    callbackDone = false;
                }
            }
            long remaining = Math.max(1L, deadlineNanos - System.nanoTime());
            ShutdownReport report = telemetry.shutdown(Duration.ofNanos(remaining));
            if (!report.isOk()) {
                telemetry.reportFailure(report);
            }
            Throwable failure = callbackFailure.get();
            if (failure != null) {
                telemetry.reportProblem("shutdown callback failed: " + failure);
                if (failure instanceof Error error) {
                    throw error;
                }
            } else if (!callbackDone) {
                telemetry.reportProblem("shutdown callback did not finish within half the "
                        + budget.toMillis() + " ms budget; telemetry was shut down without waiting for it");
            }
        }, "libo11y-shutdown-hook");
        Runtime.getRuntime().addShutdownHook(hook);
        return hook;
    }
}
