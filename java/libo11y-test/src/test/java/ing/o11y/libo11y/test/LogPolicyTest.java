package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.KeyValue;
import io.opentelemetry.api.common.Value;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.ReadWriteLogRecord;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/** The sensitivity policy on every log leg: console, extra sinks, OTLP, and records from other log bridges. */
class LogPolicyTest {
    /** The key and two cases of {@code conformance/vectors/pii-hash.json}. */
    private static final byte[] VECTOR_KEY =
            HexFormat.of().parseHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

    private static final String EMAIL = "alice@example.com";
    private static final String EMAIL_TOKEN = "hmac-sha256:a59fc578d4cb46faab1d6eb348e7c74b";
    private static final long AGE = -42L;
    private static final String AGE_TOKEN = "hmac-sha256:2156a1be40679f64ac98cbf96a0f1ecb";

    private static final String REGISTRY = """
            schema: libo11y.app-registry/v1
            namespace: acme
            attributes:
              acme.card_cvv:
                type: string
                sensitivity: secret
                cardinality: unbounded
              acme.customer_email:
                type: string
                sensitivity: pii
                cardinality: unbounded
              acme.customer_age:
                type: int
                sensitivity: pii
                cardinality: unbounded
              acme.plan:
                type: string
                sensitivity: public
                cardinality: bounded
              acme.ctx.card_cvv:
                type: string
                sensitivity: secret
                cardinality: unbounded
              acme.ctx.customer_email:
                type: string
                sensitivity: pii
                cardinality: unbounded
            """;

    private static final AttributeKey<String> AUTH = AttributeKey.stringKey("http.request.header.authorization");
    private static final AttributeKey<String> CVV = AttributeKey.stringKey("acme.card_cvv");
    private static final AttributeKey<String> EMAIL_KEY = AttributeKey.stringKey("acme.customer_email");
    private static final AttributeKey<Long> AGE_KEY = AttributeKey.longKey("acme.customer_age");
    private static final AttributeKey<String> AGE_TOKEN_KEY = AttributeKey.stringKey("acme.customer_age");
    private static final AttributeKey<String> PLAN = AttributeKey.stringKey("acme.plan");
    private static final AttributeKey<Value<?>> CTX = AttributeKey.valueKey("acme.ctx");

    /** A processor injected through the options, recording what it sees on emit. */
    private static final class Capture implements LogRecordProcessor {
        final List<Attributes> viewAttrs = new CopyOnWriteArrayList<>();
        final List<Attributes> dataAttrs = new CopyOnWriteArrayList<>();
        final List<String> singleLookups = new CopyOnWriteArrayList<>();

        @Override
        public void onEmit(Context context, ReadWriteLogRecord logRecord) {
            viewAttrs.add(logRecord.getAttributes());
            dataAttrs.add(logRecord.toLogRecordData().getAttributes());
            singleLookups.add(String.valueOf(logRecord.getAttribute(AUTH)));
            singleLookups.add(String.valueOf(logRecord.getAttribute(CVV)));
        }
    }

    private static O11yRecorder recorder(PiiMode mode, Consumer<ing.o11y.libo11y.O11yOptions.Builder> extra) {
        return O11yRecorder.start(b -> {
            b.piiMode(mode).addAppRegistryYaml(REGISTRY, "inline.yaml");
            if (mode == PiiMode.HASH) {
                b.piiHashKey(VECTOR_KEY);
            }
            extra.accept(b);
        });
    }

    private static void emitBridgeRecord(Telemetry t) {
        Value<?> ctx = Value.of(
                KeyValue.of("card_cvv", Value.of("999")),
                KeyValue.of("customer_email", Value.of(EMAIL)),
                KeyValue.of("plan", Value.of("pro")));
        t.loggerProvider().get("other.bridge").logRecordBuilder()
                .setBody("charged")
                .setAttribute(AUTH, "Bearer topsecret")
                .setAttribute(CVV, "999")
                .setAttribute(EMAIL_KEY, EMAIL)
                .setAttribute(AGE_KEY, AGE)
                .setAttribute(PLAN, "pro")
                .setAttribute(CTX, ctx)
                .emit();
    }

    private static Map<String, Value<?>> members(Value<?> value) {
        Map<String, Value<?>> out = new LinkedHashMap<>();
        @SuppressWarnings("unchecked")
        List<KeyValue> kvs = (List<KeyValue>) value.getValue();
        for (KeyValue kv : kvs) {
            out.put(kv.getKey(), kv.getValue());
        }
        return out;
    }

    private static LogRecordData exported(O11yRecorder rec, String body) {
        return rec.logs().stream()
                .filter(l -> body.equals(l.getBodyValue() == null ? null : l.getBodyValue().asString()))
                .findFirst()
                .orElseThrow();
    }

