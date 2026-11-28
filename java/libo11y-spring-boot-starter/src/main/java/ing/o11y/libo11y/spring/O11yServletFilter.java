package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.http.PathMatcher;
import ing.o11y.libo11y.internal.HttpSemconv;
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
import jakarta.servlet.AsyncContext;
import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpServletResponseWrapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.async.CallableProcessingInterceptor;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.util.WebUtils;

/**
 * Spring MVC / Jakarta Servlet filter implementing the libo11y HTTP server contract:
 * route-aware span names, stable HTTP semconv, {@code publicEndpoint} link mode,
 * {@code ignorePaths}, {@code Server-Timing}, {@code http.server.request.duration} with exemplars,
 * and {@code o11y.request.summary} wide-event canonical lines.
 *
 * <p>Each request gets exactly one {@code SERVER} span, one duration measurement and, when the
 * canonical line is on, one summary, all finished when the response is complete. For an
 * asynchronous request ({@code Callable}, {@code DeferredResult}, {@code CompletableFuture},
 * SSE) that is when the async cycle ends, not when the first dispatch returns. The filter also
 * runs on {@code ASYNC} and {@code ERROR} dispatches, never to start a second span, only to make
 * the request's span, baggage and {@link O11yRecord} current while they run.
 *
 * <p>{@code ignorePaths} patterns use Go {@code path.Match} syntax and are matched against the
 * percent-decoded path within the application: the request URI without the context path and
 * without {@code ;} path parameters, so {@code /healthz} ignores {@code /app/healthz} in an
 * application deployed at {@code /app}. Malformed patterns are rejected when the filter is built.
 */
public final class O11yServletFilter extends OncePerRequestFilter {
    /** Request attribute holding the request's {@link Exchange} across dispatches. */
    static final String EXCHANGE_ATTRIBUTE = O11yServletFilter.class.getName() + ".EXCHANGE";

    private static final AttributeKey<String> HTTP_METHOD = AttributeKey.stringKey("http.request.method");
    private static final AttributeKey<String> HTTP_METHOD_ORIGINAL =
            AttributeKey.stringKey("http.request.method_original");
    private static final AttributeKey<String> HTTP_ROUTE = AttributeKey.stringKey("http.route");
    private static final AttributeKey<Long> HTTP_STATUS = AttributeKey.longKey("http.response.status_code");
    private static final AttributeKey<String> URL_PATH = AttributeKey.stringKey("url.path");
    private static final AttributeKey<String> URL_SCHEME = AttributeKey.stringKey("url.scheme");
    private static final AttributeKey<String> SERVER_ADDRESS = AttributeKey.stringKey("server.address");
    private static final AttributeKey<Long> SERVER_PORT = AttributeKey.longKey("server.port");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");
    private static final String SERVER_TIMING = "Server-Timing";

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
    private final List<String> ignorePaths;

    /**
     * Builds the filter from {@code config}.
     *
     * @throws IllegalArgumentException if an {@code ignorePaths} pattern is malformed
     */
    public O11yServletFilter(Telemetry telemetry, O11yProperties.Http config) {
        try {
            PathMatcher.validateAll(config.getIgnorePaths());
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("invalid libo11y.http.ignore-paths: " + ex.getMessage(), ex);
        }
        this.ignorePaths = List.copyOf(config.getIgnorePaths());
        this.telemetry = telemetry;
        this.tracer = telemetry.tracer("libo11y.spring.http.server");
        this.duration = telemetry.meter("libo11y.spring.http.server")
                .histogramBuilder("http.server.request.duration")
                .setDescription("Duration of HTTP server requests.")
                .setUnit("s")
                .setExplicitBucketBoundariesAdvice(HttpSemconv.DURATION_BUCKETS)
                .build();
        this.config = config;
    }

    /** Async dispatches run with the request's context current; they never start a span. */
    @Override
    protected boolean shouldNotFilterAsyncDispatch() {
        return false;
    }

