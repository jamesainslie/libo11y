package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.logback.O11yLogbackAppender;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.BatchLogRecordProcessor;
import io.opentelemetry.sdk.logs.export.LogRecordExporter;
import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/**
 * The OpenTelemetry SDK's own diagnostics reach the console leg but not the OTLP log leg, so an
 * exporter failure logged on the batch worker thread cannot feed the queue it failed to drain.
 */
class LogbackExporterLoopTest {
    private static final String SDK_LOGGER = "io.opentelemetry.exporter.otlp.internal.HttpExporter";

    @AfterEach
    void uninstall() {
        O11yLogbackAppender.uninstall();
    }

    private static List<String> bodies(Collection<LogRecordData> logs) {
        return logs.stream().map(l -> l.getBodyValue() == null ? "" : l.getBodyValue().asString()).toList();
    }

    /** Fails every export and logs the failure the way the SDK's OTLP exporter does. */
    private static final class FailingExporter implements LogRecordExporter {
        final List<String> exported = new CopyOnWriteArrayList<>();

        @Override
        public CompletableResultCode export(Collection<LogRecordData> logs) {
            exported.addAll(bodies(logs));
            LoggerFactory.getLogger(SDK_LOGGER).warn("Failed to export logs. The request could not be executed.");
            return CompletableResultCode.ofFailure();
        }

        @Override
        public CompletableResultCode flush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            return CompletableResultCode.ofSuccess();
        }
    }

    @Test
    void sdkDiagnosticsPrintOnTheConsoleButAreNotExported() {
        try (O11yRecorder rec = O11yRecorder.start();
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            LoggerFactory.getLogger(SDK_LOGGER).warn("sdk diagnostic");
            LoggerFactory.getLogger("io.opentelemetry").warn("sdk root diagnostic");
            LoggerFactory.getLogger("io.opentelemetryish.app").info("lookalike namespace");
            LoggerFactory.getLogger("demo").info("application line");

            List<String> exported = bodies(rec.logs());
            assertEquals(List.of("lookalike namespace", "application line"), exported);
            for (String message : List.of("sdk diagnostic", "sdk root diagnostic")) {
                assertTrue(rec.consoleLines().stream().anyMatch(l -> l.contains("\"msg\":\"" + message + "\"")),
                        message + " in " + rec.consoleLines());
                assertTrue(rec.entries().stream().anyMatch(e -> e.message().equals(message)), message);
            }
        }
    }

    @Test
    void anExporterFailureLoggedOnTheWorkerThreadDoesNotRequeueItself() {
        FailingExporter exporter = new FailingExporter();
        try (O11yRecorder rec = O11yRecorder.start(b -> b.addLogRecordProcessor(BatchLogRecordProcessor
                        .builder(exporter)
                        .setScheduleDelay(Duration.ofMillis(5))
                        .build()));
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            LoggerFactory.getLogger("demo").info("application line");
            for (int i = 0; i < 5; i++) {
                rec.telemetry().forceFlush(Duration.ofSeconds(2));
            }
            assertEquals(List.of("application line"), exporter.exported);
        }
    }
}
