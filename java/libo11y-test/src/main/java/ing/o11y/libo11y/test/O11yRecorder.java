package ing.o11y.libo11y.test;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.metrics.data.DoublePointData;
import io.opentelemetry.sdk.metrics.data.ExemplarData;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Hermetic in-memory test recorder for traces, metrics (including exemplars), logs, and console JSON.
 * Never reads ambient {@code OTEL_*} environment variables or touches process globals.
 */
public final class O11yRecorder implements AutoCloseable {
    public record RecordedExemplar(String metricName, String traceId, String spanId, double value) {}

    private final InMemorySpanExporter spanExporter;
    private final InMemoryMetricReader metricReader;
    private final InMemoryLogRecordExporter logExporter;
    private final ByteArrayOutputStream consoleBuffer;
    private final List<StructuredLogger.LogEntry> entries;
    private final List<RecordedExemplar> accumulatedExemplars = new CopyOnWriteArrayList<>();
    private final Telemetry telemetry;

    private O11yRecorder(
            InMemorySpanExporter spanExporter,
            InMemoryMetricReader metricReader,
            InMemoryLogRecordExporter logExporter,
            ByteArrayOutputStream consoleBuffer,
            List<StructuredLogger.LogEntry> entries,
            Telemetry telemetry) {
        this.spanExporter = spanExporter;
        this.metricReader = metricReader;
        this.logExporter = logExporter;
        this.consoleBuffer = consoleBuffer;
        this.entries = entries;
        this.telemetry = telemetry;
    }

    public static O11yRecorder start() {
        return start(b -> {});
    }

    public static O11yRecorder start(Consumer<O11yOptions.Builder> customizer) {
        InMemorySpanExporter spanExporter = InMemorySpanExporter.create();
        InMemoryMetricReader metricReader = InMemoryMetricReader.create();
        InMemoryLogRecordExporter logExporter = InMemoryLogRecordExporter.create();
        ByteArrayOutputStream consoleBuffer = new ByteArrayOutputStream();
        List<StructuredLogger.LogEntry> entries = new CopyOnWriteArrayList<>();

        O11yOptions.Builder builder = O11yOptions.builder()
                .serviceName("test-service")
                .environment(Spec.DeploymentEnvironment.TEST)
                .env(O11yEnv.HERMETIC)
                .runtimeMetrics(false)
                .consoleOutput(consoleBuffer)
                .addSpanProcessor(SimpleSpanProcessor.create(spanExporter))
                .metricReader(metricReader)
                .addLogRecordProcessor(SimpleLogRecordProcessor.create(logExporter))
                .addExtraLogSink(entries::add);

        if (customizer != null) {
            customizer.accept(builder);
        }
        Telemetry telemetry = O11y.init(builder.build());
        return new O11yRecorder(spanExporter, metricReader, logExporter, consoleBuffer, entries, telemetry);
    }

    /** Creates an O11yRecorder wrapping pre-created in-memory exporters (useful for Spring Boot test configs). */
    public static O11yRecorder attach(
            InMemorySpanExporter spanExporter,
            InMemoryMetricReader metricReader,
            InMemoryLogRecordExporter logExporter,
            ByteArrayOutputStream consoleBuffer,
            List<StructuredLogger.LogEntry> entries,
            Telemetry telemetry) {
        return new O11yRecorder(spanExporter, metricReader, logExporter, consoleBuffer, entries, telemetry);
    }

    public Telemetry telemetry() {
        return telemetry;
    }

    public InMemorySpanExporter spanExporter() {
        return spanExporter;
    }

    public InMemoryMetricReader metricReader() {
        return metricReader;
    }

    public InMemoryLogRecordExporter logExporter() {
        return logExporter;
    }

    public void forceFlush() {
        telemetry.forceFlush(Duration.ofSeconds(2));
    }

    public List<SpanData> spans() {
        return List.copyOf(spanExporter.getFinishedSpanItems());
    }

    public List<MetricData> metrics() {
        Collection<MetricData> collected = metricReader.collectAllMetrics();
        List<MetricData> list = List.copyOf(collected);
        captureExemplars(list);
        return list;
    }

    private void captureExemplars(Collection<MetricData> collected) {
        for (MetricData md : collected) {
            for (PointData pt : md.getData().getPoints()) {
                for (ExemplarData ex : pt.getExemplars()) {
                    var sc = ex.getSpanContext();
                    double val = 0.0;
                    if (ex instanceof io.opentelemetry.sdk.metrics.data.DoubleExemplarData dex) {
                        val = dex.getValue();
                    } else if (ex instanceof io.opentelemetry.sdk.metrics.data.LongExemplarData lex) {
                        val = lex.getValue();
                    }
                    accumulatedExemplars.add(new RecordedExemplar(
                            md.getName(),
                            sc.isValid() ? sc.getTraceId() : "",
                            sc.isValid() ? sc.getSpanId() : "",
                            val));
                }
            }
        }
    }