    /** Error dispatches of a request still in flight run with its context current. */
    @Override
    protected boolean shouldNotFilterErrorDispatch() {
        return false;
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        if (request.getDispatcherType() != DispatcherType.REQUEST) {
            Exchange exchange = request.getAttribute(EXCHANGE_ATTRIBUTE) instanceof Exchange e ? e : null;
            if (exchange == null || exchange.finished.get()) {
                filterChain.doFilter(request, response);
            } else {
                exchange.run(request, exchange.wrap(response), filterChain);
            }
            return;
        }
        if (PathMatcher.matchesAny(ignorePaths, pathWithinApplication(request))) {
            filterChain.doFilter(request, response);
            return;
        }
        Exchange exchange = start(request, response);
        request.setAttribute(EXCHANGE_ATTRIBUTE, exchange);
        exchange.run(request, exchange.wrap(response), filterChain);
    }

    private Exchange start(HttpServletRequest request, HttpServletResponse response) {
        Context extracted = telemetry.propagators().getTextMapPropagator()
                .extract(Context.root(), request, SERVLET_GETTER);
        SpanContext inboundSpan = Span.fromContext(extracted).getSpanContext();
        Baggage inboundBaggage = Baggage.fromContext(extracted);

        HttpSemconv.Method method = HttpSemconv.method(request.getMethod());
        String path = request.getRequestURI();
        SpanBuilder sb = tracer.spanBuilder(method.spanName())
                .setSpanKind(SpanKind.SERVER)
                .setAttribute(HTTP_METHOD, method.value())
                .setAttribute(URL_PATH, path)
                .setAttribute(URL_SCHEME, request.getScheme());
        if (method.original() != null) {
            sb.setAttribute(HTTP_METHOD_ORIGINAL, method.original());
        }
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
        Context context = baseCtx.with(span);
        O11yRecord record = null;
        if (config.isCanonicalLine()) {
            record = O11yRecord.create(telemetry, Spec.Events.REQUEST_SUMMARY);
            record.set("http.request.method", method.value());
            if (method.original() != null) {
                record.set("http.request.method_original", method.original());
            }
            record.set("url.path", path);
            context = context.with(record);
        }
        ServerTiming timing = config.isServerTiming() ? ServerTiming.forSpan(span.getSpanContext()) : null;
        return new Exchange(request, response, method, span, context, record, timing, System.nanoTime());
    }

    /**
     * The state of one instrumented request, kept as a request attribute so the async and error
     * dispatches, the async listener and {@code Callable} execution share it.
     */
    final class Exchange implements AsyncListener {
        private final HttpServletRequest request;
        private final HttpServletResponse response;
        private final HttpSemconv.Method method;
        private final Span span;
        private final Context context;
        private final O11yRecord record;
        private final ServerTiming timing;
        private final long startNanos;
        private final AtomicBoolean finished = new AtomicBoolean(false);
        private volatile Throwable asyncFailure;
        private volatile AsyncContext listening;

        Exchange(
                HttpServletRequest request,
                HttpServletResponse response,
                HttpSemconv.Method method,
                Span span,
                Context context,
                O11yRecord record,
                ServerTiming timing,
                long startNanos) {
            this.request = request;
            this.response = response;
            this.method = method;
            this.span = span;
            this.context = context;
            this.record = record;
            this.timing = timing;
            this.startNanos = startNanos;
        }

        Context context() {
            return context;
        }

        HttpServletResponse wrap(HttpServletResponse target) {
            if (timing == null || WebUtils.getNativeResponse(target, ServerTimingResponse.class) != null) {
                return target;
            }
            return new ServerTimingResponse(target, timing);
        }

