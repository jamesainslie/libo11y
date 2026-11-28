package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Events are force-emitted; ordinary records stay level gated; the wide record is always usable. */
class EventAndRecordTest {
    @Test
    void eventsAreEmittedWhateverTheLevel() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.logLevel(Severity.ERROR))) {
            rec.telemetry().logger().event("app.order.placed", Map.of("order.id", "o1"));
            rec.telemetry().event("app.order.shipped", Map.of("order.id", "o1"));
            List<StructuredLogger.LogEntry> entries = rec.entries();
            assertEquals(2, entries.size());
            assertEquals("app.order.placed", entries.get(0).eventName());
            assertEquals("app.order.placed", entries.get(0).attributes().get(Spec.EVENT_NAME_KEY));
            assertEquals(2, rec.logs().size());
            assertEquals(2, rec.consoleLines().size());
        }
    }

    @Test
    void anOrdinaryRecordCarryingEventNameStaysGated() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.logLevel(Severity.WARN))) {
            rec.telemetry().logger().info("looks like an event", Map.of(Spec.EVENT_NAME_KEY, "app.fake"));
            assertEquals(0, rec.entries().size());
            assertEquals(0, rec.logs().size());
        }
    }

    @Test
    void theWideRecordIsEmittedWhateverTheLevelAndKeepsItsSeverity() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.logLevel(Severity.WARN))) {
            try (O11yRecord wide = O11yRecord.start(rec.telemetry(), Spec.Events.REQUEST_SUMMARY)) {
                wide.set("order.id", "o1");
            }
            assertEquals(1, rec.entries().size());
            StructuredLogger.LogEntry entry = rec.entries().get(0);
            assertEquals(Spec.Events.REQUEST_SUMMARY, entry.eventName());
            assertEquals(Severity.INFO, entry.severity());
            assertEquals(Severity.INFO, rec.logs().get(0).getSeverity());
        }
    }

    @Test
    void aConsoleWriteFailureOnAnEventDoesNotThrow() {
        OutputStream failing = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                throw new IOException("disk full");
            }
        };
        try (O11yRecorder rec = O11yRecorder.start(b -> b.consoleOutput(failing))) {
            assertDoesNotThrow(() -> rec.telemetry().logger().event("app.order.placed", Map.of()));
            assertDoesNotThrow(() -> {
                try (O11yRecord wide = O11yRecord.start(rec.telemetry(), null)) {
                    wide.set("order.id", "o1");
                }
            });
            assertEquals(2, rec.entries().size());
            assertEquals(2, rec.logs().size());
        }
    }

    @Test
    void currentReturnsAUsableNoOpRecordOutsideAnyScope() {
        O11yRecord none = O11yRecord.current();
        assertNotNull(none);
        assertSame(none, none.set("order.id", "o1").add("db.queries", 2).max("app.slowest", 1.5));
        assertDoesNotThrow(none::emit);
        assertDoesNotThrow(none::close);
        assertNull(O11yRecord.fromContext(Context.root()), "the explicit lookup still tells no record apart");
    }

    @Test
    void addAndMaxAccumulate() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            try (O11yRecord wide = O11yRecord.start(rec.telemetry(), null)) {
                O11yRecord.current().add("db.queries", 2).add("db.queries", 3);
                O11yRecord.current().max("app.slowest", 1.5).max("app.slowest", 0.5).max("app.slowest", 2.5);
                O11yRecord.current().set("app.kind", "x").add("app.kind", 4);
                O11yRecord.current().set("app.peak", "y").max("app.peak", 0.25);
                Map<String, Object> snap = wide.snapshot();
                assertEquals(5L, snap.get("db.queries"));
                assertEquals(2.5, snap.get("app.slowest"));
                assertEquals(4L, snap.get("app.kind"), "a key holding another kind is replaced by delta");
                assertEquals(0.25, snap.get("app.peak"), "a key holding another kind is replaced by the value");
            }
            Map<String, Object> emitted = rec.entries().get(0).attributes();
            assertEquals(5L, emitted.get("db.queries"));
            assertEquals(2.5, emitted.get("app.slowest"));
        }
    }

    @Test
    void controlCharacterEscapesIgnoreTheDefaultLocale() {
        Locale previous = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("ar-EG"));
            try (O11yRecorder rec = O11yRecorder.start()) {
                rec.telemetry().logger().info("bell", Map.of("app.text", "a\u0001b"));
                String line = rec.consoleLines().get(0);
                assertTrue(line.contains("\"app.text\":\"a\\u0001b\""), line);
            }
        } finally {
            Locale.setDefault(previous);
        }
    }
}
