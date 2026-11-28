package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.Signals;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Runs the hook {@link Signals#shutdownOnSignals} registers on the test thread, then removes it, so
 * no test leaves a hook on the JVM.
 */
class SignalsTest {
    private final List<Thread> hooks = new ArrayList<>();

    @AfterEach
    void removeHooks() {
        for (Thread hook : hooks) {
            Runtime.getRuntime().removeShutdownHook(hook);
        }
    }

    private Thread register(O11yRecorder rec, Duration timeout, Runnable beforeShutdown) {
        Thread hook = Signals.shutdownOnSignals(rec.telemetry(), timeout, beforeShutdown);
        hooks.add(hook);
        return hook;
    }

    /** Keeps what it exported after shutdown, unlike the SDK's in-memory exporter, which clears. */
    private static final class KeepingExporter implements SpanExporter {
        final List<SpanData> exported = new CopyOnWriteArrayList<>();
        final AtomicBoolean shutDown = new AtomicBoolean();

        @Override
        public CompletableResultCode export(Collection<SpanData> spans) {
            exported.addAll(spans);
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode flush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            shutDown.set(true);
            return CompletableResultCode.ofSuccess();
        }
    }

    private static O11yRecorder recorderWithBatchedSpans(KeepingExporter batched) {
        return O11yRecorder.start(b -> b.addSpanProcessor(
                BatchSpanProcessor.builder(batched).setScheduleDelay(Duration.ofHours(1)).build()));
    }

    @Test
    void registersANamedJvmShutdownHook() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Thread hook = register(rec, Duration.ofSeconds(1), null);
            assertEquals("libo11y-shutdown-hook", hook.getName());
            assertFalse(hook.isAlive());
            // Registered: removing it succeeds exactly once.
            assertTrue(Runtime.getRuntime().removeShutdownHook(hook));
            hooks.remove(hook);
        }
    }

    @Test
    void runsBeforeShutdownThenFlushesWhatItEmitted() {
        KeepingExporter batched = new KeepingExporter();
        try (O11yRecorder rec = recorderWithBatchedSpans(batched)) {
            Thread hook = register(rec, Duration.ofSeconds(2), () ->
                    rec.telemetry().tracer("drain").spanBuilder("drain.inflight").startSpan().end());
            hook.run();
            assertEquals(1, batched.exported.size());
            assertEquals("drain.inflight", batched.exported.get(0).getName());
            assertTrue(batched.shutDown.get());
            assertTrue(rec.telemetry().shutdown(Duration.ofSeconds(1)).isOk());
        }
    }

    @Test
    void flushesEvenWhenBeforeShutdownThrows() {
        KeepingExporter batched = new KeepingExporter();
        try (O11yRecorder rec = recorderWithBatchedSpans(batched)) {
            rec.telemetry().tracer("app").spanBuilder("pending").startSpan().end();
            Thread hook = register(rec, Duration.ofSeconds(2), () -> {
                throw new IllegalStateException("drain failed");
            });
            hook.run();
            assertEquals(1, batched.exported.size());
        }
    }

    @Test
    void runsAtMostOnce() {
        AtomicInteger calls = new AtomicInteger();
        try (O11yRecorder rec = O11yRecorder.start()) {
            Thread hook = register(rec, Duration.ofSeconds(1), calls::incrementAndGet);
            hook.run();
            hook.run();
            assertEquals(1, calls.get());
        }
    }

    @Test
    void nonPositiveTimeoutFallsBackToTheDefaultBudget() {
        KeepingExporter batched = new KeepingExporter();
        try (O11yRecorder rec = recorderWithBatchedSpans(batched)) {
            rec.telemetry().tracer("app").spanBuilder("pending").startSpan().end();
            register(rec, Duration.ZERO, null).run();
            assertEquals(1, batched.exported.size());
        }
    }

    @Test
    void nullTimeoutFallsBackToTheDefaultBudget() {
        KeepingExporter batched = new KeepingExporter();
        try (O11yRecorder rec = recorderWithBatchedSpans(batched)) {
            rec.telemetry().tracer("app").spanBuilder("pending").startSpan().end();
            register(rec, null, null).run();
            assertEquals(1, batched.exported.size());
        }
    }
}
