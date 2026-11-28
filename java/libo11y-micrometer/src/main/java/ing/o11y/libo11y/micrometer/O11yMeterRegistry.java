package ing.o11y.libo11y.micrometer;

import ing.o11y.libo11y.Telemetry;
import io.micrometer.core.instrument.AbstractMeter;
import io.micrometer.core.instrument.Clock;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.FunctionTimer;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.LongTaskTimer;
import io.micrometer.core.instrument.Measurement;
import io.micrometer.core.instrument.Meter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tag;
import io.micrometer.core.instrument.TimeGauge;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.cumulative.CumulativeFunctionCounter;
import io.micrometer.core.instrument.cumulative.CumulativeFunctionTimer;
import io.micrometer.core.instrument.distribution.DistributionStatisticConfig;
import io.micrometer.core.instrument.distribution.HistogramSnapshot;
import io.micrometer.core.instrument.distribution.pause.PauseDetector;
import io.micrometer.core.instrument.internal.DefaultGauge;
import io.micrometer.core.instrument.internal.DefaultLongTaskTimer;
import io.micrometer.core.instrument.internal.DefaultMeter;
import io.micrometer.core.instrument.noop.NoopCounter;
import io.micrometer.core.instrument.noop.NoopDistributionSummary;
import io.micrometer.core.instrument.noop.NoopTimer;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleCounter;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.ObservableDoubleGauge;
import io.opentelemetry.context.Context;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.DoubleAdder;
import java.util.concurrent.atomic.LongAdder;
import java.util.function.Supplier;
import java.util.function.ToDoubleFunction;
import java.util.function.ToLongFunction;

/**
 * Idiomatic Micrometer {@link MeterRegistry} routed directly into {@link Telemetry}'s single
 * OpenTelemetry {@code MeterProvider} pipeline:
 * <ul>
 *   <li>Zero dual-export split: Micrometer and OTel instruments share one resource and OTLP pipeline.</li>
 *   <li>Enforces {@code SensitivityPolicy} via {@link SensitivityMeterFilter} and the policy meter.</li>
 *   <li>Propagates {@link Context#current()} on every measurement so trace-based exemplars attach natively.</li>
 *   <li>Uses seconds ({@link TimeUnit#SECONDS}) as base time unit to match OpenTelemetry semantic conventions.</li>
 * </ul>
 */
public final class O11yMeterRegistry extends MeterRegistry implements AutoCloseable {
    private final io.opentelemetry.api.metrics.Meter otelMeter;
    private final List<AutoCloseable> asyncHandles = new CopyOnWriteArrayList<>();

    public O11yMeterRegistry(Telemetry telemetry) {
        this(telemetry, Clock.SYSTEM);
    }

    public O11yMeterRegistry(Telemetry telemetry, Clock clock) {
        super(clock);
        this.otelMeter = telemetry.meter("libo11y.micrometer");
        config().meterFilter(new SensitivityMeterFilter(telemetry.policy()));
    }

    @Override
    protected TimeUnit getBaseTimeUnit() {
        return TimeUnit.SECONDS;
    }

    @Override
    protected DistributionStatisticConfig defaultHistogramConfig() {
        return DistributionStatisticConfig.DEFAULT;
    }

    private static Attributes toAttributes(Meter.Id id) {
        List<Tag> tags = id.getTags();
        if (tags.isEmpty()) {
            return Attributes.empty();
        }
        AttributesBuilder b = Attributes.builder();
        for (Tag t : tags) {
            b.put(AttributeKey.stringKey(t.getKey()), t.getValue());
        }
        return b.build();
    }

    @Override
    protected Counter newCounter(Meter.Id id) {
        if (isClosed()) {
            return new NoopCounter(id);
        }
        var builder = otelMeter.counterBuilder(id.getName()).ofDoubles();
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        if (id.getBaseUnit() != null) {
            builder.setUnit(id.getBaseUnit());
        }
        DoubleCounter otelCounter = builder.build();
        Attributes attrs = toAttributes(id);
        return new O11yCounter(id, otelCounter, attrs);
    }

