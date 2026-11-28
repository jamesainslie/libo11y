package ing.o11y.libo11y.test;

import com.google.protobuf.ByteString;
import com.google.protobuf.InvalidProtocolBufferException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest;
import io.opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse;
import io.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
import io.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse;
import io.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
import io.opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse;
import io.opentelemetry.proto.common.v1.AnyValue;
import io.opentelemetry.proto.common.v1.KeyValue;
import io.opentelemetry.proto.logs.v1.LogRecord;
import io.opentelemetry.proto.logs.v1.ResourceLogs;
import io.opentelemetry.proto.logs.v1.ScopeLogs;
import io.opentelemetry.proto.metrics.v1.Exemplar;
import io.opentelemetry.proto.metrics.v1.Metric;
import io.opentelemetry.proto.metrics.v1.ResourceMetrics;
import io.opentelemetry.proto.metrics.v1.ScopeMetrics;
import io.opentelemetry.proto.trace.v1.ResourceSpans;
import io.opentelemetry.proto.trace.v1.ScopeSpans;
import io.opentelemetry.proto.trace.v1.Span;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BiConsumer;
import java.util.zip.GZIPInputStream;

/**
 * In-process OTLP/HTTP receiver on loopback for wire-level export verification.
 *
 * <p>It accepts {@code /v1/traces}, {@code /v1/metrics} and {@code /v1/logs} in the binary
 * protobuf encoding ({@code application/x-protobuf}), plain or gzip-compressed, decodes each body
 * into the OpenTelemetry protobuf types, and answers with an empty export response. A body it
 * cannot decode is answered with HTTP 400, and an OTLP/JSON body with HTTP 415; both are listed by
 * {@link #decodeFailures()}, and every assertion helper fails while any is recorded. There is no
 * OTLP/gRPC receiver.
 *
 * <p>Point an exporter at {@link #endpoint()}, for example through
 * {@code OTEL_EXPORTER_OTLP_ENDPOINT}, shut the SDK down so every batch is sent, then read the
 * typed accessors or call the assertion helpers. The receiver is thread-safe.
 */
public final class OtlpHttpReceiver implements AutoCloseable {
    /** The OTLP/HTTP path for traces. */
    public static final String TRACES_PATH = "/v1/traces";
    /** The OTLP/HTTP path for metrics. */
    public static final String METRICS_PATH = "/v1/metrics";
    /** The OTLP/HTTP path for logs. */
    public static final String LOGS_PATH = "/v1/logs";

    private static final String PROTOBUF = "application/x-protobuf";
    private static final HexFormat HEX = HexFormat.of();

    /**
     * One request as it arrived, with its body already gunzipped.
     *
     * @param path the request path
     * @param contentType the {@code Content-Type} header, or {@code null}
     * @param headers every request header
     * @param body the decompressed request body
     */
    public record CapturedRequest(
            String path,
            String contentType,
            Map<String, List<String>> headers,
            byte[] body) {}

    /**
     * A request the receiver could not decode.
     *
     * @param path the request path
     * @param reason why decoding failed
     */
    public record DecodeFailure(String path, String reason) {}

    /**
     * One exported metric data point of any type, with the metric it belongs to.
     *
     * @param metricName the metric's name
     * @param attributes the point's attributes
     * @param exemplars the point's exemplars; summary points carry none
     */
    public record MetricPoint(String metricName, List<KeyValue> attributes, List<Exemplar> exemplars) {}

    private final HttpServer server;
    private final List<CapturedRequest> requests = new CopyOnWriteArrayList<>();
    private final List<DecodeFailure> failures = new CopyOnWriteArrayList<>();
    private final List<ExportTraceServiceRequest> traceRequests = new CopyOnWriteArrayList<>();
    private final List<ExportMetricsServiceRequest> metricRequests = new CopyOnWriteArrayList<>();
    private final List<ExportLogsServiceRequest> logRequests = new CopyOnWriteArrayList<>();

    private OtlpHttpReceiver(HttpServer server) {
        this.server = server;
    }

