package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import ing.o11y.libo11y.internal.ResourceComposer;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.MetricDataType;
import io.opentelemetry.sdk.resources.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ResourceIdentityTest {
    private static String attr(Resource r, String key) {
        return r.getAttribute(AttributeKey.stringKey(key));
    }

    @Test
    void telemetrySdkIdentityIsTheOpenTelemetrySdksAsInGo() {
        Telemetry t = O11y.init(TestReaders.baseOptions(new CollectingReader()).build());
        try {
            Resource res = t.resource();
            Resource otel = Resource.getDefault();
            assertEquals("opentelemetry", attr(res, "telemetry.sdk.name"));
            assertEquals("java", attr(res, "telemetry.sdk.language"));
            assertNotNull(attr(otel, "telemetry.sdk.version"));
            assertEquals(attr(otel, "telemetry.sdk.version"), attr(res, "telemetry.sdk.version"));
        } finally {
            t.shutdown();
        }
    }

    @Test
    void processAndHostAttributesMatchGo() {
        Telemetry t = O11y.init(TestReaders.baseOptions(new CollectingReader()).build());
        try {
            Resource res = t.resource();
            assertNotNull(attr(res, "process.runtime.name"));
            assertNotNull(attr(res, "process.runtime.version"));
            for (String absent : List.of(
                    "process.runtime.description", "process.pid", "host.arch", "os.type",
                    "process.command_line", "process.command_args", "host.id")) {
                assertNull(res.getAttributes().asMap().keySet().stream()
                        .filter(k -> k.getKey().equals(absent)).findFirst().orElse(null), absent);
            }
        } finally {
            t.shutdown();
        }
    }

    @Test
    void containerIdMatchesTheGoCgroupDetector() {
        Map<String, String> cases = new java.util.LinkedHashMap<>();
        cases.put("13:name=systemd:/podruntime/docker/kubepods/docker-dc579f8a8319c8cf7d38e1adf263bc08d23",
                "dc579f8a8319c8cf7d38e1adf263bc08d23");
        cases.put("11:devices:/kubepods.slice/crio-dc679f8a8319c8cf7d38e1adf263bc08d23.scope",
                "dc679f8a8319c8cf7d38e1adf263bc08d23");
        cases.put("1:name=systemd:/pod/d86d75589bf6cc254f3e2cc29debdf85dde404998aa128997a819ff991827356",
                "d86d75589bf6cc254f3e2cc29debdf85dde404998aa128997a819ff991827356");
        cases.put("0::/kubepods/burstable/podABC/cri-containerd:"
                        + "e857a4bf04e0a6b0d3b1b9f3d6e2c1a0f9e8d7c6b5a4938271605f4e3d2c1b0a",
                "e857a4bf04e0a6b0d3b1b9f3d6e2c1a0f9e8d7c6b5a4938271605f4e3d2c1b0a");
        cases.put("0::/docker/abc123", "abc123");
        cases.put("0::/user.slice/abc123 ", "abc123");
        cases.put("0::/aa-bb-cc", "cc");
        cases.forEach((line, want) -> assertEquals(want, ResourceComposer.containerIdFromCgroup(line), line));
        for (String none : List.of("0::/", "0::/init.scope", "no slash here", "0::/a-xyz", "0::/x/aa-zz", "")) {
            assertNull(ResourceComposer.containerIdFromCgroup(none), none);
        }
        assertEquals("beef", ResourceComposer.containerIdFromCgroup("12:cpu:/\n0::/docker/beef\n0::/docker/cafe\n"));
    }

    @Test
    void gcDurationIsAHistogramOfCollectionsWithNameAndAction() throws InterruptedException {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader).runtimeMetrics(true).build());
        try {
            List<MetricData> gc = List.of();
            long deadline = System.nanoTime() + 10_000_000_000L;
            while (System.nanoTime() < deadline) {
                System.gc();
                Thread.sleep(100);
                gc = reader.named("jvm.gc.duration");
                if (!gc.isEmpty() && !gc.get(0).getData().getPoints().isEmpty()) {
                    break;
                }
            }
            assertEquals(1, gc.size(), "jvm.gc.duration stream");
            MetricData md = gc.get(0);
            assertEquals(MetricDataType.HISTOGRAM, md.getType());
            assertEquals("s", md.getUnit());
            assertFalse(md.getHistogramData().getPoints().isEmpty());
            for (HistogramPointData p : md.getHistogramData().getPoints()) {
                assertNotNull(p.getAttributes().get(AttributeKey.stringKey("jvm.gc.name")));
                assertNotNull(p.getAttributes().get(AttributeKey.stringKey("jvm.gc.action")));
                assertTrue(p.getCount() > 0);
            }
            assertEquals(List.of(0.01, 0.1, 1.0, 10.0), md.getHistogramData().getPoints().iterator().next()
                    .getBoundaries());

            MetricData used = reader.named("jvm.memory.used").get(0);
            assertEquals(MetricDataType.LONG_SUM, used.getType());
            assertFalse(used.getLongSumData().isMonotonic());
            assertEquals("By", used.getUnit());
            MetricData threads = reader.named("jvm.thread.count").get(0);
            assertEquals(MetricDataType.LONG_SUM, threads.getType());
            assertEquals("{thread}", threads.getUnit());
        } finally {
            t.shutdown();
        }
    }
}
