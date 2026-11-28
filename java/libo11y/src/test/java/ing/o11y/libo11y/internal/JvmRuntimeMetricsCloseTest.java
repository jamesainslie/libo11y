package ing.o11y.libo11y.internal;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.MeterProvider;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** Closing the runtime metrics closes every registration and reports, rather than hides, a failed one. */
class JvmRuntimeMetricsCloseTest {
    /**
     * A meter whose observable instruments count their closes, the first one also failing, and
     * which otherwise behaves like the no-op meter.
     */
    private static Meter failingMeter(AtomicInteger closes) {
        Meter noop = MeterProvider.noop().get("test");
        AtomicInteger built = new AtomicInteger();
        return proxy(Meter.class, (proxy, method, args) -> {
            Object result = invoke(method, noop, args);
            if (!method.getName().equals("upDownCounterBuilder")) {
                return result;
            }
            Object builder = result;
            return proxy(method.getReturnType(), (bp, bm, bargs) -> {
                Object built0 = invoke(bm, builder, bargs);
                if (built0 == builder) {
                    return bp;
                }
                if (!bm.getName().equals("buildWithCallback")) {
                    return built0;
                }
                boolean fail = built.getAndIncrement() == 0;
                return proxy(bm.getReturnType(), (ip, im, iargs) -> {
                    if (im.getName().equals("close")) {
                        closes.incrementAndGet();
                        if (fail) {
                            throw new IllegalStateException("instrument close failed");
                        }
                        return null;
                    }
                    return invoke(im, built0, iargs);
                });
            });
        });
    }

    private static Object invoke(Method method, Object target, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException ex) {
            throw ex.getCause();
        }
    }

    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler));
    }

    @Test
    void aFailedRegistrationCloseIsReportedAfterTheOthersClose() {
        AtomicInteger closes = new AtomicInteger();
        PolicyBridges.JvmRuntimeMetrics metrics = PolicyBridges.JvmRuntimeMetrics.register(failingMeter(closes));

        IllegalStateException thrown = assertThrows(IllegalStateException.class, metrics::close);
        assertEquals("instrument close failed", thrown.getMessage());
        assertEquals(3, closes.get(), "every observable instrument is closed even after one fails");

        assertDoesNotThrow(metrics::close, "a second close has nothing left to close");
        assertEquals(3, closes.get());
    }
}
