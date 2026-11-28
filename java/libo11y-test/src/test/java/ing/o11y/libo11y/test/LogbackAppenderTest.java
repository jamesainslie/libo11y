package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.ConsoleAppender;
import ch.qos.logback.core.encoder.EchoEncoder;
import ing.o11y.libo11y.Redact;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.logback.O11yLogbackAppender;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

/** The Logback front door: re-entrancy, exceptions, ownership of the root logger, and message scrubbing. */
class LogbackAppenderTest {
    private static final String TEST_CONSOLE = "test-console";

    private Logger root;
    private ConsoleAppender<ILoggingEvent> console;

    @BeforeEach
    void addConsoleAppender() {
        LoggerContext lc = (LoggerContext) LoggerFactory.getILoggerFactory();
        root = lc.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        console = new ConsoleAppender<>();
        console.setName(TEST_CONSOLE);
        console.setContext(lc);
        console.setEncoder(new EchoEncoder<>());
        console.start();
        root.addAppender(console);
    }

    @AfterEach
    void removeConsoleAppender() {
        O11yLogbackAppender.uninstall();
        root.detachAppender(console);
        console.stop();
    }

    private static List<StructuredLogger.LogEntry> withMessage(O11yRecorder rec, String message) {
        return rec.entries().stream().filter(e -> message.equals(e.message())).toList();
    }

    @Test
    void aLogLineEmittedWhileAppendingDoesNotRecurse() {
        AtomicInteger calls = new AtomicInteger();
        try (O11yRecorder rec = O11yRecorder.start(b -> b.addExtraLogSink(e -> {
                    if (calls.incrementAndGet() < 50) {
                        LoggerFactory.getLogger("inside.sink").info("from the sink");
                    }
                }));
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            LoggerFactory.getLogger("demo").info("outer");
            assertEquals(1, withMessage(rec, "outer").size());
            assertEquals(0, withMessage(rec, "from the sink").size());
            assertEquals(1, calls.get());
        }
    }

    @Test
    void anErrorWithAThrowableCarriesErrorTypeAndStacktrace() {
        try (O11yRecorder rec = O11yRecorder.start();
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            LoggerFactory.getLogger("demo").error("payment failed", new IllegalStateException("card declined"));
            StructuredLogger.LogEntry entry = withMessage(rec, "payment failed").get(0);
            assertEquals(IllegalStateException.class.getName(), entry.attributes().get("error.type"));
            assertEquals(IllegalStateException.class.getName(), entry.attributes().get("exception.type"));
            assertEquals("card declined", entry.attributes().get("exception.message"));
            String stack = (String) entry.attributes().get("exception.stacktrace");
            assertNotNull(stack);
            assertTrue(stack.contains("anErrorWithAThrowableCarriesErrorTypeAndStacktrace"), stack);

            LoggerFactory.getLogger("demo").warn("retrying", new IllegalStateException("blip"));
            StructuredLogger.LogEntry warn = withMessage(rec, "retrying").get(0);
            assertNull(warn.attributes().get("error.type"), "error.type belongs to ERROR records");
            assertNotNull(warn.attributes().get("exception.stacktrace"));
        }
    }

    @Test
    void eachInstallationOwnsOnlyItsOwnAppender() {
        try (O11yRecorder first = O11yRecorder.start();
                O11yRecorder second = O11yRecorder.start()) {
            O11yLogbackAppender a = O11yLogbackAppender.install(first.telemetry());
            O11yLogbackAppender b = O11yLogbackAppender.install(second.telemetry());
            LoggerFactory.getLogger("demo").info("both");
            assertEquals(1, withMessage(first, "both").size());
            assertEquals(1, withMessage(second, "both").size());

            a.close();
            LoggerFactory.getLogger("demo").info("second only");
            assertEquals(0, withMessage(first, "second only").size());
            assertEquals(1, withMessage(second, "second only").size());

            a.close();
            LoggerFactory.getLogger("demo").info("still second");
            assertEquals(1, withMessage(second, "still second").size());
            b.close();
            LoggerFactory.getLogger("demo").info("nobody");
            assertEquals(0, withMessage(second, "nobody").size());
        }
    }

    @Test
    void consoleAppendersAreDetachedWhileTheConsoleLegIsOnAndRestoredOnClose() {
        try (O11yRecorder rec = O11yRecorder.start()) {
            O11yLogbackAppender appender = O11yLogbackAppender.install(rec.telemetry());
            assertNull(root.getAppender(TEST_CONSOLE));
            appender.close();
            assertSame(console, root.getAppender(TEST_CONSOLE));
        }
    }

    @Test
    void consoleAppendersStayWhenTheConsoleLegIsOff() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.consoleEnabled(false));
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            assertSame(console, root.getAppender(TEST_CONSOLE));
        }
        assertSame(console, root.getAppender(TEST_CONSOLE));
    }

    record Customer(String id, @Redact.O11yRedact(Redact.Mode.MASK) String cardNumber) {}

    @Test
    void messageArgumentsAreScrubbedBeforeFormatting() {
        try (O11yRecorder rec = O11yRecorder.start();
                O11yLogbackAppender ignored = O11yLogbackAppender.install(rec.telemetry())) {
            LoggerFactory.getLogger("demo").info("customer {} paid", new Customer("c1", "4111111111114242"));
            StructuredLogger.LogEntry entry = rec.entries().stream()
                    .filter(e -> e.message().startsWith("customer "))
                    .findFirst()
                    .orElseThrow();
            assertFalse(entry.message().contains("4111111111114242"), entry.message());
            assertTrue(entry.message().contains("****4242"), entry.message());
        }
    }
}
