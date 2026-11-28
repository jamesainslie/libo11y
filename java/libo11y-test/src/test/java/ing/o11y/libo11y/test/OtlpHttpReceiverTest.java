package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.protobuf.ByteString;
import io.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
import io.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
import io.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
import io.opentelemetry.proto.common.v1.AnyValue;
import io.opentelemetry.proto.common.v1.ArrayValue;
import io.opentelemetry.proto.common.v1.KeyValue;
import io.opentelemetry.proto.common.v1.KeyValueList;
import io.opentelemetry.proto.logs.v1.LogRecord;
import io.opentelemetry.proto.logs.v1.ResourceLogs;
import io.opentelemetry.proto.logs.v1.ScopeLogs;
import io.opentelemetry.proto.metrics.v1.Exemplar;
import io.opentelemetry.proto.metrics.v1.ExponentialHistogram;
import io.opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint;
import io.opentelemetry.proto.metrics.v1.Gauge;
import io.opentelemetry.proto.metrics.v1.Histogram;
import io.opentelemetry.proto.metrics.v1.HistogramDataPoint;
import io.opentelemetry.proto.metrics.v1.Metric;
import io.opentelemetry.proto.metrics.v1.NumberDataPoint;
import io.opentelemetry.proto.metrics.v1.ResourceMetrics;
import io.opentelemetry.proto.metrics.v1.ScopeMetrics;
import io.opentelemetry.proto.metrics.v1.Sum;
import io.opentelemetry.proto.metrics.v1.Summary;
import io.opentelemetry.proto.metrics.v1.SummaryDataPoint;
import io.opentelemetry.proto.trace.v1.ResourceSpans;
import io.opentelemetry.proto.trace.v1.ScopeSpans;
import io.opentelemetry.proto.trace.v1.Span;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.GZIPOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class OtlpHttpReceiverTest {
    private static final String SECRET_KEY = "http.request.header.authorization";
    private static final ByteString TRACE_ID = id("0af7651916cd43dd8448eb211c80319c");
    private static final ByteString SPAN_ID = id("b7ad6b7169203331");

    private final HttpClient http = HttpClient.newHttpClient();
    private OtlpHttpReceiver receiver;

    @BeforeEach
    void startReceiver() throws IOException {
        receiver = OtlpHttpReceiver.start();
    }

    @AfterEach
    void stopReceiver() {
        receiver.close();
        http.close();
    }

    private static ByteString id(String hex) {
        return ByteString.copyFrom(HexFormat.of().parseHex(hex));
    }

    private static KeyValue kv(String key, String value) {
        return KeyValue.newBuilder().setKey(key).setValue(AnyValue.newBuilder().setStringValue(value)).build();
    }

    private int post(String path, String contentType, byte[] body, boolean gzip) throws Exception {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(receiver.endpoint() + path))
                .header("Content-Type", contentType);
        if (gzip) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (GZIPOutputStream gz = new GZIPOutputStream(out)) {
                gz.write(body);
            }
            body = out.toByteArray();
            req.header("Content-Encoding", "gzip");
        }
        return http.send(req.POST(HttpRequest.BodyPublishers.ofByteArray(body)).build(),
                HttpResponse.BodyHandlers.discarding()).statusCode();
    }

    private int postProtobuf(String path, byte[] body) throws Exception {
        return post(path, "application/x-protobuf", body, false);
    }

    private static ExportTraceServiceRequest traces(Span... spans) {
        return ExportTraceServiceRequest.newBuilder()
                .addResourceSpans(ResourceSpans.newBuilder()
                        .addScopeSpans(ScopeSpans.newBuilder().addAllSpans(List.of(spans))))
                .build();
    }

    private static ExportLogsServiceRequest logs(LogRecord... records) {
        return ExportLogsServiceRequest.newBuilder()
                .addResourceLogs(ResourceLogs.newBuilder()
                        .addScopeLogs(ScopeLogs.newBuilder().addAllLogRecords(List.of(records))))
                .build();
    }

    private static ExportMetricsServiceRequest metrics(Metric... metrics) {
        return ExportMetricsServiceRequest.newBuilder()
                .addResourceMetrics(ResourceMetrics.newBuilder()
                        .addScopeMetrics(ScopeMetrics.newBuilder().addAllMetrics(List.of(metrics))))
                .build();
    }

    private static Span span(String name) {
        return Span.newBuilder().setName(name).setTraceId(TRACE_ID).setSpanId(SPAN_ID).build();
    }

    @Test
    void decodesPlainAndGzipProtobuf() throws Exception {
        assertEquals(200, postProtobuf(OtlpHttpReceiver.TRACES_PATH, traces(span("plain")).toByteArray()));
        assertEquals(200, post(OtlpHttpReceiver.TRACES_PATH, "application/x-protobuf",
                traces(span("zipped")).toByteArray(), true));
        assertEquals(List.of("plain", "zipped"), receiver.spans().stream().map(Span::getName).toList());
        assertEquals(2, receiver.traceRequests().size());
        assertEquals(List.of(), receiver.decodeFailures());
        assertEquals("b7ad6b7169203331", OtlpHttpReceiver.hex(receiver.span("zipped").orElseThrow().getSpanId()));
    }

    @Test
    void otlpJsonIsAnsweredWith415AndFailsEveryAssertion() throws Exception {
        assertEquals(415, post(OtlpHttpReceiver.LOGS_PATH, "application/json",
                "{}".getBytes(StandardCharsets.UTF_8), false));
        assertEquals(1, receiver.decodeFailures().size());
        assertEquals(1, receiver.requestsForPath(OtlpHttpReceiver.LOGS_PATH).size());
        AssertionError err = assertThrows(AssertionError.class, () -> receiver.assertNoAttributeKey("any"));
        assertTrue(err.getMessage().contains("was not decoded"), err.getMessage());
    }

    @Test
    void malformedProtobufIsAnsweredWith400() throws Exception {
        assertEquals(400, postProtobuf(OtlpHttpReceiver.METRICS_PATH, new byte[] {0x0a, (byte) 0xff}));
        assertEquals(OtlpHttpReceiver.METRICS_PATH, receiver.decodeFailures().get(0).path());
        assertEquals(List.of(), receiver.metricRequests());
    }

    @Test
    void unknownPathIsAnsweredWith404() throws Exception {
        assertEquals(404, postProtobuf("/v1/profiles", new byte[0]));
        assertEquals(1, receiver.decodeFailures().size());
    }

    @Test
    void metricPointsCoverEveryMetricType() throws Exception {
        Exemplar ex = Exemplar.newBuilder().setTraceId(TRACE_ID).setSpanId(SPAN_ID).setAsDouble(1).build();
        postProtobuf(OtlpHttpReceiver.METRICS_PATH, metrics(
                Metric.newBuilder().setName("g").setGauge(Gauge.newBuilder()
                        .addDataPoints(NumberDataPoint.newBuilder().addExemplars(ex))).build(),
                Metric.newBuilder().setName("s").setSum(Sum.newBuilder()
                        .addDataPoints(NumberDataPoint.newBuilder().addExemplars(ex))).build(),
                Metric.newBuilder().setName("h").setHistogram(Histogram.newBuilder()
                        .addDataPoints(HistogramDataPoint.newBuilder().addExemplars(ex))).build(),
                Metric.newBuilder().setName("e").setExponentialHistogram(ExponentialHistogram.newBuilder()
                        .addDataPoints(ExponentialHistogramDataPoint.newBuilder().addExemplars(ex))).build(),
                Metric.newBuilder().setName("q").setSummary(Summary.newBuilder()
                        .addDataPoints(SummaryDataPoint.newBuilder().addAttributes(kv("k", "v")))).build())
                .toByteArray());
        List<OtlpHttpReceiver.MetricPoint> points = receiver.metricPoints();
        assertEquals(List.of("g", "s", "h", "e", "q"), points.stream().map(OtlpHttpReceiver.MetricPoint::metricName).toList());
        assertEquals(4, points.stream().filter(p -> p.exemplars().size() == 1).count());
        assertEquals("v", OtlpHttpReceiver.attribute(receiver.metricPoints("q").get(0).attributes(), "k").orElseThrow());
    }

    @Test
    void assertNoAttributeKeyFindsANestedKeyOnALogRecord() throws Exception {
        KeyValue grouped = KeyValue.newBuilder().setKey("http")
                .setValue(AnyValue.newBuilder().setKvlistValue(KeyValueList.newBuilder()
                        .addValues(kv("request.header.authorization", "Bearer x"))))
                .build();
        postProtobuf(OtlpHttpReceiver.LOGS_PATH, logs(LogRecord.newBuilder().addAttributes(grouped).build()).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, () -> receiver.assertNoAttributeKey(SECRET_KEY));
        assertTrue(err.getMessage().contains("log record: " + SECRET_KEY + "=Bearer x"), err.getMessage());
        assertDoesNotThrow(() -> receiver.assertNoAttributeKey("http.request.method"));
    }

    @Test
    void assertNoAttributeKeyFindsAnExemplarAttribute() throws Exception {
        Exemplar ex = Exemplar.newBuilder().addFilteredAttributes(kv(SECRET_KEY, "Bearer x")).build();
        postProtobuf(OtlpHttpReceiver.METRICS_PATH, metrics(Metric.newBuilder().setName("m")
                .setHistogram(Histogram.newBuilder().addDataPoints(HistogramDataPoint.newBuilder().addExemplars(ex)))
                .build()).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, () -> receiver.assertNoAttributeKey(SECRET_KEY));
        assertTrue(err.getMessage().contains("metric m exemplar"), err.getMessage());
    }

    @Test
    void assertNoAttributeKeyFindsSpanEventAndLinkAttributes() throws Exception {
        Span s = span("op").toBuilder()
                .addEvents(Span.Event.newBuilder().setName("retry").addAttributes(kv(SECRET_KEY, "a")))
                .addLinks(Span.Link.newBuilder().setTraceId(TRACE_ID).setSpanId(SPAN_ID).addAttributes(kv(SECRET_KEY, "b")))
                .build();
        postProtobuf(OtlpHttpReceiver.TRACES_PATH, traces(s).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, () -> receiver.assertNoAttributeKey(SECRET_KEY));
        assertTrue(err.getMessage().contains("span op event retry"), err.getMessage());
        assertTrue(err.getMessage().contains("span op link"), err.getMessage());
    }

    @Test
    void assertNoAttributeValueFindsArrayElementsBodiesAndNames() throws Exception {
        KeyValue list = KeyValue.newBuilder().setKey("tags").setValue(AnyValue.newBuilder()
                .setArrayValue(ArrayValue.newBuilder().addValues(AnyValue.newBuilder().setStringValue("x-leak-x"))))
                .build();
        postProtobuf(OtlpHttpReceiver.LOGS_PATH, logs(LogRecord.newBuilder()
                .setBody(AnyValue.newBuilder().setStringValue("body leak"))
                .addAttributes(list)
                .build()).toByteArray());
        postProtobuf(OtlpHttpReceiver.TRACES_PATH, traces(span("leak span")).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, () -> receiver.assertNoAttributeValue("leak"));
        assertTrue(err.getMessage().contains("log record: tags"), err.getMessage());
        assertTrue(err.getMessage().contains("log record body"), err.getMessage());
        assertTrue(err.getMessage().contains("span name leak span"), err.getMessage());
        assertDoesNotThrow(() -> receiver.assertNoAttributeValue("absent"));
    }

    @Test
    void assertLogsCorrelatedPassesWhenALogCarriesAnExportedSpansIds() throws Exception {
        postProtobuf(OtlpHttpReceiver.TRACES_PATH, traces(span("op")).toByteArray());
        postProtobuf(OtlpHttpReceiver.LOGS_PATH, logs(
                LogRecord.newBuilder().setTraceId(TRACE_ID).setSpanId(SPAN_ID).build(),
                LogRecord.newBuilder().build()).toByteArray());
        assertDoesNotThrow(receiver::assertLogsCorrelated);
    }

    @Test
    void assertLogsCorrelatedFailsOnAnUnknownSpan() throws Exception {
        postProtobuf(OtlpHttpReceiver.TRACES_PATH, traces(span("op")).toByteArray());
        postProtobuf(OtlpHttpReceiver.LOGS_PATH, logs(LogRecord.newBuilder()
                .setTraceId(TRACE_ID).setSpanId(id("0000000000000001")).build()).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, receiver::assertLogsCorrelated);
        assertTrue(err.getMessage().contains("which no exported span has"), err.getMessage());
    }

    @Test
    void assertLogsCorrelatedFailsWhenNoLogCarriesATraceId() throws Exception {
        postProtobuf(OtlpHttpReceiver.LOGS_PATH, logs(LogRecord.newBuilder().build()).toByteArray());
        AssertionError err = assertThrows(AssertionError.class, receiver::assertLogsCorrelated);
        assertTrue(err.getMessage().contains("no exported log record carries a trace ID"), err.getMessage());
    }
}
