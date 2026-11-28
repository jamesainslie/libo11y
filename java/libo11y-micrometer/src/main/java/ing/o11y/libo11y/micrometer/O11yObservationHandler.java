package ing.o11y.libo11y.micrometer;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.micrometer.common.KeyValue;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationHandler;
import io.opentelemetry.context.Context;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Micrometer {@link ObservationHandler} bridging {@code @Observed} and {@code Observation}
 * lifecycles into libo11y's {@link O11yRecord} wide events and structured logging.
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
    public void onError(Observation.Context context) {
        Throwable err = context.getError();
        if (err == null) {
            return;
        }
        O11yRecord record = O11yRecord.fromContext(Context.current());
        if (record != null) {
            record.recordError(err);
        }
    }

    @Override
    public void onStop(Observation.Context context) {
        Long startNanos = context.get(START_NANOS_KEY);
        double durationSec = startNanos != null ? (System.nanoTime() - startNanos) / 1_000_000_000.0 : 0.0;

        Map<String, Object> attrs = new LinkedHashMap<>();
        for (KeyValue kv : context.getLowCardinalityKeyValues()) {
            attrs.put(kv.getKey(), kv.getValue());
        }
        for (KeyValue kv : context.getHighCardinalityKeyValues()) {
            attrs.put(kv.getKey(), kv.getValue());
        }
        if (context.getError() != null) {
            attrs.put(Spec.Attributes.OUTCOME, Spec.Outcome.FAILURE);
            attrs.put("error.type", context.getError().getClass().getName());
        } else {
            attrs.putIfAbsent(Spec.Attributes.OUTCOME, Spec.Outcome.SUCCESS);
        }
        attrs.put(Spec.Attributes.DURATION, durationSec);

        O11yRecord record = O11yRecord.fromContext(Context.current());
        if (record != null) {
            record.setAll(attrs);
        } else if (emitStandaloneEvent && context.getName() != null && !context.getName().isEmpty()) {
            telemetry.event(context.getName(), attrs);
        }
    }
}
