package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.micrometer.O11yMeterRegistry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@SpringBootTest(
        classes = {SpringBootStarterTest.TestApp.class, SpringBootStarterTest.TestTelemetryConfig.class},
        properties = {
            "spring.application.name=orders-api",
            "libo11y.environment=staging",
            "libo11y.hermetic=true",
            "libo11y.install-global=false",
            "libo11y.install-logback-appender=false",
            "libo11y.runtime-metrics=false",
            "libo11y.http.server-timing=true",
            "libo11y.http.canonical-line=true"
        })
@AutoConfigureMockMvc
class SpringBootStarterTest {

    @SpringBootApplication
    static class TestApp {
        @RestController
        static class OrdersController {
            private final MeterRegistry meterRegistry;
            private final ObservationRegistry observationRegistry;
            private final StructuredLogger logger;

            OrdersController(
                    MeterRegistry meterRegistry,
                    ObservationRegistry observationRegistry,
                    StructuredLogger logger) {
                this.meterRegistry = meterRegistry;
                this.observationRegistry = observationRegistry;
                this.logger = logger;
            }

            @GetMapping("/orders/{id}")
            String getOrder(@PathVariable String id) {
                O11yRecord.current().set("order.id", id);
                logger.info("fetching order", Map.of("order.id", id));
                Counter.builder("orders.fetched").tag("tier", "gold").register(meterRegistry).increment();
                return Observation.createNotStarted("orders.lookup", observationRegistry)
                        .lowCardinalityKeyValue("store", "primary")
                        .observe(() -> "order:" + id);
            }

            @GetMapping("/healthz")
            String healthz() {
                return "ok";
            }
        }
    }

    @Configuration
    static class TestTelemetryConfig {
        private final InMemorySpanExporter spanExporter = InMemorySpanExporter.create();
        private final InMemoryMetricReader metricReader = InMemoryMetricReader.create();
        private final InMemoryLogRecordExporter logExporter = InMemoryLogRecordExporter.create();
        private final ByteArrayOutputStream console = new ByteArrayOutputStream();
        private final List<StructuredLogger.LogEntry> entries = new CopyOnWriteArrayList<>();

        @Bean
        O11yOptionsCustomizer testExportersCustomizer() {
            return b -> b.consoleOutput(console)
                    .addSpanProcessor(SimpleSpanProcessor.create(spanExporter))
                    .metricReader(metricReader)
                    .addLogRecordProcessor(SimpleLogRecordProcessor.create(logExporter))
                    .addExtraLogSink(entries::add);
        }

        @Bean
        O11yRecorder testRecorder(Telemetry telemetry) {
            return O11yRecorder.attach(spanExporter, metricReader, logExporter, console, entries, telemetry);
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private Telemetry telemetry;

    @Autowired
    private MeterRegistry meterRegistry;

    @Autowired
    private O11yRecorder recorder;

    @BeforeEach
    void resetRecorder() {
        recorder.reset();
    }

    @AfterAll
    static void resetGlobals() {
        O11y.resetForTesting();
    }

    @Test
    void springBootAutoConfigurationClosesThreeSignalTriangleEndToEnd() throws Exception {
        assertTrue(meterRegistry instanceof O11yMeterRegistry);
        assertEquals("orders-api", telemetry.resource().getAttribute(AttributeKey.stringKey("service.name")));
        assertEquals("staging", telemetry.resource().getAttribute(AttributeKey.stringKey("deployment.environment.name")));

        String inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        String inboundHeader = "00-" + inboundTraceId + "-00f067aa0ba902b7-01";

        MvcResult result = mockMvc.perform(get("/orders/42").header("traceparent", inboundHeader))
                .andExpect(status().isOk())
                .andExpect(content().string("order:42"))
                .andExpect(header().exists("Server-Timing"))
                .andReturn();

        String serverTiming = result.getResponse().getHeader("Server-Timing");
        assertNotNull(serverTiming);
        assertTrue(serverTiming.contains(inboundTraceId), "Server-Timing should reflect adopted trace: " + serverTiming);

        // Route-aware server span + child Observation span
        SpanData serverSpan = recorder.spans().stream()
                .filter(s -> "GET /orders/{id}".equals(s.getName()))
                .findFirst()
                .orElseThrow();
        assertEquals(inboundTraceId, serverSpan.getTraceId());
        assertEquals("/orders/{id}", serverSpan.getAttributes().get(AttributeKey.stringKey("http.route")));
        assertEquals(200L, serverSpan.getAttributes().get(AttributeKey.longKey("http.response.status_code")));

        SpanData childObsSpan = recorder.spans().stream()
                .filter(s -> "orders.lookup".equals(s.getName()))
                .findFirst()
                .orElseThrow();
        assertEquals(inboundTraceId, childObsSpan.getTraceId());
        assertEquals(serverSpan.getSpanId(), childObsSpan.getParentSpanId());

        // Canonical wide-event line emitted with controller & Observation enrichment
        var summary = recorder.entries().stream()
                .filter(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName()))
                .findFirst()
                .orElseThrow();
        assertEquals(inboundTraceId, summary.traceId());
        assertEquals("42", summary.attributes().get("order.id"));
        assertEquals("/orders/{id}", summary.attributes().get("http.route"));
        assertEquals("primary", summary.attributes().get("store"));
        assertEquals(Spec.Outcome.SUCCESS, summary.attributes().get(Spec.Attributes.OUTCOME));

        // Both HTTP server histogram AND Micrometer counter carry trace exemplars!
        recorder.assertConforms();
        recorder.assertTriangle(inboundTraceId);
        assertTrue(recorder.exemplars().stream()
                .anyMatch(e -> "http.server.request.duration".equals(e.metricName()) && inboundTraceId.equals(e.traceId())));
        assertTrue(recorder.exemplars().stream()
                .anyMatch(e -> "orders.fetched".equals(e.metricName()) && inboundTraceId.equals(e.traceId())));
    }

