package ing.o11y.libo11y.micrometer;

import ing.o11y.libo11y.internal.SensitivityPolicy;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.Tag;
import io.micrometer.core.instrument.config.MeterFilter;
import java.util.ArrayList;
import java.util.List;

/**
 * Micrometer {@link MeterFilter} enforcing libo11y's metric sensitivity contract by stripping
 * every tag classified as {@code secret} or {@code pii} (even when {@code PiiMode.HASH} is active).
 */
public final class SensitivityMeterFilter implements MeterFilter {
    private final SensitivityPolicy policy;

    public SensitivityMeterFilter(SensitivityPolicy policy) {
        this.policy = policy;
    }

    @Override
    public Meter.Id map(Meter.Id id) {
        List<Tag> original = id.getTags();
        if (original.isEmpty()) {
            return id;
        }
        List<Tag> kept = null;
        for (int i = 0; i < original.size(); i++) {
            Tag tag = original.get(i);
            if (policy.isMetricDisallowed(tag.getKey())) {
                if (kept == null) {
                    kept = new ArrayList<>(original.size() - 1);
                    for (int j = 0; j < i; j++) {
                        kept.add(original.get(j));
                    }
                }
            } else if (kept != null) {
                kept.add(tag);
            }
        }
        return kept == null ? id : id.replaceTags(kept);
    }
}
