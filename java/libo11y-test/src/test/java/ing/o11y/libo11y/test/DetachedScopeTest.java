package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;

import ing.o11y.libo11y.Detached;
import ing.o11y.libo11y.Detached.Carrier;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.trace.data.SpanData;
import org.junit.jupiter.api.Test;

/** Detached spans are libo11y's own telemetry, so they carry the one scope libo11y emits under, as in Go. */
class DetachedScopeTest {
    @Test
    void startLinkedUsesLibo11ysOwnScope() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            try (Detached.LinkedSpan ignored = Detached.startLinked(rec.telemetry(), "job", Carrier.unmarshal(""))) {
                rec.telemetry().logger().info("inside the job");
            }
            SpanData span = rec.spans().get(0);
            LogRecordData own = rec.logs().get(0);

            assertEquals("libo11y", span.getInstrumentationScopeInfo().getName());
            assertEquals(own.getInstrumentationScopeInfo().getName(), span.getInstrumentationScopeInfo().getName());
        }
    }
}
