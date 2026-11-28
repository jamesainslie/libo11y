package ing.o11y.libo11y.http;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.internal.EndpointSanitizer;
import ing.o11y.libo11y.internal.HttpSemconv;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.function.Predicate;

/**
 * Instrumented wrapper over {@link java.net.http.HttpClient} injecting W3C trace/baggage headers,
 * stripping URL credentials, and recording {@code http.client.request.duration} with exemplars.
 *
 * <p>Each request gets a {@code CLIENT} span named after its method ({@code HTTP} for a method
 * outside the semantic-convention set, which is recorded as {@code _OTHER} with the raw value in
 * {@code http.request.method_original} on the span). A 4xx or 5xx response marks the span ERROR
 * and sets {@code error.type} to the status code; a failure sets it to the exception class.
 */
public final class O11yHttpClient {
    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> HTTP_METHOD_ORIGINAL =
            AttributeKey.stringKey("http.request.method_original");
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

    /** Instruments {@code delegate} (a new default client when {@code null}), propagating to every destination. */
    public O11yHttpClient(HttpClient delegate, Telemetry telemetry) {
        this(delegate, telemetry, uri -> true, null);
    }

    /**
     * Instruments {@code delegate} (a new default client when {@code null}).
     *
     * @param propagatePredicate decides per destination whether trace and baggage headers are
     *     injected; {@code null} propagates everywhere
     * @param peerService the {@code peer.service} span attribute, or {@code null} for none
     */
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
                .setExplicitBucketBoundariesAdvice(HttpSemconv.DURATION_BUCKETS)
                .build();
        this.propagatePredicate = propagatePredicate == null ? uri -> true : propagatePredicate;
        this.peerService = peerService;
    }

    /** Sends {@code request} like {@link HttpClient#send}, inside a {@code CLIENT} span. */
    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler)
            throws IOException, InterruptedException {
        Call call = start(request);
        try (Scope ignored = call.span.makeCurrent()) {
            HttpResponse<T> response = delegate.send(call.outgoing(), handler);
            call.end(response.statusCode(), null);
            return response;
        } catch (IOException | InterruptedException | RuntimeException ex) {
            call.end(0, ex);
            throw ex;
        }
    }

    /**
     * Sends {@code request} like {@link HttpClient#sendAsync(HttpRequest, HttpResponse.BodyHandler)}.
     * The span ends, and the duration is recorded, before the returned future completes. The span
     * is never current on the calling thread after this method returns.
     */
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request, HttpResponse.BodyHandler<T> handler) {
        return sendAsync(request, handler, null);
    }

    /**
     * Sends {@code request} like
     * {@link HttpClient#sendAsync(HttpRequest, HttpResponse.BodyHandler, HttpResponse.PushPromiseHandler)}.
     * Only the initiating request is instrumented; pushed responses are not. A {@code null}
     * {@code pushPromiseHandler} accepts no pushes. Cancelling the returned future cancels the
     * underlying request.
     */
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> handler,
            HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
        Call call = start(request);
        CompletableFuture<HttpResponse<T>> sent;
        try (Scope ignored = call.span.makeCurrent()) {
            HttpRequest outgoing = call.outgoing();
            sent = pushPromiseHandler == null
                    ? delegate.sendAsync(outgoing, handler)
                    : delegate.sendAsync(outgoing, handler, pushPromiseHandler);
        } catch (RuntimeException ex) {
            call.end(0, ex);
            throw ex;
        }
        CompletableFuture<HttpResponse<T>> result = sent.whenComplete((response, failure) -> {
            if (failure != null) {
                call.end(0, unwrap(failure));
            } else {
                call.end(response.statusCode(), null);
            }
        });
        result.whenComplete((response, failure) -> {
            if (result.isCancelled()) {
                sent.cancel(true);
            }
        });
        return result;
    }

    private Call start(HttpRequest request) {
        URI uri = request.uri();
        HttpSemconv.Method method = HttpSemconv.method(request.method());
        int port = resolvePort(uri);

        SpanBuilder spanBuilder = tracer.spanBuilder(method.spanName())
                .setSpanKind(SpanKind.CLIENT)
                .setAttribute(HTTP_METHOD, method.value())
                .setAttribute(URL_FULL, EndpointSanitizer.sanitize(uri.toString()));
        if (method.original() != null) {
            spanBuilder.setAttribute(HTTP_METHOD_ORIGINAL, method.original());
        }
        AttributesBuilder metricAttrs = Attributes.builder().put(HTTP_METHOD, method.value());
        if (uri.getHost() != null) {
            spanBuilder.setAttribute(SERVER_ADDRESS, uri.getHost());
            metricAttrs.put(SERVER_ADDRESS, uri.getHost());
        }
        if (port > 0) {
            spanBuilder.setAttribute(SERVER_PORT, (long) port);
            metricAttrs.put(SERVER_PORT, (long) port);
        }
        if (peerService != null && !peerService.isEmpty()) {
            spanBuilder.setAttribute(PEER_SERVICE, peerService);
        }
        return new Call(request, spanBuilder.startSpan(), metricAttrs, System.nanoTime());
    }

    /** One instrumented request: its span, metric attributes and start time. */
    private final class Call {
        private final HttpRequest request;
        private final Span span;
        private final AttributesBuilder metricAttrs;
        private final long startNanos;

        Call(HttpRequest request, Span span, AttributesBuilder metricAttrs, long startNanos) {
            this.request = request;
            this.span = span;
            this.metricAttrs = metricAttrs;
            this.startNanos = startNanos;
        }

        /** The request to send, with trace headers injected when the destination allows it. */
        HttpRequest outgoing() {
            return propagatePredicate.test(request.uri())
                    ? injectHeaders(request, Context.current().with(span))
                    : request;
        }

        /** Ends the span and records the duration, from a status code or a failure. */
        void end(int status, Throwable failure) {
            if (failure != null) {
                String errorType = failure.getClass().getName();
                span.setAttribute(ERROR_TYPE, errorType);
                metricAttrs.put(ERROR_TYPE, errorType);
                span.recordException(failure);
                span.setStatus(StatusCode.ERROR, failure.getMessage() == null ? "" : failure.getMessage());
            } else {
                span.setAttribute(HTTP_STATUS, (long) status);
                metricAttrs.put(HTTP_STATUS, (long) status);
                String errorType = HttpSemconv.clientErrorType(status);
                if (errorType != null) {
                    span.setAttribute(ERROR_TYPE, errorType);
                    metricAttrs.put(ERROR_TYPE, errorType);
                    span.setStatus(StatusCode.ERROR);
                }
            }
            double seconds = (System.nanoTime() - startNanos) / 1_000_000_000.0;
            duration.record(seconds, metricAttrs.build(), Context.current().with(span));
            span.end();
        }
    }

    private static Throwable unwrap(Throwable failure) {
        Throwable t = failure;
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
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
