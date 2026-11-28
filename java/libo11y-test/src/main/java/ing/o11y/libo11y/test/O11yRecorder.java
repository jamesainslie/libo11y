package ing.o11y.libo11y.test;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.metrics.data.ExemplarData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
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
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/**
 * Hermetic in-memory test recorder for traces, metrics (including exemplars), logs, and console JSON.
 * Never reads ambient {@code OTEL_*} environment variables or touches process globals.
 */
public final class O11yRecorder implements AutoCloseable {
    private static final Duration FLUSH_TIMEOUT = Duration.ofSeconds(2);

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

    /**
     * Flushes the trace and log pipelines, so spans and log records buffered by a batch processor
     * reach their exporters. Metrics are not flushed: the recorder reads them by collecting its
     * in-memory reader, and flushing that reader would run a collection that discards the
     * exemplars recorded since the last one.
     */
    public void forceFlush() {
        CompletableResultCode.ofAll(List.of(
                        telemetry.sdkTracerProvider().forceFlush(),
                        telemetry.sdkLoggerProvider().forceFlush()))
                .join(FLUSH_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
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

    /**
     * Fails if the code under test broke the libo11y specification, listing every problem found in
     * one {@link AssertionError}. It is the consumer-facing conformance gate, and runs the checks of
     * Go's {@code o11ytest.AssertConforms} in the same order:
     * <ol>
     *   <li>the resource carries the schema URL and every required tier-0 attribute;</li>
     *   <li>after a flush, so buffered telemetry is counted, the {@code o11y.schema.violations}
     *       self-metric shows no secret-classified attribute the code under test tried to put on a
     *       span, log record or the resource (the pipeline removed it, but secrets must never be
     *       emitted), and no identity rule that {@code strictIdentity(false)} let startup skip;</li>
     *   <li>no log record or structured log entry carries a secret-classified attribute in the
     *       clear, and every registered event record carries the attributes and templates its
     *       contract in {@link SpecTables#EVENTS} requires;</li>
     *   <li>no span, span event or span link carries a secret-classified attribute in the clear;</li>
     *   <li>no metric data point or exemplar carries an attribute the policy removes from metrics.</li>
     * </ol>
     * Sensitivity comes from the telemetry's policy, so keys an application registry classifies are
     * checked too. The environment is validated by the SDK at startup against the specification
     * values and any {@code extraEnvironments}; a lenient startup that failed it is reported in step 2.
     *
     * @throws AssertionError listing every problem, when any check fails
     */
    public void assertConforms() {
        List<String> problems = new ArrayList<>();
        ConformanceChecks.checkResource(telemetry.resource(), problems);
        forceFlush();
        List<MetricData> collected = metrics();
        ConformanceChecks.checkViolations(collected, problems);
        ConformanceChecks.checkLogs(telemetry.policy(), logs(), entries(), problems);
        ConformanceChecks.checkSpans(telemetry.policy(), spans(), problems);
        ConformanceChecks.checkMetrics(telemetry.policy(), collected, problems);
        if (!problems.isEmpty()) {
            throw new AssertionError("libo11y conformance check failed:\n  - " + String.join("\n  - ", problems));
        }
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
