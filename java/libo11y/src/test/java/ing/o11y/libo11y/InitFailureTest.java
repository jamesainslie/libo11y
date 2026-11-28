package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Initialisation failures are typed and leave nothing running (G2). */
class InitFailureTest {
    private static O11yOptions.Builder envOptions(Map<String, String> env) {
        return O11yOptions.builder()
                .env(env)
                .serviceName("init-failure")
                .environment("test")
                .serviceVersion("1.0.0")
                .consoleOutput(new ByteArrayOutputStream())
                .runtimeMetrics(false);
    }

    @Test
    void aMalformedLogsEndpointIsATypedErrorAndStartsNoWorker() throws InterruptedException {
        Set<Long> before = TestParts.sdkWorkerThreads();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(envOptions(Map.of(
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "collector:4318/v1/logs")).build()));
        assertEquals(O11yException.ErrorCode.EXPORTER, ex.code());
        assertTrue(ex.getMessage().contains("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"), ex.getMessage());
        assertEquals(Set.of(), TestParts.newSdkWorkersAfter(before, Duration.ofSeconds(5)),
                "an SDK worker survived the failed init");
    }

    @Test
    void anEndpointWithCredentialsIsNotEchoedInTheError() {
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(envOptions(Map.of(
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "ftp://user:hunter2@collector:4318/v1/traces")).build()));
        assertEquals(O11yException.ErrorCode.EXPORTER, ex.code());
        assertFalse(ex.getMessage().contains("hunter2"), ex.getMessage());
    }

    @Test
    void aMissingCertificateFileIsATypedError() {
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(envOptions(Map.of(
                "OTEL_EXPORTER_OTLP_CERTIFICATE", "/nonexistent/libo11y/ca.pem")).build()));
        assertEquals(O11yException.ErrorCode.EXPORTER, ex.code());
        assertTrue(ex.getMessage().contains("OTEL_EXPORTER_OTLP_CERTIFICATE"), ex.getMessage());
    }

    @Test
    void aClientKeyWithoutItsCertificateIsATypedError() {
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(envOptions(Map.of(
                "OTEL_EXPORTER_OTLP_CLIENT_KEY", "/nonexistent/libo11y/client.key")).build()));
        assertEquals(O11yException.ErrorCode.EXPORTER, ex.code());
    }

    @Test
    void aFailureAfterTheExportersAreBuiltStopsThemAndTheInjectedParts() throws InterruptedException {
        // The span pipeline is built from the environment and the metric reader is injected; the
        // log endpoint fails, so everything built or handed over before it must be stopped.
        Set<Long> before = TestParts.sdkWorkerThreads();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(envOptions(Map.of(
                        "OTEL_TRACES_EXPORTER", "otlp",
                        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "not a url"))
                .metricReader(reader)
                .build()));
        assertEquals(O11yException.ErrorCode.EXPORTER, ex.code());
        assertTrue(reader.shutdownCalled(), "the injected reader was leaked");
        assertEquals(Set.of(), TestParts.newSdkWorkersAfter(before, Duration.ofSeconds(5)));
    }

    @Test
    void anIdentityFailureStopsEveryInjectedPart() {
        TestParts.StoppableSpanExporter spans = new TestParts.StoppableSpanExporter();
        TestParts.StoppableSpanProcessor processor = new TestParts.StoppableSpanProcessor();
        TestParts.StoppableReader reader = new TestParts.StoppableReader();
        TestParts.StoppableLogExporter logs = new TestParts.StoppableLogExporter();
        TestParts.StoppableLogProcessor logProcessor = new TestParts.StoppableLogProcessor();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(O11yOptions.builder()
                .hermetic()
                .environment("test")
                .consoleOutput(new ByteArrayOutputStream())
                .spanExporter(spans)
                .addSpanProcessor(processor)
                .metricReader(reader)
                .logRecordExporter(logs)
                .addLogRecordProcessor(logProcessor)
                .build()));
        assertEquals(O11yException.ErrorCode.NO_SERVICE_NAME, ex.code());
        assertTrue(spans.shutdownCalled(), "span exporter");
        assertTrue(processor.shutdownCalled(), "span processor");
        assertTrue(reader.shutdownCalled(), "metric reader");
        assertTrue(logs.shutdownCalled(), "log exporter");
        assertTrue(logProcessor.shutdownCalled(), "log processor");
    }
}