    private static long violations(O11yRecorder rec) {
        long total = 0;
        for (MetricData md : rec.metrics()) {
            if (Spec.Metrics.SCHEMA_VIOLATIONS.equals(md.getName())) {
                for (LongPointData p : md.getLongSumData().getPoints()) {
                    total += p.getValue();
                }
            }
        }
        return total;
    }

    @Test
    void bridgeRecordDropsSecretAndPiiOnExporterAndInjectedProcessor() {
        Capture capture = new Capture();
        try (O11yRecorder rec = recorder(PiiMode.DROP, b -> b.addLogRecordProcessor(capture))) {
            emitBridgeRecord(rec.telemetry());

            Attributes out = exported(rec, "charged").getAttributes();
            assertNull(out.get(AUTH));
            assertNull(out.get(CVV));
            assertNull(out.get(EMAIL_KEY));
            assertNull(out.get(AGE_KEY));
            assertEquals("pro", out.get(PLAN));
            Map<String, Value<?>> ctx = members(out.get(CTX));
            assertEquals(Map.of("plan", Value.of("pro")), ctx);

            for (Attributes seen : List.of(capture.viewAttrs.get(0), capture.dataAttrs.get(0))) {
                assertEquals(out, seen);
            }
            assertEquals(List.of("null", "null"), capture.singleLookups);
        }
    }

    @Test
    void bridgeRecordTokenizesPiiOnceInHashMode() {
        Capture capture = new Capture();
        try (O11yRecorder rec = recorder(PiiMode.HASH, b -> b.addLogRecordProcessor(capture))) {
            emitBridgeRecord(rec.telemetry());

            Attributes out = exported(rec, "charged").getAttributes();
            assertNull(out.get(AUTH));
            assertNull(out.get(CVV));
            assertEquals(EMAIL_TOKEN, out.get(EMAIL_KEY));
            assertNull(out.get(AGE_KEY), "the raw long must not survive next to its token");
            assertEquals(AGE_TOKEN, out.get(AGE_TOKEN_KEY));
            long ageKeys = out.asMap().keySet().stream()
                    .filter(k -> k.getKey().equals("acme.customer_age"))
                    .count();
            assertEquals(1, ageKeys);
            Map<String, Value<?>> ctx = members(out.get(CTX));
            assertEquals(Value.of(EMAIL_TOKEN), ctx.get("customer_email"));
            assertFalse(ctx.containsKey("card_cvv"));
            assertEquals(out, capture.viewAttrs.get(0));
            assertEquals(out, capture.dataAttrs.get(0));
        }
    }

    @Test
    void bridgeRecordKeepsPiiInKeepMode() {
        try (O11yRecorder rec = recorder(PiiMode.KEEP, b -> {})) {
            emitBridgeRecord(rec.telemetry());

            Attributes out = exported(rec, "charged").getAttributes();
            assertNull(out.get(AUTH));
            assertNull(out.get(CVV));
            assertEquals(EMAIL, out.get(EMAIL_KEY));
            assertEquals(AGE, out.get(AGE_KEY));
            Map<String, Value<?>> ctx = members(out.get(CTX));
            assertEquals(Value.of(EMAIL), ctx.get("customer_email"));
            assertFalse(ctx.containsKey("card_cvv"));
        }
    }

    @Test
    void bridgeRecordWalksListsOfMapsAndFailsClosedAtTheDepthBound() {
        try (O11yRecorder rec = recorder(PiiMode.DROP, b -> {})) {
            Value<?> list = Value.of(List.<Value<?>>of(
                    Value.of(KeyValue.of("authorization", Value.of("Bearer a")), KeyValue.of("accept", Value.of("x"))),
                    Value.of(KeyValue.of("authorization", Value.of("Bearer b")))));
            Value<?> deep = Value.of("leaf");
            for (int i = 0; i < 20; i++) {
                deep = Value.of(KeyValue.of("n", deep));
            }
            rec.telemetry().loggerProvider().get("other.bridge").logRecordBuilder()
                    .setBody("nested")
                    .setAttribute(AttributeKey.valueKey("http.request.header"), list)
                    .setAttribute(AttributeKey.valueKey("app.deep"), deep)
                    .setAttribute(AttributeKey.stringKey("app.flat"), "ok")
                    .emit();

            Attributes out = exported(rec, "nested").getAttributes();
            Value<?> headers = out.get(AttributeKey.valueKey("http.request.header"));
            assertNotNull(headers);
            @SuppressWarnings("unchecked")
            List<Value<?>> elements = (List<Value<?>>) headers.getValue();
            assertEquals(1, elements.size(), "a map emptied by classification is dropped");
            assertEquals(Map.of("accept", Value.of("x")), members(elements.get(0)));
            assertNull(out.get(AttributeKey.valueKey("app.deep")), "a composite past the depth bound is dropped");
            assertEquals("ok", out.get(AttributeKey.stringKey("app.flat")));
        }
    }