    @Override
    protected Timer newTimer(Meter.Id id, DistributionStatisticConfig distributionStatisticConfig, PauseDetector pauseDetector) {
        if (isClosed()) {
            return new NoopTimer(id);
        }
        var builder = otelMeter.histogramBuilder(id.getName()).setUnit("s");
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        DoubleHistogram histogram = builder.build();
        Attributes attrs = toAttributes(id);
        return new O11yTimer(id, clock, histogram, attrs);
    }

    @Override
    protected DistributionSummary newDistributionSummary(Meter.Id id, DistributionStatisticConfig distributionStatisticConfig, double scale) {
        if (isClosed()) {
            return new NoopDistributionSummary(id);
        }
        var builder = otelMeter.histogramBuilder(id.getName());
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        if (id.getBaseUnit() != null) {
            builder.setUnit(id.getBaseUnit());
        }
        DoubleHistogram histogram = builder.build();
        Attributes attrs = toAttributes(id);
        return new O11yDistributionSummary(id, histogram, attrs, scale);
    }

    @Override
    protected <T> Gauge newGauge(Meter.Id id, T obj, ToDoubleFunction<T> valueFunction) {
        DefaultGauge<T> gauge = new DefaultGauge<>(id, obj, valueFunction);
        var builder = otelMeter.gaugeBuilder(id.getName());
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        if (id.getBaseUnit() != null) {
            builder.setUnit(id.getBaseUnit());
        }
        Attributes attrs = toAttributes(id);
        ObservableDoubleGauge handle = builder.buildWithCallback(m -> {
            double v = gauge.value();
            if (!Double.isNaN(v)) {
                m.record(v, attrs);
            }
        });
        asyncHandles.add(handle);
        return gauge;
    }

    @Override
    protected <T> TimeGauge newTimeGauge(Meter.Id id, T obj, TimeUnit valueFunctionUnit, ToDoubleFunction<T> valueFunction) {
        TimeGauge tg = super.newTimeGauge(id, obj, valueFunctionUnit, valueFunction);
        var builder = otelMeter.gaugeBuilder(id.getName()).setUnit("s");
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        Attributes attrs = toAttributes(id);
        ObservableDoubleGauge handle = builder.buildWithCallback(m -> {
            double v = tg.value(TimeUnit.SECONDS);
            if (!Double.isNaN(v)) {
                m.record(v, attrs);
            }
        });
        asyncHandles.add(handle);
        return tg;
    }

    @Override
    protected <T> FunctionCounter newFunctionCounter(Meter.Id id, T obj, ToDoubleFunction<T> countFunction) {
        CumulativeFunctionCounter<T> fc = new CumulativeFunctionCounter<>(id, obj, countFunction);
        var builder = otelMeter.counterBuilder(id.getName()).ofDoubles();
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        if (id.getBaseUnit() != null) {
            builder.setUnit(id.getBaseUnit());
        }
        Attributes attrs = toAttributes(id);
        asyncHandles.add(builder.buildWithCallback(m -> {
            double v = fc.count();
            if (Double.isFinite(v) && v >= 0) {
                m.record(v, attrs);
            }
        }));
        return fc;
    }

    @Override
    protected <T> FunctionTimer newFunctionTimer(
            Meter.Id id,
            T obj,
            ToLongFunction<T> countFunction,
            ToDoubleFunction<T> totalTimeFunction,
            TimeUnit totalTimeFunctionUnit) {
        return new CumulativeFunctionTimer<>(id, obj, countFunction, totalTimeFunction, totalTimeFunctionUnit, getBaseTimeUnit());
    }

    @Override
    protected LongTaskTimer newLongTaskTimer(Meter.Id id, DistributionStatisticConfig distributionStatisticConfig) {
        return new DefaultLongTaskTimer(id, clock, getBaseTimeUnit(), distributionStatisticConfig, false);
    }

    @Override
    protected Meter newMeter(Meter.Id id, Meter.Type type, Iterable<Measurement> measurements) {
        return new DefaultMeter(id, type, measurements);
    }

    @Override
    public void close() {
        for (AutoCloseable h : asyncHandles) {
            try {
                h.close();
            } catch (Exception ignored) {
                // best effort
            }
        }
        asyncHandles.clear();
        super.close();
    }

