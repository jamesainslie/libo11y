package ing.o11y.libo11y.logback;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.AppenderBase;
import ing.o11y.libo11y.Telemetry;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.LoggerFactory;
import org.slf4j.event.KeyValuePair;

/**
 * Logback appender routing standard SLF4J calls (including SLF4J 2.x fluent {@code addKeyValue}
 * and MDC attributes) through {@link Telemetry#logger()} with automatic trace correlation
 * and {@code SensitivityPolicy} enforcement.
 */
public final class O11yLogbackAppender extends AppenderBase<ILoggingEvent> {
    private static final String APPENDER_NAME = "LIBO11Y";
    private final Telemetry telemetry;

    public O11yLogbackAppender(Telemetry telemetry) {
        this.telemetry = telemetry;
        setName(APPENDER_NAME);
    }

    /** Installs this appender on the Logback root logger (idempotent per Telemetry instance). */
    public static O11yLogbackAppender install(Telemetry telemetry) {
        if (!(LoggerFactory.getILoggerFactory() instanceof LoggerContext lc)) {
            return null;
        }
        Logger root = lc.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        root.detachAppender(APPENDER_NAME);
        O11yLogbackAppender appender = new O11yLogbackAppender(telemetry);
        appender.setContext(lc);
        appender.start();
        root.addAppender(appender);
        return appender;
    }

    public static void uninstall() {
        if (LoggerFactory.getILoggerFactory() instanceof LoggerContext lc) {
            Logger root = lc.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
            root.detachAppender(APPENDER_NAME);
        }
    }

    @Override
    protected void append(ILoggingEvent event) {
        if (telemetry == null || event == null) {
            return;
        }
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
        IThrowableProxy tp = event.getThrowableProxy();
        if (tp != null) {
            attrs.put("exception.type", tp.getClassName());
            if (tp.getMessage() != null) {
                attrs.put("exception.message", tp.getMessage());
            }
        }
        telemetry.logger().emit(
                Context.current(),
                mapSeverity(event.getLevel()),
                event.getFormattedMessage(),
                null,
                attrs,
                false);
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
