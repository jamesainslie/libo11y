package ing.o11y.libo11y;

import java.util.ArrayList;
import java.util.List;

/**
 * Per-signal result returned by {@link Telemetry#shutdown(java.time.Duration)} and
 * {@link Telemetry#forceFlush(java.time.Duration)}: each error is {@code null} when the signal
 * finished cleanly, and otherwise names what failed, timed out, or which exports were rejected.
 */
public record ShutdownReport(
        Throwable traceError,
        Throwable metricError,
        Throwable logError) {

    public static final ShutdownReport OK = new ShutdownReport(null, null, null);

    public boolean isOk() {
        return traceError == null && metricError == null && logError == null;
    }

    public List<Throwable> errors() {
        List<Throwable> list = new ArrayList<>(3);
        if (traceError != null) {
            list.add(traceError);
        }
        if (metricError != null) {
            list.add(metricError);
        }
        if (logError != null) {
            list.add(logError);
        }
        return List.copyOf(list);
    }

    public O11yException toException() {
        if (isOk()) {
            return null;
        }
        StringBuilder sb = new StringBuilder("telemetry shutdown failed:");
        if (traceError != null) {
            sb.append(" traces=").append(traceError.getMessage());
        }
        if (metricError != null) {
            sb.append(" metrics=").append(metricError.getMessage());
        }
        if (logError != null) {
            sb.append(" logs=").append(logError.getMessage());
        }
        O11yException ex = new O11yException(O11yException.ErrorCode.EXPORTER, sb.toString());
        for (Throwable t : errors()) {
            ex.addSuppressed(t);
        }
        return ex;
    }
}
