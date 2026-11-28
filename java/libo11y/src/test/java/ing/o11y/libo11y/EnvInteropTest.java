package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import ing.o11y.libo11y.internal.O11yEnvParser;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapSetter;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.metrics.InstrumentType;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

/** The standard OTEL_* environment surface (G4) and the processor-only pipelines (G6). */
class EnvInteropTest {
    private static O11yOptions.Builder envOptions(Map<String, String> env) {
        return O11yOptions.builder()
                .env(env)
                .serviceName("env-interop")
                .environment("test")
                .serviceVersion("1.0.0")
                .consoleOutput(new ByteArrayOutputStream())
                .runtimeMetrics(false);
    }

    /** Every signal off unless a test turns one on, so no test exports to a real collector. */
    private static Map<String, String> quiet(String... pairs) {
        Map<String, String> env = new HashMap<>();
        env.put("OTEL_TRACES_EXPORTER", "none");
        env.put("OTEL_METRICS_EXPORTER", "none");
        env.put("OTEL_LOGS_EXPORTER", "none");
        for (int i = 0; i < pairs.length; i += 2) {
            env.put(pairs[i], pairs[i + 1]);
        }
        return env;
    }

    private static final class Captured extends Handler {
        final List<LogRecord> records = new CopyOnWriteArrayList<>();

        @Override
        public void publish(LogRecord record) {
            records.add(record);
        }

        @Override
        public void flush() {}

        @Override
        public void close() {}
    }

    // (b) console exporters and exporter lists

    @Test
    void consoleTracesAreBuiltAndReported() {
        Logger jul = Logger.getLogger("io.opentelemetry.exporter.logging.LoggingSpanExporter");
        Captured captured = new Captured();
        jul.addHandler(captured);
        try {
            Telemetry t = O11y.init(envOptions(quiet("OTEL_TRACES_EXPORTER", "console")).build());
            assertEquals("console", t.effectiveConfig().get("o11y.config.traces"));
            t.tracer("console").spanBuilder("printed").startSpan().end();
            assertTrue(t.shutdown(Duration.ofSeconds(5)).isOk());
            assertTrue(captured.records.stream().anyMatch(r -> String.valueOf(r.getMessage()).contains("printed")
                            || String.valueOf(java.util.Arrays.toString(r.getParameters())).contains("printed")),
                    "no console span: " + captured.records.size());
        } finally {
            jul.removeHandler(captured);
        }
    }

    @Test
    void consoleMetricsAndLogsAreBuilt() {
        Logger jul = Logger.getLogger("io.opentelemetry.exporter.logging.LoggingMetricExporter");
        Captured captured = new Captured();
        jul.addHandler(captured);
        PrintStream out = System.out;
        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        System.setOut(new PrintStream(stdout, true, StandardCharsets.UTF_8));
        try {
            Telemetry t = O11y.init(envOptions(quiet(
                            "OTEL_METRICS_EXPORTER", "console",
                            "OTEL_LOGS_EXPORTER", "console"))
                    .build());
            assertEquals("console", t.effectiveConfig().get("o11y.config.metrics"));
            assertEquals("console", t.effectiveConfig().get("o11y.config.logs"));
            t.meter("console").counterBuilder("console.counter").build().add(1);
            t.logger().info("console record");
            assertTrue(t.shutdown(Duration.ofSeconds(5)).isOk());
        } finally {
            System.setOut(out);
            jul.removeHandler(captured);
        }
        assertFalse(captured.records.isEmpty(), "no console metrics");
        assertTrue(stdout.toString(StandardCharsets.UTF_8).contains("console record"),
                stdout.toString(StandardCharsets.UTF_8));
    }

