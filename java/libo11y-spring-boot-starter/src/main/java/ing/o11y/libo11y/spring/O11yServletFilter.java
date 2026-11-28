package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.http.PathMatcher;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.List;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Spring MVC / Jakarta Servlet filter implementing the libo11y HTTP server contract:
 * route-aware span names, stable HTTP semconv, {@code publicEndpoint} link mode,
 * {@code ignorePaths}, {@code Server-Timing}, {@code http.server.request.duration} with exemplars,
 * and {@code o11y.request.summary} wide-event canonical lines.
 */
public final class O11yServletFilter extends OncePerRequestFilter {
    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> HTTP_ROUTE = AttributeKey.stringKey("http.route");
    private static final AttributeKey<Long> HTTP_STATUS = AttributeKey.longKey("http.response.status_code");
    private static final AttributeKey<String> URL_PATH = AttributeKey.stringKey("url.path");
    private static final AttributeKey<String> URL_SCHEME = AttributeKey.stringKey("url.scheme");
    private static final AttributeKey<String> SERVER_ADDRESS = AttributeKey.stringKey("server.address");
    private static final AttributeKey<Long> SERVER_PORT = AttributeKey.longKey("server.port");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private static final TextMapGetter<HttpServletRequest> SERVLET_GETTER = new TextMapGetter<>() {
        @Override
        @SuppressWarnings("deprecation")
        public Iterable<String> keys(HttpServletRequest carrier) {
            return carrier == null ? List.of() : Collections.list(carrier.getHeaderNames());
        }

        @Override
        public String get(HttpServletRequest carrier, String key) {
            return carrier == null || key == null ? null : carrier.getHeader(key);
        }
    };

    private final Telemetry telemetry;
    private final Tracer tracer;
    private final DoubleHistogram duration;
    private final O11yProperties.Http config;

    public O11yServletFilter(Telemetry telemetry, O11yProperties.Http config) {
        this.telemetry = telemetry;
        this.tracer = telemetry.tracer("libo11y.spring.http.server");
        this.duration = telemetry.meter("libo11y.spring.http.server")
                .histogramBuilder("http.server.request.duration")
                .setDescription("Duration of HTTP server requests.")
                .setUnit("s")
                .build();
        this.config = config;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();
        if (PathMatcher.matchesAny(config.getIgnorePaths(), path)) {
            filterChain.doFilter(request, response);
            return;
        }

        Context extracted = telemetry.propagators().getTextMapPropagator()
                .extract(Context.root(), request, SERVLET_GETTER);
        SpanContext inboundSpan = Span.fromContext(extracted).getSpanContext();
        Baggage inboundBaggage = Baggage.fromContext(extracted);

        String method = request.getMethod();
        SpanBuilder sb = tracer.spanBuilder(method)
                .setSpanKind(SpanKind.SERVER)
                .setAttribute(HTTP_METHOD, method)
                .setAttribute(URL_PATH, path)
                .setAttribute(URL_SCHEME, request.getScheme());

        if (request.getServerName() != null && !request.getServerName().isEmpty()) {
            sb.setAttribute(SERVER_ADDRESS, request.getServerName());
        }
        if (request.getServerPort() > 0) {
            sb.setAttribute(SERVER_PORT, (long) request.getServerPort());
        }

        Context baseCtx;
        if (config.isPublicEndpoint()) {
            sb.setNoParent();
            if (inboundSpan.isValid()) {
                sb.addLink(inboundSpan);
            }
            baseCtx = Context.root();
        } else {
            sb.setParent(extracted);
            baseCtx = Context.root().with(inboundBaggage);
        }

        Span span = sb.startSpan();
        if (config.isServerTiming() && span.getSpanContext().isValid()) {
            SpanContext sc = span.getSpanContext();
            String traceparent = "00-" + sc.getTraceId() + "-" + sc.getSpanId() + "-" + sc.getTraceFlags().asHex();
            response.addHeader("Server-Timing", "traceparent;desc=\"" + traceparent + "\"");
        }

        long startNanos = System.nanoTime();
        Throwable failure = null;
        try (Scope spanScope = baseCtx.with(span).makeCurrent()) {
            O11yRecord record = config.isCanonicalLine()
                    ? O11yRecord.start(telemetry, Spec.Events.REQUEST_SUMMARY)
                    : null;
            try {
                if (record != null) {
                    record.set("http.request.method", method);
                    record.set("url.path", path);
                }
                filterChain.doFilter(request, response);
            } catch (Throwable ex) {
                failure = ex;
                span.setAttribute(ERROR_TYPE, ex.getClass().getName());
                span.recordException(ex);
                span.setStatus(StatusCode.ERROR, ex.getMessage());
                if (record != null) {
                    record.recordError(ex);
                }
                throw ex;
            } finally {
                int status = failure != null && response.getStatus() < 400 ? 500 : response.getStatus();
                Object routeAttr = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
                String route = routeAttr != null ? routeAttr.toString() : null;
                if (route != null && !route.isEmpty()) {
                    span.setAttribute(HTTP_ROUTE, route);
                    span.updateName(method + " " + route);
                }
                span.setAttribute(HTTP_STATUS, (long) status);
                if (status >= 500) {
                    span.setStatus(StatusCode.ERROR);
                }

                double seconds = (System.nanoTime() - startNanos) / 1_000_000_000.0;
                AttributesBuilder metricAttrs = Attributes.builder()
                        .put(HTTP_METHOD, method)
                        .put(HTTP_STATUS, (long) status)
                        .put(URL_SCHEME, request.getScheme());
                if (route != null && !route.isEmpty()) {
                    metricAttrs.put(HTTP_ROUTE, route);
                }
                if (failure != null) {
                    metricAttrs.put(ERROR_TYPE, failure.getClass().getName());
                }
                duration.record(seconds, metricAttrs.build(), Context.current());

                if (record != null) {
                    if (route != null && !route.isEmpty()) {
                        record.set("http.route", route);
                    }
                    record.set("http.response.status_code", (long) status);
                    record.set(Spec.Attributes.DURATION, seconds);
                    if (failure == null) {
                        record.setOutcome(status >= 500 ? Spec.Outcome.FAILURE : Spec.Outcome.SUCCESS);
                    }
                    record.close();
                }
            }
        } finally {
            span.end();
        }
    }
}