        /**
         * Runs one dispatch of the request with its context current. The request finishes when a
         * dispatch fails or ends without starting (or restarting) async processing; otherwise the
         * async listener finishes it when the async cycle completes.
         */
        void run(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
                throws ServletException, IOException {
            Throwable failure = null;
            try (Scope ignored = context.makeCurrent()) {
                chain.doFilter(req, res);
            } catch (Throwable ex) {
                failure = ex;
                throw ex;
            } finally {
                if (failure == null && req.isAsyncStarted()) {
                    listen(req.getAsyncContext());
                } else {
                    if (timing != null && !res.isCommitted()) {
                        timing.decide(res);
                    }
                    finish(failure);
                }
            }
        }

        private void listen(AsyncContext asyncContext) {
            if (listening != asyncContext) {
                listening = asyncContext;
                asyncContext.addListener(this, request, response);
            }
        }

        @Override
        public void onComplete(AsyncEvent event) {
            finish(asyncFailure);
        }

        @Override
        public void onTimeout(AsyncEvent event) {
            // The final status, set by whoever handles the timeout, is recorded on completion.
        }

        @Override
        public void onError(AsyncEvent event) {
            if (event != null && event.getThrowable() != null) {
                asyncFailure = event.getThrowable();
            }
        }

        @Override
        public void onStartAsync(AsyncEvent event) {
            // A restarted async cycle drops its listeners; stay registered for the final one.
            if (event != null && event.getAsyncContext() != null) {
                listening = event.getAsyncContext();
                event.getAsyncContext().addListener(this, request, response);
            }
        }

        private void finish(Throwable failure) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            try (Scope ignored = context.makeCurrent()) {
                int status = failure != null && response.getStatus() < 400 ? 500 : response.getStatus();
                Object routeAttr = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
                String route = routeAttr != null && !routeAttr.toString().isEmpty() ? routeAttr.toString() : null;
                if (route != null) {
                    span.setAttribute(HTTP_ROUTE, route);
                    span.updateName(method.spanName() + " " + route);
                }
                span.setAttribute(HTTP_STATUS, (long) status);
                String errorType;
                if (failure != null) {
                    errorType = failure.getClass().getName();
                    span.recordException(failure);
                    span.setStatus(StatusCode.ERROR, failure.getMessage() == null ? "" : failure.getMessage());
                } else {
                    errorType = HttpSemconv.serverErrorType(status);
                    if (errorType != null) {
                        span.setStatus(StatusCode.ERROR);
                    }
                }
                if (errorType != null) {
                    span.setAttribute(ERROR_TYPE, errorType);
                }

                double seconds = (System.nanoTime() - startNanos) / 1_000_000_000.0;
                AttributesBuilder metricAttrs = Attributes.builder()
                        .put(HTTP_METHOD, method.value())
                        .put(HTTP_STATUS, (long) status)
                        .put(URL_SCHEME, request.getScheme());
                if (route != null) {
                    metricAttrs.put(HTTP_ROUTE, route);
                }
                if (errorType != null) {
                    metricAttrs.put(ERROR_TYPE, errorType);
                }
                duration.record(seconds, metricAttrs.build(), Context.current());

                if (record != null) {
                    if (route != null) {
                        record.set("http.route", route);
                    }
                    record.set("http.response.status_code", (long) status);
                    record.set(Spec.Attributes.DURATION, seconds);
                    if (failure != null) {
                        record.recordError(failure);
                    } else {
                        record.setOutcome(status >= 500 ? Spec.Outcome.FAILURE : Spec.Outcome.SUCCESS);
                    }
                    record.close();
                }
            } finally {
                span.end();
            }
        }
    }

    /**
     * Makes the request's span, baggage and record current while a {@code Callable} returned by a
     * controller runs on the MVC task executor. Registered by the auto-configuration.
     */
    static final class ContextPropagatingCallableInterceptor implements CallableProcessingInterceptor {
        private static final String SCOPE_ATTRIBUTE = ContextPropagatingCallableInterceptor.class.getName() + ".SCOPE";

        @Override
        public <T> void preProcess(NativeWebRequest request, Callable<T> task) {
            if (request.getAttribute(EXCHANGE_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST) instanceof Exchange exchange) {
                request.setAttribute(SCOPE_ATTRIBUTE, exchange.context().makeCurrent(), RequestAttributes.SCOPE_REQUEST);
            }
        }

        @Override
        public <T> void postProcess(NativeWebRequest request, Callable<T> task, Object concurrentResult) {
            if (request.getAttribute(SCOPE_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST) instanceof Scope scope) {
                request.removeAttribute(SCOPE_ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
                scope.close();
            }
        }
    }

    /**
     * Decides once, as the response headers are about to be committed, whether to add the
     * {@code Server-Timing} entry: only when the response's {@code Content-Type} is
     * {@code text/html}.
     */
    static final class ServerTiming {
        private final String entry;
        private final AtomicBoolean decided = new AtomicBoolean(false);

