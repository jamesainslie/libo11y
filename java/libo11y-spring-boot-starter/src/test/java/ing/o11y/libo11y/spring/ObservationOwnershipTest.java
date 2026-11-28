package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.micrometer.observation.autoconfigure.ObservationRegistryCustomizer;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClient;

/**
 * With {@code spring-boot-starter-actuator} on the classpath, Boot owns the
 * {@link ObservationRegistry} and libo11y contributes to it, and each HTTP signal has one owner:
 * one SERVER span per request and one CLIENT span per outbound call.
 */
@SpringBootTest(
        classes = ObservationOwnershipTest.App.class,
        properties = {
            "spring.application.name=ownership-api",
            "libo11y.environment=test",
            "libo11y.hermetic=true",
            "libo11y.install-logback-appender=false",
            "libo11y.runtime-metrics=false",
            "libo11y.emit-observation-events=true",
            "management.observations.enable.disabled=false"
        })
@AutoConfigureMockMvc
class ObservationOwnershipTest {
    static final List<ObservationRegistry> CUSTOMIZED = new CopyOnWriteArrayList<>();

    @Configuration(proxyBeanMethods = false)
    @EnableAutoConfiguration
    static class App {
        @RestController
        static class PingController {
            @GetMapping("/ping")
            String ping() {
                return "pong";
            }
        }

        @Bean
        ObservationRegistryCustomizer<ObservationRegistry> recordingCustomizer() {
            return CUSTOMIZED::add;
        }

        @Bean
        Exporters exporters() {
            return new Exporters();
        }

        @Bean
        O11yOptionsCustomizer exportersCustomizer(Exporters exporters) {
            return exporters::apply;
        }

        @Bean
        O11yRecorder ownershipRecorder(Exporters exporters, Telemetry telemetry) {
            return exporters.recorder(telemetry);
        }
    }

    /** In-memory exporters for one application context. */
    static final class Exporters {
        final InMemorySpanExporter spans = InMemorySpanExporter.create();
        final InMemoryMetricReader metrics = InMemoryMetricReader.create();
        final InMemoryLogRecordExporter logs = InMemoryLogRecordExporter.create();
        final ByteArrayOutputStream console = new ByteArrayOutputStream();
        final List<StructuredLogger.LogEntry> entries = new CopyOnWriteArrayList<>();

        void apply(ing.o11y.libo11y.O11yOptions.Builder b) {
            b.consoleOutput(console)
                    .addSpanProcessor(SimpleSpanProcessor.create(spans))
                    .metricReader(metrics)
                    .addLogRecordProcessor(SimpleLogRecordProcessor.create(logs))
                    .addExtraLogSink(entries::add);
        }

