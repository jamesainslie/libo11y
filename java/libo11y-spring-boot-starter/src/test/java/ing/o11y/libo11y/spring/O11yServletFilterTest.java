package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.test.O11yRecorder;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.trace.data.SpanData;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.servlet.HandlerMapping;

class O11yServletFilterTest {
    private static final AttributeKey<String> METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> METHOD_ORIGINAL = AttributeKey.stringKey("http.request.method_original");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private O11yRecorder recorder;

    @BeforeEach
    void start() {
        recorder = O11yRecorder.start();
    }

    @AfterEach
    void stop() {
        recorder.close();
    }

    private static O11yProperties.Http http() {
        return new O11yProperties().getHttp();
    }

    private MockHttpServletResponse run(O11yProperties.Http cfg, MockHttpServletRequest req, FilterChain chain)
            throws Exception {
        MockHttpServletResponse res = new MockHttpServletResponse();
        new O11yServletFilter(recorder.telemetry(), cfg).doFilter(req, res, chain);
        return res;
    }

    private SpanData onlyServerSpan() {
        List<SpanData> spans = recorder.spans().stream().filter(s -> s.getKind() == SpanKind.SERVER).toList();
        assertEquals(1, spans.size(), "server spans: " + spans);
        return spans.get(0);
    }

    private HistogramPointData onlyDurationPoint() {
        MetricData m = recorder.metrics().stream()
                .filter(md -> "http.server.request.duration".equals(md.getName()))
                .findFirst()
                .orElseThrow();
        List<HistogramPointData> points = List.copyOf(m.getHistogramData().getPoints());
        assertEquals(1, points.size(), "points: " + points);
        return points.get(0);
    }

    private static FilterChain html(String contentType) {
        return (rq, rs) -> {
            rs.setContentType(contentType);
            rs.getWriter().write("<html></html>");
        };
    }

