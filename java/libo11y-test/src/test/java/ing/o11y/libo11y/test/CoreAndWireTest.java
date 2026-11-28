package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import ing.o11y.libo11y.Detached;
import ing.o11y.libo11y.ForceEmit;
import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.PiiMode;
import ing.o11y.libo11y.Proc;
import ing.o11y.libo11y.Redact;
import ing.o11y.libo11y.ShutdownReport;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.http.O11yHttpClient;
import ing.o11y.libo11y.http.PathMatcher;
import ing.o11y.libo11y.jdbc.O11yDataSource;
import ing.o11y.libo11y.jdbc.SqlSanitizer;
import ing.o11y.libo11y.logback.O11yLogbackAppender;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.slf4j.LoggerFactory;

@ExtendWith(O11yExtension.class)
class CoreAndWireTest {
    private static final byte[] HASH_KEY = "0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8);

    @AfterEach
    void tearDownGlobals() {
        O11yLogbackAppender.uninstall();
        O11y.resetForTesting();
    }

    @Test
    void strictInitWithoutServiceNameFails() {
        O11yException noSvc = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().environment("production").hermetic().build()));
        assertEquals(O11yException.ErrorCode.NO_SERVICE_NAME, noSvc.code());
    }

    @Test
    void strictInitWithoutEnvironmentFails() {
        O11yException noEnv = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().serviceName("billing").hermetic().build()));
        assertEquals(O11yException.ErrorCode.NO_ENVIRONMENT, noEnv.code());
    }

    @Test
    void strictInitWithUnknownEnvironmentFails() {
        O11yException badEnv = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().serviceName("billing").environment("mars").hermetic().build()));
        assertEquals(O11yException.ErrorCode.INVALID_ENVIRONMENT, badEnv.code());
    }

    @Test
    void lenientIdentityStartsAndCountsViolations() {
        // strictIdentity=false allows startup and counts identity_missing violations
        try (O11yRecorder rec = O11yRecorder.start(b -> b
                .serviceName("")
                .environment("")
                .strictIdentity(false))) {
            boolean hasViolations = rec.metrics().stream()
                    .anyMatch(m -> Spec.Metrics.SCHEMA_VIOLATIONS.equals(m.getName()));
            assertTrue(hasViolations);
        }
    }

    private static Telemetry setupCheckout(List<ing.o11y.libo11y.StructuredLogger.LogEntry> captured) {
        return O11y.setup(O11yOptions.builder()
                .serviceName("checkout")
                .environment("production")
                .hermetic()
                .runtimeMetrics(false)
                .consoleEnabled(false)
                .addExtraLogSink(captured::add)
                .build());
    }

    @Test
    void setupEmitsTheConfiguredCanary() {
        List<ing.o11y.libo11y.StructuredLogger.LogEntry> captured = new java.util.concurrent.CopyOnWriteArrayList<>();
        try (Telemetry t = setupCheckout(captured)) {
            assertEquals(1, captured.size());
            assertEquals(Spec.Events.TELEMETRY_CONFIGURED, captured.get(0).eventName());
        }
    }

    @Test
    void secondSetupFailsWithAlreadySetup() {
        try (Telemetry t = setupCheckout(new java.util.concurrent.CopyOnWriteArrayList<>())) {
            O11yException dup = assertThrows(O11yException.class, () -> O11y.setup(
                    O11yOptions.builder().serviceName("checkout").environment("production").hermetic().build()));
            assertEquals(O11yException.ErrorCode.ALREADY_SETUP, dup.code());
        }
    }

    @Test
    void setupShutdownIsIdempotent() {
        try (Telemetry t = setupCheckout(new java.util.concurrent.CopyOnWriteArrayList<>())) {
            ShutdownReport r1 = t.shutdown(Duration.ofSeconds(2));
            ShutdownReport r2 = t.shutdown(Duration.ofSeconds(2));
            assertTrue(r1.isOk());
            assertEquals(r1, r2);
        }
    }

    @Test
    void rejectingConsoleSinkFailsSetupWithCanaryRejected() {
        OutputStream failing = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                throw new IOException("disk full");
            }
        };
        O11yException rejected = assertThrows(O11yException.class, () -> O11y.setup(
                O11yOptions.builder()
                        .serviceName("checkout")
                        .environment("production")
                        .hermetic()
                        .runtimeMetrics(false)
                        .consoleOutput(failing)
                        .build()));
        assertEquals(O11yException.ErrorCode.CANARY_REJECTED, rejected.code());
    }

    private static final String APP_REGISTRY_YAML = """
            schema: libo11y.app-registry/v1
            namespace: acme
            attributes:
              acme.card_cvv:
                type: string
                sensitivity: secret
                cardinality: unbounded
              acme.customer_email:
                type: string
                sensitivity: pii
                cardinality: unbounded
              acme.plan:
                type: string
                sensitivity: public
                cardinality: bounded
            """;

    private static O11yRecorder startHashModeWithAppRegistry() {
        return O11yRecorder.start(b -> b
                .piiMode(PiiMode.HASH)
                .piiHashKey(HASH_KEY)
                .addAppRegistryYaml(APP_REGISTRY_YAML, "inline.yaml"));
    }

    /**
     * Emits the acme checkout on all three signals inside one span. With {@code withSecrets} the
     * code under test also tries to emit the spec secret and the registry secret.
     */
    private static void emitAcmeCheckout(O11yRecorder rec, boolean withSecrets) {
        Telemetry t = rec.telemetry();
        var builder = t.tracer("test").spanBuilder("op")
                .setAttribute("acme.customer_email", "alice@example.com")
                .setAttribute("acme.plan", "pro");
        Map<String, Object> logAttrs = new LinkedHashMap<>();
        var metricAttrs = Attributes.builder();
        if (withSecrets) {
            builder.setAttribute("http.request.header.authorization", "Bearer secret")
                    .setAttribute("acme.card_cvv", "999");
            logAttrs.put("acme.card_cvv", "999");
            metricAttrs.put(AttributeKey.stringKey("acme.card_cvv"), "999");
        }
        logAttrs.put("acme.customer_email", "alice@example.com");
        logAttrs.put("acme.plan", "pro");
        metricAttrs.put(AttributeKey.stringKey("acme.customer_email"), "alice@example.com");
        metricAttrs.put(AttributeKey.stringKey("acme.plan"), "pro");
        Span span = builder.startSpan();
        try (Scope ignored = span.makeCurrent()) {
            t.logger().info("checked", logAttrs);
            t.meter("test").counterBuilder("acme.orders").build().add(1L, metricAttrs.build(), Context.current());
        } finally {
            span.end();
        }
    }

    @Test
    void spanDropsSecretsAndHashesAppRegistryPii() {
        try (O11yRecorder rec = startHashModeWithAppRegistry()) {
            emitAcmeCheckout(rec, true);
            SpanData sp = rec.spans().get(0);
            assertNull(sp.getAttributes().get(AttributeKey.stringKey("http.request.header.authorization")));
            assertNull(sp.getAttributes().get(AttributeKey.stringKey("acme.card_cvv")));
            String hashedEmail = sp.getAttributes().get(AttributeKey.stringKey("acme.customer_email"));
            assertNotNull(hashedEmail);
            assertTrue(hashedEmail.startsWith("hmac-sha256:"));
            assertEquals("pro", sp.getAttributes().get(AttributeKey.stringKey("acme.plan")));
        }
    }

    @Test
    void logEntryDropsSecretAndCarriesTheSameHashAsTheSpan() {
        try (O11yRecorder rec = startHashModeWithAppRegistry()) {
            emitAcmeCheckout(rec, true);
            String hashedEmail = rec.spans().get(0).getAttributes().get(AttributeKey.stringKey("acme.customer_email"));
            // Log entry got hashed PII and dropped secret
            var entry = rec.entries().get(0);
            assertFalse(entry.attributes().containsKey("acme.card_cvv"));
            assertEquals(hashedEmail, entry.attributes().get("acme.customer_email"));
        }
    }

    @Test
    void metricDropsSecretAndPiiEvenInHashMode() {
        try (O11yRecorder rec = startHashModeWithAppRegistry()) {
            emitAcmeCheckout(rec, true);
            // Metric dropped BOTH secret AND PII even in HASH mode!
            MetricData orders = rec.metrics().stream()
                    .filter(m -> "acme.orders".equals(m.getName()))
                    .findFirst()
                    .orElseThrow();
            PointData pt = orders.getData().getPoints().iterator().next();
            assertNull(pt.getAttributes().get(AttributeKey.stringKey("acme.card_cvv")));
            assertNull(pt.getAttributes().get(AttributeKey.stringKey("acme.customer_email")));
            assertEquals("pro", pt.getAttributes().get(AttributeKey.stringKey("acme.plan")));
        }
    }

    @Test
    void conformanceFailsWhenTheCodeEmitsSecretsEvenThoughTheyWereDropped() {
        try (O11yRecorder rec = startHashModeWithAppRegistry()) {
            emitAcmeCheckout(rec, true);
            AssertionError err = assertThrows(AssertionError.class, rec::assertConforms);
            assertTrue(err.getMessage().contains("emitted secret-classified attributes on traces"), err.getMessage());
            assertTrue(err.getMessage().contains("emitted secret-classified attributes on logs"), err.getMessage());
        }
    }

    @Test
    void hashModeCheckoutWithoutSecretsConformsAndClosesTheTriangle() {
        try (O11yRecorder rec = startHashModeWithAppRegistry()) {
            emitAcmeCheckout(rec, false);
            rec.assertConforms();
            rec.assertTriangle(rec.spans().get(0).getTraceId());
        }
    }

    record Customer(
            String id,
            @Redact.O11yRedact(Redact.Mode.MASK) String cardNumber,
            @Redact.O11yRedact(Redact.Mode.SECRET) String password,
            @Redact.O11yRedact(Redact.Mode.OMIT) String internalToken) {}

    @Test
    void secretAndMaskedRenderRedacted() {
        assertEquals(Redact.REDACTED, Redact.Secret.of("top-secret").toString());
        assertEquals("XXXXXXXXXXXXXXXXXXX", Redact.Masked.of("4111-1111-1111-4242").toString());
    }

    @Test
    void scrubHonoursRedactAnnotations() {
        @SuppressWarnings("unchecked")
        Map<String, Object> scrubbed = (Map<String, Object>) Redact.scrub(
                new Customer("c1", "411111114242", "hunter2", "tok"));
        assertEquals("c1", scrubbed.get("id"));
        assertEquals("XXXXXXXXXXXX", scrubbed.get("cardNumber"));
        assertEquals(Redact.REDACTED, scrubbed.get("password"));
        assertFalse(scrubbed.containsKey("internalToken"));
    }

    @Test
    void scrubFailsClosedOnCycles() {
        // Cyclic map fails closed
        Map<String, Object> cyclic = new LinkedHashMap<>();
        cyclic.put("self", cyclic);
        @SuppressWarnings("unchecked")
        Map<String, Object> scrubbedCycle = (Map<String, Object>) Redact.scrub(cyclic);
        assertEquals(Redact.REDACTED, scrubbedCycle.get("self"));
    }

    @Test
    void forceEmitBypassesTheLevelGate() {
        // ForceEmit bypasses WARN level gate
        try (O11yRecorder warnRec = O11yRecorder.start(b -> b.logLevel(Severity.WARN))) {
            warnRec.telemetry().logger().info("suppressed");
            assertEquals(0, warnRec.entries().size());
            try (Scope ignored = ForceEmit.enable()) {
                warnRec.telemetry().logger().info("audit-line", Map.of(Spec.Attributes.RECORD_CLASS, Spec.RecordClass.AUDIT));
            }
            assertEquals(1, warnRec.entries().size());
            assertEquals("audit-line", warnRec.entries().get(0).message());
        }
    }

    @Test
    void wideRecordConformsAndClosesTheTriangle(O11yRecorder rec) {
        // O11yRecord wide event + O11yExtension triangle check
        Telemetry t = rec.telemetry();
        Span span = t.tracer("checkout").spanBuilder("checkout.place").startSpan();
        String traceId = span.getSpanContext().getTraceId();
        try (Scope ignored = span.makeCurrent();
                O11yRecord wide = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
            // The request summary contract requires these; without them assertConforms fails.
            O11yRecord.current()
                    .set("order.id", "ord-42")
                    .set("http.request.method", "POST")
                    .set("http.response.status_code", 201L)
                    .set(Spec.Attributes.DURATION, 0.123)
                    .setOutcome(Spec.Outcome.SUCCESS);
            DoubleHistogram hist = t.meter("checkout").histogramBuilder("checkout.duration").setUnit("s").build();
            hist.record(0.123, Attributes.of(AttributeKey.stringKey("region"), "us-east"), Context.current());
        } finally {
            span.end();
        }
        rec.assertConforms();
        rec.assertTriangle(traceId);
    }

    @Test
    void procEnvCarriesTraceparentOnlyAndRoundTrips() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.baggageEgressAllow("tenant"::equals))) {
            Telemetry t = rec.telemetry();
            Span parent = t.tracer("parent").spanBuilder("enqueue").startSpan();
            Map<String, String> procEnv = new HashMap<>();
            try (Scope ignored = Context.current()
                    .with(parent)
                    .with(Baggage.builder().put("tenant", "t1").put("secret_bag", "nope").build())
                    .makeCurrent()) {
                Proc.injectEnv(Context.current(), procEnv);
            } finally {
                parent.end();
            }

            // Proc env carries TRACEPARENT only, never baggage
            assertTrue(procEnv.containsKey("TRACEPARENT"));
            assertFalse(procEnv.containsKey("BAGGAGE"));
            Context extractedProc = Proc.extractEnv(procEnv);
            assertEquals(parent.getSpanContext().getTraceId(), Span.fromContext(extractedProc).getSpanContext().getTraceId());
        }
    }

    @Test
    void detachedCarrierStartsALinkedRootWithEgressFilteredBaggage() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.baggageEgressAllow("tenant"::equals))) {
            Telemetry t = rec.telemetry();

            // Detached carrier with egress-filtered baggage
            Span parent = t.tracer("parent").spanBuilder("enqueue").startSpan();
            Detached.Carrier carrier;
            try (Scope ignored = Context.current()
                    .with(parent)
                    .with(Baggage.builder().put("tenant", "t1").put("secret_bag", "nope").build())
                    .makeCurrent()) {
                carrier = Detached.capture(t);
            } finally {
                parent.end();
            }

            // Detached unmarshal + linked root span + filtered baggage
            Detached.Carrier restored = Detached.Carrier.unmarshal(carrier.marshal());
            try (Detached.LinkedSpan linked = Detached.startLinked(t, "worker.run", restored)) {
                assertNotEquals(parent.getSpanContext().getTraceId(), linked.span().getSpanContext().getTraceId());
                assertEquals("t1", Baggage.current().getEntryValue("tenant"));
                assertNull(Baggage.current().getEntryValue("secret_bag"));
            }
            SpanData workerSpan = rec.spans().stream().filter(s -> "worker.run".equals(s.getName())).findFirst().orElseThrow();
            assertEquals(1, workerSpan.getLinks().size());
            assertEquals(parent.getSpanContext().getTraceId(), workerSpan.getLinks().get(0).getSpanContext().getTraceId());
        }
    }

    @Test
    void logbackAppenderCorrelatesWithTheActiveSpanAndRedacts(O11yRecorder rec) {
        Telemetry t = rec.telemetry();
        // SLF4J / Logback appender correlates with active span and redacts secret keys
        O11yLogbackAppender.install(t);
        Span logSpan = t.tracer("app").spanBuilder("slf4j-op").startSpan();
        try (Scope ignored = logSpan.makeCurrent()) {
            LoggerFactory.getLogger("demo.Service")
                    .atInfo()
                    .addKeyValue("order.id", "ord-9")
                    .addKeyValue("http.request.header.authorization", "Bearer topsecret")
                    .log("processed order");
        } finally {
            logSpan.end();
            O11yLogbackAppender.uninstall();
        }
        var slf4jEntry = rec.entries().stream()
                .filter(e -> "processed order".equals(e.message()))
                .findFirst()
                .orElseThrow();
        assertEquals(logSpan.getSpanContext().getTraceId(), slf4jEntry.traceId());
        assertEquals("ord-9", slf4jEntry.attributes().get("order.id"));
        assertFalse(slf4jEntry.attributes().containsKey("http.request.header.authorization"));
    }

    @Test
    void sqlSanitizerReplacesLiteralsAndStripsComments() {
        assertEquals("SELECT * FROM users WHERE email = ? AND age > ?  ",
                SqlSanitizer.sanitize("postgresql", "SELECT * FROM users WHERE email = 'a@b.com' AND age > 42 -- secret"));
    }

    @Test
    void pathMatcherStarMatchesOneSegment() {
        assertTrue(PathMatcher.match("/actuator/health/*", "/actuator/health/liveness"));
        assertFalse(PathMatcher.match("/actuator/health/*", "/actuator/health/a/b"));
    }

    @Test
    void dataSourceEmitsSanitizedClientSpansOnlyUnderAParent(O11yRecorder rec) throws Exception {
        Telemetry t = rec.telemetry();
        DataSource fakeDs = fakeDataSource();
        O11yDataSource o11yDs = new O11yDataSource(fakeDs, t, "postgresql", "appdb");
        // Outside parent: no span emitted
        int spansBefore = rec.spans().size();
        try (Connection c = o11yDs.getConnection();
                PreparedStatement ps = c.prepareStatement("SELECT id FROM orders WHERE total = 99")) {
            ps.executeQuery();
        }
        assertEquals(spansBefore, rec.spans().size());

        // Inside parent: CLIENT span emitted with sanitized query
        Span reqSpan = t.tracer("web").spanBuilder("GET /orders").startSpan();
        try (Scope ignored = reqSpan.makeCurrent();
                Connection c = o11yDs.getConnection();
                PreparedStatement ps = c.prepareStatement("SELECT id FROM orders WHERE customer = 'alice'")) {
            ps.executeQuery();
        } finally {
            reqSpan.end();
        }
        SpanData dbSpan = rec.spans().stream()
                .filter(s -> "SELECT orders".equals(s.getName()))
                .findFirst()
                .orElseThrow();
        assertEquals("SELECT id FROM orders WHERE customer = ?",
                dbSpan.getAttributes().get(AttributeKey.stringKey("db.query.text")));
    }

    @Test
    void httpClientInjectsTraceparentAndStripsCredentialsFromUrlFull(O11yRecorder rec) throws Exception {
        Telemetry t = rec.telemetry();
        // O11yHttpClient injects W3C headers and strips credentials from url.full
        AtomicReference<String> receivedTraceparent = new AtomicReference<>();
        HttpServer echo = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        echo.createContext("/ping", ex -> {
            receivedTraceparent.set(ex.getRequestHeaders().getFirst("traceparent"));
            byte[] ok = "ok".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, ok.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(ok);
            }
        });
        echo.start();
        try {
            O11yHttpClient client = new O11yHttpClient(HttpClient.newHttpClient(), t, uri -> true, "echo-svc");
            URI target = URI.create("http://user:pass@127.0.0.1:" + echo.getAddress().getPort() + "/ping?token=xyz");
            HttpResponse<String> resp = client.send(
                    HttpRequest.newBuilder(target).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            assertEquals(200, resp.statusCode());
            assertNotNull(receivedTraceparent.get());
            SpanData httpSpan = rec.spans().stream()
                    .filter(s -> "GET".equals(s.getName()))
                    .findFirst()
                    .orElseThrow();
            String urlFull = httpSpan.getAttributes().get(AttributeKey.stringKey("url.full"));
            assertFalse(urlFull.contains("pass"));
            assertFalse(urlFull.contains("token=xyz"));
            assertEquals("echo-svc", httpSpan.getAttributes().get(AttributeKey.stringKey("peer.service")));
        } finally {
            echo.stop(0);
        }
    }

    @Test
    void otlpHttpWireExportDeliversAllThreeSignals() throws Exception {
        try (OtlpHttpReceiver receiver = OtlpHttpReceiver.start()) {
            Map<String, String> env = Map.of(
                    "OTEL_EXPORTER_OTLP_ENDPOINT", receiver.endpoint(),
                    "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf",
                    "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip",
                    "OTEL_EXPORTER_OTLP_HEADERS", "x-api-key=test-token",
                    "OTEL_METRIC_EXPORT_INTERVAL", "60000");
            Telemetry t = O11y.init(O11yOptions.builder()
                    .serviceName("wire-svc")
                    .environment("production")
                    .env(env)
                    .runtimeMetrics(false)
                    .consoleEnabled(false)
                    .build());

            Span sp = t.tracer("wire").spanBuilder("wire.op").startSpan();
            try (Scope ignored = sp.makeCurrent()) {
                t.logger().info("wire log", Map.of("k", "v"));
                t.meter("wire").counterBuilder("wire.count").build().add(1L, Attributes.empty(), Context.current());
            } finally {
                sp.end();
            }

            ShutdownReport report = t.shutdown(Duration.ofSeconds(5));
            assertTrue(report.isOk(), "shutdown errors: " + report.errors());

            assertFalse(receiver.requestsForPath("/v1/traces").isEmpty(), "expected OTLP /v1/traces");
            assertFalse(receiver.requestsForPath("/v1/metrics").isEmpty(), "expected OTLP /v1/metrics");
            assertFalse(receiver.requestsForPath("/v1/logs").isEmpty(), "expected OTLP /v1/logs");
            assertTrue(receiver.requestsForPath("/v1/traces").get(0).body().length > 0);
            assertEquals(List.of("test-token"), receiver.requestsForPath("/v1/traces").get(0).headers().get("X-api-key"));

            // The payloads decode to the telemetry emitted above.
            assertEquals(List.of(), receiver.decodeFailures());
            assertEquals(sp.getSpanContext().getTraceId(),
                    OtlpHttpReceiver.hex(receiver.span("wire.op").orElseThrow().getTraceId()));
            assertTrue(receiver.logRecords().stream().anyMatch(lr -> "wire log".equals(lr.getBody().getStringValue())));
            assertEquals(1, receiver.metricPoints("wire.count").size());
        }
    }

    private static DataSource fakeDataSource() {
        PreparedStatement ps = (PreparedStatement) Proxy.newProxyInstance(
                PreparedStatement.class.getClassLoader(),
                new Class<?>[] {PreparedStatement.class},
                (proxy, method, args) -> {
                    if ("close".equals(method.getName())) {
                        return null;
                    }
                    if ("executeQuery".equals(method.getName())) {
                        return null;
                    }
                    return null;
                });
        Connection conn = (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                (proxy, method, args) -> {
                    if ("prepareStatement".equals(method.getName())) {
                        return ps;
                    }
                    return null;
                });
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class},
                (proxy, method, args) -> {
                    if ("getConnection".equals(method.getName())) {
                        return conn;
                    }
                    return null;
                });
    }
}
