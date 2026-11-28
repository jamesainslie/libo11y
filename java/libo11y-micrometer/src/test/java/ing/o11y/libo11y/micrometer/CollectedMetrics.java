package ing.o11y.libo11y.micrometer;

import static org.junit.jupiter.api.Assertions.assertEquals;

import ing.o11y.libo11y.test.O11yRecorder;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import java.util.List;
import java.util.Optional;

/** One collection cycle of a recorder's metric reader, with lookups by metric name. */
final class CollectedMetrics {
    private final List<MetricData> metrics;

    private CollectedMetrics(List<MetricData> metrics) {
        this.metrics = metrics;
    }

    static CollectedMetrics collect(O11yRecorder rec) {
        return new CollectedMetrics(rec.metrics());
    }

    List<MetricData> named(String name) {
        return metrics.stream().filter(m -> name.equals(m.getName())).toList();
    }

    Optional<MetricData> find(String name) {
        List<MetricData> found = named(name);
        return found.isEmpty() ? Optional.empty() : Optional.of(found.get(0));
    }

    /** Returns the only metric with this name, failing when there is none or more than one. */
    MetricData only(String name) {
        List<MetricData> found = named(name);
        assertEquals(1, found.size(), () -> "metrics named " + name + ": " + found);
        return found.get(0);
    }

    /** Returns the only point of the only metric with this name. */
    PointData point(String name) {
        List<? extends PointData> points = List.copyOf(only(name).getData().getPoints());
        assertEquals(1, points.size(), () -> "points of " + name + ": " + points);
        return points.get(0);
    }
}
