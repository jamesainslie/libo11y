package ing.o11y.libo11y.jdbc;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.jdbc.SqlSanitizer.Dialect;
import ing.o11y.libo11y.jdbc.SqlSanitizer.Summary;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanBuilder;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.io.PrintWriter;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.logging.Logger;
import javax.sql.DataSource;

/**
 * JDBC {@link DataSource} wrapper that follows the database client semantic conventions, matching
 * the Go reference ({@code go/o11ysql}).
 *
 * <p>Each statement records {@code db.client.operation.duration}, a histogram in seconds with the
 * semantic-convention bucket advice and an exemplar pointing at the statement's span when there is
 * one. A client span is created only when the calling context already holds a span, so pool
 * maintenance and other background statements never create root spans. The span is named {@code
 * "{db.operation.name} {db.collection.name}"} (the one that is known, or {@code db.system.name} when
 * neither is) and carries {@code db.system.name}, {@code db.namespace} when configured, {@code
 * db.operation.name}, {@code db.collection.name} when the statement names exactly one table, and
 * {@code db.query.text} with every literal replaced by {@code ?}, every comment removed, and cut to
 * at most 4096 UTF-8 bytes on a character boundary. {@code db.query.text} is recorded only for
 * {@code postgresql}, {@code sqlite}, {@code mysql}, and {@code mariadb}; see {@link SqlSanitizer}.
 *
 * <p>An error sets the span status to Error and adds {@code error.type} (the exception's class name)
 * to the span and the metric. The exception message is never recorded, because driver messages often
 * quote the values a statement carried.
 *
 * <p>A {@link Statement} batch built with {@code addBatch} is summarized as one operation: {@code
 * db.operation.batch.size} counts the statements, {@code db.operation.name} is {@code BATCH} followed
 * by the shared operation, if any, and {@code db.query.text} holds the shared sanitized text, or the
 * sanitized texts joined by {@code "; "}, within the same 4096-byte bound.
 */
public final class O11yDataSource implements DataSource {
    private static final AttributeKey<String> DB_SYSTEM = AttributeKey.stringKey("db.system.name");
    private static final AttributeKey<String> DB_NAMESPACE = AttributeKey.stringKey("db.namespace");
    private static final AttributeKey<String> DB_OPERATION = AttributeKey.stringKey("db.operation.name");
    private static final AttributeKey<String> DB_COLLECTION = AttributeKey.stringKey("db.collection.name");
    private static final AttributeKey<String> DB_QUERY_TEXT = AttributeKey.stringKey("db.query.text");
    private static final AttributeKey<Long> DB_BATCH_SIZE = AttributeKey.longKey("db.operation.batch.size");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    /** The boundaries the semantic conventions advise for {@code db.client.operation.duration}, in seconds. */
    private static final List<Double> DURATION_BUCKETS = List.of(0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0);

    /**
     * Bounds {@code db.query.text} in UTF-8 bytes. The SDK sets no attribute length limit by default,
     * and the text of a bulk INSERT or a migration can run to megabytes.
     */
    private static final int MAX_QUERY_TEXT_BYTES = 4096;

    private static final String OTHER_SQL = "other_sql";
    private static final char REPLACEMENT = (char) 0xFFFD;

    private static final Set<String> EXEC_METHODS = Set.of(
            "execute", "executeQuery", "executeUpdate", "executeBatch",
            "executeLargeUpdate", "executeLargeBatch");

    private final DataSource delegate;
    private final String dbNamespace;
    private final Tracer tracer;
    private final DoubleHistogram durationHistogram;
    /** The database system, or {@code null} until it is read from the first connection's URL. */
    private volatile DbSystem system;

    /** A {@code db.system.name} value and its lexer, which is {@code null} when no lexer is known. */
    private record DbSystem(String name, Dialect dialect) {
        static final DbSystem OTHER = new DbSystem(OTHER_SQL, null);

        static DbSystem of(String name) {
            return name == null || name.isEmpty() ? OTHER : new DbSystem(name, SqlSanitizer.dialectFor(name));
        }

        Dialect lexer() {
            return dialect == null ? Dialect.STANDARD : dialect;
        }

        boolean queryText() {
            return dialect != null;
        }
    }

    /** What the telemetry records about one operation. {@code text} is {@code null} when omitted. */
    private record Description(String operation, String collection, String text, long batchSize) {}

