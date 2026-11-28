package ing.o11y.libo11y.micrometer;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.micrometer.common.KeyValue;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationHandler;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Micrometer {@link ObservationHandler} bridging {@code @Observed} and {@code Observation}
 * lifecycles into libo11y's {@link O11yRecord} wide events and structured logging.
 *
 * <p>An observation that stops inside an active {@link O11yRecord} adds its key values to that
 * record. It never sets the record's {@code o11y.outcome}, {@code o11y.duration} or error: those
 * belong to the code that started the record (the request middleware), so a nested or child
 * observation, failed or not, cannot change the outcome or duration of the request's wide event.
 * An observation with no active record emits its own event, carrying its own outcome and duration,
 * when standalone events are enabled.
 */
public final class O11yObservationHandler implements ObservationHandler<Observation.Context> {
    private static final String START_NANOS_KEY = "libo11y.observation.start_nanos";

    private final Telemetry telemetry;
    private final boolean emitStandaloneEvent;

    public O11yObservationHandler(Telemetry telemetry) {
        this(telemetry, false);
    }

    public O11yObservationHandler(Telemetry telemetry, boolean emitStandaloneEvent) {
        this.telemetry = telemetry;
        this.emitStandaloneEvent = emitStandaloneEvent;
    }

    @Override
    public boolean supportsContext(Observation.Context context) {
        return context != null;
    }

    @Override
    public void onStart(Observation.Context context) {
        context.put(START_NANOS_KEY, System.nanoTime());
    }

    @Override
    public void onStop(Observation.Context context) {
        Map<String, Object> attrs = new LinkedHashMap<>();
        for (KeyValue kv : context.getLowCardinalityKeyValues()) {
            attrs.put(kv.getKey(), kv.getValue());
        }
        for (KeyValue kv : context.getHighCardinalityKeyValues()) {
            attrs.put(kv.getKey(), kv.getValue());
        }

        O11yRecord record = O11yRecord.current();
        if (record != null) {
            // The record's owner decides the outcome and duration of the wide event.
            attrs.remove(Spec.Attributes.OUTCOME);
            attrs.remove(Spec.Attributes.DURATION);
            record.setAll(attrs);
            return;
        }
        if (!emitStandaloneEvent || context.getName() == null || context.getName().isEmpty()) {
            return;
        }
        Throwable error = context.getError();
        if (error != null) {
            attrs.put(Spec.Attributes.OUTCOME, Spec.Outcome.FAILURE);
            attrs.put("error.type", error.getClass().getName());
        } else {
            attrs.putIfAbsent(Spec.Attributes.OUTCOME, Spec.Outcome.SUCCESS);
        }
        Long startNanos = context.get(START_NANOS_KEY);
        double durationSec = startNanos != null ? (System.nanoTime() - startNanos) / 1_000_000_000.0 : 0.0;
        attrs.put(Spec.Attributes.DURATION, durationSec);
        telemetry.event(context.getName(), attrs);
    }
}
