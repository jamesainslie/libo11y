package ing.o11y.libo11y.http;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.Telemetry;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.common.export.MemoryMode;
import io.opentelemetry.sdk.metrics.InstrumentType;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.export.CollectionRegistration;
import io.opentelemetry.sdk.metrics.export.MetricReader;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** A hermetic {@link Telemetry} that keeps finished spans and collects metrics on demand. */
final class TestTelemetry implements AutoCloseable {
    private final List<SpanData> spans = new CopyOnWriteArrayList<>();
    private final Reader reader = new Reader();
    final Telemetry telemetry;

    TestTelemetry() {
        SpanExporter exporter = new SpanExporter() {
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
        };
        telemetry = O11y.init(O11yOptions.builder()
                .serviceName("http-test")
                .environment("development")
                .hermetic()
                .runtimeMetrics(false)
                .consoleEnabled(false)
                .addSpanProcessor(SimpleSpanProcessor.create(exporter))
                .metricReader(reader)
                .build());
    }

    List<SpanData> spans() {
        return List.copyOf(spans);
    }

    List<MetricData> metrics() {
        return new ArrayList<>(reader.registration.collectAllMetrics());
    }

    MetricData metric(String name) {
        return metrics().stream()
                .filter(m -> name.equals(m.getName()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no metric " + name + " in " + metrics()));
    }

    @Override
    public void close() {
        telemetry.shutdown();
    }

    private static final class Reader implements MetricReader {
        private volatile CollectionRegistration registration = CollectionRegistration.noop();

        @Override
        public void register(CollectionRegistration registration) {
            this.registration = registration;
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

        @Override
        public MemoryMode getMemoryMode() {
            return MemoryMode.IMMUTABLE_DATA;
        }
    }
}
