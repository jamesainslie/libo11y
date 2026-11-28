package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.common.export.MemoryMode;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.LogRecordExporter;
import io.opentelemetry.sdk.metrics.Aggregation;
import io.opentelemetry.sdk.metrics.InstrumentType;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.export.MetricExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Records the export failures of one signal so a shutdown or flush can report them. The batch
 * processors and the periodic reader discard an export's result, so the exporters they drive are
 * wrapped with {@link #observe(SpanExporter)} and its overloads, and every failed export is handed
 * to each {@link Window} open at the time: a shutdown or flush opens one around its own work, and
 * so also sees a batch a background worker exported while it ran, as Go's SDK does.
 */
public final class ExportFailures {
    /** Failures reported in full; later ones are only counted. */
    static final int REPORTED = 5;

    private final Spec.Signal signal;
    private final List<Window> open = new CopyOnWriteArrayList<>();

    /** Creates the recorder of {@code signal}: traces, metrics or logs. */
    public ExportFailures(Spec.Signal signal) {
        this.signal = signal;
    }

    /** Raised for an export that failed without saying why. */
    public static final class ExportFailedException extends RuntimeException {
        ExportFailedException(String message) {
            super(message);
        }
    }

    /** Opens a window that collects every failure recorded until it is closed. */
    public Window open() {
        Window w = new Window();
        open.add(w);
        return w;
    }

    /** Collects the failures recorded while it is open. */
    public final class Window {
        private final List<Throwable> failures = new ArrayList<>();
        private int count;

        private Window() {}

        private synchronized void add(Throwable failure) {
            count++;
            if (failures.size() < REPORTED) {
                failures.add(failure);
            }
        }

        /**
         * Closes the window and returns what failed while it was open: {@code null} when nothing
         * did, the failure itself when one export failed, and otherwise an
         * {@link ExportFailedException} that counts them and carries the first few as suppressed.
         */
        public synchronized Throwable close() {
            open.remove(this);
            if (count == 0) {
                return null;
            }
            if (count == 1) {
                return failures.get(0);
            }
            ExportFailedException all = new ExportFailedException(String.format(
                    Locale.ROOT, "%d %s exports failed", count, signal));
            failures.forEach(all::addSuppressed);
            return all;
        }
    }

    void record(CompletableResultCode result) {
        if (result.isSuccess()) {
            return;
        }
        Throwable cause = result.getFailureThrowable();
        record(cause != null ? cause : new ExportFailedException(signal + " export failed"));
    }

    void record(Throwable failure) {
        for (Window w : open) {
            w.add(failure);
        }
    }

    private CompletableResultCode watch(CompletableResultCode result) {
        result.whenComplete(() -> record(result));
        return result;
    }

    private <T> T rethrowAfterRecording(RuntimeException ex) {
        record(ex);
        throw ex;
    }

    /** Wraps {@code delegate} so its failed exports are recorded. */
    public SpanExporter observe(SpanExporter delegate) {
        return new SpanExporter() {
            @Override
            public CompletableResultCode export(Collection<SpanData> spans) {
                try {
                    return watch(delegate.export(spans));
                } catch (RuntimeException ex) {
                    return rethrowAfterRecording(ex);
                }
            }

            @Override
            public CompletableResultCode flush() {
                return delegate.flush();
            }

            @Override
            public CompletableResultCode shutdown() {
                return delegate.shutdown();
            }

            @Override
            public String toString() {
                return delegate.toString();
            }
        };
    }

    /** Wraps {@code delegate} so its failed exports are recorded. */
    public LogRecordExporter observe(LogRecordExporter delegate) {
        return new LogRecordExporter() {
            @Override
            public CompletableResultCode export(Collection<LogRecordData> logs) {
                try {
                    return watch(delegate.export(logs));
                } catch (RuntimeException ex) {
                    return rethrowAfterRecording(ex);
                }
            }

            @Override
            public CompletableResultCode flush() {
                return delegate.flush();
            }

            @Override
            public CompletableResultCode shutdown() {
                return delegate.shutdown();
            }

            @Override
            public String toString() {
                return delegate.toString();
            }
        };
    }

    /** Wraps {@code delegate} so its failed exports are recorded; temporality and aggregation stay the delegate's. */
    public MetricExporter observe(MetricExporter delegate) {
        return new MetricExporter() {
            @Override
            public CompletableResultCode export(Collection<MetricData> metrics) {
                try {
                    return watch(delegate.export(metrics));
                } catch (RuntimeException ex) {
                    return rethrowAfterRecording(ex);
                }
            }

            @Override
            public AggregationTemporality getAggregationTemporality(InstrumentType instrumentType) {
                return delegate.getAggregationTemporality(instrumentType);
            }

            @Override
            public Aggregation getDefaultAggregation(InstrumentType instrumentType) {
                return delegate.getDefaultAggregation(instrumentType);
            }

            @Override
            public MemoryMode getMemoryMode() {
                return delegate.getMemoryMode();
            }

            @Override
            public CompletableResultCode flush() {
                return delegate.flush();
            }

            @Override
            public CompletableResultCode shutdown() {
                return delegate.shutdown();
            }

            @Override
            public String toString() {
                return delegate.toString();
            }
        };
    }
}