    @Test
    void serverTimingAndCanonicalLineAreOptIn() throws Exception {
        O11yProperties.Http cfg = http();
        assertFalse(cfg.isServerTiming());
        assertFalse(cfg.isCanonicalLine());

        MockHttpServletResponse res = run(cfg, new MockHttpServletRequest("GET", "/page"), html("text/html"));
        assertNull(res.getHeader("Server-Timing"));
        assertTrue(recorder.entries().stream().noneMatch(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName())));
        onlyServerSpan();
    }

    @Test
    void serverTimingNamesTheServerSpanOnHtmlResponses() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setServerTiming(true);
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/page");
        String inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        req.addHeader("traceparent", "00-" + inboundTraceId + "-00f067aa0ba902b7-01");
        MockHttpServletResponse res = run(cfg, req, html("Text/HTML; charset=utf-8"));
        SpanData span = onlyServerSpan();
        assertEquals(inboundTraceId, span.getTraceId(), "Server-Timing names the adopted trace");
        String expected = "traceparent;desc=\"00-" + span.getTraceId() + "-" + span.getSpanId() + "-"
                + span.getSpanContext().getTraceFlags().asHex() + "\"";
        assertEquals(List.of(expected), res.getHeaders("Server-Timing"));
    }

    @Test
    void serverTimingKeepsTheHandlersOwnEntryFirst() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setServerTiming(true);
        MockHttpServletResponse res = run(cfg, new MockHttpServletRequest("GET", "/page"), (rq, rs) -> {
            ((HttpServletResponse) rs).addHeader("Server-Timing", "db;dur=53");
            rs.setContentType("text/html");
            rs.getOutputStream().write("<p>".getBytes(StandardCharsets.UTF_8));
        });
        List<String> values = res.getHeaders("Server-Timing");
        assertEquals(2, values.size(), values.toString());
        assertEquals("db;dur=53", values.get(0));
        assertTrue(values.get(1).startsWith("traceparent;desc=\"00-"), values.get(1));
    }

    @Test
    void serverTimingIsNotAddedToNonHtmlResponses() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setServerTiming(true);
        assertNull(run(cfg, new MockHttpServletRequest("GET", "/api"), html("application/json"))
                .getHeader("Server-Timing"));
        assertNull(run(cfg, new MockHttpServletRequest("GET", "/api"), (rq, rs) -> rs.getWriter().write("<html>"))
                .getHeader("Server-Timing"));
        assertNull(run(cfg, new MockHttpServletRequest("GET", "/api"), (rq, rs) -> { })
                .getHeader("Server-Timing"));
    }

    @Test
    void serverTimingIsDecidedWhenTheHandlerReturnsWithoutWriting() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setServerTiming(true);
        MockHttpServletResponse res = run(
                cfg, new MockHttpServletRequest("HEAD", "/page"), (rq, rs) -> rs.setContentType("text/html"));
        assertEquals(1, res.getHeaders("Server-Timing").size());
    }

    @Test
    void unknownMethodIsOtherWithTheOriginalOnTheSpan() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setCanonicalLine(true);
        run(cfg, new MockHttpServletRequest("PURGE", "/items/7"), (rq, rs) ->
                rq.setAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE, "/items/{id}"));
        SpanData span = onlyServerSpan();
        assertEquals("HTTP /items/{id}", span.getName());
        assertEquals("_OTHER", span.getAttributes().get(METHOD));
        assertEquals("PURGE", span.getAttributes().get(METHOD_ORIGINAL));
        Attributes metricAttrs = onlyDurationPoint().getAttributes();
        assertEquals("_OTHER", metricAttrs.get(METHOD));
        assertNull(metricAttrs.get(METHOD_ORIGINAL));
        var summary = recorder.entries().stream()
                .filter(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName()))
                .findFirst()
                .orElseThrow();
        assertEquals("_OTHER", summary.attributes().get("http.request.method"));
        assertEquals("PURGE", summary.attributes().get("http.request.method_original"));
    }

    @Test
    void knownMethodInAnotherCaseIsUpperCased() throws Exception {
        run(http(), new MockHttpServletRequest("get", "/x"), (rq, rs) -> { });
        SpanData span = onlyServerSpan();
        assertEquals("GET", span.getName());
        assertEquals("GET", span.getAttributes().get(METHOD));
        assertEquals("get", span.getAttributes().get(METHOD_ORIGINAL));
    }

    @Test
    void serverErrorStatusSetsErrorType() throws Exception {
        run(http(), new MockHttpServletRequest("GET", "/x"), (rq, rs) -> ((HttpServletResponse) rs).setStatus(503));
        SpanData span = onlyServerSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals("503", span.getAttributes().get(ERROR_TYPE));
        assertEquals("503", onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void clientErrorStatusIsNotAServerError() throws Exception {
        run(http(), new MockHttpServletRequest("GET", "/x"), (rq, rs) -> ((HttpServletResponse) rs).setStatus(404));
        SpanData span = onlyServerSpan();
        assertEquals(StatusCode.UNSET, span.getStatus().getStatusCode());
        assertNull(span.getAttributes().get(ERROR_TYPE));
        assertNull(onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void exceptionWinsWithItsClassName() {
        assertThrows(IllegalStateException.class, () -> run(
                http(), new MockHttpServletRequest("GET", "/x"), (rq, rs) -> {
                    ((HttpServletResponse) rs).setStatus(503);
                    throw new IllegalStateException("boom");
                }));
        SpanData span = onlyServerSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals(IllegalStateException.class.getName(), span.getAttributes().get(ERROR_TYPE));
        assertEquals(IllegalStateException.class.getName(), onlyDurationPoint().getAttributes().get(ERROR_TYPE));
    }

    @Test
    void durationHistogramUsesSemanticConventionBuckets() throws Exception {
        run(http(), new MockHttpServletRequest("GET", "/x"), (rq, rs) -> { });
        assertEquals(
                List.of(0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0),
                onlyDurationPoint().getBoundaries());
    }

    @Test
    void ignorePathsMatchTheDecodedPathWithinTheApplication() throws Exception {
        O11yProperties.Http cfg = http();
        cfg.setIgnorePaths(List.of("/healthz", "/café/*"));

        MockHttpServletRequest underContext = new MockHttpServletRequest("GET", "/app/healthz");
        underContext.setContextPath("/app");
        run(cfg, underContext, (rq, rs) -> { });

        MockHttpServletRequest encoded = new MockHttpServletRequest("GET", "/caf%C3%A9/menu");
        run(cfg, encoded, (rq, rs) -> { });

        MockHttpServletRequest pathParameter = new MockHttpServletRequest("GET", "/healthz;jsessionid=abc");
        run(cfg, pathParameter, (rq, rs) -> { });

        assertTrue(recorder.spans().isEmpty(), "ignored requests must not be traced: " + recorder.spans());

        run(cfg, new MockHttpServletRequest("GET", "/healthz/deep"), (rq, rs) -> { });
        onlyServerSpan();
    }

    @Test
    void malformedIgnorePathFailsWhenTheFilterIsBuilt() {
        O11yProperties.Http cfg = http();
        cfg.setIgnorePaths(List.of("/healthz", "/debug/["));
        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class, () -> new O11yServletFilter(recorder.telemetry(), cfg));
        assertTrue(ex.getMessage().contains("/debug/["), ex.getMessage());
        assertTrue(ex.getMessage().contains("libo11y.http.ignore-paths"), ex.getMessage());
    }
}
