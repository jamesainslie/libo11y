package ing.o11y.libo11y.jdbc;

import ing.o11y.libo11y.Telemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.trace.Span;
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
import java.sql.CallableStatement;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Set;
import java.util.logging.Logger;
import javax.sql.DataSource;

/**
 * JDBC {@link DataSource} wrapper emitting parent-gated client spans, sanitized {@code db.query.text},
 * and {@code db.client.operation.duration} histograms with trace-based exemplars.
 */
public final class O11yDataSource implements DataSource {
    private static final AttributeKey<String> DB_SYSTEM = AttributeKey.stringKey("db.system.name");
    private static final AttributeKey<String> DB_NAMESPACE = AttributeKey.stringKey("db.namespace");
    private static final AttributeKey<String> DB_OPERATION = AttributeKey.stringKey("db.operation.name");
    private static final AttributeKey<String> DB_QUERY_TEXT = AttributeKey.stringKey("db.query.text");
    private static final AttributeKey<String> ERROR_TYPE = AttributeKey.stringKey("error.type");

    private static final Set<String> EXEC_METHODS = Set.of(
            "execute", "executeQuery", "executeUpdate", "executeBatch",
            "executeLargeUpdate", "executeLargeBatch");

    private final DataSource delegate;
    private final String dbSystem;
    private final String dbNamespace;
    private final Tracer tracer;
    private final DoubleHistogram durationHistogram;

    public O11yDataSource(DataSource delegate, Telemetry telemetry, String dbSystem, String dbNamespace) {
        this.delegate = delegate;
        this.dbSystem = dbSystem == null || dbSystem.isEmpty() ? "other_sql" : dbSystem;
        this.dbNamespace = dbNamespace;
        this.tracer = telemetry.tracer("libo11y.jdbc");
        this.durationHistogram = telemetry.meter("libo11y.jdbc")
                .histogramBuilder("db.client.operation.duration")
                .setDescription("Duration of database client operations.")
                .setUnit("s")
                .build();
    }

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
        return (Connection) Proxy.newProxyInstance(
                Connection.class.getClassLoader(),
                new Class<?>[] {Connection.class},
                new ConnectionHandler(conn));
    }

    private Statement wrapStatement(Statement stmt, String fixedSql, Class<?> iface) {
        return (Statement) Proxy.newProxyInstance(
                iface.getClassLoader(),
                new Class<?>[] {iface},
                new StatementHandler(stmt, fixedSql));
    }

    private final class ConnectionHandler implements InvocationHandler {
        private final Connection target;

        ConnectionHandler(Connection target) {
            this.target = target;
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
                return wrapStatement(s, null, Statement.class);
            }
            if ("prepareStatement".equals(name) && result instanceof PreparedStatement ps) {
                String sql = (args != null && args.length > 0 && args[0] instanceof String str) ? str : null;
                return wrapStatement(ps, sql, PreparedStatement.class);
            }
            if ("prepareCall".equals(name) && result instanceof CallableStatement cs) {
                String sql = (args != null && args.length > 0 && args[0] instanceof String str) ? str : null;
                return wrapStatement(cs, sql, CallableStatement.class);
            }
            return result;
        }
    }

    private final class StatementHandler implements InvocationHandler {
        private final Statement target;
        private final String fixedSql;

        StatementHandler(Statement target, String fixedSql) {
            this.target = target;
            this.fixedSql = fixedSql;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if (!EXEC_METHODS.contains(method.getName())) {
                try {
                    return method.invoke(target, args);
                } catch (InvocationTargetException ex) {
                    throw ex.getTargetException();
                }
            }

            String sql = fixedSql;
            if (sql == null && args != null && args.length > 0 && args[0] instanceof String s) {
                sql = s;
            }

            String op = SqlSanitizer.extractOperation(sql);
            String sanitized = SqlSanitizer.sanitize(dbSystem, sql);
            boolean hasParent = Span.current().getSpanContext().isValid();

            AttributesBuilder metricAttrs = Attributes.builder().put(DB_SYSTEM, dbSystem);
            if (dbNamespace != null && !dbNamespace.isEmpty()) {
                metricAttrs.put(DB_NAMESPACE, dbNamespace);
            }
            if (!op.isEmpty()) {
                metricAttrs.put(DB_OPERATION, op);
            }

            Span span = null;
            Scope scope = null;
            if (hasParent) {
                String spanName = op.isEmpty() ? dbSystem : op + (dbNamespace != null ? " " + dbNamespace : "");
                var sb = tracer.spanBuilder(spanName)
                        .setSpanKind(SpanKind.CLIENT)
                        .setAttribute(DB_SYSTEM, dbSystem);
                if (dbNamespace != null && !dbNamespace.isEmpty()) {
                    sb.setAttribute(DB_NAMESPACE, dbNamespace);
                }
                if (!op.isEmpty()) {
                    sb.setAttribute(DB_OPERATION, op);
                }
                if (sanitized != null && !sanitized.isEmpty()) {
                    sb.setAttribute(DB_QUERY_TEXT, sanitized);
                }
                span = sb.startSpan();
                scope = span.makeCurrent();
            }

            long startNanos = System.nanoTime();
            try {
                Object res = method.invoke(target, args);
                return res;
            } catch (InvocationTargetException ex) {
                Throwable cause = ex.getTargetException();
                metricAttrs.put(ERROR_TYPE, cause.getClass().getName());
                if (span != null) {
                    span.setAttribute(ERROR_TYPE, cause.getClass().getName());
                    span.recordException(cause);
                    span.setStatus(StatusCode.ERROR, cause.getMessage());
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
