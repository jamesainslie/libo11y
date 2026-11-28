package ing.o11y.libo11y.logback;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.Appender;
import ch.qos.logback.core.ConsoleAppender;
import ch.qos.logback.core.UnsynchronizedAppenderBase;
import ing.o11y.libo11y.Redact;
import ing.o11y.libo11y.Telemetry;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.LoggerFactory;
import org.slf4j.event.KeyValuePair;
import org.slf4j.helpers.MessageFormatter;

/**
 * Logback appender routing standard SLF4J calls (including SLF4J 2.x fluent {@code addKeyValue}
 * and MDC attributes) through {@link Telemetry#logger()} with automatic trace correlation
 * and {@code SensitivityPolicy} enforcement.
 *
 * <p>{@link #install(Telemetry)} attaches a new appender to the root logger and returns it; closing
 * it detaches exactly that appender. While libo11y's console leg is enabled, an installation also
 * detaches the root logger's {@link ConsoleAppender}s, which would otherwise print every event a
 * second time without classification, and restores them when the last such installation is closed.
 *
 * <p>A log line emitted on the same thread while any libo11y appender is appending (by a sink or
 * an exporter, for example) is not routed back through libo11y. Events from the OpenTelemetry
 * SDK's own loggers (the {@code io.opentelemetry} namespace, which Spring Boot bridges from
 * java.util.logging) reach the console leg and the extra sinks but not the OTLP log leg: an export
 * failure the SDK logs on its batch worker thread would otherwise be queued for export again,
 * once per failed export, for as long as the collector is down.
 */
public final class O11yLogbackAppender extends UnsynchronizedAppenderBase<ILoggingEvent> implements AutoCloseable {
    private static final String NAME_PREFIX = "LIBO11Y-";
    /** The logger namespace of the OpenTelemetry SDK, its exporters and its instrumentation. */
    private static final String OTEL_NAMESPACE = "io.opentelemetry";
    private static final AtomicLong SEQUENCE = new AtomicLong();
    private static final ThreadLocal<Boolean> APPENDING = ThreadLocal.withInitial(() -> Boolean.FALSE);
    private static final Set<O11yLogbackAppender> INSTALLED = ConcurrentHashMap.newKeySet();

    /** Console appenders detached while any installation owns the console; shared by all of them. */
    private static final Object CONSOLE_LOCK = new Object();
    private static List<Appender<ILoggingEvent>> detachedConsoles = List.of(); // guarded by CONSOLE_LOCK
    private static int consoleOwners; // guarded by CONSOLE_LOCK

    private final Telemetry telemetry;
    private Logger root; // guarded by CONSOLE_LOCK
    private boolean ownsConsole; // guarded by CONSOLE_LOCK

    public O11yLogbackAppender(Telemetry telemetry) {
        this.telemetry = telemetry;
        setName(NAME_PREFIX + SEQUENCE.incrementAndGet());
    }

    /**
     * Installs a new appender on the Logback root logger and returns it, or returns {@code null}
     * when Logback is not the SLF4J backend. Close the returned appender to uninstall it; that
     * leaves every other installation in place.
     */
    public static O11yLogbackAppender install(Telemetry telemetry) {
        if (!(LoggerFactory.getILoggerFactory() instanceof LoggerContext lc)) {
            return null;
        }
        Logger root = lc.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        O11yLogbackAppender appender = new O11yLogbackAppender(telemetry);
        appender.setContext(lc);
        appender.start();
        synchronized (CONSOLE_LOCK) {
            appender.root = root;
            if (telemetry != null && telemetry.logger().consoleEnabled()) {
                if (consoleOwners == 0) {
                    detachedConsoles = detachConsoleAppenders(root);
                }
                consoleOwners++;
                appender.ownsConsole = true;
            }
            root.addAppender(appender);
        }
        INSTALLED.add(appender);
        return appender;
    }

    /** Closes every appender {@link #install(Telemetry)} returned that is still installed. */
    public static void uninstall() {
        for (O11yLogbackAppender appender : List.copyOf(INSTALLED)) {
            appender.close();
        }
    }