        O11yRecorder recorder(Telemetry telemetry) {
            return O11yRecorder.attach(spans, metrics, logs, console, entries, telemetry);
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObservationRegistry observationRegistry;

    @Autowired
    private MeterRegistry meterRegistry;

    @Autowired
    private RestClient.Builder restClientBuilder;

    @Autowired
    private O11yRecorder recorder;

    private com.sun.net.httpserver.HttpServer downstream;
    private final List<String> traceparents = new CopyOnWriteArrayList<>();

    @BeforeEach
    void start() throws Exception {
        recorder.reset();
        downstream = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        downstream.createContext("/downstream", ex -> {
            List<String> values = ex.getRequestHeaders().get("traceparent");
            if (values != null) {
                traceparents.addAll(values);
            }
            byte[] body = "ok".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, body.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        });
        downstream.start();
    }

    @AfterEach
    void stop() {
        downstream.stop(0);
    }

    private static long count(List<SpanData> spans, SpanKind kind) {
        return spans.stream().filter(s -> s.getKind() == kind).count();
    }

    @Test
    void bootConfiguresTheRegistryLibo11yContributesTo() {
        assertTrue(CUSTOMIZED.stream().anyMatch(r -> r == observationRegistry),
                "Boot's ObservationRegistryCustomizers must apply");
        assertTrue(Observation.createNotStarted("disabled.lookup", observationRegistry).isNoop(),
                "management.observations.enable.* must apply");
    }

    @Test
    void eachObservationHandlerRunsOnce() {
        Observation.createNotStarted("orders.lookup", observationRegistry)
                .lowCardinalityKeyValue("store", "primary")
                .observe(() -> { });

        assertEquals(1, recorder.spans().stream().filter(s -> "orders.lookup".equals(s.getName())).count(),
                "spans: " + recorder.spans());
        assertEquals(1, recorder.entries().stream().filter(e -> "orders.lookup".equals(e.eventName())).count(),
                "the libo11y observation handler must be registered once: " + recorder.entries());
        assertEquals(1, meterRegistry.get("orders.lookup").timer().count(),
                "the meter observation handler must be registered once");
    }

    @Test
    void oneServerSpanPerRequest() throws Exception {
        mockMvc.perform(get("/ping")).andExpect(status().isOk());
        assertEquals(1, count(recorder.spans(), SpanKind.SERVER), "spans: " + recorder.spans());
        assertNull(meterRegistry.find("http.server.requests").timer(),
                "libo11y owns HTTP server telemetry, so Spring's server observation must be off");
    }

    @Test
    void oneClientSpanPerCall() {
        String body = restClientBuilder.build().get()
                .uri("http://127.0.0.1:" + downstream.getAddress().getPort() + "/downstream")
                .retrieve()
                .body(String.class);
        assertEquals("ok", body);
        assertEquals(1, count(recorder.spans(), SpanKind.CLIENT), "spans: " + recorder.spans());
        assertEquals(1, traceparents.size(), "traceparent headers: " + traceparents);
        assertNull(meterRegistry.find("http.client.requests").timer(),
                "libo11y owns HTTP client telemetry, so Spring's client observation must be off");
    }

    @Test
    void springOwnsTheSignalsWhenLibo11yHttpInstrumentationIsOff() throws Exception {
        try (ConfigurableApplicationContext context = new SpringApplicationBuilder(App.class)
                .web(WebApplicationType.SERVLET)
                .properties(
                        "server.port=0",
                        "spring.application.name=spring-owned-api",
                        "libo11y.environment=test",
                        "libo11y.hermetic=true",
                        "libo11y.install-logback-appender=false",
                        "libo11y.runtime-metrics=false",
                        "libo11y.http.enabled=false",
                        "libo11y.http.client-enabled=false")
                .run()) {
            Exporters exporters = context.getBean(Exporters.class);
            int port = Integer.parseInt(context.getEnvironment().getProperty("local.server.port", "0"));
            assertTrue(port > 0);
            RestClient client = context.getBean(RestClient.Builder.class).build();
            assertEquals("pong", client.get().uri("http://127.0.0.1:" + port + "/ping").retrieve().body(String.class));

            // The server observation stops after the response is flushed, so wait for its span.
            long deadline = System.nanoTime() + 10_000_000_000L;
            while (count(exporters.spans.getFinishedSpanItems(), SpanKind.SERVER) == 0 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            List<SpanData> spans = List.copyOf(exporters.spans.getFinishedSpanItems());
            assertEquals(1, count(spans, SpanKind.SERVER), "spans: " + spans);
            assertEquals(1, count(spans, SpanKind.CLIENT), "spans: " + spans);
            assertTrue(spans.stream().noneMatch(s -> s.getInstrumentationScopeInfo().getName().startsWith("libo11y.spring")),
                    "libo11y's own HTTP instrumentation must be off: " + spans);
            MeterRegistry meters = context.getBean(MeterRegistry.class);
            assertNotNull(meters.find("http.server.requests").timer());
            assertNotNull(meters.find("http.client.requests").timer());
        }
    }
}