    /**
     * Starts a receiver on an ephemeral loopback port.
     *
     * @return the running receiver
     * @throws IOException if the server cannot bind
     */
    public static OtlpHttpReceiver start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        OtlpHttpReceiver receiver = new OtlpHttpReceiver(server);
        server.createContext("/", receiver::handle);
        server.start();
        return receiver;
    }

    /**
     * Returns the base URL to give an OTLP/HTTP exporter, without a signal path.
     *
     * @return the endpoint, such as {@code http://127.0.0.1:43123}
     */
    public String endpoint() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /**
     * Returns every request received so far, decoded or not.
     *
     * @return the captured requests in arrival order
     */
    public List<CapturedRequest> requests() {
        return List.copyOf(requests);
    }

    /**
     * Returns the requests received on one path.
     *
     * @param path the request path, such as {@link #TRACES_PATH}
     * @return the captured requests for that path in arrival order
     */
    public List<CapturedRequest> requestsForPath(String path) {
        return requests.stream().filter(r -> path.equals(r.path())).toList();
    }

    /**
     * Returns the requests that could not be decoded.
     *
     * @return the decode failures in arrival order
     */
    public List<DecodeFailure> decodeFailures() {
        return List.copyOf(failures);
    }

    /**
     * Returns every decoded trace export request.
     *
     * @return the requests in arrival order
     */
    public List<ExportTraceServiceRequest> traceRequests() {
        return List.copyOf(traceRequests);
    }

    /**
     * Returns every decoded metric export request.
     *
     * @return the requests in arrival order
     */
    public List<ExportMetricsServiceRequest> metricRequests() {
        return List.copyOf(metricRequests);
    }

    /**
     * Returns every decoded log export request.
     *
     * @return the requests in arrival order
     */
    public List<ExportLogsServiceRequest> logRequests() {
        return List.copyOf(logRequests);
    }

    /**
     * Returns every exported span across all trace requests.
     *
     * @return the spans in arrival order
     */
    public List<Span> spans() {
        List<Span> out = new ArrayList<>();
        for (ExportTraceServiceRequest req : traceRequests) {
            for (ResourceSpans rs : req.getResourceSpansList()) {
                for (ScopeSpans ss : rs.getScopeSpansList()) {
                    out.addAll(ss.getSpansList());
                }
            }
        }
        return out;
    }

    /**
     * Returns the first exported span with the given name.
     *
     * @param name the span name
     * @return the span, or empty if none was exported
     */
    public Optional<Span> span(String name) {
        return spans().stream().filter(s -> name.equals(s.getName())).findFirst();
    }

    /**
     * Returns every exported log record across all log requests.
     *
     * @return the log records in arrival order
     */
    public List<LogRecord> logRecords() {
        List<LogRecord> out = new ArrayList<>();
        for (ExportLogsServiceRequest req : logRequests) {
            for (ResourceLogs rl : req.getResourceLogsList()) {
                for (ScopeLogs sl : rl.getScopeLogsList()) {
                    out.addAll(sl.getLogRecordsList());
                }
            }
        }
        return out;
    }

    /**
     * Returns every exported metric across all metric requests.
     *
     * @return the metrics in arrival order
     */
    public List<Metric> metrics() {
        List<Metric> out = new ArrayList<>();
        for (ExportMetricsServiceRequest req : metricRequests) {
            for (ResourceMetrics rm : req.getResourceMetricsList()) {
                for (ScopeMetrics sm : rm.getScopeMetricsList()) {
                    out.addAll(sm.getMetricsList());
                }
            }
        }
        return out;
    }

    /**
     * Returns every exported data point of every metric type, each with its exemplars.
     *
     * @return the points in arrival order
     */
    public List<MetricPoint> metricPoints() {
        List<MetricPoint> out = new ArrayList<>();
        for (Metric m : metrics()) {
            String name = m.getName();
            switch (m.getDataCase()) {
                case GAUGE -> m.getGauge().getDataPointsList().forEach(p ->
                        out.add(new MetricPoint(name, p.getAttributesList(), p.getExemplarsList())));
                case SUM -> m.getSum().getDataPointsList().forEach(p ->
                        out.add(new MetricPoint(name, p.getAttributesList(), p.getExemplarsList())));
                case HISTOGRAM -> m.getHistogram().getDataPointsList().forEach(p ->
                        out.add(new MetricPoint(name, p.getAttributesList(), p.getExemplarsList())));
                case EXPONENTIAL_HISTOGRAM -> m.getExponentialHistogram().getDataPointsList().forEach(p ->
                        out.add(new MetricPoint(name, p.getAttributesList(), p.getExemplarsList())));
                case SUMMARY -> m.getSummary().getDataPointsList().forEach(p ->
                        out.add(new MetricPoint(name, p.getAttributesList(), List.of())));
                case DATA_NOT_SET -> { }
            }
        }
        return out;
    }

    /**
     * Returns the exported data points of one metric.
     *
     * @param metricName the metric's name
     * @return its points in arrival order
     */
    public List<MetricPoint> metricPoints(String metricName) {
        return metricPoints().stream().filter(p -> metricName.equals(p.metricName())).toList();
    }

    /**
     * Returns the lowercase hex form of an OTLP trace or span ID, as the OpenTelemetry API prints it.
     *
     * @param id the ID bytes
     * @return the hex string, empty for an empty ID
     */
    public static String hex(ByteString id) {
        return HEX.formatHex(id.toByteArray());
    }

    /**
     * Returns the string form of the top-level attribute named key.
     *
     * @param attributes the attributes to search
     * @param key the attribute key
     * @return the value as a string, or empty if absent
     */
    public static Optional<String> attribute(List<KeyValue> attributes, String key) {
        return attributes.stream()
                .filter(kv -> key.equals(kv.getKey()))
                .findFirst()
                .map(kv -> valueString(kv.getValue()));
    }

    /**
     * Fails unless every request was decoded and no exported attribute, on any resource, scope,
     * span, span event, span link, log record (attributes and a key-value body), metric data point
     * or exemplar, carries {@code key}. Nested key-value lists are checked under their dotted keys.
     *
     * @param key the attribute key that must not be exported
     * @throws AssertionError naming every place the key was found
     */
    public void assertNoAttributeKey(String key) {
        List<String> found = new ArrayList<>();
        forEachAttribute((where, kv) -> walk(where, "", kv, (path, value) -> {
            if (key.equals(path)) {
                found.add(where + ": " + path + "=" + valueString(value));
            }
        }));
        fail("attribute " + key + " was exported", found);
    }

    /**
     * Fails unless every request was decoded and no exported string, in any attribute value at
     * any nesting depth, a log record body, a span name or a span event name, contains
     * {@code needle}.
     *
     * @param needle the text that must not be exported
     * @throws AssertionError naming every place the text was found
     */
    public void assertNoAttributeValue(String needle) {
        List<String> found = new ArrayList<>();
        forEachAttribute((where, kv) -> walk(where, "", kv, (path, value) -> {
            if (value.hasStringValue() && value.getStringValue().contains(needle)) {
                found.add(where + ": " + path);
            }
        }));
        for (Span s : spans()) {
            if (s.getName().contains(needle)) {
                found.add("span name " + s.getName());
            }
            s.getEventsList().forEach(e -> {
                if (e.getName().contains(needle)) {
                    found.add("span " + s.getName() + " event name " + e.getName());
                }
            });
        }
        for (LogRecord lr : logRecords()) {
            if (lr.getBody().hasStringValue() && lr.getBody().getStringValue().contains(needle)) {
                found.add("log record body");
            }
        }
        fail("value containing \"" + needle + "\" was exported", found);
    }

    /**
     * Fails unless every request was decoded, at least one exported log record carries a trace
     * ID, and every log record that carries one also carries the trace and span ID of an exported
     * span. Log records emitted outside any span carry no trace ID and are not checked.
     *
     * @throws AssertionError naming every log record without a matching span
     */
    public void assertLogsCorrelated() {
        List<String> problems = new ArrayList<>();
        List<String> spanKeys = spans().stream()
                .map(s -> hex(s.getTraceId()) + "/" + hex(s.getSpanId()))
                .toList();
        int correlated = 0;
        for (LogRecord lr : logRecords()) {
            if (lr.getTraceId().isEmpty()) {
                continue;
            }
            correlated++;
            String key = hex(lr.getTraceId()) + "/" + hex(lr.getSpanId());
            if (!spanKeys.contains(key)) {
                problems.add("log record " + valueString(lr.getBody()) + " carries trace/span " + key
                        + ", which no exported span has");
            }
        }
        if (correlated == 0) {
            problems.add("no exported log record carries a trace ID");
        }
        fail("log records are not correlated with exported spans", problems);
    }

    private void fail(String headline, List<String> found) {
        List<String> all = new ArrayList<>();
        failures.forEach(f -> all.add("request to " + f.path() + " was not decoded: " + f.reason()));
        all.addAll(found);
        if (!all.isEmpty()) {
            throw new AssertionError(headline + ":\n  - " + String.join("\n  - ", all));
        }
    }

    /** Visits every exported attribute list with a description of where it was found. */
    private void forEachAttribute(BiConsumer<String, KeyValue> visit) {
        for (ExportTraceServiceRequest req : traceRequests) {
            for (ResourceSpans rs : req.getResourceSpansList()) {
                rs.getResource().getAttributesList().forEach(kv -> visit.accept("traces resource", kv));
                for (ScopeSpans ss : rs.getScopeSpansList()) {
                    ss.getScope().getAttributesList().forEach(kv -> visit.accept("traces scope", kv));
                    for (Span s : ss.getSpansList()) {
                        String span = "span " + s.getName();
                        s.getAttributesList().forEach(kv -> visit.accept(span, kv));
                        s.getEventsList().forEach(e ->
                                e.getAttributesList().forEach(kv -> visit.accept(span + " event " + e.getName(), kv)));
                        s.getLinksList().forEach(l ->
                                l.getAttributesList().forEach(kv -> visit.accept(span + " link", kv)));
                    }
                }
            }
        }
        for (ExportLogsServiceRequest req : logRequests) {
            for (ResourceLogs rl : req.getResourceLogsList()) {
                rl.getResource().getAttributesList().forEach(kv -> visit.accept("logs resource", kv));
                for (ScopeLogs sl : rl.getScopeLogsList()) {
                    sl.getScope().getAttributesList().forEach(kv -> visit.accept("logs scope", kv));
                    for (LogRecord lr : sl.getLogRecordsList()) {
                        lr.getAttributesList().forEach(kv -> visit.accept("log record", kv));
                        if (lr.getBody().hasKvlistValue()) {
                            lr.getBody().getKvlistValue().getValuesList()
                                    .forEach(kv -> visit.accept("log record body", kv));
                        }
                    }
                }
            }
        }
        for (ExportMetricsServiceRequest req : metricRequests) {
            for (ResourceMetrics rm : req.getResourceMetricsList()) {
                rm.getResource().getAttributesList().forEach(kv -> visit.accept("metrics resource", kv));
                for (ScopeMetrics sm : rm.getScopeMetricsList()) {
                    sm.getScope().getAttributesList().forEach(kv -> visit.accept("metrics scope", kv));
                }
            }
        }
        for (MetricPoint p : metricPoints()) {
            p.attributes().forEach(kv -> visit.accept("metric " + p.metricName() + " point", kv));
            p.exemplars().forEach(ex -> ex.getFilteredAttributesList()
                    .forEach(kv -> visit.accept("metric " + p.metricName() + " exemplar", kv)));
        }
    }

    /** Visits the dotted path and value of every leaf under kv, descending into lists. */
    private static void walk(String where, String prefix, KeyValue kv, BiConsumer<String, AnyValue> visit) {
        String path = prefix.isEmpty() ? kv.getKey() : prefix + "." + kv.getKey();
        walkValue(where, path, kv.getValue(), visit);
    }

    private static void walkValue(String where, String path, AnyValue value, BiConsumer<String, AnyValue> visit) {
        if (value.hasKvlistValue()) {
            value.getKvlistValue().getValuesList().forEach(kv -> walk(where, path, kv, visit));
        } else if (value.hasArrayValue()) {
            value.getArrayValue().getValuesList().forEach(v -> walkValue(where, path, v, visit));
        } else {
            visit.accept(path, value);
        }
    }

    private static String valueString(AnyValue v) {
        return switch (v.getValueCase()) {
            case STRING_VALUE -> v.getStringValue();
            case BOOL_VALUE -> Boolean.toString(v.getBoolValue());
            case INT_VALUE -> Long.toString(v.getIntValue());
            case DOUBLE_VALUE -> Double.toString(v.getDoubleValue());
            case BYTES_VALUE -> HEX.formatHex(v.getBytesValue().toByteArray());
            case ARRAY_VALUE -> v.getArrayValue().getValuesList().stream()
                    .map(OtlpHttpReceiver::valueString).toList().toString();
            case KVLIST_VALUE -> {
                Map<String, String> m = new LinkedHashMap<>();
                v.getKvlistValue().getValuesList().forEach(kv -> m.put(kv.getKey(), valueString(kv.getValue())));
                yield m.toString();
            }
            default -> "";
        };
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().getPath();
            byte[] raw = exchange.getRequestBody().readAllBytes();
            String encoding = exchange.getRequestHeaders().getFirst("Content-Encoding");
            String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
            Map<String, List<String>> headers = new LinkedHashMap<>();
            exchange.getRequestHeaders().forEach((k, v) -> headers.put(k, List.copyOf(v)));

            byte[] body;
            try {
                body = "gzip".equalsIgnoreCase(encoding) ? gunzip(raw) : raw;
            } catch (IOException ex) {
                requests.add(new CapturedRequest(path, contentType, headers, raw));
                reject(exchange, path, 400, "gzip body could not be decompressed: " + ex.getMessage());
                return;
            }
            requests.add(new CapturedRequest(path, contentType, headers, body));

            String mediaType = contentType == null
                    ? PROTOBUF
                    : contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
            if (!PROTOBUF.equals(mediaType)) {
                reject(exchange, path, 415, "content type " + contentType + " is not supported; only "
                        + PROTOBUF + " is decoded");
                return;
            }
            byte[] response;
            try {
                switch (path) {
                    case TRACES_PATH -> {
                        traceRequests.add(ExportTraceServiceRequest.parseFrom(body));
                        response = ExportTraceServiceResponse.getDefaultInstance().toByteArray();
                    }
                    case METRICS_PATH -> {
                        metricRequests.add(ExportMetricsServiceRequest.parseFrom(body));
                        response = ExportMetricsServiceResponse.getDefaultInstance().toByteArray();
                    }
                    case LOGS_PATH -> {
                        logRequests.add(ExportLogsServiceRequest.parseFrom(body));
                        response = ExportLogsServiceResponse.getDefaultInstance().toByteArray();
                    }
                    default -> {
                        reject(exchange, path, 404, "not an OTLP/HTTP signal path");
                        return;
                    }
                }
            } catch (InvalidProtocolBufferException ex) {
                reject(exchange, path, 400, "body is not a valid OTLP protobuf message: " + ex.getMessage());
                return;
            }
            exchange.getResponseHeaders().add("Content-Type", PROTOBUF);
            exchange.sendResponseHeaders(200, response.length == 0 ? -1 : response.length);
            if (response.length > 0) {
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(response);
                }
            }
        }
    }

    private void reject(HttpExchange exchange, String path, int status, String reason) throws IOException {
        failures.add(new DecodeFailure(path, reason));
        exchange.sendResponseHeaders(status, -1);
    }

    private static byte[] gunzip(byte[] compressed) throws IOException {
        try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            return gis.readAllBytes();
        }
    }

    /** Stops the receiver immediately. */
    @Override
    public void close() {
        server.stop(0);
    }
}
