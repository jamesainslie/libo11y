package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.test.O11yRecorder;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * An observation inside a wide event enriches it but never decides its outcome or duration.
 * Those belong to the code that started the record, as in the HTTP middleware.
 */
class ObservationNestingTest {
    private O11yRecorder rec;
    private Telemetry t;
    private ObservationRegistry observations;

    @BeforeEach
    void setUp() {
        rec = O11yRecorder.start();
        t = rec.telemetry();
        observations = ObservationRegistry.create();
        observations.observationConfig().observationHandler(new O11yObservationHandler(t, true));
    }

    @AfterEach
    void tearDown() {
        rec.close();
    }

    private Map<String, Object> summary() {
        return rec.entries().stream()
                .filter(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName()))
                .findFirst()
                .orElseThrow()
                .attributes();
    }

    @Test
    void childFailureDoesNotFailTheEnclosingRecord() {
        try (O11yRecord wide = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
            assertThrows(IllegalStateException.class, () -> Observation.createNotStarted("cache.get", observations)
                    .lowCardinalityKeyValue("cache.name", "users")
                    .observe(() -> {
                        throw new IllegalStateException("miss");
                    }));
            // The request recovered from the cache miss and succeeded.
            wide.setOutcome(Spec.Outcome.SUCCESS);
            wide.set(Spec.Attributes.DURATION, 1.25);
        }

        Map<String, Object> attrs = summary();
        assertEquals(Spec.Outcome.SUCCESS.value(), attrs.get(Spec.Attributes.OUTCOME.getKey()));
        assertEquals(1.25, attrs.get(Spec.Attributes.DURATION.getKey()));
        assertEquals("users", attrs.get("cache.name"));
        assertFalse(attrs.containsKey("error.type"), () -> "child error leaked into the summary: " + attrs);
        assertFalse(attrs.containsKey("exception.message"), () -> "child error leaked into the summary: " + attrs);
    }

    @Test
    void childObservationDoesNotReplaceTheOwnersOutcomeOrDuration() {
        try (O11yRecord wide = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
            wide.setOutcome(Spec.Outcome.FAILURE);
            wide.set(Spec.Attributes.DURATION, 3.0);
            Observation outer = Observation.start("outer", observations);
            try (Observation.Scope ignored = outer.openScope()) {
                Observation.createNotStarted("inner", observations)
                        .lowCardinalityKeyValue("inner.step", "load")
                        .observe(() -> { });
            } finally {
                outer.stop();
            }
        }

        Map<String, Object> attrs = summary();
        assertEquals(Spec.Outcome.FAILURE.value(), attrs.get(Spec.Attributes.OUTCOME.getKey()));
        assertEquals(3.0, attrs.get(Spec.Attributes.DURATION.getKey()));
        assertEquals("load", attrs.get("inner.step"));
    }

    @Test
    void childKeyValuesCannotSetOutcomeOrDuration() {
        try (O11yRecord ignored = O11yRecord.start(t, Spec.Events.REQUEST_SUMMARY)) {
            Observation.createNotStarted("inner", observations)
                    .lowCardinalityKeyValue(Spec.Attributes.OUTCOME.getKey(), Spec.Outcome.FAILURE.value())
                    .highCardinalityKeyValue(Spec.Attributes.DURATION.getKey(), "9")
                    .observe(() -> { });
        }

        Map<String, Object> attrs = summary();
        assertFalse(attrs.containsKey(Spec.Attributes.OUTCOME.getKey()), () -> "child set the outcome: " + attrs);
        assertFalse(attrs.containsKey(Spec.Attributes.DURATION.getKey()), () -> "child set the duration: " + attrs);
    }

    @Test
    void standaloneObservationOwnsItsOutcomeAndDuration() {
        assertThrows(IllegalStateException.class, () -> Observation.createNotStarted("job.run", observations)
                .observe(() -> {
                    throw new IllegalStateException("boom");
                }));

        List<Map<String, Object>> events = rec.entries().stream()
                .filter(e -> "job.run".equals(e.eventName()))
                .map(e -> e.attributes())
                .toList();
        assertEquals(1, events.size());
        assertEquals(Spec.Outcome.FAILURE.value(), events.get(0).get(Spec.Attributes.OUTCOME.getKey()));
        assertEquals(IllegalStateException.class.getName(), events.get(0).get("error.type"));
        assertEquals(Double.class, events.get(0).get(Spec.Attributes.DURATION.getKey()).getClass());
    }
}