    /**
     * Wraps {@code delegate}, recording each statement as a {@code dbSystem} operation.
     *
     * @param delegate the data source to instrument
     * @param telemetry the telemetry whose tracer and meter record the operations
     * @param dbSystem the {@code db.system.name} value, such as {@code postgresql}; {@code null} or
     *     empty means {@code other_sql}
     * @param dbNamespace the {@code db.namespace} value, or {@code null} to leave it off
     */
    public O11yDataSource(DataSource delegate, Telemetry telemetry, String dbSystem, String dbNamespace) {
        this(delegate, telemetry, DbSystem.of(dbSystem), dbNamespace);
    }

    private O11yDataSource(DataSource delegate, Telemetry telemetry, DbSystem system, String dbNamespace) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(telemetry, "telemetry");
        this.system = system;
        this.dbNamespace = dbNamespace == null || dbNamespace.isEmpty() ? null : dbNamespace;
        this.tracer = telemetry.tracer("libo11y.jdbc");
        this.durationHistogram = telemetry.meter("libo11y.jdbc")
                .histogramBuilder("db.client.operation.duration")
                .setDescription("Duration of database client operations.")
                .setUnit("s")
                .setExplicitBucketBoundariesAdvice(DURATION_BUCKETS)
                .build();
    }

    /**
     * Wraps {@code delegate} and reads {@code db.system.name} from the JDBC URL of the first
     * connection the application borrows, so creating the wrapper never connects to the database. A
     * URL that names no known system, or a connection whose metadata cannot be read, is described as
     * {@code other_sql}, which records no {@code db.query.text}.
     *
     * @param delegate the data source to instrument
     * @param telemetry the telemetry whose tracer and meter record the operations
     * @param dbNamespace the {@code db.namespace} value, or {@code null} to leave it off
     * @return the instrumented data source
     */
    public static O11yDataSource detectingSystem(DataSource delegate, Telemetry telemetry, String dbNamespace) {
        return new O11yDataSource(delegate, telemetry, (DbSystem) null, dbNamespace);
    }

    /**
     * Returns the {@code db.system.name} value a JDBC URL implies, or {@code other_sql}.
     *
     * @param url a JDBC URL such as {@code jdbc:postgresql://host/db}; may be {@code null}
     * @return the {@code db.system.name} value
     */
    static String systemForJdbcUrl(String url) {
        if (url == null) {
            return OTHER_SQL;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.startsWith("jdbc:postgresql:")) {
            return "postgresql";
        }
        if (lower.startsWith("jdbc:mysql:")) {
            return "mysql";
        }
        if (lower.startsWith("jdbc:mariadb:")) {
            return "mariadb";
        }
        if (lower.startsWith("jdbc:sqlite:")) {
            return "sqlite";
        }
        if (lower.startsWith("jdbc:h2:")) {
            return "h2database";
        }
        return OTHER_SQL;
    }

    /**
     * Returns the wrapped data source.
     *
     * @return the delegate given at construction
     */
    public DataSource delegate() {
        return delegate;
    }

    @Override
    public Connection getConnection() throws SQLException {
        return wrapConnection(delegate.getConnection());
    }

    @Override
    public Connection getConnection(String username, String password) throws SQLException {
        return wrapConnection(delegate.getConnection(username, password));
    }

    private Connection wrapConnection(Connection conn) {
        DbSystem sys = system;
        if (sys == null) {
            sys = detect(conn);
        }
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                new ConnectionHandler(conn, sys));
    }

    /** Reads the system from the connection's URL and keeps it for every later connection. */
    private DbSystem detect(Connection conn) {
        DatabaseMetaData metaData;
        String url;
        try {
            metaData = conn.getMetaData();
            url = metaData == null ? null : metaData.getURL();
        } catch (SQLException ex) {
            // The URL only names the system. A connection that cannot report it is described as
            // other_sql, which records no query text, and the next connection tries again; the
            // application sees the failure on its own first use of the connection.
            return DbSystem.OTHER;
        }
        DbSystem detected = DbSystem.of(systemForJdbcUrl(url));
        system = detected;
        return detected;
    }

    private Statement wrapStatement(Statement stmt, String fixedSql, DbSystem sys, Class<?> iface) {
        return (Statement) Proxy.newProxyInstance(
                iface.getClassLoader(),
                new Class<?>[] {iface},
                new StatementHandler(stmt, fixedSql, sys));
    }

    private final class ConnectionHandler implements InvocationHandler {
        private final Connection target;
        private final DbSystem sys;

        ConnectionHandler(Connection target, DbSystem sys) {
            this.target = target;
            this.sys = sys;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            Object result;
            try {
                result = method.invoke(target, args);
            } catch (InvocationTargetException ex) {
                throw ex.getTargetException();
            }
            String name = method.getName();
            if ("createStatement".equals(name) && result instanceof Statement s) {
                return wrapStatement(s, null, sys, Statement.class);
            }
            if ("prepareStatement".equals(name) && result instanceof PreparedStatement ps) {
                return wrapStatement(ps, firstString(args), sys, PreparedStatement.class);
            }
            if ("prepareCall".equals(name) && result instanceof CallableStatement cs) {
                return wrapStatement(cs, firstString(args), sys, CallableStatement.class);
            }
            return result;
        }
    }

    private static String firstString(Object[] args) {
        return args != null && args.length > 0 && args[0] instanceof String s ? s : null;
    }

    /** Sanitizes and summarizes one statement under the system's lexer. */
    private static Description describe(String sql, DbSystem sys) {
        if (sql == null) {
            return new Description("", "", null, 0);
        }
        String sanitized = wellFormed(SqlSanitizer.sanitizeText(sql, sys.lexer()));
        Summary summary = SqlSanitizer.summarize(sanitized);
        String text = sys.queryText() ? truncate(sanitized, MAX_QUERY_TEXT_BYTES) : null;
        return new Description(summary.operation(), summary.collection(), text, 0);
    }

    /**
     * Replaces each unpaired surrogate with U+FFFD. OTLP sends attribute values as protobuf strings,
     * which must be valid UTF-8, and one invalid value fails the whole export batch.
     */
    static String wellFormed(String s) {
        StringBuilder b = null;
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            boolean paired = Character.isHighSurrogate(c) && i + 1 < n && Character.isLowSurrogate(s.charAt(i + 1));
            if (paired) {
                if (b != null) {
                    b.append(c).append(s.charAt(i + 1));
                }
                i++;
                continue;
            }
            if (Character.isSurrogate(c)) {
                if (b == null) {
                    b = new StringBuilder(n).append(s, 0, i);
                }
                b.append(REPLACEMENT);
            } else if (b != null) {
                b.append(c);
            }
        }
        return b == null ? s : b.toString();
    }

    /**
     * Returns the longest prefix of the well-formed {@code s} that has at most {@code maxBytes} UTF-8
     * bytes and ends on a character boundary. Cutting sanitized text cannot expose a literal, because
     * every literal is already gone.
     */
    static String truncate(String s, int maxBytes) {
        if (s.length() * 3 <= maxBytes) {
            return s; // at most three UTF-8 bytes per char, so it fits
        }
        int bytes = 0;
        int i = 0;
        int n = s.length();
        while (i < n) {
            int cp = s.codePointAt(i);
            int size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            if (bytes + size > maxBytes) {
                return s.substring(0, i);
            }
            bytes += size;
            i += Character.charCount(cp);
        }
        return s;
    }

    /**
     * Accumulates a bounded summary of the statements added to a batch. It keeps no raw SQL: each
     * statement is sanitized when it is added, and only a bounded prefix of the sanitized text is
     * kept. JDBC statements are not meant for concurrent use, but the methods are synchronized so a
     * misuse cannot corrupt the summary.
     */
    private static final class Batch {
        private final DbSystem sys;
        private long size;
        private String operation;
        private boolean sameOperation;
        private String collection;
        private boolean sameCollection;
        private String firstText;
        private boolean sameText;
        private final StringBuilder joined = new StringBuilder();

        Batch(DbSystem sys) {
            this.sys = sys;
        }

        synchronized void add(String sql) {
            Description d = describe(sql, sys);
            if (size == 0) {
                operation = d.operation();
                collection = d.collection();
                firstText = d.text();
                sameOperation = true;
                sameCollection = true;
                sameText = true;
            } else {
                sameOperation &= operation.equals(d.operation());
                sameCollection &= collection.equals(d.collection());
                sameText &= Objects.equals(firstText, d.text());
            }
            size++;
            if (d.text() != null && joined.length() <= MAX_QUERY_TEXT_BYTES) {
                // Each char takes at least one UTF-8 byte, so this many chars always covers the bound.
                if (size > 1) {
                    joined.append("; ");
                }
                joined.append(d.text(), 0, Math.min(d.text().length(), MAX_QUERY_TEXT_BYTES + 1));
            }
        }

        synchronized void clear() {
            size = 0;
            joined.setLength(0);
        }

        /** Describes the batch and resets it, as JDBC resets a batch once it has been executed. */
        synchronized Description drain(String fixedSql) {
            Description d;
            if (size == 0) {
                d = describe(fixedSql, sys);
            } else if (size == 1) {
                d = new Description(operation, collection, firstText, 0);
            } else {
                String op = sameOperation && !operation.isEmpty() ? "BATCH " + operation : "BATCH";
                String text = sameText ? firstText : sys.queryText() ? truncate(joined.toString(), MAX_QUERY_TEXT_BYTES) : null;
                d = new Description(op, sameCollection ? collection : "", text, size);
            }
            clear();
            return d;
        }
    }

    private final class StatementHandler implements InvocationHandler {
        private final Statement target;
        private final String fixedSql;
        private final DbSystem sys;
        private final Batch batch;

        StatementHandler(Statement target, String fixedSql, DbSystem sys) {
            this.target = target;
            this.fixedSql = fixedSql;
            this.sys = sys;
            this.batch = new Batch(sys);
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if (!EXEC_METHODS.contains(name)) {
                Object result = invokeTarget(method, args);
                if ("addBatch".equals(name)) {
                    String sql = args == null || args.length == 0 ? fixedSql : firstString(args);
                    batch.add(sql);
                } else if ("clearBatch".equals(name)) {
                    batch.clear();
                }
                return result;
            }
            Description d;
            if ("executeBatch".equals(name) || "executeLargeBatch".equals(name)) {
                d = batch.drain(fixedSql);
            } else {
                d = describe(fixedSql != null ? fixedSql : firstString(args), sys);
            }
            return instrument(d, method, args);
        }

        private Object invokeTarget(Method method, Object[] args) throws Throwable {
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException ex) {
                throw ex.getTargetException();
            }
        }

        private Object instrument(Description d, Method method, Object[] args) throws Throwable {
            AttributesBuilder metricAttrs = Attributes.builder().put(DB_SYSTEM, sys.name());
            if (dbNamespace != null) {
                metricAttrs.put(DB_NAMESPACE, dbNamespace);
            }
            if (!d.operation().isEmpty()) {
                metricAttrs.put(DB_OPERATION, d.operation());
            }
            if (!d.collection().isEmpty()) {
                metricAttrs.put(DB_COLLECTION, d.collection());
            }

            Span span = null;
            Scope scope = null;
            if (Span.current().getSpanContext().isValid()) {
                SpanBuilder sb = tracer.spanBuilder(spanName(d))
                        .setSpanKind(SpanKind.CLIENT)
                        .setAllAttributes(metricAttrs.build());
                if (d.text() != null && !d.text().isEmpty()) {
                    sb.setAttribute(DB_QUERY_TEXT, d.text());
                }
                if (d.batchSize() > 1) {
                    sb.setAttribute(DB_BATCH_SIZE, d.batchSize());
                }
                span = sb.startSpan();
                scope = span.makeCurrent();
            }

            long startNanos = System.nanoTime();
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException ex) {
                Throwable cause = ex.getTargetException();
                String errorType = cause.getClass().getName();
                metricAttrs.put(ERROR_TYPE, errorType);
                if (span != null) {
                    span.setAttribute(ERROR_TYPE, errorType);
                    span.setStatus(StatusCode.ERROR); // no message: it may quote statement values
                }
                throw cause;
            } finally {
                double seconds = (System.nanoTime() - startNanos) / 1_000_000_000.0;
                durationHistogram.record(seconds, metricAttrs.build(), Context.current());
                if (scope != null) {
                    scope.close();
                }
                if (span != null) {
                    span.end();
                }
            }
        }

        /** Names the span like Go: operation and collection, the one that is known, or the system. */
        private String spanName(Description d) {
            if (d.operation().isEmpty()) {
                return d.collection().isEmpty() ? sys.name() : d.collection();
            }
            return d.collection().isEmpty() ? d.operation() : d.operation() + " " + d.collection();
        }
    }

    @Override
    public PrintWriter getLogWriter() throws SQLException {
        return delegate.getLogWriter();
    }

    @Override
    public void setLogWriter(PrintWriter out) throws SQLException {
        delegate.setLogWriter(out);
    }

    @Override
    public void setLoginTimeout(int seconds) throws SQLException {
        delegate.setLoginTimeout(seconds);
    }

    @Override
    public int getLoginTimeout() throws SQLException {
        return delegate.getLoginTimeout();
    }

    @Override
    public Logger getParentLogger() throws java.sql.SQLFeatureNotSupportedException {
        return delegate.getParentLogger();
    }

    @Override
    public <T> T unwrap(Class<T> iface) throws SQLException {
        if (iface.isInstance(this)) {
            return iface.cast(this);
        }
        return delegate.unwrap(iface);
    }

    @Override
    public boolean isWrapperFor(Class<?> iface) throws SQLException {
        return iface.isInstance(this) || delegate.isWrapperFor(iface);
    }
}
