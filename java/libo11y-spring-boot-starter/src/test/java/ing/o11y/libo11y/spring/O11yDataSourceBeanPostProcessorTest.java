package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.Telemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.AbstractDataSource;

@ExtendWith(OutputCaptureExtension.class)
class O11yDataSourceBeanPostProcessorTest {
    private static final AttributeKey<String> SYSTEM = AttributeKey.stringKey("db.system.name");
    private static final AttributeKey<String> QUERY_TEXT = AttributeKey.stringKey("db.query.text");

    private final InMemorySpanExporter spans = InMemorySpanExporter.create();

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(O11yAutoConfiguration.class))
            .withBean(O11yOptionsCustomizer.class, () -> b -> b.addSpanProcessor(SimpleSpanProcessor.create(spans)))
            .withPropertyValues(
                    "spring.application.name=jdbc-test",
                    "libo11y.environment=staging",
                    "libo11y.hermetic=true",
                    "libo11y.install-global=false",
                    "libo11y.install-logback-appender=false",
                    "libo11y.runtime-metrics=false",
                    "libo11y.console-enabled=false");

    @AfterEach
    void reset() {
        O11y.resetForTesting();
    }

    /** A concrete pool type, as an application would inject it; it counts every connection it opens. */
    static class CountingDataSource extends AbstractDataSource {
        private final AtomicInteger connections = new AtomicInteger();
        private final String url;

        CountingDataSource(String url) {
            this.url = url;
        }

        /** Counts connections through a method, as callers of a proxied pool must. */
        int connectionsOpened() {
            return connections.get();
        }

        @Override
        public Connection getConnection() {
            connections.incrementAndGet();
            return fakeConnection(url);
        }

        @Override
        public Connection getConnection(String username, String password) {
            return getConnection();
        }
    }

    /** A pool type that cannot be subclassed, so only its interfaces can be proxied. */
    static final class FinalDataSource extends AbstractDataSource {
        @Override
        public Connection getConnection() {
            return fakeConnection("jdbc:sqlite:app.db");
        }

        @Override
        public Connection getConnection(String username, String password) {
            return getConnection();
        }
    }

    /** Takes the pool by its concrete type, which a plain {@code DataSource} wrapper would break. */
    record PoolUser(CountingDataSource pool) {}

    @Configuration(proxyBeanMethods = false)
    static class PoolConfig {
        @Bean
        CountingDataSource pool() {
            return new CountingDataSource("jdbc:postgresql://db/app");
        }

        @Bean
        PoolUser poolUser(CountingDataSource pool) {
            return new PoolUser(pool);
        }
    }

    private static Connection fakeConnection(String url) {
        DatabaseMetaData md = (DatabaseMetaData) Proxy.newProxyInstance(
                DatabaseMetaData.class.getClassLoader(), new Class<?>[] {DatabaseMetaData.class},
                (p, m, a) -> m.getName().equals("getURL") ? url : null);
        Statement st = (Statement) Proxy.newProxyInstance(
                Statement.class.getClassLoader(), new Class<?>[] {Statement.class},
                (p, m, a) -> m.getName().equals("execute") ? Boolean.FALSE : null);
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(), new Class<?>[] {Connection.class}, (p, m, a) -> switch (m.getName()) {
                    case "getMetaData" -> md;
                    case "createStatement" -> st;
                    default -> null;
                });
    }

    private SpanData execute(Telemetry telemetry, DataSource ds, String sql) throws SQLException {
        Span parent = telemetry.tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            st.execute(sql);
        } finally {
            parent.end();
        }
        List<SpanData> db = spans.getFinishedSpanItems().stream()
                .filter(s -> !s.getName().equals("parent"))
                .toList();
        assertEquals(1, db.size(), "db spans: " + db);
        return db.get(0);
    }

    @Test
    void startupOpensNoConnectionAndKeepsTheConcreteType() {
        runner.withUserConfiguration(PoolConfig.class).run(ctx -> {
            CountingDataSource pool = ctx.getBean(CountingDataSource.class);
            assertEquals(0, pool.connectionsOpened(), "startup must not borrow a connection");
            assertSame(pool, ctx.getBean(PoolUser.class).pool());

            SpanData span = execute(ctx.getBean(Telemetry.class), pool, "SELECT * FROM orders WHERE id = 7");

            assertEquals(1, pool.connectionsOpened());
            assertEquals("postgresql", span.getAttributes().get(SYSTEM));
            assertEquals("SELECT * FROM orders WHERE id = ?", span.getAttributes().get(QUERY_TEXT));
        });
    }

    @Test
    void unwrapAndIsWrapperForSeeThroughTheProxy() {
        runner.withUserConfiguration(PoolConfig.class).run(ctx -> {
            CountingDataSource pool = ctx.getBean(CountingDataSource.class);
            assertTrue(pool.isWrapperFor(CountingDataSource.class));
            assertSame(pool, pool.unwrap(CountingDataSource.class));
            assertTrue(pool.isWrapperFor(DataSource.class));
            assertFalse(pool.isWrapperFor(java.sql.Driver.class));
        });
    }

    @Test
    void configuredSystemWinsOverTheUrl() {
        runner.withUserConfiguration(PoolConfig.class)
                .withPropertyValues("libo11y.jdbc.db-system=mysql")
                .run(ctx -> {
                    CountingDataSource pool = ctx.getBean(CountingDataSource.class);
                    SpanData span = execute(ctx.getBean(Telemetry.class), pool, "SELECT * FROM t WHERE a = \"secret\"");
                    assertEquals("mysql", span.getAttributes().get(SYSTEM));
                    assertEquals("SELECT * FROM t WHERE a = ?", span.getAttributes().get(QUERY_TEXT));
                });
    }

    @Test
    void finalPoolClassIsStillInstrumentedThroughItsInterfaces() {
        runner.withBean("pool", FinalDataSource.class, FinalDataSource::new).run(ctx -> {
            DataSource ds = ctx.getBean("pool", DataSource.class);
            assertNotSame(FinalDataSource.class, ds.getClass());
            SpanData span = execute(ctx.getBean(Telemetry.class), ds, "SELECT * FROM t WHERE a = 'secret'");
            assertEquals("sqlite", span.getAttributes().get(SYSTEM));
            assertEquals("SELECT * FROM t WHERE a = ?", span.getAttributes().get(QUERY_TEXT));
        });
    }

    @Test
    void postProcessorCreatesNoBeanEarly(CapturedOutput output) {
        runner.withUserConfiguration(PoolConfig.class).run(ctx -> {
            assertTrue(ctx.getStartupFailure() == null, "context failed: " + ctx.getStartupFailure());
        });
        assertFalse(output.getAll().contains("not eligible for getting processed by all BeanPostProcessors"),
                output.getAll());
    }
}
