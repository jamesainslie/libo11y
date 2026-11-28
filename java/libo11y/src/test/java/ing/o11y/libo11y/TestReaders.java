package ing.o11y.libo11y;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.metrics.InstrumentType;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.metrics.export.CollectionRegistration;
import io.opentelemetry.sdk.metrics.export.MetricReader;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;

/** In-memory readers and exporters shared by the policy tests. */
final class TestReaders {
    private TestReaders() {}

    /** A pull metric reader that collects on demand, with cumulative temporality. */
    static final class CollectingReader implements MetricReader {
        private final AtomicReference<CollectionRegistration> registration = new AtomicReference<>();

        @Override
        public void register(CollectionRegistration reg) {
            registration.set(reg);
        }

        Collection<MetricData> collect() {
            CollectionRegistration reg = registration.get();
            return reg == null ? List.of() : reg.collectAllMetrics();
        }

        List<MetricData> named(String name) {
            List<MetricData> out = new ArrayList<>();
            for (MetricData md : collect()) {
                if (md.getName().equals(name)) {
                    out.add(md);
                }
            }
            return out;
        }

        @Override
        public CompletableResultCode forceFlush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public AggregationTemporality getAggregationTemporality(InstrumentType instrumentType) {
            return AggregationTemporality.CUMULATIVE;
        }
    }

    /** A span exporter that keeps every exported span. */
    static final class CollectingSpanExporter implements SpanExporter {
        final List<SpanData> spans = new CopyOnWriteArrayList<>();

        @Override
        public CompletableResultCode export(Collection<SpanData> batch) {
            spans.addAll(batch);
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode flush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            return CompletableResultCode.ofSuccess();
        }
    }

    /** Options for a hermetic, valid identity with the console written to a buffer. */
    static O11yOptions.Builder baseOptions(CollectingReader reader) {
        return O11yOptions.builder()
                .hermetic()
                .serviceName("policy-test")
                .environment("test")
                .serviceVersion("1.2.3")
                .consoleOutput(new ByteArrayOutputStream())
                .runtimeMetrics(false)
                .metricReader(reader);
    }

    /** Every point of every stream named name. */
    static List<PointData> points(CollectingReader reader, String name) {
        List<PointData> out = new ArrayList<>();
        for (MetricData md : reader.named(name)) {
            out.addAll(md.getData().getPoints());
        }
        return out;
    }

    /** Sums the o11y.schema.violations points that match signal and rule. */
    static long violations(CollectingReader reader, String signal, String rule) {
        long total = 0;
        for (PointData p : points(reader, "o11y.schema.violations")) {
            Attributes a = p.getAttributes();
            if (signal.equals(a.get(AttributeKey.stringKey("o11y.signal")))
                    && rule.equals(a.get(AttributeKey.stringKey("o11y.rule")))) {
                total += ((LongPointData) p).getValue();
            }
        }
        return total;
    }
}