        private ServerTiming(String entry) {
            this.entry = entry;
        }

        static ServerTiming forSpan(SpanContext sc) {
            if (!sc.isValid()) {
                return null;
            }
            return new ServerTiming("traceparent;desc=\"00-" + sc.getTraceId() + "-" + sc.getSpanId()
                    + "-" + sc.getTraceFlags().asHex() + "\"");
        }

        void decide(HttpServletResponse target) {
            if (decided.compareAndSet(false, true) && !target.isCommitted() && isHtml(target.getContentType())) {
                target.addHeader(SERVER_TIMING, entry);
            }
        }

        void reset() {
            decided.set(false);
        }

        static boolean isHtml(String contentType) {
            if (contentType == null) {
                return false;
            }
            int semi = contentType.indexOf(';');
            String media = (semi >= 0 ? contentType.substring(0, semi) : contentType).trim();
            return media.toLowerCase(Locale.ROOT).equals("text/html");
        }
    }

    /**
     * Adds the {@code Server-Timing} entry at the moment the handler starts the body or commits
     * the response: when it first obtains the output stream or writer, flushes, sends an error or
     * a redirect. Spring MVC sets {@code Content-Type} before any of these. A handler that does
     * none of them is decided when its dispatch ends, while the headers can still change.
     */
    static final class ServerTimingResponse extends HttpServletResponseWrapper {
        private final ServerTiming timing;

        ServerTimingResponse(HttpServletResponse response, ServerTiming timing) {
            super(response);
            this.timing = timing;
        }

        private void decide() {
            timing.decide((HttpServletResponse) getResponse());
        }

        @Override
        public ServletOutputStream getOutputStream() throws IOException {
            decide();
            return super.getOutputStream();
        }

        @Override
        public PrintWriter getWriter() throws IOException {
            decide();
            return super.getWriter();
        }

        @Override
        public void flushBuffer() throws IOException {
            decide();
            super.flushBuffer();
        }

        @Override
        public void sendError(int sc) throws IOException {
            decide();
            super.sendError(sc);
        }

        @Override
        public void sendError(int sc, String msg) throws IOException {
            decide();
            super.sendError(sc, msg);
        }

        @Override
        public void sendRedirect(String location) throws IOException {
            decide();
            super.sendRedirect(location);
        }

        @Override
        public void sendRedirect(String location, int sc, boolean clearBuffer) throws IOException {
            decide();
            super.sendRedirect(location, sc, clearBuffer);
        }

        @Override
        public void reset() {
            super.reset();
            timing.reset();
        }
    }

    /**
     * The percent-decoded (UTF-8) request path within the application, the equivalent of Go's
     * {@code r.URL.Path}: the request URI without the context path and without {@code ;} path
     * parameters.
     */
    static String pathWithinApplication(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null) {
            return "";
        }
        String contextPath = request.getContextPath();
        if (contextPath != null && !contextPath.isEmpty() && uri.startsWith(contextPath)) {
            uri = uri.substring(contextPath.length());
        }
        return percentDecode(stripPathParameters(uri));
    }

    private static String stripPathParameters(String path) {
        if (path.indexOf(';') < 0) {
            return path;
        }
        StringBuilder out = new StringBuilder(path.length());
        boolean inParameter = false;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '/') {
                inParameter = false;
            } else if (c == ';') {
                inParameter = true;
            }
            if (!inParameter) {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static String percentDecode(String path) {
        if (path.indexOf('%') < 0) {
            return path;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(path.length());
        int i = 0;
        while (i < path.length()) {
            int c = path.codePointAt(i);
            int hi = c == '%' && i + 2 < path.length() ? Character.digit(path.charAt(i + 1), 16) : -1;
            int lo = hi >= 0 ? Character.digit(path.charAt(i + 2), 16) : -1;
            if (lo >= 0) {
                bytes.write((hi << 4) | lo);
                i += 3;
            } else {
                byte[] encoded = Character.toString(c).getBytes(StandardCharsets.UTF_8);
                bytes.write(encoded, 0, encoded.length);
                i += Character.charCount(c);
            }
        }
        return bytes.toString(StandardCharsets.UTF_8);
    }
}
