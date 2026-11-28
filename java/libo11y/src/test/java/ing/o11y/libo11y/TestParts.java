package ing.o11y.libo11y;

import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.ReadWriteLogRecord;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.logs.export.LogRecordExporter;
import io.opentelemetry.sdk.metrics.InstrumentType;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.metrics.export.CollectionRegistration;
import io.opentelemetry.sdk.metrics.export.MetricReader;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import java.time.Duration;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Injected parts that record their lifecycle, shared by the lifecycle and environment tests. */
final class TestParts {
    private TestParts() {}

    /** A span exporter that keeps its batches, optionally fails every export, and records shutdown. */
    static final class StoppableSpanExporter implements SpanExporter {
        final List<Collection<SpanData>> batches = new CopyOnWriteArrayList<>();
        private final boolean failExports;
        private final AtomicBoolean shutdown = new AtomicBoolean();

        StoppableSpanExporter() {
            this(false);
        }

        StoppableSpanExporter(boolean failExports) {
            this.failExports = failExports;
        }

        @Override
        public CompletableResultCode export(Collection<SpanData> spans) {
            batches.add(List.copyOf(spans));
            return failExports ? CompletableResultCode.ofFailure() : CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode flush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            shutdown.set(true);
            return CompletableResultCode.ofSuccess();
        }

        boolean shutdownCalled() {
            return shutdown.get();
        }

        int spanCount() {
            return batches.stream().mapToInt(Collection::size).sum();
        }
    }

    /** A log exporter that keeps its batches, optionally fails every export, and records shutdown. */
    static final class StoppableLogExporter implements LogRecordExporter {
        final List<Collection<LogRecordData>> batches = new CopyOnWriteArrayList<>();
        private final boolean failExports;
        private final AtomicBoolean shutdown = new AtomicBoolean();

        StoppableLogExporter() {
            this(false);
        }

        StoppableLogExporter(boolean failExports) {
            this.failExports = failExports;
        }

        @Override
        public CompletableResultCode export(Collection<LogRecordData> logs) {
            batches.add(List.copyOf(logs));
            return failExports ? CompletableResultCode.ofFailure() : CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode flush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            shutdown.set(true);
            return CompletableResultCode.ofSuccess();
        }

        boolean shutdownCalled() {
            return shutdown.get();
        }
    }

    /** A pull reader that records shutdown. */
    static final class StoppableReader implements MetricReader {
        private final AtomicBoolean shutdown = new AtomicBoolean();

        @Override
        public void register(CollectionRegistration registration) {}

        @Override
        public CompletableResultCode forceFlush() {
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode shutdown() {
            shutdown.set(true);
            return CompletableResultCode.ofSuccess();
        }

        @Override
        public AggregationTemporality getAggregationTemporality(InstrumentType instrumentType) {
            return AggregationTemporality.CUMULATIVE;
        }

        boolean shutdownCalled() {
            return shutdown.get();
        }
    }

    /**
     * A span processor that records shutdown and can block inside it until released, or throw
     * from it.
     */
    static final class StoppableSpanProcessor implements SpanProcessor {
        private final CountDownLatch release = new CountDownLatch(1);
        private final boolean block;
        private final RuntimeException failure;
        private final AtomicBoolean shutdown = new AtomicBoolean();
        final AtomicInteger ended = new AtomicInteger();

        StoppableSpanProcessor() {
            this(false, null);
        }

        private StoppableSpanProcessor(boolean block, RuntimeException failure) {
            this.block = block;
            this.failure = failure;
        }

        static StoppableSpanProcessor blocking() {
            return new StoppableSpanProcessor(true, null);
        }

        static StoppableSpanProcessor throwing(RuntimeException failure) {
            return new StoppableSpanProcessor(false, failure);
        }

        void release() {
            release.countDown();
        }

        @Override
        public void onStart(Context parentContext, ReadWriteSpan span) {}

        @Override
        public boolean isStartRequired() {
            return false;
        }

        @Override
        public void onEnd(ReadableSpan span) {
            ended.incrementAndGet();
        }

        @Override
        public boolean isEndRequired() {
            return true;
        }

        @Override
        public CompletableResultCode shutdown() {
            shutdown.set(true);
            if (failure != null) {
                throw failure;
            }
            if (block) {
                try {
                    release.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                }
            }
            return CompletableResultCode.ofSuccess();
        }

        boolean shutdownCalled() {
            return shutdown.get();
        }
    }

    /** A log processor that records shutdown and what it saw. */
    static final class StoppableLogProcessor implements LogRecordProcessor {
        private final AtomicBoolean shutdown = new AtomicBoolean();
        final AtomicInteger emitted = new AtomicInteger();

        @Override
        public void onEmit(Context context, ReadWriteLogRecord logRecord) {
            emitted.incrementAndGet();
        }

        @Override
        public CompletableResultCode shutdown() {
            shutdown.set(true);
            return CompletableResultCode.ofSuccess();
        }

        boolean shutdownCalled() {
            return shutdown.get();
        }
    }

    /** The ids of the live threads whose name starts with one of the OpenTelemetry SDK worker prefixes. */
    static Set<Long> sdkWorkerThreads() {
        Set<Long> ids = new HashSet<>();
        for (Thread t : Thread.getAllStackTraces().keySet()) {
            String n = t.getName();
            if (t.isAlive() && (n.startsWith("BatchSpanProcessor")
                    || n.startsWith("BatchLogRecordProcessor")
                    || n.startsWith("PeriodicMetricReader"))) {
                ids.add(t.threadId());
            }
        }
        return ids;
    }

    /** Waits up to {@code timeout} for every SDK worker thread not in {@code before} to end, and returns the survivors. */
    static Set<Long> newSdkWorkersAfter(Set<Long> before, Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        Set<Long> extra;
        do {
            extra = sdkWorkerThreads();
            extra.removeAll(before);
            if (extra.isEmpty()) {
                return extra;
            }
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        return extra;
    }
}
