package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.Test;

/** Shutdown is bounded, concurrent, reports export failures and says what it dropped (G3). */
class ShutdownLifecycleTest {
    private static O11yOptions.Builder options() {
        return O11yOptions.builder()
                .hermetic()
                .serviceName("shutdown-test")
                .environment("test")
                .serviceVersion("1.0.0")
                .consoleOutput(new ByteArrayOutputStream())
                .runtimeMetrics(false);
    }

    private static long millisSince(long startNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
    }

    @Test
    void aProcessorBlockingInShutdownCannotHoldTheCallerOrStarveTheOtherSignals() {
        TestParts.StoppableSpanProcessor hung = TestParts.StoppableSpanProcessor.blocking();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter();
        Telemetry t = O11y.init(options()
                .addSpanProcessor(hung)
                .metricReader(reader)
                .logRecordExporter(logs)
                .build());
        try {
            long start = System.nanoTime();
            ShutdownReport report = t.shutdown(Duration.ofMillis(300));
            long took = millisSince(start);
            assertTrue(took < 2_000, "shutdown held the caller for " + took + " ms");
            assertInstanceOf(TimeoutException.class, report.traceError());
            assertNull(report.metricError());
            assertNull(report.logError());
            assertTrue(reader.shutdownCalled());
            assertTrue(logs.shutdownCalled());
        } finally {
            hung.release();
        }
    }

    @Test
    void aConcurrentCallerWaitsOnlyForItsOwnDeadline() throws Exception {
        TestParts.StoppableSpanProcessor hung = TestParts.StoppableSpanProcessor.blocking();
        Telemetry t = O11y.init(options().addSpanProcessor(hung).build());
        try {
            CompletableFuture<ShutdownReport> first = new CompletableFuture<>();
            Thread runner = new Thread(() -> first.complete(t.shutdown(Duration.ofSeconds(20))));
            runner.setDaemon(true);
            runner.start();
            while (!hung.shutdownCalled()) {
                Thread.sleep(5);
            }
            long start = System.nanoTime();
            ShutdownReport second = t.shutdown(Duration.ofMillis(200));
            long took = millisSince(start);
            assertTrue(took < 2_000, "the second caller waited " + took + " ms");
            assertFalse(second.isOk());
            assertInstanceOf(TimeoutException.class, second.traceError());

            hung.release();
            ShutdownReport done = first.get(10, TimeUnit.SECONDS);
            assertTrue(done.isOk(), "" + done);
            assertSame(done, t.shutdown(Duration.ofMillis(50)));
        } finally {
            hung.release();
        }
    }

    @Test
    void aThrowingProcessorStillCompletesTheSharedResult() throws Exception {
        TestParts.StoppableSpanProcessor broken =
                TestParts.StoppableSpanProcessor.throwing(new IllegalStateException("processor broke"));
        Telemetry t = O11y.init(options().addSpanProcessor(broken).build());
        ShutdownReport report = t.shutdown(Duration.ofSeconds(2));
        assertNotNull(report.traceError());
        ShutdownReport again = CompletableFuture.supplyAsync(() -> t.shutdown(Duration.ofSeconds(1)))
                .get(5, TimeUnit.SECONDS);
        assertSame(report, again);
    }