    @Test
    void violationsAreCountedOncePerRecordWhateverTheProcessorCount() {
        try (O11yRecorder rec = recorder(PiiMode.DROP, b -> b
                .addLogRecordProcessor(new Capture())
                .addLogRecordProcessor(new Capture()))) {
            long before = violations(rec);
            rec.telemetry().loggerProvider().get("other.bridge").logRecordBuilder()
                    .setBody("one secret")
                    .setAttribute(AUTH, "Bearer topsecret")
                    .emit();
            assertEquals(before + 1, violations(rec));

            rec.telemetry().logger().info("one secret again", Map.of(AUTH.getKey(), "Bearer topsecret"));
            assertEquals(before + 2, violations(rec));
        }
    }

    @Test
    void oneTokenPerValueOnEveryLeg() {
        Capture first = new Capture();
        Capture second = new Capture();
        List<StructuredLogger.LogEntry> extra = new CopyOnWriteArrayList<>();
        try (O11yRecorder rec = recorder(PiiMode.HASH, b -> b
                .addLogRecordProcessor(first)
                .addLogRecordProcessor(second)
                .addExtraLogSink(extra::add))) {
            Telemetry t = rec.telemetry();
            Span span = t.tracer("test").spanBuilder("op").setAttribute(EMAIL_KEY, EMAIL).startSpan();
            try (Scope ignored = span.makeCurrent()) {
                t.logger().info("signed up", Map.of(EMAIL_KEY.getKey(), EMAIL));
            } finally {
                span.end();
            }

            SpanData sp = rec.spans().get(0);
            assertEquals(EMAIL_TOKEN, sp.getAttributes().get(EMAIL_KEY));
            assertEquals(EMAIL_TOKEN, rec.entries().get(0).attributes().get(EMAIL_KEY.getKey()));
            assertEquals(EMAIL_TOKEN, extra.get(0).attributes().get(EMAIL_KEY.getKey()));
            assertEquals(EMAIL_TOKEN, exported(rec, "signed up").getAttributes().get(EMAIL_KEY));
            assertEquals(EMAIL_TOKEN, first.dataAttrs.get(0).get(EMAIL_KEY));
            assertEquals(EMAIL_TOKEN, second.dataAttrs.get(0).get(EMAIL_KEY));
            String console = rec.consoleLines().stream()
                    .filter(l -> l.contains("\"msg\":\"signed up\""))
                    .findFirst()
                    .orElseThrow();
            assertTrue(console.contains("\"acme.customer_email\":\"" + EMAIL_TOKEN + "\""), console);
        }
    }

    private static int occurrences(String line, String key) {
        Matcher m = Pattern.compile(Pattern.quote("\"" + key + "\":")).matcher(line);
        int n = 0;
        while (m.find()) {
            n++;
        }
        return n;
    }

    private static String field(String line, String key) {
        Matcher m = Pattern.compile(Pattern.quote("\"" + key + "\":\"") + "([^\"]*)\"").matcher(line);
        return m.find() ? m.group(1) : null;
    }

    private static Map<String, Object> forgedReserved() {
        Map<String, Object> attrs = new LinkedHashMap<>();
        attrs.put("trace_id", "00000000000000000000000000000bad");
        attrs.put("span_id", "0000000000000bad");
        attrs.put("trace_flags", "00");
        attrs.put("time", "1999-01-01T00:00:00Z");
        attrs.put("level", "DEBUG");
        attrs.put("msg", "forged");
        attrs.put("app.kept", "yes");
        return attrs;
    }

    @Test
    void reservedConsoleFieldsCannotBeForgedInsideASpan() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Telemetry t = rec.telemetry();
            Span span = t.tracer("test").spanBuilder("op").startSpan();
            try (Scope ignored = span.makeCurrent()) {
                t.logger().warn("real message", forgedReserved());
            } finally {
                span.end();
            }
            String line = rec.consoleLines().get(rec.consoleLines().size() - 1);
            for (String key : List.of("trace_id", "span_id", "trace_flags", "time", "level", "msg")) {
                assertEquals(1, occurrences(line, key), key + " in " + line);
            }
            assertEquals(span.getSpanContext().getTraceId(), field(line, "trace_id"));
            assertEquals(span.getSpanContext().getSpanId(), field(line, "span_id"));
            assertEquals("WARN", field(line, "level"));
            assertEquals("real message", field(line, "msg"));
            assertEquals("yes", field(line, "app.kept"));