    private static final class O11yCounter extends AbstractMeter implements Counter {
        private final DoubleCounter otelCounter;
        private final Attributes attrs;
        private final DoubleAdder localCount = new DoubleAdder();

        O11yCounter(Meter.Id id, DoubleCounter otelCounter, Attributes attrs) {
            super(id);
            this.otelCounter = otelCounter;
            this.attrs = attrs;
        }

        @Override
        public void increment(double amount) {
            if (amount > 0) {
                localCount.add(amount);
                otelCounter.add(amount, attrs, Context.current());
            }
        }

        @Override
        public double count() {
            return localCount.sum();
        }
    }

    private static final class O11yTimer extends AbstractMeter implements Timer {
        private final Clock clock;
        private final DoubleHistogram histogram;
        private final Attributes attrs;
        private final LongAdder count = new LongAdder();
        private final DoubleAdder totalSeconds = new DoubleAdder();
        private volatile double maxSeconds;

        O11yTimer(Meter.Id id, Clock clock, DoubleHistogram histogram, Attributes attrs) {
            super(id);
            this.clock = clock;
            this.histogram = histogram;
            this.attrs = attrs;
        }

        @Override
        public void record(long amount, TimeUnit unit) {
            if (amount < 0) {
                return;
            }
            double seconds = unit.toNanos(amount) / 1_000_000_000.0;
            count.increment();
            totalSeconds.add(seconds);
            if (seconds > maxSeconds) {
                maxSeconds = seconds;
            }
            histogram.record(seconds, attrs, Context.current());
        }

        @Override
        public <T> T record(Supplier<T> f) {
            long start = clock.monotonicTime();
            try {
                return f.get();
            } finally {
                record(clock.monotonicTime() - start, TimeUnit.NANOSECONDS);
            }
        }

        @Override
        public <T> T recordCallable(Callable<T> f) throws Exception {
            long start = clock.monotonicTime();
            try {
                return f.call();
            } finally {
                record(clock.monotonicTime() - start, TimeUnit.NANOSECONDS);
            }
        }

        @Override
        public void record(Runnable f) {
            long start = clock.monotonicTime();
            try {
                f.run();
            } finally {
                record(clock.monotonicTime() - start, TimeUnit.NANOSECONDS);
            }
        }

        @Override
        public long count() {
            return count.sum();
        }

        @Override
        public double totalTime(TimeUnit unit) {
            return totalSeconds.sum() * unit.convert(1L, TimeUnit.SECONDS);
        }

        @Override
        public double max(TimeUnit unit) {
            return maxSeconds * unit.convert(1L, TimeUnit.SECONDS);
        }

        @Override
        public TimeUnit baseTimeUnit() {
            return TimeUnit.SECONDS;
        }

        @Override
        public HistogramSnapshot takeSnapshot() {
            return HistogramSnapshot.empty(count(), totalTime(TimeUnit.NANOSECONDS), max(TimeUnit.NANOSECONDS));
        }
    }

    private static final class O11yDistributionSummary extends AbstractMeter implements DistributionSummary {
        private final DoubleHistogram histogram;
        private final Attributes attrs;
        private final double scale;
        private final LongAdder count = new LongAdder();
        private final DoubleAdder total = new DoubleAdder();
        private volatile double max;

        O11yDistributionSummary(Meter.Id id, DoubleHistogram histogram, Attributes attrs, double scale) {
            super(id);
            this.histogram = histogram;
            this.attrs = attrs;
            this.scale = scale;
        }

        @Override
        public void record(double amount) {
            if (amount < 0) {
                return;
            }
            double scaled = amount * scale;
            count.increment();
            total.add(scaled);
            if (scaled > max) {
                max = scaled;
            }
            histogram.record(scaled, attrs, Context.current());
        }

        @Override
        public long count() {
            return count.sum();
        }

        @Override
        public double totalAmount() {
            return total.sum();
        }

        @Override
        public double max() {
            return max;
        }

        @Override
        public HistogramSnapshot takeSnapshot() {
            return HistogramSnapshot.empty(count(), totalAmount(), max());
        }
    }
}
