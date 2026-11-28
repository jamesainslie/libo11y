package ing.o11y.libo11y;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.ContextKey;
import io.opentelemetry.context.Scope;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Wide-event accumulator bound to the active OpenTelemetry {@link Context}.
 * Collects attributes across a request or unit of work and emits one canonical event on close.
 */
public final class O11yRecord implements AutoCloseable {
    private static final ContextKey<O11yRecord> RECORD_KEY = ContextKey.named("o11y.record");

    private final Telemetry telemetry;
    private final String eventName;
    private final Map<String, Object> attrs = Collections.synchronizedMap(new LinkedHashMap<>());
    private final AtomicBoolean emitted = new AtomicBoolean(false);
    private volatile Severity severity = Severity.INFO;
    private volatile Scope scope;

    private O11yRecord(Telemetry telemetry, String eventName) {
        this.telemetry = telemetry;
        this.eventName = eventName == null || eventName.isEmpty() ? Spec.Events.REQUEST_SUMMARY : eventName;
    }

    public static O11yRecord start(Telemetry telemetry, String eventName) {
        O11yRecord rec = new O11yRecord(telemetry, eventName);
        rec.scope = Context.current().with(RECORD_KEY, rec).makeCurrent();
        return rec;
    }

    public static O11yRecord current() {
        return Context.current().get(RECORD_KEY);
    }

    public static O11yRecord fromContext(Context context) {
        return context == null ? null : context.get(RECORD_KEY);
    }

    public O11yRecord set(String key, Object value) {
        if (key != null && !key.isEmpty() && value != null) {
            attrs.put(key, value);
        }
        return this;
    }

    public O11yRecord setAll(Map<String, Object> values) {
        if (values != null) {
            values.forEach(this::set);
        }
        return this;
    }

    public O11yRecord setOutcome(String outcome) {
        return set(Spec.Attributes.OUTCOME, outcome);
    }

    public O11yRecord setSeverity(Severity severity) {
        if (severity != null) {
            this.severity = severity;
        }
        return this;
    }

    public O11yRecord recordError(Throwable error) {
        if (error != null) {
            set("error.type", error.getClass().getName());
            if (error.getMessage() != null) {
                set("exception.message", error.getMessage());
            }
            setOutcome(Spec.Outcome.FAILURE);
            this.severity = Severity.ERROR;
        }
        return this;
    }

    public Map<String, Object> snapshot() {
        synchronized (attrs) {
            return Map.copyOf(attrs);
        }
    }

    public void emit() {
        if (emitted.compareAndSet(false, true)) {
            Map<String, Object> copy;
            synchronized (attrs) {
                copy = new LinkedHashMap<>(attrs);
            }
            telemetry.logger().emit(Context.current(), severity, eventName, eventName, copy, false);
        }
    }

    @Override
    public void close() {
        try {
            emit();
        } finally {
            Scope s = this.scope;
            if (s != null) {
                this.scope = null;
                s.close();
            }
        }
    }
}
