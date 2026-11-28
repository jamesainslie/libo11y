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
    void tierZeroIdentityValidationAndStrictOptOut() {
        O11yException noSvc = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().environment("production").hermetic().build()));
        assertEquals(O11yException.ErrorCode.NO_SERVICE_NAME, noSvc.code());

        O11yException noEnv = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().serviceName("billing").hermetic().build()));
        assertEquals(O11yException.ErrorCode.NO_ENVIRONMENT, noEnv.code());

        O11yException badEnv = assertThrows(O11yException.class, () -> O11y.init(
                O11yOptions.builder().serviceName("billing").environment("mars").hermetic().build()));
        assertEquals(O11yException.ErrorCode.INVALID_ENVIRONMENT, badEnv.code());

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

    @Test
    void setupCanaryDoubleSetupAndRejectingSink() {
        List<ing.o11y.libo11y.StructuredLogger.LogEntry> captured = new java.util.concurrent.CopyOnWriteArrayList<>();
        try (Telemetry t = O11y.setup(O11yOptions.builder()
                .serviceName("checkout")
                .environment("production")
                .hermetic()
                .runtimeMetrics(false)
                .consoleEnabled(false)
                .addExtraLogSink(captured::add)
                .build())) {
            assertEquals(1, captured.size());
            assertEquals(Spec.Events.TELEMETRY_CONFIGURED, captured.get(0).eventName());

            O11yException dup = assertThrows(O11yException.class, () -> O11y.setup(
                    O11yOptions.builder().serviceName("checkout").environment("production").hermetic().build()));
            assertEquals(O11yException.ErrorCode.ALREADY_SETUP, dup.code());

            ShutdownReport r1 = t.shutdown(Duration.ofSeconds(2));
            ShutdownReport r2 = t.shutdown(Duration.ofSeconds(2));
            assertTrue(r1.isOk());
            assertEquals(r1, r2);
        }

        // Rejecting console sink fails setup with CANARY_REJECTED
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

    @Test
    void sensitivityPolicyAcrossSpansLogsMetricsAndAppRegistry() {
        String appRegYaml = """
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

        try (O11yRecorder rec = O11yRecorder.start(b -> b
                .piiMode(PiiMode.HASH)
                .piiHashKey(HASH_KEY)
                .addAppRegistryYaml(appRegYaml, "inline.yaml"))) {
            Telemetry t = rec.telemetry();
            Span span = t.tracer("test").spanBuilder("op")
                    .setAttribute("http.request.header.authorization", "Bearer secret")
                    .setAttribute("acme.card_cvv", "999")
                    .setAttribute("acme.customer_email", "alice@example.com")
                    .setAttribute("acme.plan", "pro")
                    .startSpan();
            try (Scope ignored = span.makeCurrent()) {
                t.logger().info("checked", Map.of(
                        "acme.card_cvv", "999",
                        "acme.customer_email", "alice@example.com",
                        "acme.plan", "pro"));
                t.meter("test").counterBuilder("acme.orders").build().add(1L, Attributes.of(
                        AttributeKey.stringKey("acme.card_cvv"), "999",
                        AttributeKey.stringKey("acme.customer_email"), "alice@example.com",
                        AttributeKey.stringKey("acme.plan"), "pro"),
                        Context.current());
            } finally {
                span.end();
            }

            SpanData sp = rec.spans().get(0);
            assertNull(sp.getAttributes().get(AttributeKey.stringKey("http.request.header.authorization")));
            assertNull(sp.getAttributes().get(AttributeKey.stringKey("acme.card_cvv")));
            String hashedEmail = sp.getAttributes().get(AttributeKey.stringKey("acme.customer_email"));
            assertNotNull(hashedEmail);
            assertTrue(hashedEmail.startsWith("hmac-sha256:"));
            assertEquals("pro", sp.getAttributes().get(AttributeKey.stringKey("acme.plan")));

            // Log entry got hashed PII and dropped secret
            var entry = rec.entries().get(0);
            assertFalse(entry.attributes().containsKey("acme.card_cvv"));
            assertEquals(hashedEmail, entry.attributes().get("acme.customer_email"));

            // Metric dropped BOTH secret AND PII even in HASH mode!
            MetricData orders = rec.metrics().stream()
                    .filter(m -> "acme.orders".equals(m.getName()))
                    .findFirst()
                    .orElseThrow();
            PointData pt = orders.getData().getPoints().iterator().next();
            assertNull(pt.getAttributes().get(AttributeKey.stringKey("acme.card_cvv")));
            assertNull(pt.getAttributes().get(AttributeKey.stringKey("acme.customer_email")));
            assertEquals("pro", pt.getAttributes().get(AttributeKey.stringKey("acme.plan")));

            rec.assertConforms();
            rec.assertTriangle(sp.getTraceId());
        }
    }

    record Customer(
            String id,
            @Redact.O11yRedact(Redact.Mode.MASK) String cardNumber,
            @Redact.O11yRedact(Redact.Mode.SECRET) String password,
            @Redact.O11yRedact(Redact.Mode.OMIT) String internalToken) {}

    @Test
    void captureTimeRedactionForceEmitAndRecord(O11yRecorder rec) {
        assertEquals(Redact.REDACTED, Redact.Secret.of("top-secret").toString());
        assertEquals("****4242", Redact.Masked.of("4111-1111-1111-4242").toString());

        @SuppressWarnings("unchecked")
        Map<String, Object> scrubbed = (Map<String, Object>) Redact.scrub(
                new Customer("c1", "411111114242", "hunter2", "tok"));
        assertEquals("c1", scrubbed.get("id"));
        assertEquals("****4242", scrubbed.get("cardNumber"));
        assertEquals(Redact.REDACTED, scrubbed.get("password"));
        assertFalse(scrubbed.containsKey("internalToken"));

        // Cyclic map fails closed
        Map<String, Object> cyclic = new LinkedHashMap<>();
        cyclic.put("self", cyclic);
        @SuppressWarnings("unchecked")
        Map<String, Object> scrubbedCycle = (Map<String, Object>) Redact.scrub(cyclic);
        assertEquals(Redact.REDACTED, scrubbedCycle.get("self"));

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

        // O11yRecord wide event + O11yExtension triangle check
        Telemetry t = rec.telemetry();
        Span span = t.tracer("checkout").spanBuilder("checkout.place").startSpan();
        String traceId = span.getSpanContext().getTraceId();
        try (Scope ignored = span.makeCurrent();
                O11yRecord wide = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
            O11yRecord.current().set("order.id", "ord-42").setOutcome(Spec.Outcome.SUCCESS);
            DoubleHistogram hist = t.meter("checkout").histogramBuilder("checkout.duration").setUnit("s").build();
            hist.record(0.123, Attributes.of(AttributeKey.stringKey("region"), "us-east"), Context.current());
        } finally {
            span.end();
        }
        rec.assertConforms();
        rec.assertTriangle(traceId);
    }

    @Test
    void detachedProcLogbackJdbcAndHttpClient() throws Exception {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.baggageEgressAllow("tenant"::equals))) {
            Telemetry t = rec.telemetry();

            // Detached carrier with egress-filtered baggage
            Span parent = t.tracer("parent").spanBuilder("enqueue").startSpan();
            Detached.Carrier carrier;
            Map<String, String> procEnv = new HashMap<>();
            try (Scope ignored = Context.current()
                    .with(parent)
                    .with(Baggage.builder().put("tenant", "t1").put("secret_bag", "nope").build())
                    .makeCurrent()) {
                carrier = Detached.capture(t);
                Proc.injectEnv(Context.current(), procEnv);
            } finally {
                parent.end();
            }

            // Proc env carries TRACEPARENT only, never baggage
            assertTrue(procEnv.containsKey("TRACEPARENT"));
            assertFalse(procEnv.containsKey("BAGGAGE"));
            Context extractedProc = Proc.extractEnv(procEnv);
            assertEquals(parent.getSpanContext().getTraceId(), Span.fromContext(extractedProc).getSpanContext().getTraceId());

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

            // SQL sanitizer + JDBC DataSource wrapper (parent-gated spans)
            assertEquals("SELECT * FROM users WHERE email = ? AND age > ?",
                    SqlSanitizer.sanitize("postgresql", "SELECT * FROM users WHERE email = 'a@b.com' AND age > 42 -- secret"));
            assertTrue(PathMatcher.match("/actuator/health/*", "/actuator/health/liveness"));
            assertFalse(PathMatcher.match("/actuator/health/*", "/actuator/health/a/b"));

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
                    .filter(s -> "SELECT appdb".equals(s.getName()))
                    .findFirst()
                    .orElseThrow();
            assertEquals("SELECT id FROM orders WHERE customer = ?",
                    dbSpan.getAttributes().get(AttributeKey.stringKey("db.query.text")));

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
