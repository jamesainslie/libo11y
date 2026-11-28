package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import ing.o11y.libo11y.TestReaders.CollectingSpanExporter;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.io.IOException;
import java.io.OutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** O11y.setup owns the OpenTelemetry global only through supported API (G1). */
class GlobalOwnershipTest {
    @BeforeEach
    @AfterEach
    void reset() {
        O11y.resetForTesting();
    }

    private static O11yOptions.Builder options(CollectingSpanExporter spans) {
        return TestReaders.baseOptions(new CollectingReader())
                .addSpanProcessor(SimpleSpanProcessor.create(spans));
    }

    private static void globalSpan(String name) {
        GlobalOpenTelemetry.getTracer("global-ownership").spanBuilder(name).startSpan().end();
    }

    @Test
    void aForeignGlobalIsATypedErrorAndStaysInstalled() {
        CollectingSpanExporter foreignSpans = new CollectingSpanExporter();
        OpenTelemetrySdk foreign = OpenTelemetrySdk.builder()
                .setTracerProvider(SdkTracerProvider.builder()
                        .addSpanProcessor(SimpleSpanProcessor.create(foreignSpans))
                        .build())
                .build();
        GlobalOpenTelemetry.set(foreign);
        try {
            CollectingSpanExporter mine = new CollectingSpanExporter();
            O11yException ex = assertThrows(O11yException.class, () -> O11y.setup(options(mine).build()));
            assertEquals(O11yException.ErrorCode.ALREADY_SETUP, ex.code());
            assertTrue(ex.getMessage().contains("GlobalOpenTelemetry"), ex.getMessage());
            assertNull(O11y.global());

            globalSpan("after-failed-setup");
            assertEquals(1, foreignSpans.spans.size(), "the foreign global was replaced");
            assertEquals(0, mine.spans.size());
        } finally {
            foreign.close();
        }
    }

    @Test
    void setupAfterShutdownRoutesTheGlobalToTheNewPipeline() {
        CollectingSpanExporter first = new CollectingSpanExporter();
        Telemetry a = O11y.setup(options(first).build());
        globalSpan("a");
        assertEquals(1, first.spans.size());
        assertTrue(a.shutdown().isOk());
        assertNull(O11y.global());

        CollectingSpanExporter second = new CollectingSpanExporter();
        Telemetry b = O11y.setup(options(second).build());
        assertSame(b, O11y.global());
        globalSpan("b");
        assertEquals(1, second.spans.size());
        assertEquals(1, first.spans.size());

        // Shutting the first handle down again changes nothing about the second.
        a.shutdown();
        assertSame(b, O11y.global());
        globalSpan("b2");
        assertEquals(2, second.spans.size());
    }

    @Test
    void aFailedSetupLeavesTheInstalledGlobalAlone() {
        CollectingSpanExporter first = new CollectingSpanExporter();
        Telemetry a = O11y.setup(options(first).build());
        a.shutdown();

        OutputStream rejecting = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                throw new IOException("sink down");
            }
        };
        O11yException ex = assertThrows(O11yException.class, () -> O11y.setup(options(new CollectingSpanExporter())
                .consoleOutput(rejecting)
                .build()));
        assertEquals(O11yException.ErrorCode.CANARY_REJECTED, ex.code());
        assertTrue(GlobalOpenTelemetry.isSet(), "a failed setup cleared a global it never installed");
        assertNull(O11y.global());

        // The guard was released, so the next setup succeeds and takes the global over.
        CollectingSpanExporter third = new CollectingSpanExporter();
        Telemetry c = O11y.setup(options(third).build());
        assertSame(c, O11y.global());
        globalSpan("c");
        assertEquals(1, third.spans.size());
    }

    @Test
    void aSecondSetupIsRejectedAndItsInjectedPartsAreStopped() {
        Telemetry a = O11y.setup(options(new CollectingSpanExporter()).build());
        TestParts.StoppableSpanExporter injected = new TestParts.StoppableSpanExporter();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.setup(
                TestReaders.baseOptions(new CollectingReader()).spanExporter(injected).build()));
        assertEquals(O11yException.ErrorCode.ALREADY_SETUP, ex.code());
        assertTrue(injected.shutdownCalled(), "the rejected setup leaked its injected exporter");
        assertSame(a, O11y.global());
    }
}