    @Test
    void aRejectedFinalBatchFailsTheReport() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter(true);
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter(true);
        Telemetry t = O11y.init(options().spanExporter(spans).logRecordExporter(logs).build());
        t.tracer("shutdown").spanBuilder("lost").startSpan().end();
        t.logger().info("lost record");
        ShutdownReport report = t.shutdown(Duration.ofSeconds(5));
        assertEquals(1, spans.spanCount());
        assertTrue(spans.shutdownCalled());
        assertFalse(report.isOk());
        assertNotNull(report.traceError(), "span export failure missing: " + report);
        assertNotNull(report.logError(), "log export failure missing: " + report);
        assertNull(report.metricError());
    }

    @Test
    void forceFlushReportsExportFailures() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter(true);
        Telemetry t = O11y.init(options().spanExporter(spans).build());
        try {
            t.tracer("flush").spanBuilder("lost").startSpan().end();
            ShutdownReport flushed = t.forceFlush(Duration.ofSeconds(5));
            assertNotNull(flushed.traceError(), "" + flushed);
            assertNull(flushed.metricError());
            assertNull(flushed.logError());
            assertTrue(t.forceFlush(Duration.ofSeconds(5)).isOk(), "a flush with nothing to export failed");
        } finally {
            t.shutdown();
        }
    }

    @Test
    void aFailedSignalEmitsTheDroppedEventToTheSurvivingSinks() {
        List<StructuredLogger.LogEntry> seen = new CopyOnWriteArrayList<>();
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter(true);
        Telemetry t = O11y.init(options().spanExporter(spans).addExtraLogSink(seen::add).build());
        t.tracer("dropped").spanBuilder("lost").startSpan().end();
        ShutdownReport report = t.shutdown(Duration.ofSeconds(5));
        assertNotNull(report.traceError());
        List<StructuredLogger.LogEntry> dropped = seen.stream()
                .filter(e -> Spec.Events.TELEMETRY_DROPPED.equals(e.eventName()))
                .toList();
        assertEquals(1, dropped.size(), "dropped events: " + dropped);
        assertEquals(Spec.Signal.TRACES.value(), dropped.get(0).attributes().get(Spec.Attributes.SIGNAL.getKey()));
        assertEquals(report.traceError().getClass().getName(), dropped.get(0).attributes().get("error.type"));
    }

    @Test
    void closeWritesAFailedShutdownToTheConsole() {
        ByteArrayOutputStream console = new ByteArrayOutputStream();
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter(true);
        try (Telemetry t = O11y.init(options().consoleOutput(console).spanExporter(spans).build())) {
            t.tracer("close").spanBuilder("lost").startSpan().end();
        }
        String out = console.toString(StandardCharsets.UTF_8);
        assertTrue(out.contains("telemetry shutdown failed"), out);
        assertTrue(out.contains(Spec.Events.TELEMETRY_DROPPED), out);
    }

    @Test
    void theShutdownHookBoundsBeforeShutdownByTheBudget() throws Exception {
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        Telemetry t = O11y.init(options().metricReader(reader).build());
        Thread hook = Signals.shutdownOnSignals(t, Duration.ofMillis(400), () -> {
            try {
                Thread.sleep(10_000);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            }
        });
        try {
            long start = System.nanoTime();
            hook.run();
            long took = millisSince(start);
            assertTrue(took < 2_000, "the hook ran for " + took + " ms");
            assertTrue(reader.shutdownCalled(), "telemetry was not shut down");
        } finally {
            Runtime.getRuntime().removeShutdownHook(hook);
        }
    }

    @Test
    void aFailingBeforeShutdownIsReportedAndTelemetryStillShutsDown() {
        ByteArrayOutputStream console = new ByteArrayOutputStream();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        Telemetry t = O11y.init(options().consoleOutput(console).metricReader(reader).build());
        Thread hook = Signals.shutdownOnSignals(t, Duration.ofSeconds(2), () -> {
            throw new IllegalStateException("drain failed");
        });
        try {
            hook.run();
            assertTrue(reader.shutdownCalled(), "telemetry was not shut down");
            String out = console.toString(StandardCharsets.UTF_8);
            assertTrue(out.contains("shutdown callback failed") && out.contains("drain failed"), out);
        } finally {
            Runtime.getRuntime().removeShutdownHook(hook);
        }
    }

    @Test
    void anErrorFromBeforeShutdownPropagatesAfterTheShutdown() {
        ByteArrayOutputStream console = new ByteArrayOutputStream();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        Telemetry t = O11y.init(options().consoleOutput(console).metricReader(reader).build());
        OutOfMemoryError oom = new OutOfMemoryError("simulated");
        Thread hook = Signals.shutdownOnSignals(t, Duration.ofSeconds(2), () -> {
            throw oom;
        });
        try {
            OutOfMemoryError thrown = org.junit.jupiter.api.Assertions.assertThrows(OutOfMemoryError.class, hook::run);
            assertSame(oom, thrown);
            assertTrue(reader.shutdownCalled(), "telemetry was not shut down before the error propagated");
            assertTrue(console.toString(StandardCharsets.UTF_8).contains("simulated"),
                    console.toString(StandardCharsets.UTF_8));
        } finally {
            Runtime.getRuntime().removeShutdownHook(hook);
        }
    }
}