            Attributes otlp = exported(rec, "real message").getAttributes();
            assertNull(otlp.get(AttributeKey.stringKey("trace_id")));
            assertNull(otlp.get(AttributeKey.stringKey("span_id")));
            assertFalse(rec.entries().get(rec.entries().size() - 1).attributes().containsKey("trace_id"));
        }
    }

    @Test
    void reservedConsoleFieldsCannotBeForgedOutsideASpan() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            rec.telemetry().logger().warn("real message", forgedReserved());
            String line = rec.consoleLines().get(rec.consoleLines().size() - 1);
            assertEquals(0, occurrences(line, "trace_id"), line);
            assertEquals(0, occurrences(line, "span_id"), line);
            assertEquals(0, occurrences(line, "trace_flags"), line);
            assertEquals(1, occurrences(line, "msg"), line);
            assertEquals("real message", field(line, "msg"));
            assertEquals("yes", field(line, "app.kept"));
        }
    }

    @Test
    void attributeReplacerOutputCannotSetTraceIdOrSpanId() {
        // The Java replacer maps (key, value) to a value and cannot rename a key, so the only way
        // it could write trace_id is by returning a value for a caller trace_id key. The reserved
        // filter runs on the replacer's result, so that value never reaches a leg.
        java.util.function.BiFunction<String, Object, Object> replacer =
                (k, v) -> k.equals("trace_id") || k.equals("span_id") ? "00000000000000000000000000000bad" : v;
        try (O11yRecorder rec = O11yRecorder.start(b -> b.attrReplacer(replacer))) {
            Telemetry t = rec.telemetry();
            Span span = t.tracer("test").spanBuilder("op").startSpan();
            try (Scope ignored = span.makeCurrent()) {
                t.logger().info("replaced", Map.of("trace_id", "x", "span_id", "y", "app.kept", "yes"));
            } finally {
                span.end();
            }
            String line = rec.consoleLines().get(rec.consoleLines().size() - 1);
            assertEquals(1, occurrences(line, "trace_id"), line);
            assertEquals(1, occurrences(line, "span_id"), line);
            assertEquals(span.getSpanContext().getTraceId(), field(line, "trace_id"));
            assertEquals(span.getSpanContext().getSpanId(), field(line, "span_id"));
            Attributes otlp = exported(rec, "replaced").getAttributes();
            assertNull(otlp.get(AttributeKey.stringKey("trace_id")));
            assertNull(otlp.get(AttributeKey.stringKey("span_id")));
            assertEquals("yes", otlp.get(AttributeKey.stringKey("app.kept")));
        }
    }

    @Test
    void homogeneousListsKeepTheirTypeOnOtlp() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            Map<String, Object> attrs = new LinkedHashMap<>();
            attrs.put("app.longs", List.of(1L, 2L));
            attrs.put("app.ints", List.of(3, 4));
            attrs.put("app.doubles", List.of(1.5, 2.5));
            attrs.put("app.bools", List.of(true, false));
            attrs.put("app.strings", List.of("a", "b"));
            attrs.put("app.mixed", List.of(1L, "b"));
            rec.telemetry().logger().info("lists", attrs);

            Attributes otlp = exported(rec, "lists").getAttributes();
            assertEquals(List.of(1L, 2L), otlp.get(AttributeKey.longArrayKey("app.longs")));
            assertEquals(List.of(3L, 4L), otlp.get(AttributeKey.longArrayKey("app.ints")));
            assertEquals(List.of(1.5, 2.5), otlp.get(AttributeKey.doubleArrayKey("app.doubles")));
            assertEquals(List.of(true, false), otlp.get(AttributeKey.booleanArrayKey("app.bools")));
            assertEquals(List.of("a", "b"), otlp.get(AttributeKey.stringArrayKey("app.strings")));
            assertEquals(List.of("1", "b"), otlp.get(AttributeKey.stringArrayKey("app.mixed")));
        }
    }

    @Test
    void aThrowingExtraSinkDoesNotReachTheCallerOrStopTheOtherSinks() {
        List<StructuredLogger.LogEntry> after = new ArrayList<>();
        try (O11yRecorder rec = O11yRecorder.start(b -> b
                .addExtraLogSink(e -> {
                    throw new IllegalStateException("sink down");
                })
                .addExtraLogSink(after::add))) {
            assertDoesNotThrow(() -> rec.telemetry().logger().info("still flows"));
            assertEquals("still flows", after.get(0).message());
            assertEquals("still flows", exported(rec, "still flows").getBodyValue().asString());
        }
    }
}