    @Test
    void anExporterListBuildsEveryExporter() {
        Telemetry t = O11y.init(envOptions(quiet(
                        "OTEL_TRACES_EXPORTER", "otlp, console",
                        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:9/v1/traces"))
                .build());
        try {
            assertEquals("otlp,console", t.effectiveConfig().get("o11y.config.traces"));
        } finally {
            t.shutdown(Duration.ofMillis(200));
        }
    }

    @Test
    void anUnknownExporterOrNoneInAListIsATypedError() {
        for (String value : List.of("zipkin", "otlp,zipkin", "none,otlp", "prometheus")) {
            O11yException ex = assertThrows(O11yException.class,
                    () -> O11y.init(envOptions(quiet("OTEL_TRACES_EXPORTER", value)).build()), value);
            assertEquals(O11yException.ErrorCode.EXPORTER, ex.code(), value);
        }
    }

    // (c) percent decoding only

    @Test
    void resourceAttributesAndHeadersKeepPlusSigns() throws Exception {
        assertEquals(Map.of("token", "a+b/c==", "v", "1.0.0+build", "s", "a b,c", "u", "é"),
                O11yEnvParser.parseKeyValuePairs("token=a+b/c==,v=1.0.0+build,s=a%20b%2Cc,u=%C3%A9"));
        assertEquals(Map.of("e", "\uD83D\uDE00 x"), O11yEnvParser.parseKeyValuePairs("e=\uD83D\uDE00%20x"));

        Telemetry t = O11y.init(envOptions(quiet("OTEL_RESOURCE_ATTRIBUTES", "team=a+b,service.namespace=x%2By"))
                .serviceVersion(null)
                .build());
        try {
            assertEquals("a+b", t.resource().getAttribute(AttributeKey.stringKey("team")));
            assertEquals("x+y", t.resource().getAttribute(AttributeKey.stringKey("service.namespace")));
        } finally {
            t.shutdown();
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        List<String> auth = new CopyOnWriteArrayList<>();
        server.createContext("/v1/traces", exchange -> {
            auth.add(exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        try {
            Telemetry otlp = O11y.init(envOptions(quiet(
                            "OTEL_TRACES_EXPORTER", "otlp",
                            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                            "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/traces",
                            "OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic dXNlcjpw+YXNz"))
                    .build());
            otlp.tracer("headers").spanBuilder("h").startSpan().end();
            assertTrue(otlp.shutdown(Duration.ofSeconds(5)).isOk());
        } finally {
            server.stop(0);
        }
        assertEquals(List.of("Basic dXNlcjpw+YXNz"), auth);
    }

    // (d) code options win without parsing the environment they override

    @Test
    void anExplicitOptionIgnoresTheInvalidVariableItOverrides() {
        Map<String, String> env = quiet(
                "OTEL_TRACES_SAMPLER", "bogus",
                "OTEL_METRICS_EXEMPLAR_FILTER", "bogus",
                "OTEL_PROPAGATORS", "bogus");
        env.put("OTEL_TRACES_EXPORTER", "bogus");
        env.put("OTEL_METRICS_EXPORTER", "bogus");
        env.put("OTEL_LOGS_EXPORTER", "bogus");
        env.put("OTEL_EXPORTER_OTLP_ENDPOINT", "not a url");
        Telemetry t = O11y.init(envOptions(env)
                .sampler(Sampler.alwaysOn())
                .exemplarFilter(ExemplarFilterMode.ALWAYS_OFF)
                .propagators(List.of(io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator.getInstance()))
                .spanExporter(new TestParts.StoppableSpanExporter())
                .metricReader(new TestParts.StoppableReader())
                .logRecordExporter(new TestParts.StoppableLogExporter())
                .build());
        assertTrue(t.shutdown().isOk());
        for (String key : List.of("OTEL_TRACES_SAMPLER", "OTEL_METRICS_EXEMPLAR_FILTER", "OTEL_PROPAGATORS")) {
            O11yException ex = assertThrows(O11yException.class,
                    () -> O11y.init(envOptions(quiet(key, "bogus")).build()), key);
            assertEquals(O11yException.ErrorCode.INVALID_OPTION, ex.code(), key);
        }
    }

    // (e) OTEL_SDK_DISABLED

    @Test
    void theKillSwitchRecordsNothingKeepsPropagationAndStopsInjectedParts() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter();
        TestParts.StoppableSpanProcessor processor = new TestParts.StoppableSpanProcessor();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter();
        TestParts.StoppableLogProcessor logProcessor = new TestParts.StoppableLogProcessor();
        Telemetry t = O11y.init(envOptions(Map.of(
                        "OTEL_SDK_DISABLED", "TRUE",
                        "OTEL_TRACES_EXPORTER", "bogus",
                        "OTEL_EXPORTER_OTLP_ENDPOINT", "not a url"))
                .spanExporter(spans)
                .addSpanProcessor(processor)
                .metricReader(reader)
                .logRecordExporter(logs)
                .addLogRecordProcessor(logProcessor)
                .build());

        SpanContext remote = SpanContext.createFromRemoteParent(
                "0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", TraceFlags.getSampled(), TraceState.getDefault());
        Context parent = Context.root().with(Span.wrap(remote));
        for (Span span : List.of(
                t.tracer("off").spanBuilder("a").setParent(parent).startSpan(),
                t.openTelemetry().getTracer("off").spanBuilder("b").setParent(parent).startSpan(),
                t.sdkTracerProvider().get("off").spanBuilder("c").setParent(parent).startSpan())) {
            assertFalse(span.isRecording(), "a disabled SDK recorded a span");
            assertEquals(remote.getTraceId(), span.getSpanContext().getTraceId());
            span.end();
        }
        Span child = t.tracer("off").spanBuilder("d").setParent(parent).startSpan();
        Map<String, String> carrier = new HashMap<>();
        TextMapSetter<Map<String, String>> setter = Map::put;
        t.propagators().getTextMapPropagator().inject(parent.with(child), carrier, setter);
        assertTrue(carrier.get("traceparent").contains(remote.getTraceId()), "" + carrier);
        t.logger().info("not exported");

        assertTrue(t.shutdown().isOk());
        assertEquals(0, processor.ended.get());
        assertEquals(0, logProcessor.emitted.get());
        assertTrue(reader.shutdownCalled(), "metric reader");
        assertTrue(spans.shutdownCalled(), "span exporter");
        assertTrue(processor.shutdownCalled(), "span processor");
        assertTrue(logs.shutdownCalled(), "log exporter");
        assertTrue(logProcessor.shutdownCalled(), "log processor");
        assertEquals("none", t.effectiveConfig().get("o11y.config.traces"));
    }

    // (f) batch, limit, timeout, temporality and propagator variables Go honours

    @Test
    void batchVariablesShapeTheBatchesOfBothBatchProcessors() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter();
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter();
        Telemetry t = O11y.init(envOptions(quiet(
                        "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "1",
                        "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", "1"))
                .spanExporter(spans)
                .logRecordExporter(logs)
                .build());
        for (int i = 0; i < 3; i++) {
            t.tracer("bsp").spanBuilder("s" + i).startSpan().end();
            t.logger().info("r" + i);
        }
        assertTrue(t.shutdown(Duration.ofSeconds(5)).isOk());
        assertEquals(3, spans.batches.size(), "span batches");
        assertTrue(spans.batches.stream().allMatch(b -> b.size() == 1));
        assertTrue(logs.batches.size() >= 3, "log batches: " + logs.batches.size());
        assertTrue(logs.batches.stream().allMatch(b -> b.size() == 1));
    }

    @Test
    void theScheduleDelayVariableExportsWithoutAFlush() throws InterruptedException {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter();
        Telemetry t = O11y.init(envOptions(quiet("OTEL_BSP_SCHEDULE_DELAY", "20")).spanExporter(spans).build());
        try {
            t.tracer("bsp").spanBuilder("soon").startSpan().end();
            long deadline = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            while (spans.spanCount() == 0 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            assertEquals(1, spans.spanCount());
        } finally {
            t.shutdown();
        }
    }

    @Test
    void spanAndLogRecordLimitsApply() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter();
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter();
        Telemetry t = O11y.init(envOptions(quiet(
                        "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "1",
                        "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT", "3",
                        "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "1"))
                .spanExporter(spans)
                .logRecordExporter(logs)
                .build());
        t.tracer("limits").spanBuilder("l")
                .setAllAttributes(Attributes.of(
                        AttributeKey.stringKey("http.route"), "/abcdef",
                        AttributeKey.stringKey("http.request.method"), "GET"))
                .startSpan()
                .end();
        t.loggerProvider().get("limits").logRecordBuilder()
                .setBody("limited")
                .setAttribute(AttributeKey.stringKey("http.route"), "/a")
                .setAttribute(AttributeKey.stringKey("http.request.method"), "GET")
                .emit();
        assertTrue(t.shutdown(Duration.ofSeconds(5)).isOk());
        SpanData span = spans.batches.get(0).iterator().next();
        assertEquals(1, span.getAttributes().size(), "" + span.getAttributes());
        span.getAttributes().forEach((k, v) -> assertTrue(String.valueOf(v).length() <= 3, k + "=" + v));
        LogRecordData record = logs.batches.stream().flatMap(b -> b.stream())
                .filter(r -> "limited".equals(r.getBodyValue() == null ? null : r.getBodyValue().asString()))
                .findFirst()
                .orElseThrow();
        assertEquals(1, record.getAttributes().size(), "" + record.getAttributes());
    }

    @Test
    void exportTimeoutAndTemporalityVariablesAreRead() {
        O11yEnvParser.ParsedEnv env = O11yEnvParser.parse(Map.of(
                "OTEL_METRIC_EXPORT_TIMEOUT", "1500",
                "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "Delta"));
        assertEquals(Duration.ofMillis(1500), env.metricExportTimeout());
        O11yEnvParser.SignalConfig metrics = env.otlp(O11yEnvParser.METRICS);
        assertEquals(AggregationTemporality.DELTA, metrics.temporality().getAggregationTemporality(InstrumentType.COUNTER));
        assertEquals(AggregationTemporality.CUMULATIVE,
                metrics.temporality().getAggregationTemporality(InstrumentType.UP_DOWN_COUNTER));
        assertEquals(AggregationTemporality.CUMULATIVE, O11yEnvParser.parse(Map.of()).otlp(O11yEnvParser.METRICS)
                .temporality().getAggregationTemporality(InstrumentType.COUNTER));
        assertNull(O11yEnvParser.parse(Map.of()).metricExportTimeout());
        O11yException ex = assertThrows(O11yException.class, () -> O11yEnvParser.parse(Map.of(
                "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", "sideways")).otlp(O11yEnvParser.METRICS));
        assertEquals(O11yException.ErrorCode.INVALID_OPTION, ex.code());
    }

    @Test
    void thePropagatorsVariableSelectsThePropagators() {
        SpanContext sc = SpanContext.create(
                "0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", TraceFlags.getSampled(), TraceState.getDefault());
        Context ctx = Context.root().with(Span.wrap(sc));
        TextMapSetter<Map<String, String>> setter = Map::put;

        Telemetry b3 = O11y.init(envOptions(quiet("OTEL_PROPAGATORS", " b3 , tracecontext ")).build());
        Map<String, String> carrier = new HashMap<>();
        b3.propagators().getTextMapPropagator().inject(ctx, carrier, setter);
        assertTrue(carrier.containsKey("b3"), "" + carrier);
        assertTrue(carrier.containsKey("traceparent"), "" + carrier);
        String fields = String.valueOf(b3.effectiveConfig().get("o11y.config.propagators"));
        assertTrue(fields.startsWith("b3,") && fields.endsWith(",traceparent,tracestate"), fields);
        b3.shutdown();

        Telemetry none = O11y.init(envOptions(quiet("OTEL_PROPAGATORS", "none")).build());
        Map<String, String> empty = new HashMap<>();
        none.propagators().getTextMapPropagator().inject(ctx, empty, setter);
        assertEquals(Map.of(), empty);
        assertEquals("none", none.effectiveConfig().get("o11y.config.propagators"));
        none.shutdown();

        for (String value : List.of("xray", "jaeger", "ottrace", "tracecontext,bogus", "TraceContext")) {
            O11yException ex = assertThrows(O11yException.class,
                    () -> O11y.init(envOptions(quiet("OTEL_PROPAGATORS", value)).build()), value);
            assertEquals(O11yException.ErrorCode.INVALID_OPTION, ex.code(), value);
        }
    }

    // G6 (a): processors alone own the export path

    @Test
    void injectedProcessorsAloneBuildNoEnvironmentExporter() {
        Map<String, String> env = Map.of("OTEL_EXPORTER_OTLP_ENDPOINT", "not a url");
        Telemetry t = O11y.init(envOptions(env)
                .addSpanProcessor(new TestParts.StoppableSpanProcessor())
                .addLogRecordProcessor(new TestParts.StoppableLogProcessor())
                .metricReader(new TestParts.StoppableReader())
                .build());
        try {
            assertEquals("injected", t.effectiveConfig().get("o11y.config.traces"));
            assertEquals("injected", t.effectiveConfig().get("o11y.config.metrics"));
            assertEquals("injected", t.effectiveConfig().get("o11y.config.logs"));
            assertNotEquals("otlp", t.effectiveConfig().get("o11y.config.traces"));
        } finally {
            t.shutdown();
        }
    }
}
