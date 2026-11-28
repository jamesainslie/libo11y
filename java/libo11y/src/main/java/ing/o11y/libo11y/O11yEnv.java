package ing.o11y.libo11y;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Environment-map sentinel and helpers for hermetic vs process-env initialization. */
public final class O11yEnv {
    private O11yEnv() {}

    /**
     * Pass this sentinel to {@link O11yOptions.Builder#env(Map)} to ignore ambient
     * {@code OTEL_*} environment variables and disable un-injected exporters.
     */
    public static final Map<String, String> HERMETIC = Collections.unmodifiableMap(new LinkedHashMap<>());

    public static boolean isHermetic(Map<String, String> env) {
        return env == HERMETIC;
    }
}
