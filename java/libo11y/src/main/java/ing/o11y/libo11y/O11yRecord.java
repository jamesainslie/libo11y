package ing.o11y.libo11y;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.ContextKey;
import io.opentelemetry.context.ImplicitContextKeyed;
import io.opentelemetry.context.Scope;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Wide-event accumulator bound to the active OpenTelemetry {@link Context}.
 * Collects attributes across a request or unit of work and emits one canonical event on close.
 */
public final class O11yRecord implements AutoCloseable, ImplicitContextKeyed {
    private static final ContextKey<O11yRecord> RECORD_KEY = ContextKey.named("o11y.record");

    /** The record {@link #current()} returns outside any record scope: every operation does nothing. */
    private static final O11yRecord NOOP = new O11yRecord(null, null);

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

    /**
     * Creates a record without making it current on the calling thread. Bind it to a context with
     * {@link Context#with(ImplicitContextKeyed)} and make that context current wherever the work
     * runs, which may be several threads in turn, as in an asynchronous request. {@link #close()}
     * then emits the event without changing any thread's current context.
     */
    public static O11yRecord create(Telemetry telemetry, String eventName) {
        return new O11yRecord(telemetry, eventName);
    }

    /**
     * Returns {@code context} with this record as its current record. The no-op record that
     * {@link #current()} returns outside a record scope is never stored, so {@link
     * #fromContext(Context)} keeps reporting that no record is active.
     */
    @Override
    public Context storeInContext(Context context) {
        return this == NOOP ? context : context.with(RECORD_KEY, this);
    }

    /**
     * Returns the record bound to the current context, or a no-op record when none is active, so a
     * call site never needs a null check. Use {@link #fromContext(Context)} to tell the two apart.
     */
    public static O11yRecord current() {
        O11yRecord rec = Context.current().get(RECORD_KEY);
        return rec == null ? NOOP : rec;
    }

    /** Returns the record bound to {@code context}, or {@code null} when none is. */
    public static O11yRecord fromContext(Context context) {
        return context == null ? null : context.get(RECORD_KEY);
    }

    public O11yRecord set(String key, Object value) {
        if (this != NOOP && key != null && !key.isEmpty() && value != null) {
            attrs.put(key, value);
        }
        return this;
    }

    /**
     * Sets the attribute at a generated typed key. The compiler checks {@code value} against the
     * key's registry type, and a closed enum constant is stored as its wire string. A null key or
     * value is ignored, as in {@link #set(String, Object)}.
     *
     * @param <T> the key's value type
     * @param key the attribute key, from {@link Spec.Attributes}
     * @param value the value
     * @return this record
     */
    public <T> O11yRecord set(Spec.Key<T> key, T value) {
        return key == null ? this : set(key.getKey(), key.wireValue(value));
    }

    /**
     * Adds {@code delta} to the integer counter at {@code key}, creating it at {@code delta} when
     * absent. A key holding a value of another kind is replaced by {@code delta}.
     */
    public O11yRecord add(String key, long delta) {
        if (this == NOOP || key == null || key.isEmpty()) {
            return this;
        }
        attrs.compute(key, (k, v) -> v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte
                ? ((Number) v).longValue() + delta
                : delta);
        return this;
    }

    /**
     * Records the larger of the existing and the new value at {@code key}, for example the slowest
     * downstream call in a request. A key holding a value of another kind is replaced by {@code value}.
     */
    public O11yRecord max(String key, double value) {
        if (this == NOOP || key == null || key.isEmpty()) {
            return this;
        }
        attrs.compute(key, (k, v) -> (v instanceof Double || v instanceof Float) && ((Number) v).doubleValue() >= value
                ? ((Number) v).doubleValue()
                : value);
        return this;
    }

    public O11yRecord setAll(Map<String, Object> values) {
        if (values != null) {
            values.forEach(this::set);
        }
        return this;
    }

    /**
     * Sets {@code o11y.outcome}. A null outcome is ignored.
     *
     * @param outcome the outcome of the work this record describes
     * @return this record
     */
    public O11yRecord setOutcome(Spec.Outcome outcome) {
        return set(Spec.Attributes.OUTCOME, outcome);
    }

    public O11yRecord setSeverity(Severity severity) {
        if (this != NOOP && severity != null) {
            this.severity = severity;
        }
        return this;
    }

    public O11yRecord recordError(Throwable error) {
        if (this != NOOP && error != null) {
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

    /**
     * Emits the accumulated attributes once, as an event: force-emitted whatever the level, at this
     * record's own severity. The no-op record emits nothing.
     */
    public void emit() {
        if (telemetry != null && emitted.compareAndSet(false, true)) {
            Map<String, Object> copy;
            synchronized (attrs) {
                copy = new LinkedHashMap<>(attrs);
            }
            telemetry.logger().emit(Context.current(), severity, eventName, eventName, copy, true);
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
