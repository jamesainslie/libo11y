package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.jdbc.O11yDataSource;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class O11yDataSourceTest {
    private static final AttributeKey<String> SYSTEM = AttributeKey.stringKey("db.system.name");
    private static final AttributeKey<String> OPERATION = AttributeKey.stringKey("db.operation.name");
    private static final AttributeKey<String> COLLECTION = AttributeKey.stringKey("db.collection.name");
    private static final AttributeKey<String> QUERY_TEXT = AttributeKey.stringKey("db.query.text");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");
    private static final AttributeKey<Long> BATCH_SIZE = AttributeKey.longKey("db.operation.batch.size");

    private O11yRecorder rec;

    @BeforeEach
    void start() {
        rec = O11yRecorder.start();
    }

    @AfterEach
    void stop() {
        rec.close();
        O11y.resetForTesting();
    }

    /** A JDBC fake: every statement succeeds unless {@code failWith} is set, and metadata reports {@code url}. */
    private static final class FakeDb {
        final AtomicInteger connections = new AtomicInteger();
        SQLException failWith;
        String url = "jdbc:postgresql://db/app";
        boolean metadataFails;

        DataSource dataSource() {
            return (DataSource) Proxy.newProxyInstance(
                    DataSource.class.getClassLoader(), new Class<?>[] {DataSource.class}, (p, m, a) -> {
                        if (m.getName().equals("getConnection")) {
                            connections.incrementAndGet();
                            return connection();
                        }
                        return null;
                    });
        }

        private Connection connection() {
            DatabaseMetaData md = (DatabaseMetaData) Proxy.newProxyInstance(
                    DatabaseMetaData.class.getClassLoader(), new Class<?>[] {DatabaseMetaData.class},
                    (p, m, a) -> m.getName().equals("getURL") ? url : null);
            return (Connection) Proxy.newProxyInstance(
                    Connection.class.getClassLoader(), new Class<?>[] {Connection.class}, (p, m, a) -> {
                        switch (m.getName()) {
                            case "getMetaData":
                                if (metadataFails) {
                                    throw new SQLException("connection is broken");
                                }
                                return md;
                            case "createStatement":
                                return statement(Statement.class);
                            case "prepareStatement":
                                return statement(PreparedStatement.class);
                            default:
                                return null;
                        }
                    });
        }

        private Object statement(Class<?> iface) {
            return Proxy.newProxyInstance(iface.getClassLoader(), new Class<?>[] {iface}, (p, m, a) -> {
                String name = m.getName();
                if (name.startsWith("execute")) {
                    if (failWith != null) {
                        throw failWith;
                    }
                    if (name.equals("executeBatch")) {
                        return new int[0];
                    }
                    if (name.equals("execute")) {
                        return false;
                    }
                    if (name.equals("executeUpdate")) {
                        return 0;
                    }
                }
                return null;
            });
        }
    }

    private SpanData runInParent(DataSource ds, String sql) throws SQLException {
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            st.execute(sql);
        } finally {
            parent.end();
        }
        return dbSpan();
    }

    private SpanData dbSpan() {
        List<SpanData> spans = rec.spans().stream().filter(s -> !s.getName().equals("parent")).toList();
        assertEquals(1, spans.size(), "db spans: " + spans);
        return spans.get(0);
    }

    private MetricData durationMetric() {
        return rec.metrics().stream()
                .filter(m -> m.getName().equals("db.client.operation.duration"))
                .findFirst()
                .orElseThrow();
    }

    @Test
    void driverErrorMessageNeverReachesTelemetry() {
        FakeDb db = new FakeDb();
        db.failWith = new SQLException("duplicate key value violates unique constraint: (ssn)=(123-45-6789)", "23505");
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);

        assertThrows(SQLException.class, () -> runInParent(ds, "INSERT INTO people (ssn) VALUES ('123-45-6789')"));

        SpanData span = dbSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals("", span.getStatus().getDescription());
        assertTrue(span.getEvents().isEmpty(), "events: " + span.getEvents());
        assertEquals("java.sql.SQLException", span.getAttributes().get(ERROR_TYPE));
        assertFalse(span.toString().contains("123-45-6789"), span.toString());
        assertNull(span.getAttributes().get(AttributeKey.stringKey("db.response.status_code")));

        HistogramPointData point = durationMetric().getHistogramData().getPoints().iterator().next();
        assertEquals("java.sql.SQLException", point.getAttributes().get(ERROR_TYPE));
    }

    @Test
    void queryTextIsCutAt4096BytesOnACharacterBoundary() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        String emoji = "\uD83D\uDE00"; // four UTF-8 bytes, two chars

        SpanData span = runInParent(ds, "SELECT ab" + emoji.repeat(2000));

        String text = span.getAttributes().get(QUERY_TEXT);
        assertEquals("SELECT ab" + emoji.repeat(1021), text);
        assertTrue(text.getBytes(StandardCharsets.UTF_8).length <= 4096);
    }

    @Test
    void unpairedSurrogatesBecomeReplacementCharacters() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);

        SpanData span = runInParent(ds, "SELECT * FROM t\uD800x WHERE a = 1");

        assertEquals("SELECT * FROM t\uFFFDx WHERE a = ?", span.getAttributes().get(QUERY_TEXT));
        assertEquals("t\uFFFDx", span.getAttributes().get(COLLECTION));
    }

    @Test
    void durationHistogramUsesTheSemanticConventionBuckets() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);

        runInParent(ds, "SELECT 1");

        HistogramPointData point = durationMetric().getHistogramData().getPoints().iterator().next();
        assertEquals(List.of(0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0), point.getBoundaries());
    }

    @Test
    void spanIsNamedByOperationAndCollectionLikeGo() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);

        SpanData span = runInParent(ds, "/* app */ SELECT id FROM orders WHERE total = 99");

        assertEquals("SELECT orders", span.getName());
        assertEquals("SELECT", span.getAttributes().get(OPERATION));
        assertEquals("orders", span.getAttributes().get(COLLECTION));
        assertEquals("  SELECT id FROM orders WHERE total = ?", span.getAttributes().get(QUERY_TEXT));

        HistogramPointData point = durationMetric().getHistogramData().getPoints().iterator().next();
        assertEquals("orders", point.getAttributes().get(COLLECTION));
        assertEquals("SELECT", point.getAttributes().get(OPERATION));
    }

    @Test
    void spanNameFallsBackToOperationThenSystem() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", "appdb");
        assertEquals("COMMIT", runInParent(ds, "COMMIT").getName());
        rec.reset();
        SpanData span = runInParent(ds, "WITH x AS (SELECT 1) SELECT * FROM x");
        assertEquals("postgresql", span.getName());
        assertEquals("appdb", span.getAttributes().get(AttributeKey.stringKey("db.namespace")));
    }

    @Test
    void unknownSystemGetsNoQueryText() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "h2database", null);

        SpanData span = runInParent(ds, "SELECT * FROM users WHERE email = 'a@example.com'");

        assertNull(span.getAttributes().get(QUERY_TEXT));
        assertEquals("SELECT users", span.getName());
        assertEquals("h2database", span.getAttributes().get(SYSTEM));
    }

    @Test
    void spansOnlyUnderAParentButTheMetricAlways() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        try (Connection c = ds.getConnection(); Statement st = c.createStatement()) {
            st.execute("SELECT 1");
        }
        assertTrue(rec.spans().isEmpty(), "spans: " + rec.spans());
        assertEquals(1L, durationMetric().getHistogramData().getPoints().iterator().next().getCount());

        rec.reset();
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            st.execute("SELECT 1");
        } finally {
            parent.end();
        }
        SpanData span = dbSpan();
        assertEquals(parent.getSpanContext().getSpanId(), span.getParentSpanId());
        assertTrue(rec.exemplars().stream().anyMatch(e -> e.spanId().equals(span.getSpanId())));
    }

    @Test
    void statementBatchIsSummarizedWithoutRawText() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            st.addBatch("INSERT INTO t (a) VALUES ('alice')");
            st.addBatch("INSERT INTO t (a) VALUES ('bob')");
            st.executeBatch();
        } finally {
            parent.end();
        }
        SpanData span = dbSpan();
        assertEquals("BATCH INSERT t", span.getName());
        assertEquals("BATCH INSERT", span.getAttributes().get(OPERATION));
        assertEquals("t", span.getAttributes().get(COLLECTION));
        assertEquals(2L, span.getAttributes().get(BATCH_SIZE));
        assertEquals("INSERT INTO t (a) VALUES (?)", span.getAttributes().get(QUERY_TEXT));
    }

    @Test
    void mixedBatchJoinsSanitizedTextAndClearBatchResets() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            st.addBatch("DELETE FROM gone WHERE id = 1");
            st.clearBatch();
            st.addBatch("INSERT INTO t (a) VALUES ('alice')");
            st.addBatch("UPDATE u SET b = 'bob'");
            st.executeBatch();
        } finally {
            parent.end();
        }
        SpanData span = dbSpan();
        assertEquals("BATCH", span.getName());
        assertEquals("BATCH", span.getAttributes().get(OPERATION));
        assertNull(span.getAttributes().get(COLLECTION));
        assertEquals(2L, span.getAttributes().get(BATCH_SIZE));
        assertEquals("INSERT INTO t (a) VALUES (?); UPDATE u SET b = ?", span.getAttributes().get(QUERY_TEXT));
    }

    @Test
    void largeBatchTextStaysBounded() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                Statement st = c.createStatement()) {
            for (int i = 0; i < 5000; i++) {
                st.addBatch("INSERT INTO t" + (i % 2) + " (a) VALUES ('secret')");
            }
            st.executeBatch();
        } finally {
            parent.end();
        }
        SpanData span = dbSpan();
        assertEquals(5000L, span.getAttributes().get(BATCH_SIZE));
        assertEquals("BATCH INSERT", span.getName());
        assertTrue(span.getAttributes().get(QUERY_TEXT).getBytes(StandardCharsets.UTF_8).length <= 4096);
        assertFalse(span.getAttributes().get(QUERY_TEXT).contains("secret"));
    }

    @Test
    void preparedBatchCountsEachAddBatch() throws SQLException {
        FakeDb db = new FakeDb();
        O11yDataSource ds = new O11yDataSource(db.dataSource(), rec.telemetry(), "postgresql", null);
        Span parent = rec.telemetry().tracer("test").spanBuilder("parent").startSpan();
        try (Scope ignored = parent.makeCurrent();
                Connection c = ds.getConnection();
                PreparedStatement ps = c.prepareStatement("INSERT INTO t (a) VALUES (?)")) {
            ps.addBatch();
            ps.addBatch();
            ps.addBatch();
            ps.executeBatch();
        } finally {
            parent.end();
        }
        SpanData span = dbSpan();
        assertEquals("BATCH INSERT t", span.getName());
        assertEquals(3L, span.getAttributes().get(BATCH_SIZE));
        assertEquals("INSERT INTO t (a) VALUES (?)", span.getAttributes().get(QUERY_TEXT));
    }

    @Test
    void detectingSystemReadsTheUrlOfTheFirstBorrowedConnection() throws SQLException {
        FakeDb db = new FakeDb();
        db.url = "jdbc:mysql://db:3306/app";
        O11yDataSource ds = O11yDataSource.detectingSystem(db.dataSource(), rec.telemetry(), null);
        assertEquals(0, db.connections.get(), "construction must not connect");

        SpanData span = runInParent(ds, "SELECT * FROM t WHERE a = \"secret\"");

        assertEquals(1, db.connections.get());
        assertEquals("mysql", span.getAttributes().get(SYSTEM));
        assertEquals("SELECT * FROM t WHERE a = ?", span.getAttributes().get(QUERY_TEXT));
    }

    @Test
    void detectingSystemFallsBackToOtherSqlWhenMetadataFails() throws SQLException {
        FakeDb db = new FakeDb();
        db.metadataFails = true;
        O11yDataSource ds = O11yDataSource.detectingSystem(db.dataSource(), rec.telemetry(), null);

        SpanData span = runInParent(ds, "SELECT * FROM t WHERE a = 'secret'");

        assertEquals("other_sql", span.getAttributes().get(SYSTEM));
        assertNull(span.getAttributes().get(QUERY_TEXT));
    }

    @Test
    void unwrapReachesTheDelegate() throws SQLException {
        FakeDb db = new FakeDb();
        DataSource raw = db.dataSource();
        O11yDataSource ds = new O11yDataSource(raw, rec.telemetry(), "postgresql", null);
        assertSame(ds, ds.unwrap(O11yDataSource.class));
        assertSame(raw, ds.delegate());
    }
}
