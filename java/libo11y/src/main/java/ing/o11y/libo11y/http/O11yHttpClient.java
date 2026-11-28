package ing.o11y.libo11y.http;

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
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Instrumented wrapper over {@link java.net.http.HttpClient} injecting W3C trace/baggage headers,
 * stripping URL credentials, and recording {@code http.client.request.duration} with exemplars.
 */
public final class O11yHttpClient {
    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<Long> HTTP_STATUS = AttributeKey.longKey("http.response.status_code");
    private static final AttributeKey<String> SERVER_ADDRESS = AttributeKey.stringKey("server.address");
    private static final AttributeKey<Long> SERVER_PORT = AttributeKey.longKey("server.port");
    private static final AttributeKey<String> URL_FULL = AttributeKey.stringKey("url.full");
    private static final AttributeKey<String> PEER_SERVICE = AttributeKey.stringKey("peer.service");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private final HttpClient delegate;
    private final Telemetry telemetry;
    private final Tracer tracer;
    private final DoubleHistogram duration;
    private final Predicate<URI> propagatePredicate;
    private final String peerService;

    public O11yHttpClient(HttpClient delegate, Telemetry telemetry) {
        this(delegate, telemetry, uri -> true, null);
    }

    public O11yHttpClient(
            HttpClient delegate,
            Telemetry telemetry,
            Predicate<URI> propagatePredicate,
            String peerService) {
        this.delegate = delegate == null ? HttpClient.newHttpClient() : delegate;
        this.telemetry = telemetry;
        this.tracer = telemetry.tracer("libo11y.http.client");
        this.duration = telemetry.meter("libo11y.http.client")
                .histogramBuilder("http.client.request.duration")
                .setDescription("Duration of HTTP client requests.")
                .setUnit("s")
                .build();
        this.propagatePredicate = propagatePredicate == null ? uri -> true : propagatePredicate;
        this.peerService = peerService;
    }

    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler)
            throws IOException, InterruptedException {
        URI uri = request.uri();
        String method = request.method();
        String sanitizedUrl = EndpointSanitizer.sanitize(uri.toString());
        int port = resolvePort(uri);

        var spanBuilder = tracer.spanBuilder(method)
                .setSpanKind(SpanKind.CLIENT)
                .setAttribute(HTTP_METHOD, method)
                .setAttribute(URL_FULL, sanitizedUrl);
        if (uri.getHost() != null) {
            spanBuilder.setAttribute(SERVER_ADDRESS, uri.getHost());
        }
        if (port > 0) {
            spanBuilder.setAttribute(SERVER_PORT, (long) port);
        }
        if (peerService != null && !peerService.isEmpty()) {
            spanBuilder.setAttribute(PEER_SERVICE, peerService);
        }

        Span span = spanBuilder.startSpan();
        long startNanos = System.nanoTime();
        AttributesBuilder metricAttrs = Attributes.builder().put(HTTP_METHOD, method);
        if (uri.getHost() != null) {
            metricAttrs.put(SERVER_ADDRESS, uri.getHost());
        }
        if (port > 0) {
            metricAttrs.put(SERVER_PORT, (long) port);
        }

        try (Scope ignored = span.makeCurrent()) {
            HttpRequest outgoing = propagatePredicate.test(uri)
                    ? injectHeaders(request, Context.current())
                    : request;
            HttpResponse<T> response = delegate.send(outgoing, handler);
            int status = response.statusCode();
            span.setAttribute(HTTP_STATUS, (long) status);
            metricAttrs.put(HTTP_STATUS, (long) status);
            if (status >= 400) {
                span.setStatus(StatusCode.ERROR);
            }
            return response;
        } catch (IOException | InterruptedException | RuntimeException ex) {
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

    private HttpRequest injectHeaders(HttpRequest original, Context ctx) {
        HttpRequest.Builder copy = HttpRequest.newBuilder(original.uri())
                .method(original.method(), original.bodyPublisher().orElse(HttpRequest.BodyPublishers.noBody()));
        original.timeout().ifPresent(copy::timeout);
        original.version().ifPresent(copy::version);
        copy.expectContinue(original.expectContinue());
        for (Map.Entry<String, List<String>> h : original.headers().map().entrySet()) {
            for (String v : h.getValue()) {
                copy.header(h.getKey(), v);
            }
        }
        telemetry.propagators().getTextMapPropagator().inject(ctx, copy, (carrier, key, value) -> {
            if (carrier != null && key != null && value != null) {
                carrier.setHeader(key, value);
            }
        });
        return copy.build();
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
