package ing.o11y.libo11y.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class O11yHttpClientTest {
    private static final AttributeKey<String> METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> METHOD_ORIGINAL = AttributeKey.stringKey("http.request.method_original");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");
    private static final AttributeKey<Long> STATUS = AttributeKey.longKey("http.response.status_code");

    private HttpServer server;
    private final AtomicReference<String> seenTraceparent = new AtomicReference<>();
    private TestTelemetry t;
    private O11yHttpClient client;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            seenTraceparent.set(ex.getRequestHeaders().getFirst("traceparent"));
            String path = ex.getRequestURI().getPath();
            int status = path.startsWith("/status/") ? Integer.parseInt(path.substring("/status/".length())) : 200;
            byte[] body = "ok".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(status, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        t = new TestTelemetry();
        client = new O11yHttpClient(HttpClient.newHttpClient(), t.telemetry);
    }

    @AfterEach
    void stop() {
        server.stop(0);
        t.close();
    }

    private URI uri(String path) {
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path);
    }

    private SpanData onlyClientSpan() {
        List<SpanData> spans = t.spans().stream().filter(s -> s.getKind() == SpanKind.CLIENT).toList();
        assertEquals(1, spans.size(), "client spans: " + spans);
        return spans.get(0);
    }

    private HistogramPointData onlyDurationPoint() {
        MetricData m = t.metric("http.client.request.duration");
        List<HistogramPointData> points = List.copyOf(m.getHistogramData().getPoints());
        assertEquals(1, points.size(), "points: " + points);
        return points.get(0);
    }

    @Test
    void durationHistogramUsesSemanticConventionBuckets() throws Exception {
        client.send(HttpRequest.newBuilder(uri("/ok")).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(
                List.of(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0),
                onlyDurationPoint().getBoundaries());
    }

    @Test
    void unknownMethodIsOtherWithOriginalOnTheSpanOnly() throws Exception {
        client.send(
                HttpRequest.newBuilder(uri("/ok")).method("PURGE", HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.ofString());
        SpanData span = onlyClientSpan();
        assertEquals("HTTP", span.getName());
        assertEquals("_OTHER", span.getAttributes().get(METHOD));
        assertEquals("PURGE", span.getAttributes().get(METHOD_ORIGINAL));
        Attributes metricAttrs = onlyDurationPoint().getAttributes();
        assertEquals("_OTHER", metricAttrs.get(METHOD));
        assertNull(metricAttrs.get(METHOD_ORIGINAL));
    }

    @Test
    void knownMethodKeepsItsNameAndHasNoOriginal() throws Exception {
        client.send(HttpRequest.newBuilder(uri("/ok")).GET().build(), HttpResponse.BodyHandlers.ofString());
        SpanData span = onlyClientSpan();
        assertEquals("GET", span.getName());
        assertEquals("GET", span.getAttributes().get(METHOD));
        assertNull(span.getAttributes().get(METHOD_ORIGINAL));
    }

    @Test
    void clientErrorStatusSetsErrorTypeAndErrorStatus() throws Exception {
        client.send(HttpRequest.newBuilder(uri("/status/404")).GET().build(), HttpResponse.BodyHandlers.ofString());
        SpanData span = onlyClientSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals("404", span.getAttributes().get(ERROR_TYPE));
        assertEquals("404", onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void successStatusHasNoErrorType() throws Exception {
        client.send(HttpRequest.newBuilder(uri("/status/204")).GET().build(), HttpResponse.BodyHandlers.ofString());
        SpanData span = onlyClientSpan();
        assertEquals(StatusCode.UNSET, span.getStatus().getStatusCode());
        assertNull(span.getAttributes().get(ERROR_TYPE));
        assertNull(onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void exceptionWinsWithItsClassName() {
        server.stop(0);
        assertThrows(IOException.class, () -> client.send(
                HttpRequest.newBuilder(uri("/ok")).GET().build(), HttpResponse.BodyHandlers.ofString()));
        SpanData span = onlyClientSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        String errorType = span.getAttributes().get(ERROR_TYPE);
        assertNotNull(errorType);
        assertTrue(errorType.contains("Exception"), errorType);
        assertEquals(errorType, onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void sendAsyncEndsTheSpanWhenTheResponseArrives() throws Exception {
        Span before = Span.current();
        CompletableFuture<HttpResponse<String>> future = client.sendAsync(
                HttpRequest.newBuilder(uri("/status/503")).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(before, Span.current(), "the span scope must not leak onto the calling thread");
        HttpResponse<String> response = future.get(10, TimeUnit.SECONDS);
        assertEquals(503, response.statusCode());

        SpanData span = onlyClientSpan();
        assertTrue(span.hasEnded());
        assertEquals(503L, span.getAttributes().get(STATUS));
        assertEquals("503", span.getAttributes().get(ERROR_TYPE));
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertNotNull(seenTraceparent.get());
        assertTrue(seenTraceparent.get().contains(span.getTraceId()), seenTraceparent.get());
        assertTrue(seenTraceparent.get().contains(span.getSpanId()), seenTraceparent.get());
        HistogramPointData point = onlyDurationPoint();
        assertEquals(1, point.getCount());
        assertEquals("503", point.getAttributes().get(ERROR_TYPE));
        assertFalse(point.getExemplars().isEmpty(), "duration should carry the span as exemplar");
        assertEquals(span.getSpanId(), point.getExemplars().get(0).getSpanContext().getSpanId());
    }

    @Test
    void sendAsyncWithPushPromiseHandlerIsInstrumented() throws Exception {
        HttpResponse<String> response = client.sendAsync(
                        HttpRequest.newBuilder(uri("/ok")).GET().build(),
                        HttpResponse.BodyHandlers.ofString(),
                        (initiating, push, acceptor) -> { })
                .get(10, TimeUnit.SECONDS);
        assertEquals(200, response.statusCode());
        assertEquals(200L, onlyClientSpan().getAttributes().get(STATUS));
    }

    @Test
    void sendAsyncFailureRecordsTheCauseClass() {
        server.stop(0);
        CompletableFuture<HttpResponse<String>> future = client.sendAsync(
                HttpRequest.newBuilder(uri("/ok")).GET().build(), HttpResponse.BodyHandlers.ofString());
        CompletionException ex = assertThrows(CompletionException.class, future::join);
        assertInstanceOf(IOException.class, ex.getCause());
        SpanData span = onlyClientSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals(ex.getCause().getClass().getName(), span.getAttributes().get(ERROR_TYPE));
        assertEquals(ex.getCause().getClass().getName(), onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }
}