    public List<LogRecordData> logs() {
        return List.copyOf(logExporter.getFinishedLogRecordItems());
    }

    public List<StructuredLogger.LogEntry> entries() {
        return List.copyOf(entries);
    }

    public List<String> consoleLines() {
        String raw = consoleBuffer.toString(StandardCharsets.UTF_8);
        if (raw.isEmpty()) {
            return List.of();
        }
        return Arrays.stream(raw.split("\n")).filter(s -> !s.isEmpty()).toList();
    }

    public List<RecordedExemplar> exemplars() {
        metrics();
        return List.copyOf(accumulatedExemplars);
    }

    public void reset() {
        spanExporter.reset();
        logExporter.reset();
        entries.clear();
        accumulatedExemplars.clear();
        consoleBuffer.reset();
        metricReader.collectAllMetrics(); // drain any prior exemplars
    }

    /** Asserts schema URL, tier-0 identity, and zero leaked SECRET attributes across all signals. */
    public void assertConforms() {
        Resource res = telemetry.resource();
        if (!Spec.SCHEMA_URL.equals(res.getSchemaUrl())) {
            throw new AssertionError("resource schema URL = " + res.getSchemaUrl() + ", want " + Spec.SCHEMA_URL);
        }
        Attributes resAttrs = res.getAttributes();
        for (String req : SpecTables.REQUIRED_TIER0) {
            String val = resAttrs.get(AttributeKey.stringKey(req));
            if (val == null || val.isEmpty()) {
                throw new AssertionError("missing required tier-0 resource attribute: " + req);
            }
        }
        String env = resAttrs.get(AttributeKey.stringKey("deployment.environment.name"));
        if (!SpecTables.ENVIRONMENT_VALUES.contains(env)) {
            throw new AssertionError("unexpected deployment.environment.name: " + env);
        }

        // Verify no SECRET attribute leaked onto any span, log, or metric
        for (SpanData sp : spans()) {
            checkNoSecrets("span:" + sp.getName(), sp.getAttributes());
        }
        for (LogRecordData lr : logs()) {
            checkNoSecrets("log", lr.getAttributes());
        }
        for (MetricData md : metrics()) {
            for (PointData pt : md.getData().getPoints()) {
                checkNoSecrets("metric:" + md.getName(), pt.getAttributes());
                if (pt instanceof LongPointData || pt instanceof DoublePointData || pt instanceof HistogramPointData) {
                    pt.getAttributes().forEach((k, v) -> {
                        if (telemetry.policy().isMetricDisallowed(k.getKey())) {
                            throw new AssertionError("disallowed metric attribute leaked: " + k.getKey()
                                    + " on " + md.getName());
                        }
                    });
                }
            }
        }
    }

    private void checkNoSecrets(String surface, Attributes attrs) {
        attrs.forEach((k, v) -> {
            if (telemetry.policy().sensitivityOf(k.getKey()) == SpecTables.Sensitivity.SECRET) {
                throw new AssertionError("secret attribute leaked on " + surface + ": " + k.getKey());
            }
        });
    }

    /** Asserts that at least one span AND one log record share the given trace ID. */
    public void assertCorrelated(String traceId) {
        if (traceId == null || traceId.isEmpty()) {
            throw new AssertionError("traceId must not be empty");
        }
        boolean hasSpan = spans().stream().anyMatch(s -> traceId.equals(s.getTraceId()));
        if (!hasSpan) {
            throw new AssertionError("no span found with traceId=" + traceId);
        }
        boolean hasLog = logs().stream().anyMatch(l -> traceId.equals(l.getSpanContext().getTraceId()));
        if (!hasLog) {
            throw new AssertionError("no OTLP log record found with traceId=" + traceId);
        }
        boolean hasEntry = entries().stream().anyMatch(e -> traceId.equals(e.traceId()));
        if (!hasEntry) {
            throw new AssertionError("no structured log entry found with traceId=" + traceId);
        }
    }

    /** Asserts the full 3-signal reconciliation triangle (span + log + metric exemplar) for {@code traceId}. */
    public void assertTriangle(String traceId) {
        assertCorrelated(traceId);
        boolean hasExemplar = exemplars().stream().anyMatch(ex -> traceId.equals(ex.traceId()));
        if (!hasExemplar) {
            throw new AssertionError("no metric exemplar found with traceId=" + traceId
                    + " (recorded exemplars: " + exemplars() + ")");
        }
    }

    @Override
    public void close() {
        telemetry.close();
    }
}
