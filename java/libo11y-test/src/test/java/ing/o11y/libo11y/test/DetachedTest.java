package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.Detached;
import ing.o11y.libo11y.Detached.Carrier;
import ing.o11y.libo11y.O11yException;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.baggage.BaggageBuilder;
import io.opentelemetry.api.baggage.BaggageEntryMetadata;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The expected carrier strings are Go's own output ({@code go/detached.go}) for the same contexts,
 * printed by a Go test over {@code SDK.Capture} and {@code Carrier.UnmarshalText}.
 */
class DetachedTest {
    private static final String TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
    private static final String SPAN_ID = "b7ad6b7169203331";
    private static final String TP = "traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-01";

    private static final TextMapGetter<Map<String, String>> GETTER = new TextMapGetter<>() {
        @Override
        @SuppressWarnings("deprecation")
        public Iterable<String> keys(Map<String, String> carrier) {
            return carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
            return carrier == null ? null : carrier.get(key);
        }
    };

    /** A context holding the remote span Go's tests use, extracted from W3C headers. */
    private static Context remoteContext(String tracestate) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("traceparent", "00-" + TRACE_ID + "-" + SPAN_ID + "-01");
        if (!tracestate.isEmpty()) {
            headers.put("tracestate", tracestate);
        }
        return W3CTraceContextPropagator.getInstance().extract(Context.root(), headers, GETTER);
    }

    private static Context withBaggage(Context ctx, String... pairs) {
        BaggageBuilder b = Baggage.fromContext(ctx).toBuilder();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            b.put(pairs[i], pairs[i + 1]);
        }
        return ctx.with(b.build());
    }

    @Test
    void captureEncodesExactlyAsGoDoes() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Context ctx = withBaggage(remoteContext("vendor=abc,other=xyz"), "tenant", "acme");
            String f1 = "baggage=tenant%3Dacme&" + TP + "&tracestate=vendor%3Dabc%2Cother%3Dxyz";
            assertEquals(f1, Detached.capture(rec.telemetry(), ctx).marshal());

            Context special = withBaggage(remoteContext(""), "k", "a/b c=d%,é\"x");
            assertEquals("baggage=k%3Da%2Fb%2520c%3Dd%2525%252C%25C3%25A9%2522x&" + TP,
                    Detached.capture(rec.telemetry(), special).marshal());

            Context withProperty = remoteContext("").with(Baggage.builder()
                    .put("tenant", "acme", BaggageEntryMetadata.create("p=1")).build());
            assertEquals("baggage=tenant%3Dacme%3Bp%3D1&" + TP,
                    Detached.capture(rec.telemetry(), withProperty).marshal());

            SpanContext unsampled = SpanContext.createFromRemoteParent(
                    "01000000000000000000000000000000", "0200000000000000",
                    io.opentelemetry.api.trace.TraceFlags.getDefault(),
                    io.opentelemetry.api.trace.TraceState.getDefault());
            assertEquals("traceparent=00-01000000000000000000000000000000-0200000000000000-00",
                    Detached.capture(rec.telemetry(), Context.root().with(Span.wrap(unsampled))).marshal());

            for (String text : List.of(f1, "baggage=tenant%3Dacme%3Bp%3D1&" + TP)) {
                assertEquals(text, Carrier.unmarshal(text).marshal());
                assertEquals(text, Carrier.unmarshal(text).toString());
            }
        }
    }

    @Test
    void captureDropsTracestateThenBaggageInsteadOfFailing() {
        // The largest tracestate W3C allows: URL encoding triples it past 32 KiB.
        List<String> members = new ArrayList<>();
        for (int i = 0; i < 32; i++) {
            members.add(String.format(java.util.Locale.ROOT, "k%02d%s=%s", i, "/".repeat(253), "/".repeat(256)));
        }
        try (O11yRecorder rec = O11yRecorder.start()) {
            Context ctx = withBaggage(remoteContext(String.join(",", members)), "tenant", "acme");
            assertTrue(Span.fromContext(ctx).getSpanContext().getTraceState().size() == 32);
            Carrier c = Detached.capture(rec.telemetry(), ctx);
            assertEquals("baggage=tenant%3Dacme&" + TP, c.marshal());
            assertEquals(SPAN_ID, Carrier.unmarshal(c.marshal()).spanContext().getSpanId());
        }
    }

    @Test
    void unmarshalMatchesGo() {
        Map<String, String> ok = new LinkedHashMap<>();
        ok.put(TP + "&baggage=c%3D3%2Ca%3D1%2C%3D%3D%3D%2Cb%3D2", "baggage=c%3D3%2Ca%3D1%2Cb%3D2&" + TP);
        ok.put(TP + "&baggage=a%3D1%2Ca%3D2", "baggage=a%3D1%2Ca%3D2&" + TP);
        ok.put(TP + "&baggage=a%3D1%2Ca%3D2%2C%3D%3D%3D", "baggage=a%3D2&" + TP);
        ok.put("traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-03", "traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-03");
        ok.put("traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-02", "traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-02");
        ok.put("traceparent=01-" + TRACE_ID + "-" + SPAN_ID + "-ff-extra", "traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-03");
        ok.put(TP + "&tracestate=a%3D1%2C+b%3D2+%2C%2Cc%3D3", TP + "&tracestate=a%3D1%2Cb%3D2%2Cc%3D3");
        ok.put(TP + "&tracestate=A%3D1", TP);
        ok.put(TP + "&traceparent=junk", TP);
        ok.put(TP + "&baggage=%3D%3D%3D", TP);
        ok.put(TP + "&baggage=+a+%3D+1+%3Bp%3Dx+%2C+%3D%3D%3D+%2C+b%3D2", "baggage=+a+%3D+1+%3Bp%3Dx+%2C+b%3D2&" + TP);
        ok.put(TP + "&baggage=k%3Da%252Fb", "baggage=k%3Da%252Fb&" + TP);
        ok.put(TP + "&baggage=k%3Da%2Fb", "baggage=k%3Da%2Fb&" + TP);
        ok.forEach((in, want) -> assertEquals(want, Carrier.unmarshal(in).marshal(), "unmarshal " + in));

        List<String> bad = List.of(
                "traceparent=00-" + TRACE_ID + "-" + SPAN_ID + "-ff",
                "traceparent=00-0AF7651916CD43DD8448EB211C80319C-" + SPAN_ID + "-01",
                "traceparent=ff-" + TRACE_ID + "-" + SPAN_ID + "-01",
                "traceparent=00-00000000000000000000000000000000-" + SPAN_ID + "-01",
                "traceparent=00-xyz",
                TP + "&x=1;y",
                "traceparent=junk&" + TP,
                "%zz",
                "baggage=a%3Db",
                TP + "&a=%4",
                "traceparent=" + "a".repeat(40 << 10),
                TP + "&a".repeat(10_000));
        for (String in : bad) {
            O11yException e = assertThrows(O11yException.class, () -> Carrier.unmarshal(in), "unmarshal " + in);
            assertEquals(O11yException.ErrorCode.INVALID_CARRIER, e.code());
        }
        assertTrue(Carrier.unmarshal(TP + "&a".repeat(9_998)).spanContext().isValid());
    }

    @Test
    void emptyCarrier() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Carrier c = Detached.capture(rec.telemetry(), withBaggage(Context.root(), "tenant", "acme"));
            assertTrue(c.isEmpty(), "no valid span context captures the empty carrier");
            assertEquals("", c.marshal());
            assertTrue(Carrier.unmarshal("").isEmpty());
            assertTrue(Carrier.unmarshal(null).isEmpty());
            assertFalse(Carrier.unmarshal("").spanContext().isValid());
        }
    }

    @Test
    void captureAppliesTheBaggageEgressFilter() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.baggageEgressAllow(k -> !"session".equals(k)))) {
            String text = Detached.capture(rec.telemetry(),
                    withBaggage(remoteContext(""), "tenant", "acme", "session", "s-1")).marshal();
            assertEquals("baggage=tenant%3Dacme&" + TP, text);
        }
    }

    @Test
    void startLinkedMergesBaggageOnTopOfTheCallersAndLinksARoot() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Carrier carrier = Detached.capture(rec.telemetry(),
                    withBaggage(remoteContext(""), "tenant", "acme", "region", "eu"));
            Context worker = withBaggage(Context.root(), "worker", "pool-1", "region", "us");
            Span loop = rec.telemetry().tracer("test").spanBuilder("worker-loop").setParent(worker).startSpan();
            try (Scope ignored = worker.with(loop).makeCurrent();
                    Detached.LinkedSpan job = Detached.startLinked(rec.telemetry(), "job", Carrier.unmarshal(carrier.marshal()))) {
                Baggage bag = Baggage.current();
                assertEquals("acme", bag.getEntryValue("tenant"));
                assertEquals("eu", bag.getEntryValue("region"), "the carrier wins a key collision");
                assertEquals("pool-1", bag.getEntryValue("worker"), "the caller's baggage is kept");
                assertEquals(job.span().getSpanContext(), Span.current().getSpanContext());
            } finally {
                loop.end();
            }
            SpanData job = rec.spans().stream().filter(s -> "job".equals(s.getName())).findFirst().orElseThrow();
            assertFalse(job.getParentSpanContext().isValid(), "a new root");
            assertNotEquals(TRACE_ID, job.getTraceId());
            assertEquals(1, job.getLinks().size());
            assertEquals(SPAN_ID, job.getLinks().get(0).getSpanContext().getSpanId());

            Context explicit = withBaggage(Context.root(), "worker", "pool-2");
            try (Detached.LinkedSpan ignored = Detached.startLinked(rec.telemetry(), explicit, "job2", carrier)) {
                assertEquals("pool-2", Baggage.current().getEntryValue("worker"));
                assertEquals("acme", Baggage.current().getEntryValue("tenant"));
            }
        }
    }

    @Test
    void startLinkedWithTheEmptyCarrierStartsAnUnlinkedRoot() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            try (Detached.LinkedSpan ignored = Detached.startLinked(rec.telemetry(), "job", Carrier.unmarshal(""))) {
                assertNull(Baggage.current().getEntryValue("tenant"));
            }
            SpanData job = rec.spans().stream().filter(s -> "job".equals(s.getName())).findFirst().orElseThrow();
            assertFalse(job.getParentSpanContext().isValid());
            assertTrue(job.getLinks().isEmpty());
        }
    }

    @Test
    void restoredBaggageFollowsTheW3cLimitsAsGoDoes() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            try (Detached.LinkedSpan ignored = Detached.startLinked(rec.telemetry(), "job",
                    Carrier.unmarshal(TP + "&baggage=a%3D1%2Ca%3D2%2C%3D%3D%3D"))) {
                assertEquals(1, Baggage.current().size());
                assertEquals("2", Baggage.current().getEntryValue("a"), "the last duplicate wins");
            }

            StringBuilder big = new StringBuilder();
            for (int i = 0; i < 40; i++) {
                big.append(i == 0 ? "" : ",").append(String.format(java.util.Locale.ROOT, "k%02d=%s", i, "v".repeat(250)));
            }
            Carrier over = Carrier.unmarshal(TP + "&baggage=" + java.net.URLEncoder.encode(big.toString(),
                    java.nio.charset.StandardCharsets.UTF_8));
            assertEquals(TP, over.marshal(), "baggage over 8192 bytes is dropped whole");

            StringBuilder many = new StringBuilder();
            for (int i = 0; i < 70; i++) {
                many.append(i == 0 ? "" : ",").append(String.format(java.util.Locale.ROOT, "k%02d=v%02d", i, i));
            }
            Carrier wide = Carrier.unmarshal(TP + "&baggage=" + java.net.URLEncoder.encode(many.toString(),
                    java.nio.charset.StandardCharsets.UTF_8));
            try (Detached.LinkedSpan ignored = Detached.startLinked(rec.telemetry(), "job", wide)) {
                assertEquals(64, Baggage.current().size(), "the 64 members Go's Parse keeps");
                assertEquals("v63", Baggage.current().getEntryValue("k63"));
                assertNull(Baggage.current().getEntryValue("k64"));
            }
        }
    }
}
