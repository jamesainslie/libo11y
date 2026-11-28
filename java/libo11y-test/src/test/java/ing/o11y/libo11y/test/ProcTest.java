package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.Proc;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ProcTest {
    private static final String TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
    private static final String SPAN_ID = "b7ad6b7169203331";
    private static final String TRACEPARENT = "00-" + TRACE_ID + "-" + SPAN_ID + "-01";

    private static Context sampledParent(TraceState state) {
        SpanContext sc = SpanContext.create(TRACE_ID, SPAN_ID, TraceFlags.getSampled(), state);
        return Context.root().with(Span.wrap(sc))
                .with(Baggage.builder().put("tenant", "t1").put("user", "u1").build());
    }

    @Test
    void envEntriesCarryTraceparentAndNeverBaggage() {
        Map<String, String> env = Proc.envEntries(sampledParent(TraceState.getDefault()));
        assertEquals(Map.of("TRACEPARENT", TRACEPARENT), env);
        assertThrows(UnsupportedOperationException.class, () -> env.put("X", "y"));
    }

    @Test
    void envEntriesCarryTracestateWhenPresent() {
        TraceState state = TraceState.builder().put("vendor", "v1").build();
        Map<String, String> env = Proc.envEntries(sampledParent(state));
        assertEquals(TRACEPARENT, env.get("TRACEPARENT"));
        assertEquals("vendor=v1", env.get("TRACESTATE"));
        assertEquals(2, env.size());
    }

    @Test
    void envEntriesAreEmptyWithoutAValidSpan() {
        assertEquals(Map.of(), Proc.envEntries(Context.root()));
    }

    @Test
    void injectEnvReplacesStaleTraceVariablesAndKeepsTheRest() {
        Map<String, String> env = new HashMap<>();
        env.put("PATH", "/bin");
        env.put("TRACEPARENT", "00-11111111111111111111111111111111-2222222222222222-01");
        env.put("TRACESTATE", "stale=1");
        Proc.injectEnv(sampledParent(TraceState.getDefault()), env);
        assertEquals(TRACEPARENT, env.get("TRACEPARENT"));
        assertNull(env.get("TRACESTATE"));
        assertEquals("/bin", env.get("PATH"));
        assertFalse(env.containsKey("BAGGAGE"));
    }

    @Test
    void injectEnvWithoutASpanRemovesInheritedTraceVariables() {
        Map<String, String> env = new HashMap<>();
        env.put("TRACEPARENT", TRACEPARENT);
        env.put("TRACESTATE", "vendor=v1");
        Proc.injectEnv(Context.root(), env);
        assertTrue(env.isEmpty(), env.toString());
    }

    @Test
    void extractEnvRestoresTheRemoteParent() {
        Map<String, String> env = Map.of("TRACEPARENT", TRACEPARENT, "TRACESTATE", "vendor=v1");
        SpanContext sc = Span.fromContext(Proc.extractEnv(env)).getSpanContext();
        assertTrue(sc.isValid());
        assertTrue(sc.isRemote());
        assertTrue(sc.isSampled());
        assertEquals(TRACE_ID, sc.getTraceId());
        assertEquals(SPAN_ID, sc.getSpanId());
        assertEquals("v1", sc.getTraceState().get("vendor"));
    }

    @Test
    void extractEnvIgnoresBaggageAndMalformedParents() {
        Context fromBaggageOnly = Proc.extractEnv(Map.of("BAGGAGE", "tenant=t1"));
        assertFalse(Span.fromContext(fromBaggageOnly).getSpanContext().isValid());
        assertNull(Baggage.fromContext(fromBaggageOnly).getEntryValue("tenant"));

        Context malformed = Proc.extractEnv(Map.of("TRACEPARENT", "not-a-traceparent"));
        assertFalse(Span.fromContext(malformed).getSpanContext().isValid());
    }

    @Test
    void envRoundTripThroughInjectAndExtract() {
        Map<String, String> env = new HashMap<>();
        Proc.injectEnv(sampledParent(TraceState.getDefault()), env);
        SpanContext sc = Span.fromContext(Proc.extractEnv(env)).getSpanContext();
        assertEquals(TRACE_ID, sc.getTraceId());
        assertEquals(SPAN_ID, sc.getSpanId());
    }

    @Test
    void frameCarriesTraceAndEgressFilteredBaggage() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.baggageEgressAllow("tenant"::equals))) {
            Map<String, String> frame = Proc.injectFrame(rec.telemetry(), sampledParent(TraceState.getDefault()));
            assertEquals(TRACEPARENT, frame.get("traceparent"));
            assertEquals("tenant=t1", frame.get("baggage"));

            Context restored = Proc.extractFrame(rec.telemetry(), frame);
            assertEquals(TRACE_ID, Span.fromContext(restored).getSpanContext().getTraceId());
            assertEquals("t1", Baggage.fromContext(restored).getEntryValue("tenant"));
            assertNull(Baggage.fromContext(restored).getEntryValue("user"));
        }
    }

    @Test
    void extractFrameMatchesHeaderNamesCaseInsensitively() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Map<String, String> frame = new LinkedHashMap<>();
            frame.put("TraceParent", TRACEPARENT);
            SpanContext sc = Span.fromContext(Proc.extractFrame(rec.telemetry(), frame)).getSpanContext();
            assertEquals(TRACE_ID, sc.getTraceId());
        }
    }

    @Test
    void extractFrameWithoutHeadersReturnsTheRootContext() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            assertSame(Context.root(), Proc.extractFrame(rec.telemetry(), Map.of()));
        }
    }
}
