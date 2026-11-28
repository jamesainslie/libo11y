package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.internal.EndpointSanitizer;
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
 */
public final class O11yRestClientInterceptor implements ClientHttpRequestInterceptor {
    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
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

    public O11yRestClientInterceptor(Telemetry telemetry) {
        this(telemetry, uri -> true, null);
    }

    public O11yRestClientInterceptor(Telemetry telemetry, Predicate<URI> propagatePredicate, String peerService) {
        this.telemetry = telemetry;
        this.tracer = telemetry.tracer("libo11y.spring.restclient");
        this.duration = telemetry.meter("libo11y.spring.restclient")
                .histogramBuilder("http.client.request.duration")
                .setDescription("Duration of HTTP client requests.")
                .setUnit("s")
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
        String method = request.getMethod().name();
        String sanitizedUrl = EndpointSanitizer.sanitize(uri.toString());
        int port = resolvePort(uri);

        var sb = tracer.spanBuilder(method)
                .setSpanKind(SpanKind.CLIENT)
                .setAttribute(HTTP_METHOD, method)
                .setAttribute(URL_FULL, sanitizedUrl);
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
        AttributesBuilder metricAttrs = Attributes.builder().put(HTTP_METHOD, method);
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
            if (status >= 400) {
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
