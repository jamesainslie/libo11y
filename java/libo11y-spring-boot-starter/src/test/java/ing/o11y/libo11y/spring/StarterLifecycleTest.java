package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.core.Appender;
import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.logback.O11yLogbackAppender;
import ing.o11y.libo11y.micrometer.SensitivityMeterFilter;
import io.micrometer.core.instrument.config.MeterFilter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.json.JsonParserFactory;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

class StarterLifecycleTest {
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(O11yAutoConfiguration.class, O11yObservationAutoConfiguration.class))
            .withPropertyValues(
                    "spring.application.name=lifecycle-api",
                    "libo11y.environment=test",
                    "libo11y.hermetic=true",
                    "libo11y.runtime-metrics=false");

    @AfterEach
    void resetGlobals() {
        O11y.resetForTesting();
    }

    /** Captures each context's console output and log entries. */
    @Configuration(proxyBeanMethods = false)
    static class Capture {
        final ByteArrayOutputStream console = new ByteArrayOutputStream();
        final List<StructuredLogger.LogEntry> entries = new CopyOnWriteArrayList<>();

        @Bean
        O11yOptionsCustomizer captureCustomizer() {
            return b -> b.consoleOutput(console).addExtraLogSink(entries::add);
        }
    }

    private static Logger root() {
        return ((LoggerContext) LoggerFactory.getILoggerFactory()).getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
    }

    private static int libo11yAppenders() {
        int count = 0;
        for (Iterator<Appender<ch.qos.logback.classic.spi.ILoggingEvent>> it = root().iteratorForAppenders(); it.hasNext();) {
            if (it.next() instanceof O11yLogbackAppender) {
                count++;
            }
        }
        return count;
    }

    @Test
    void twoContextsInOneJvmStartWithTheDefaults() {
        runner.run(first -> {
            assertNull(first.getStartupFailure());
            runner.run(second -> {
                assertNull(second.getStartupFailure());
                assertFalse(first.getBean(Telemetry.class) == second.getBean(Telemetry.class));
            });
            assertNull(O11y.global(), "the starter must not install process globals by default");
        });
    }

    @Test
    void installGlobalIsStillAvailableOnRequest() {
        runner.withPropertyValues("libo11y.install-global=true").run(context -> {
            assertNull(context.getStartupFailure());
            assertSame(context.getBean(Telemetry.class), O11y.global());
        });
    }

    @Test
    void eachContextOwnsItsLogbackAppender() {
        int before = libo11yAppenders();
        runner.withUserConfiguration(Capture.class).run(first -> {
            assertEquals(before + 1, libo11yAppenders());
            runner.withUserConfiguration(Capture.class).run(second -> assertEquals(before + 2, libo11yAppenders()));
            assertEquals(before + 1, libo11yAppenders(), "closing one context must leave the other's appender");

            Capture capture = first.getBean(Capture.class);
            capture.entries.clear();
            LoggerFactory.getLogger("lifecycle.check").info("still routed");
            assertTrue(capture.entries.stream().anyMatch(e -> "still routed".equals(e.message())),
                    "the first context must still receive SLF4J logs: " + capture.entries);
        });
        assertEquals(before, libo11yAppenders());
    }

    @Test
    void noAppenderIsInstalledWhenDisabled() {
        int before = libo11yAppenders();
        runner.withPropertyValues("libo11y.install-logback-appender=false")
                .run(context -> assertEquals(before, libo11yAppenders()));
    }

    @Test
    void consoleIsOffByDefaultWhenTheAppenderIsInstalled() {
        runner.withUserConfiguration(Capture.class).run(context -> {
            context.getBean(Telemetry.class).logger().info("console check", Map.of());
            assertEquals("", context.getBean(Capture.class).console.toString(StandardCharsets.UTF_8));
        });
    }

    @Test
    void consoleCanBeTurnedBackOn() {
        runner.withUserConfiguration(Capture.class).withPropertyValues("libo11y.console-enabled=true").run(context -> {
            context.getBean(Telemetry.class).logger().info("console check", Map.of());
            assertTrue(context.getBean(Capture.class).console.toString(StandardCharsets.UTF_8).contains("console check"));
        });
    }

    @Test
    void consoleIsOnByDefaultWithoutTheAppender() {
        runner.withUserConfiguration(Capture.class)
                .withPropertyValues("libo11y.install-logback-appender=false")
                .run(context -> {
                    context.getBean(Telemetry.class).logger().info("console check", Map.of());
                    assertTrue(context.getBean(Capture.class).console.toString(StandardCharsets.UTF_8)
                            .contains("console check"));
                });
    }

    @Configuration(proxyBeanMethods = false)
    static class UserMeterFilter {
        @Bean
        MeterFilter denyNothing() {
            return MeterFilter.acceptNameStartsWith("app.");
        }
    }

    @Test
    void aUserMeterFilterDoesNotRemoveTheSensitivityFilter() {
        runner.withUserConfiguration(UserMeterFilter.class).run(context -> {
            assertNull(context.getStartupFailure());
            assertEquals(1, context.getBeansOfType(SensitivityMeterFilter.class).size());
            assertEquals(2, context.getBeansOfType(MeterFilter.class).size());
        });
    }

    @Configuration(proxyBeanMethods = false)
    static class RejectAudit {
        @Bean
        io.micrometer.observation.ObservationPredicate rejectAudit() {
            return (name, context) -> !name.startsWith("audit.");
        }
    }

    @Test
    void withoutBootObservationTheFallbackRegistryCarriesEachHandlerOnce() {
        runner.withUserConfiguration(Capture.class, RejectAudit.class)
                .withPropertyValues("libo11y.emit-observation-events=true", "libo11y.install-logback-appender=false")
                .run(context -> {
                    io.micrometer.observation.ObservationRegistry registry =
                            context.getBean(io.micrometer.observation.ObservationRegistry.class);
                    io.micrometer.observation.Observation.createNotStarted("orders.lookup", registry)
                            .observe(() -> { });
                    Capture capture = context.getBean(Capture.class);
                    assertEquals(1, capture.entries.stream()
                            .filter(e -> "orders.lookup".equals(e.eventName())).count(), capture.entries.toString());
                    assertEquals(1, context.getBean(io.micrometer.core.instrument.MeterRegistry.class)
                            .get("orders.lookup").timer().count());
                    assertTrue(io.micrometer.observation.Observation.createNotStarted("audit.write", registry).isNoop(),
                            "ObservationPredicate beans must apply to the fallback registry");
                });
    }

    @Test
    void configurationMetadataDescribesEveryProperty() throws IOException {
        String json;
        try (InputStream in = getClass().getClassLoader()
                .getResourceAsStream("META-INF/spring-configuration-metadata.json")) {
            assertNotNull(in, "spring-configuration-metadata.json must be generated");
            json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        Map<String, Object> metadata = JsonParserFactory.getJsonParser().parseMap(json);
        List<?> properties = (List<?>) metadata.get("properties");
        assertFalse(properties.isEmpty());
        List<String> undocumented = new ArrayList<>();
        Map<String, Object> serverTiming = null;
        for (Object p : properties) {
            @SuppressWarnings("unchecked")
            Map<String, Object> property = (Map<String, Object>) p;
            Object description = property.get("description");
            if (!(description instanceof String s) || s.isBlank()) {
                undocumented.add(String.valueOf(property.get("name")));
            }
            if ("libo11y.http.server-timing".equals(property.get("name"))) {
                serverTiming = property;
            }
        }
        assertTrue(undocumented.isEmpty(), "properties without a description: " + undocumented);
        assertNotNull(serverTiming);
        assertEquals(false, serverTiming.get("defaultValue"));
    }
}