    /**
     * Detaches this appender from the root logger and stops it. Closing the last installation that
     * detached the console appenders reattaches them. Closing twice does nothing.
     */
    @Override
    public void close() {
        synchronized (CONSOLE_LOCK) {
            if (root == null) {
                return;
            }
            root.detachAppender(this);
            if (ownsConsole && --consoleOwners == 0) {
                for (Appender<ILoggingEvent> console : detachedConsoles) {
                    root.addAppender(console);
                }
                detachedConsoles = List.of();
            }
            ownsConsole = false;
            root = null;
        }
        INSTALLED.remove(this);
        stop();
    }

    private static List<Appender<ILoggingEvent>> detachConsoleAppenders(Logger root) {
        List<Appender<ILoggingEvent>> consoles = new ArrayList<>();
        for (Iterator<Appender<ILoggingEvent>> it = root.iteratorForAppenders(); it.hasNext(); ) {
            Appender<ILoggingEvent> a = it.next();
            if (a instanceof ConsoleAppender<?>) {
                consoles.add(a);
            }
        }
        for (Appender<ILoggingEvent> a : consoles) {
            root.detachAppender(a);
        }
        return List.copyOf(consoles);
    }

    @Override
    protected void append(ILoggingEvent event) {
        if (telemetry == null || event == null || APPENDING.get()) {
            return;
        }
        APPENDING.set(Boolean.TRUE);
        try {
            emit(event);
        } finally {
            APPENDING.remove();
        }
    }

    private void emit(ILoggingEvent event) {
        Map<String, Object> attrs = new LinkedHashMap<>();
        if (event.getLoggerName() != null && !event.getLoggerName().isEmpty()) {
            attrs.put("logger.name", event.getLoggerName());
        }
        Map<String, String> mdc = event.getMDCPropertyMap();
        if (mdc != null && !mdc.isEmpty()) {
            attrs.putAll(mdc);
        }
        List<KeyValuePair> kvps = event.getKeyValuePairs();
        if (kvps != null) {
            for (KeyValuePair kv : kvps) {
                if (kv != null && kv.key != null) {
                    attrs.put(kv.key, kv.value);
                }
            }
        }
        Severity severity = mapSeverity(event.getLevel());
        IThrowableProxy tp = event.getThrowableProxy();
        if (tp != null) {
            attrs.put("exception.type", tp.getClassName());
            if (tp.getMessage() != null) {
                attrs.put("exception.message", tp.getMessage());
            }
            attrs.put("exception.stacktrace", ThrowableProxyUtil.asString(tp));
            if (severity == Severity.ERROR) {
                attrs.put("error.type", tp.getClassName());
            }
        }
        if (isOpenTelemetryDiagnostic(event.getLoggerName())) {
            telemetry.logger().emitLocal(Context.current(), severity, formatMessage(event), attrs);
            return;
        }
        telemetry.logger().emit(
                Context.current(),
                severity,
                formatMessage(event),
                null,
                attrs,
                false);
    }

    /** Reports whether {@code loggerName} is {@code io.opentelemetry} or a logger below it. */
    private static boolean isOpenTelemetryDiagnostic(String loggerName) {
        return loggerName != null
                && loggerName.startsWith(OTEL_NAMESPACE)
                && (loggerName.length() == OTEL_NAMESPACE.length()
                        || loggerName.charAt(OTEL_NAMESPACE.length()) == '.');
    }

    /**
     * Formats the message from arguments passed through {@link Redact#scrub(Object)}, so an
     * annotated, {@code Secret} or {@code Masked} argument cannot leak through the message text.
     */
    private static String formatMessage(ILoggingEvent event) {
        Object[] args = event.getArgumentArray();
        if (args == null || args.length == 0) {
            return event.getFormattedMessage();
        }
        Object[] scrubbed = new Object[args.length];
        for (int i = 0; i < args.length; i++) {
            scrubbed[i] = Redact.scrub(args[i]);
        }
        return MessageFormatter.arrayFormat(event.getMessage(), scrubbed).getMessage();
    }

    private static Severity mapSeverity(Level level) {
        if (level == null) {
            return Severity.INFO;
        }
        return switch (level.toInt()) {
            case Level.TRACE_INT -> Severity.TRACE;
            case Level.DEBUG_INT -> Severity.DEBUG;
            case Level.WARN_INT -> Severity.WARN;
            case Level.ERROR_INT -> Severity.ERROR;
            default -> Severity.INFO;
        };
    }
}
