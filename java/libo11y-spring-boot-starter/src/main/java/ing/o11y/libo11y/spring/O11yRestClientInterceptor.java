package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.internal.EndpointSanitizer;
import ing.o11y.libo11y.internal.HttpSemconv;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.io.IOException;
import java.net.URI;
import java.util.function.Predicate;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

/**
 * Spring {@link ClientHttpRequestInterceptor} for {@code RestClient} and {@code RestTemplate}:
 * injects W3C headers via {@link Telemetry#propagators()}, strips URL credentials, creates
 * {@code CLIENT} spans, and records {@code http.client.request.duration} with trace-based exemplars.
 *
 * <p>Methods outside the semantic-convention set are recorded as {@code _OTHER}, with the raw value
 * in {@code http.request.method_original} on the span, and name the span {@code HTTP}. A 4xx or
 * 5xx response marks the span ERROR and sets {@code error.type} to the status code; a failure sets
 * it to the exception class.
 */
public final class O11yRestClientInterceptor implements ClientHttpRequestInterceptor {
    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> HTTP_METHOD_ORIGINAL =
            AttributeKey.stringKey("http.request.method_original");
    private static final AttributeKey<Long> HTTP_STATUS = AttributeKey.longKey("http.response.status_code");
    private static final AttributeKey<String> SERVER_ADDRESS = AttributeKey.stringKey("server.address");
    private static final AttributeKey<Long> SERVER_PORT = AttributeKey.longKey("server.port");
    private static final AttributeKey<String> URL_FULL = AttributeKey.stringKey("url.full");
    private static final AttributeKey<String> PEER_SERVICE = AttributeKey.stringKey("peer.service");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private final Telemetry telemetry;
    private final Tracer tracer;
    private final DoubleHistogram duration;
    private final Predicate<URI> propagatePredicate;
    private final String peerService;

    /** Instruments requests through {@code telemetry}, propagating to every destination. */
    public O11yRestClientInterceptor(Telemetry telemetry) {
        this(telemetry, uri -> true, null);
    }

    /**
     * Instruments requests through {@code telemetry}.
     *
     * @param propagatePredicate decides per destination whether trace and baggage headers are
     *     injected; {@code null} propagates everywhere
     * @param peerService the {@code peer.service} span attribute, or {@code null} for none
     */
    public O11yRestClientInterceptor(Telemetry telemetry, Predicate<URI> propagatePredicate, String peerService) {
        this.telemetry = telemetry;
        this.tracer = telemetry.tracer("libo11y.spring.restclient");
        this.duration = telemetry.meter("libo11y.spring.restclient")
                .histogramBuilder("http.client.request.duration")
                .setDescription("Duration of HTTP client requests.")
                .setUnit("s")
                .setExplicitBucketBoundariesAdvice(HttpSemconv.DURATION_BUCKETS)
                .build();
        this.propagatePredicate = propagatePredicate == null ? uri -> true : propagatePredicate;
        this.peerService = peerService;
    }

    @Override
    public ClientHttpResponse intercept(
            HttpRequest request,
            byte[] body,
            ClientHttpRequestExecution execution) throws IOException {
        URI uri = request.getURI();
        HttpSemconv.Method method = HttpSemconv.method(request.getMethod().name());
        String sanitizedUrl = EndpointSanitizer.sanitize(uri.toString());
        int port = resolvePort(uri);

        var sb = tracer.spanBuilder(method.spanName())
                .setSpanKind(SpanKind.CLIENT)
                .setAttribute(HTTP_METHOD, method.value())
                .setAttribute(URL_FULL, sanitizedUrl);
        if (method.original() != null) {
            sb.setAttribute(HTTP_METHOD_ORIGINAL, method.original());
        }
        if (uri.getHost() != null) {
            sb.setAttribute(SERVER_ADDRESS, uri.getHost());
        }
        if (port > 0) {
            sb.setAttribute(SERVER_PORT, (long) port);
        }
        if (peerService != null && !peerService.isEmpty()) {
            sb.setAttribute(PEER_SERVICE, peerService);
        }

        Span span = sb.startSpan();
        long startNanos = System.nanoTime();
        AttributesBuilder metricAttrs = Attributes.builder().put(HTTP_METHOD, method.value());
        if (uri.getHost() != null) {
            metricAttrs.put(SERVER_ADDRESS, uri.getHost());
        }
        if (port > 0) {
            metricAttrs.put(SERVER_PORT, (long) port);
        }

        try (Scope ignored = span.makeCurrent()) {
            if (propagatePredicate.test(uri)) {
                telemetry.propagators().getTextMapPropagator().inject(
                        Context.current(),
                        request.getHeaders(),
                        (headers, key, value) -> {
                            if (headers != null && key != null && value != null) {
                                headers.set(key, value);
                            }
                        });
            }
            ClientHttpResponse response = execution.execute(request, body);
            int status = response.getStatusCode().value();
            span.setAttribute(HTTP_STATUS, (long) status);
            metricAttrs.put(HTTP_STATUS, (long) status);
            String errorType = HttpSemconv.clientErrorType(status);
            if (errorType != null) {
                span.setAttribute(ERROR_TYPE, errorType);
                metricAttrs.put(ERROR_TYPE, errorType);
                span.setStatus(StatusCode.ERROR);
            }
            return response;
        } catch (IOException | RuntimeException ex) {
            span.setAttribute(ERROR_TYPE, ex.getClass().getName());
            metricAttrs.put(ERROR_TYPE, ex.getClass().getName());
            span.recordException(ex);
            span.setStatus(StatusCode.ERROR, ex.getMessage());
            throw ex;
        } finally {
            double seconds = (System.nanoTime() - startNanos) / 1_000_000_000.0;
            duration.record(seconds, metricAttrs.build(), Context.current().with(span));
            span.end();
        }
    }

    private static int resolvePort(URI uri) {
        if (uri.getPort() > 0) {
            return uri.getPort();
        }
        if ("https".equalsIgnoreCase(uri.getScheme())) {
            return 443;
        }
        if ("http".equalsIgnoreCase(uri.getScheme())) {
            return 80;
        }
        return -1;
    }
}
