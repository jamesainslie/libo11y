package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ing.o11y.libo11y.test.O11yRecorder;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.mock.http.client.MockClientHttpRequest;
import org.springframework.mock.http.client.MockClientHttpResponse;

class O11yRestClientInterceptorTest {
    private static final AttributeKey<String> METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> METHOD_ORIGINAL = AttributeKey.stringKey("http.request.method_original");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private O11yRecorder recorder;
    private O11yRestClientInterceptor interceptor;

    @BeforeEach
    void start() {
        recorder = O11yRecorder.start();
        interceptor = new O11yRestClientInterceptor(recorder.telemetry());
    }

    @AfterEach
    void stop() {
        recorder.close();
    }

    private void call(String method, HttpStatus status) throws IOException {
        MockClientHttpRequest request = new MockClientHttpRequest(HttpMethod.valueOf(method), URI.create("http://svc.local/items"));
        interceptor.intercept(request, new byte[0], (req, body) -> new MockClientHttpResponse(new byte[0], status));
    }

    private SpanData onlyClientSpan() {
        List<SpanData> spans = recorder.spans().stream().filter(s -> s.getKind() == SpanKind.CLIENT).toList();
        assertEquals(1, spans.size(), "client spans: " + spans);
        return spans.get(0);
    }

    private HistogramPointData onlyDurationPoint() {
        return recorder.metrics().stream()
                .filter(m -> "http.client.request.duration".equals(m.getName()))
                .flatMap(m -> m.getHistogramData().getPoints().stream())
                .reduce((a, b) -> {
                    throw new AssertionError("more than one point");
                })
                .orElseThrow();
    }

    @Test
    void unknownMethodIsOtherWithTheOriginalOnTheSpanOnly() throws IOException {
        call("PURGE", HttpStatus.OK);
        SpanData span = onlyClientSpan();
        assertEquals("HTTP", span.getName());
        assertEquals("_OTHER", span.getAttributes().get(METHOD));
        assertEquals("PURGE", span.getAttributes().get(METHOD_ORIGINAL));
        Attributes metricAttrs = onlyDurationPoint().getAttributes();
        assertEquals("_OTHER", metricAttrs.get(METHOD));
        assertNull(metricAttrs.get(METHOD_ORIGINAL));
    }

    @Test
    void clientErrorStatusSetsErrorType() throws IOException {
        call("GET", HttpStatus.NOT_FOUND);
        SpanData span = onlyClientSpan();
        assertEquals("GET", span.getName());
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals("404", span.getAttributes().get(ERROR_TYPE));
        assertEquals("404", onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void successHasNoErrorType() throws IOException {
        call("GET", HttpStatus.OK);
        assertNull(onlyClientSpan().getAttributes().get(ERROR_TYPE));
        assertEquals(StatusCode.UNSET, onlyClientSpan().getStatus().getStatusCode());
    }

    @Test
    void exceptionWinsWithItsClassName() {
        MockClientHttpRequest request = new MockClientHttpRequest(HttpMethod.GET, URI.create("http://svc.local/items"));
        assertThrows(IOException.class, () -> interceptor.intercept(request, new byte[0], (req, body) -> {
            throw new IOException("refused");
        }));
        assertEquals(IOException.class.getName(), onlyClientSpan().getAttributes().get(ERROR_TYPE));
        assertEquals(IOException.class.getName(), onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void durationHistogramUsesSemanticConventionBuckets() throws IOException {
        call("GET", HttpStatus.OK);
        assertEquals(
                List.of(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0),
                onlyDurationPoint().getBoundaries());
    }
}