    @Test
    void ignorePathsProducesNoTelemetry() throws Exception {
        mockMvc.perform(get("/healthz"))
                .andExpect(status().isOk())
                .andExpect(content().string("ok"));

        assertTrue(recorder.spans().isEmpty());
        assertTrue(recorder.entries().isEmpty());
    }

    @Test
    void failureAnalyzerProducesActionableDiagnostics() {
        O11yFailureAnalyzer analyzer = new O11yFailureAnalyzer();
        FailureAnalysis noSvc = analyzer.analyze(new O11yException(O11yException.ErrorCode.NO_SERVICE_NAME, "missing"));
        assertNotNull(noSvc);
        assertTrue(noSvc.getAction().contains("spring.application.name"));

        FailureAnalysis noEnv = analyzer.analyze(new O11yException(O11yException.ErrorCode.NO_ENVIRONMENT, "missing"));
        assertNotNull(noEnv);
        assertTrue(noEnv.getAction().contains("libo11y.environment"));

        assertNotEquals(noSvc.getAction(), noEnv.getAction());
        assertFalse(noSvc.getDescription().isEmpty());
    }

    @Test
    void restClientInterceptorInjectsTraceparentAndStripsCredentials() throws Exception {
        java.util.concurrent.atomic.AtomicReference<String> seenHeader = new java.util.concurrent.atomic.AtomicReference<>();
        com.sun.net.httpserver.HttpServer server = com.sun.net.httpserver.HttpServer.create(
                new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/downstream", ex -> {
            seenHeader.set(ex.getRequestHeaders().getFirst("traceparent"));
            byte[] body = "pong".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, body.length);
            try (java.io.OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });
        server.start();
        try {
            org.springframework.web.client.RestClient client = org.springframework.web.client.RestClient.builder()
                    .requestInterceptor(new O11yRestClientInterceptor(telemetry, uri -> true, "downstream-svc"))
                    .build();
            String url = "http://user:secret@127.0.0.1:" + server.getAddress().getPort() + "/downstream?key=1";
            String resp = client.get().uri(url).retrieve().body(String.class);
            assertEquals("pong", resp);
            assertNotNull(seenHeader.get());
            SpanData clientSpan = recorder.spans().stream()
                    .filter(s -> s.getKind() == io.opentelemetry.api.trace.SpanKind.CLIENT)
                    .findFirst()
                    .orElseThrow();
            String fullUrl = clientSpan.getAttributes().get(AttributeKey.stringKey("url.full"));
            assertFalse(fullUrl.contains("secret"));
            assertFalse(fullUrl.contains("key=1"));
            assertEquals("downstream-svc", clientSpan.getAttributes().get(AttributeKey.stringKey("peer.service")));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void publicEndpointLinksInsteadOfParenting() throws Exception {
        O11yProperties.Http pubCfg = new O11yProperties.Http();
        pubCfg.setPublicEndpoint(true);
        pubCfg.setCanonicalLine(false);
        O11yServletFilter pubFilter = new O11yServletFilter(telemetry, pubCfg);

        org.springframework.mock.web.MockHttpServletRequest req =
                new org.springframework.mock.web.MockHttpServletRequest("GET", "/public");
        String inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        req.addHeader("traceparent", "00-" + inboundTraceId + "-00f067aa0ba902b7-01");
        org.springframework.mock.web.MockHttpServletResponse res =
                new org.springframework.mock.web.MockHttpServletResponse();
        pubFilter.doFilter(req, res, (r, s) -> {});

        SpanData span = recorder.spans().stream().findFirst().orElseThrow();
        assertNotEquals(inboundTraceId, span.getTraceId());
        assertEquals(1, span.getLinks().size());
        assertEquals(inboundTraceId, span.getLinks().get(0).getSpanContext().getTraceId());
    }
}
