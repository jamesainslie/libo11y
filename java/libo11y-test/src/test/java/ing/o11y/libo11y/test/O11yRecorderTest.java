package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

@ExtendWith(O11yExtension.class)
class O11yRecorderTest {
    private static String recordInsideSpan(O11yRecorder rec) {
        Span span = rec.telemetry().tracer("app").spanBuilder("op").startSpan();
        try (Scope ignored = span.makeCurrent()) {
            rec.telemetry().meter("app").histogramBuilder("app.latency").build()
                    .record(0.25, Attributes.empty(), Context.current());
        } finally {
            span.end();
        }
        return span.getSpanContext().getTraceId();
    }

    @Test
    void forceFlushKeepsExemplarsRecordedBeforeIt(O11yRecorder rec) {
        String traceId = recordInsideSpan(rec);
        // The in-memory reader collects on flush, and a collection resets the exemplar reservoirs.
        rec.forceFlush();
        assertEquals(1, rec.exemplars().stream().filter(e -> traceId.equals(e.traceId())).count());
    }

    @Test
    void assertConformsKeepsExemplarsForTheTriangle(O11yRecorder rec) {
        String traceId = recordInsideSpan(rec);
        rec.telemetry().logger().info("inside-free");
        rec.assertConforms();
        assertEquals(1, rec.exemplars().stream().filter(e -> traceId.equals(e.traceId())).count());
    }

    @Test
    void exemplarsAreNotDuplicatedAcrossCollections(O11yRecorder rec) {
        recordInsideSpan(rec);
        rec.metrics();
        rec.metrics();
        assertEquals(1, rec.exemplars().size());
    }
}
