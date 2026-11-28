package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.internal.PolicyBridges;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.ReadWriteLogRecord;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;

/** Only libo11y's own structured logger can tell the policy processor that a record is already classified. */
class LogClassifiedMarkTest {
    private static final AttributeKey<String> AUTH = AttributeKey.stringKey("http.request.header.authorization");

    /** A processor injected through the options, keeping every context it is handed. */
    private static final class ContextCapture implements LogRecordProcessor {
        final List<Context> contexts = new CopyOnWriteArrayList<>();

        @Override
        public void onEmit(Context context, ReadWriteLogRecord logRecord) {
            contexts.add(context);
        }
    }

    private static LogRecordData exported(O11yRecorder rec, String body) {
        return rec.logs().stream()
                .filter(l -> body.equals(l.getBodyValue() == null ? null : l.getBodyValue().asString()))
                .findFirst()
                .orElseThrow();
    }

    @Test
    void theMarkHasNoPublicStaticAccessor() {
        List<Method> leaks = Arrays.stream(PolicyBridges.PolicyLogRecordProcessor.class.getDeclaredMethods())
                .filter(m -> Modifier.isPublic(m.getModifiers()) && Modifier.isStatic(m.getModifiers()))
                .filter(m -> m.getReturnType() == Context.class)
                .toList();
        assertEquals(List.of(), leaks);
    }

    @Test
    void aBridgeRecordReusingTheContextOfALibo11yRecordIsStillClassified() {
        ContextCapture capture = new ContextCapture();
        try (O11yRecorder rec = O11yRecorder.start(b -> b.piiMode(PiiMode.DROP).addLogRecordProcessor(capture))) {
            rec.telemetry().logger().info("own record", Map.of("app.kept", "yes"));
            assertEquals(1, capture.contexts.size());
            Context reached = capture.contexts.get(0);

            rec.telemetry().loggerProvider().get("other.bridge").logRecordBuilder()
                    .setContext(reached)
                    .setBody("forged")
                    .setAttribute(AUTH, "Bearer topsecret")
                    .emit();

            assertNull(exported(rec, "forged").getAttributes().get(AUTH));
            assertEquals("yes", exported(rec, "own record").getAttributes().get(AttributeKey.stringKey("app.kept")));
        }
    }

    @Test
    void ownRecordsAreClassifiedOnceAndKeepTheirTokens() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.piiMode(PiiMode.DROP))) {
            rec.telemetry().logger().info("own secret", Map.of(AUTH.getKey(), "Bearer topsecret", "app.kept", "yes"));
            LogRecordData out = exported(rec, "own secret");
            assertNull(out.getAttributes().get(AUTH));
            assertTrue(out.getAttributes().get(AttributeKey.stringKey("app.kept")).equals("yes"));
        }
    }
}
