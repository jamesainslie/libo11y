package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.BatchCallback;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.ObservableDoubleMeasurement;
import io.opentelemetry.api.metrics.ObservableLongMeasurement;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.metrics.InstrumentSelector;
import io.opentelemetry.sdk.metrics.SdkMeterProvider;
import io.opentelemetry.sdk.metrics.View;
import io.opentelemetry.sdk.metrics.data.DoublePointData;
import io.opentelemetry.sdk.metrics.data.ExemplarData;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.PointData;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class MetricPolicyTest {
    private static final AttributeKey<String> SECRET = AttributeKey.stringKey("http.request.header.authorization");
    private static final AttributeKey<String> PII = AttributeKey.stringKey("host.ip");
    private static final AttributeKey<String> ROUTE = AttributeKey.stringKey("http.route");
    private static final AttributeKey<String> OTHER = AttributeKey.stringKey("app.other");
    private static final Attributes RAW = Attributes.of(SECRET, "Bearer s3cr3t", PII, "10.0.0.1", ROUTE, "/a", OTHER, "x");
    private static final byte[] KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    @AfterEach
    void reset() {
        O11y.resetForTesting();
    }

    private static void assertClean(PointData p) {
        assertNull(p.getAttributes().get(SECRET), "secret on data point: " + p.getAttributes());
        assertNull(p.getAttributes().get(PII), "pii on data point: " + p.getAttributes());
        for (ExemplarData ex : p.getExemplars()) {
            assertNull(ex.getFilteredAttributes().get(SECRET), "secret on exemplar: " + ex);
            assertNull(ex.getFilteredAttributes().get(PII), "pii on exemplar: " + ex);
        }
    }

    @Test
    void telemetryExposesNoUnfilteredMeterProvider() {
        for (Method m : Telemetry.class.getMethods()) {
            if (!Modifier.isPublic(m.getModifiers())) {
                continue;
            }
            Class<?> rt = m.getReturnType();
            assertFalse(SdkMeterProvider.class.isAssignableFrom(rt), "public raw meter provider: " + m);
            assertFalse(OpenTelemetrySdk.class.isAssignableFrom(rt), "public raw OpenTelemetrySdk: " + m);
        }
    }

    @Test
    void everyPublicMeterPathAppliesThePolicyToPointsAndExemplars() {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.setup(TestReaders.baseOptions(reader)
                .exemplarFilter(ExemplarFilterMode.ALWAYS_ON)
                .build());
        Map<String, Function<String, Meter>> paths = Map.of(
                "meter", t::meter,
                "meterProvider", name -> t.meterProvider().get(name),
                "openTelemetry", name -> t.openTelemetry().getMeterProvider().get(name),
                "global", name -> GlobalOpenTelemetry.getMeterProvider().get(name));
        paths.forEach((path, meter) -> {
            meter.apply("scope." + path).counterBuilder("path." + path).build().add(1, RAW);
            meter.apply("scope." + path).histogramBuilder("hist." + path).build().record(2.5, RAW);
        });
        for (String path : paths.keySet()) {
            List<PointData> counter = TestReaders.points(reader, "path." + path);
            List<PointData> hist = TestReaders.points(reader, "hist." + path);
            assertEquals(1, counter.size(), path);
            assertEquals(1, hist.size(), path);
            assertClean(counter.get(0));
            assertClean(hist.get(0));
            assertEquals("/a", counter.get(0).getAttributes().get(ROUTE), path);
        }
    }

    @Test
    void addedViewsApplyAndStillEnforceThePolicyOnExemplars() {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader)
                .exemplarFilter(ExemplarFilterMode.ALWAYS_ON)
                .addView(
                        InstrumentSelector.builder().setName("viewed").build(),
                        View.builder().setName("viewed.renamed").setAttributeFilter(Set.of("http.route")).build())
                .build());
        try {
            t.meter("views").histogramBuilder("viewed").build().record(1.0, RAW);
            List<PointData> pts = TestReaders.points(reader, "viewed.renamed");
            assertEquals(1, pts.size());
            HistogramPointData p = (HistogramPointData) pts.get(0);
            assertEquals(Attributes.of(ROUTE, "/a"), p.getAttributes());
            assertClean(p);
            assertFalse(p.getExemplars().isEmpty(), "exemplar expected under always_on");
            assertEquals("x", p.getExemplars().get(0).getFilteredAttributes().get(OTHER));
            assertTrue(reader.named("viewed").isEmpty(), "view replaces the default stream");
        } finally {
            t.shutdown();
        }
    }

    @Test
    void piiOnMetricsFollowsTheModeKeepAllowsHashAndDropDrop() {
        for (PiiMode mode : PiiMode.values()) {
            CollectingReader reader = new CollectingReader();
            O11yOptions.Builder b = TestReaders.baseOptions(reader).piiMode(mode);
            if (mode == PiiMode.HASH) {
                b.piiHashKey(KEY);
            }
            Telemetry t = O11y.init(b.build());
            try {
                t.meter("pii").counterBuilder("pii.count").build().add(1, RAW);
                PointData p = TestReaders.points(reader, "pii.count").get(0);
                assertNull(p.getAttributes().get(SECRET), mode.name());
                if (mode == PiiMode.KEEP) {
                    assertEquals("10.0.0.1", p.getAttributes().get(PII), mode.name());
                    assertFalse(t.policy().isMetricDisallowed("host.ip"));
                } else {
                    assertNull(p.getAttributes().get(PII), mode.name());
                    assertTrue(t.policy().isMetricDisallowed("host.ip"));
                }
                assertTrue(t.policy().isMetricDisallowed("http.request.header.authorization"));
            } finally {
                t.shutdown();
            }
        }
    }

    @Test
    void batchCallbackRecordsThroughThePolicy() {
        CollectingReader reader = new CollectingReader();
        Telemetry t = O11y.init(TestReaders.baseOptions(reader).build());
        try {
            Meter meter = t.meter("batch");
            ObservableLongMeasurement a = meter.counterBuilder("batch.a").buildObserver();
            ObservableDoubleMeasurement g = meter.gaugeBuilder("batch.g").buildObserver();
            try (BatchCallback cb = meter.batchCallback(() -> {
                a.record(3, RAW);
                g.record(1.5, RAW);
            }, a, g)) {
                List<PointData> ap = TestReaders.points(reader, "batch.a");
                List<PointData> gp = TestReaders.points(reader, "batch.g");
                assertEquals(1, ap.size());
                assertEquals(1, gp.size());
                assertEquals(3, ((LongPointData) ap.get(0)).getValue());
                assertEquals(1.5, ((DoublePointData) gp.get(0)).getValue());
                assertClean(ap.get(0));
                assertClean(gp.get(0));
            }
        } finally {
            t.shutdown();
        }
    }
}
