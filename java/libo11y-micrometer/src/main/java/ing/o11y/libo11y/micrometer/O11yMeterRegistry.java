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
import io.micrometer.core.instrument.Statistic;
import io.micrometer.core.instrument.Tag;
import io.micrometer.core.instrument.TimeGauge;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.cumulative.CumulativeFunctionCounter;
import io.micrometer.core.instrument.cumulative.CumulativeFunctionTimer;
import io.micrometer.core.instrument.distribution.DistributionStatisticConfig;
import io.micrometer.core.instrument.distribution.HistogramSnapshot;
import io.micrometer.core.instrument.distribution.TimeWindowMax;
import io.micrometer.core.instrument.distribution.pause.PauseDetector;
import io.micrometer.core.instrument.internal.DefaultGauge;
import io.micrometer.core.instrument.internal.DefaultLongTaskTimer;
import io.micrometer.core.instrument.internal.DefaultMeter;
import io.micrometer.core.instrument.noop.NoopCounter;
import io.micrometer.core.instrument.noop.NoopDistributionSummary;
import io.micrometer.core.instrument.noop.NoopFunctionCounter;
import io.micrometer.core.instrument.noop.NoopFunctionTimer;
import io.micrometer.core.instrument.noop.NoopGauge;
import io.micrometer.core.instrument.noop.NoopLongTaskTimer;
import io.micrometer.core.instrument.noop.NoopMeter;
import io.micrometer.core.instrument.noop.NoopTimeGauge;
import io.micrometer.core.instrument.noop.NoopTimer;
import io.micrometer.core.instrument.util.TimeUtils;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.metrics.DoubleCounter;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.DoubleHistogramBuilder;
import io.opentelemetry.context.Context;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.DoubleAdder;
import java.util.concurrent.atomic.LongAdder;
import java.util.function.DoubleSupplier;
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
 *
 * <p>Every Micrometer meter type exports, following the OpenTelemetry Micrometer bridge:
 * <ul>
 *   <li>{@link Counter} and {@link FunctionCounter}: a monotonic sum named after the meter.</li>
 *   <li>{@link Gauge} and {@link TimeGauge}: a gauge named after the meter, a time gauge in seconds.</li>
 *   <li>{@link Timer} and {@link DistributionSummary}: an explicit-bucket histogram. Service level
 *       objectives, or the percentile histogram buckets inside the minimum and maximum expected values,
 *       become the bucket boundaries. A timer with neither uses the semantic-convention seconds
 *       buckets. Client-side percentiles are not exported.</li>
 *   <li>{@link FunctionTimer}: monotonic sums {@code <name>.count} and {@code <name>.sum} (seconds).</li>
 *   <li>{@link LongTaskTimer}: up-down sums {@code <name>.active} and {@code <name>.duration} (seconds).</li>
 *   <li>Any other {@link Meter}: one instrument per measurement, named {@code <name>.<statistic>}.</li>
 * </ul>
 *
 * <p>Removing a meter, or closing the registry, unregisters its OpenTelemetry callbacks.
 */
public final class O11yMeterRegistry extends MeterRegistry implements AutoCloseable {
    /** Seconds buckets the semantic conventions advise for {@code http.server.request.duration}. */
    private static final List<Double> DEFAULT_SECONDS_BUCKETS = List.of(
            0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0);
    private static final TimeUnit BASE_TIME_UNIT = TimeUnit.SECONDS;
    private static final String BASE_TIME_UNIT_SYMBOL = "s";

    private final io.opentelemetry.api.metrics.Meter otelMeter;

    public O11yMeterRegistry(Telemetry telemetry) {
        this(telemetry, Clock.SYSTEM);
    }

    public O11yMeterRegistry(Telemetry telemetry, Clock clock) {
        super(clock);
        this.otelMeter = telemetry.meter("libo11y.micrometer");
        config().meterFilter(new SensitivityMeterFilter(telemetry.policy()));
        // MeterRegistry.close() closes every meter; a removed meter is closed here.
        config().onMeterRemoved(Meter::close);
    }

    @Override
    protected TimeUnit getBaseTimeUnit() {
        return BASE_TIME_UNIT;
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
        var builder = otelMeter.histogramBuilder(id.getName()).setUnit(BASE_TIME_UNIT_SYMBOL);
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        List<Double> buckets = histogramBuckets(distributionStatisticConfig, true);
        builder.setExplicitBucketBoundariesAdvice(buckets.isEmpty() ? DEFAULT_SECONDS_BUCKETS : buckets);
        DoubleHistogram histogram = builder.build();
        Attributes attrs = toAttributes(id);
        return new O11yTimer(id, clock, distributionStatisticConfig, histogram, attrs);
    }

    @Override
    protected DistributionSummary newDistributionSummary(Meter.Id id, DistributionStatisticConfig distributionStatisticConfig, double scale) {
        if (isClosed()) {
            return new NoopDistributionSummary(id);
        }
        DoubleHistogramBuilder builder = otelMeter.histogramBuilder(id.getName());
        if (id.getDescription() != null) {
            builder.setDescription(id.getDescription());
        }
        if (id.getBaseUnit() != null) {
            builder.setUnit(id.getBaseUnit());
        }
        List<Double> buckets = histogramBuckets(distributionStatisticConfig, false);
        if (!buckets.isEmpty()) {
            builder.setExplicitBucketBoundariesAdvice(buckets);
        }
        DoubleHistogram histogram = builder.build();
        Attributes attrs = toAttributes(id);
        return new O11yDistributionSummary(id, clock, distributionStatisticConfig, histogram, attrs, scale);
    }

    /**
     * Returns the bucket boundaries the configuration asks for: its service level objectives and, for a
     * percentile histogram, Micrometer's percentile buckets between the minimum and maximum expected
     * values. Empty when the configuration publishes no histogram. Timer values are nanoseconds and are
     * converted to seconds.
     */
    private static List<Double> histogramBuckets(DistributionStatisticConfig config, boolean nanos) {
        if (!config.isPublishingHistogram()) {
            return List.of();
        }
        List<Double> out = new ArrayList<>();
        for (double bound : config.getHistogramBuckets(true)) {
            double converted = nanos ? TimeUtils.nanosToUnit(bound, BASE_TIME_UNIT) : bound;
            if (Double.isFinite(converted)) {
                out.add(converted);
            }
        }
        return List.copyOf(out);
    }

    @Override
    protected <T> Gauge newGauge(Meter.Id id, T obj, ToDoubleFunction<T> valueFunction) {
        if (isClosed()) {
            return new NoopGauge(id);
        }
        O11yGauge<T> gauge = new O11yGauge<>(id, obj, valueFunction);
        gauge.callbacks.add(gaugeCallback(id.getName(), id.getDescription(), id.getBaseUnit(), toAttributes(id), gauge::value));
        return gauge;
    }

    @Override
    protected <T> TimeGauge newTimeGauge(Meter.Id id, T obj, TimeUnit valueFunctionUnit, ToDoubleFunction<T> valueFunction) {
        if (isClosed()) {
            return new NoopTimeGauge(id);
        }
        O11yTimeGauge<T> gauge = new O11yTimeGauge<>(id, obj, valueFunctionUnit, valueFunction);
        gauge.callbacks.add(gaugeCallback(
                id.getName(), id.getDescription(), BASE_TIME_UNIT_SYMBOL, toAttributes(id), gauge::value));
        return gauge;
    }

    @Override
    protected <T> FunctionCounter newFunctionCounter(Meter.Id id, T obj, ToDoubleFunction<T> countFunction) {
        if (isClosed()) {
            return new NoopFunctionCounter(id);
        }
        O11yFunctionCounter<T> counter = new O11yFunctionCounter<>(id, obj, countFunction);
        counter.callbacks.add(doubleSumCallback(
                id.getName(), id.getDescription(), id.getBaseUnit(), toAttributes(id), true, counter::count));
        return counter;
    }

    @Override
    protected <T> FunctionTimer newFunctionTimer(
            Meter.Id id,
            T obj,
            ToLongFunction<T> countFunction,
            ToDoubleFunction<T> totalTimeFunction,
            TimeUnit totalTimeFunctionUnit) {
        if (isClosed()) {
            return new NoopFunctionTimer(id);
        }
        O11yFunctionTimer<T> timer =
                new O11yFunctionTimer<>(id, obj, countFunction, totalTimeFunction, totalTimeFunctionUnit);
        Attributes attrs = toAttributes(id);
        timer.callbacks.add(longSumCallback(
                id.getName() + ".count", id.getDescription(), "{invocation}", attrs, true, timer::count));
        timer.callbacks.add(doubleSumCallback(id.getName() + ".sum", id.getDescription(), BASE_TIME_UNIT_SYMBOL,
                attrs, true, () -> timer.totalTime(BASE_TIME_UNIT)));
        return timer;
    }

    @Override
    protected LongTaskTimer newLongTaskTimer(Meter.Id id, DistributionStatisticConfig distributionStatisticConfig) {
        if (isClosed()) {
            return new NoopLongTaskTimer(id);
        }
        O11yLongTaskTimer timer = new O11yLongTaskTimer(id, clock, distributionStatisticConfig);
        Attributes attrs = toAttributes(id);
        timer.callbacks.add(longSumCallback(
                id.getName() + ".active", id.getDescription(), "{tasks}", attrs, false, timer::activeTasks));
        timer.callbacks.add(doubleSumCallback(id.getName() + ".duration", id.getDescription(), BASE_TIME_UNIT_SYMBOL,
                attrs, false, () -> timer.duration(BASE_TIME_UNIT)));
        return timer;
    }

    @Override
    protected Meter newMeter(Meter.Id id, Meter.Type type, Iterable<Measurement> measurements) {
        if (isClosed()) {
            return new NoopMeter(id);
        }
        List<Measurement> list = new ArrayList<>();
        measurements.forEach(list::add);
        O11yMeter meter = new O11yMeter(id, type, list);
        Attributes attrs = toAttributes(id);
        for (Measurement m : list) {
            meter.callbacks.add(measurementCallback(id, m, attrs));
        }
        return meter;
    }

    /**
     * Registers one instrument for a custom meter's measurement, named and typed as the OpenTelemetry
     * Micrometer bridge does: totals and counts are monotonic sums, active tasks an up-down sum, and
     * everything else a gauge.
     */
    private Runnable measurementCallback(Meter.Id id, Measurement m, Attributes attrs) {
        Statistic statistic = m.getStatistic();
        // TOTAL_TIME and TOTAL share the tag value "total", so TOTAL_TIME gets its own suffix.
        String suffix = statistic == Statistic.TOTAL_TIME ? "total_time" : statistic.getTagValueRepresentation();
        String name = id.getName() + "." + suffix;
        return switch (statistic) {
            case TOTAL, TOTAL_TIME, COUNT ->
                    doubleSumCallback(name, id.getDescription(), id.getBaseUnit(), attrs, true, m::getValue);
            case ACTIVE_TASKS ->
                    doubleSumCallback(name, id.getDescription(), id.getBaseUnit(), attrs, false, m::getValue);
            case DURATION, MAX, VALUE, UNKNOWN ->
                    gaugeCallback(name, id.getDescription(), id.getBaseUnit(), attrs, m::getValue);
        };
    }

    private Runnable gaugeCallback(
            String name, String description, String unit, Attributes attrs, DoubleSupplier value) {
        var builder = otelMeter.gaugeBuilder(name);
        if (description != null) {
            builder.setDescription(description);
        }
        if (unit != null) {
            builder.setUnit(unit);
        }
        var handle = builder.buildWithCallback(m -> {
            double v = value.getAsDouble();
            if (Double.isFinite(v)) {
                m.record(v, attrs);
            }
        });
        return handle::close;
    }

    private Runnable doubleSumCallback(
            String name, String description, String unit, Attributes attrs, boolean monotonic, DoubleSupplier value) {
        if (monotonic) {
            var builder = otelMeter.counterBuilder(name).ofDoubles();
            if (description != null) {
                builder.setDescription(description);
            }
            if (unit != null) {
                builder.setUnit(unit);
            }
            var handle = builder.buildWithCallback(m -> {
                double v = value.getAsDouble();
                if (Double.isFinite(v) && v >= 0) {
                    m.record(v, attrs);
                }
            });
            return handle::close;
        }
        var builder = otelMeter.upDownCounterBuilder(name).ofDoubles();
        if (description != null) {
            builder.setDescription(description);
        }
        if (unit != null) {
            builder.setUnit(unit);
        }
        var handle = builder.buildWithCallback(m -> {
            double v = value.getAsDouble();
            if (Double.isFinite(v)) {
                m.record(v, attrs);
            }
        });
        return handle::close;
    }

    private Runnable longSumCallback(
            String name, String description, String unit, Attributes attrs, boolean monotonic, DoubleSupplier value) {
        if (monotonic) {
            var builder = otelMeter.counterBuilder(name);
            if (description != null) {
                builder.setDescription(description);
            }
            if (unit != null) {
                builder.setUnit(unit);
            }
            var handle = builder.buildWithCallback(m -> {
                double v = value.getAsDouble();
                if (Double.isFinite(v) && v >= 0) {
                    m.record((long) v, attrs);
                }
            });
            return handle::close;
        }
        var builder = otelMeter.upDownCounterBuilder(name);
        if (description != null) {
            builder.setDescription(description);
        }
        if (unit != null) {
            builder.setUnit(unit);
        }
        var handle = builder.buildWithCallback(m -> {
            double v = value.getAsDouble();
            if (Double.isFinite(v)) {
                m.record((long) v, attrs);
            }
        });
        return handle::close;
    }

    /** The OpenTelemetry callbacks a meter registered, closed once when the meter is removed or closed. */
    private static final class Callbacks {
        private final List<Runnable> closers = new ArrayList<>();
        private boolean closed;

        void add(Runnable closer) {
            synchronized (this) {
                if (!closed) {
                    closers.add(closer);
                    return;
                }
            }
            closer.run();
        }

        void close() {
            List<Runnable> toClose;
            synchronized (this) {
                if (closed) {
                    return;
                }
                closed = true;
                toClose = List.copyOf(closers);
                closers.clear();
            }
            toClose.forEach(Runnable::run);
        }
    }

    private static final class O11yGauge<T> extends DefaultGauge<T> {
        final Callbacks callbacks = new Callbacks();

        O11yGauge(Meter.Id id, T obj, ToDoubleFunction<T> valueFunction) {
            super(id, obj, valueFunction);
        }

        @Override
        public void close() {
            callbacks.close();
        }
    }

    private static final class O11yTimeGauge<T> extends DefaultGauge<T> implements TimeGauge {
        final Callbacks callbacks = new Callbacks();

        O11yTimeGauge(Meter.Id id, T obj, TimeUnit valueFunctionUnit, ToDoubleFunction<T> valueFunction) {
            super(id, obj, o -> TimeUtils.convert(valueFunction.applyAsDouble(o), valueFunctionUnit, BASE_TIME_UNIT));
        }

        @Override
        public TimeUnit baseTimeUnit() {
            return BASE_TIME_UNIT;
        }

        @Override
        public void close() {
            callbacks.close();
        }
    }

    private static final class O11yFunctionCounter<T> extends CumulativeFunctionCounter<T> {
        final Callbacks callbacks = new Callbacks();

        O11yFunctionCounter(Meter.Id id, T obj, ToDoubleFunction<T> countFunction) {
            super(id, obj, countFunction);
        }

        @Override
        public void close() {
            callbacks.close();
        }
    }

    private static final class O11yFunctionTimer<T> extends CumulativeFunctionTimer<T> {
        final Callbacks callbacks = new Callbacks();

        O11yFunctionTimer(Meter.Id id, T obj, ToLongFunction<T> countFunction, ToDoubleFunction<T> totalTimeFunction,
                TimeUnit totalTimeFunctionUnit) {
            super(id, obj, countFunction, totalTimeFunction, totalTimeFunctionUnit, BASE_TIME_UNIT);
        }

        @Override
        public void close() {
            callbacks.close();
        }
    }

    private static final class O11yLongTaskTimer extends DefaultLongTaskTimer {
        final Callbacks callbacks = new Callbacks();

        O11yLongTaskTimer(Meter.Id id, Clock clock, DistributionStatisticConfig config) {
            super(id, clock, BASE_TIME_UNIT, config, false);
        }

        @Override
        public void close() {
            callbacks.close();
        }
    }

    private static final class O11yMeter extends DefaultMeter {
        final Callbacks callbacks = new Callbacks();

        O11yMeter(Meter.Id id, Meter.Type type, Iterable<Measurement> measurements) {
            super(id, type, measurements);
        }

        @Override
        public void close() {
            callbacks.close();
        }
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
        private final TimeWindowMax max;

        O11yTimer(Meter.Id id, Clock clock, DistributionStatisticConfig config, DoubleHistogram histogram,
                Attributes attrs) {
            super(id);
            this.clock = clock;
            this.histogram = histogram;
            this.attrs = attrs;
            this.max = new TimeWindowMax(clock, config);
        }

        @Override
        public void record(long amount, TimeUnit unit) {
            if (amount < 0) {
                return;
            }
            long nanos = unit.toNanos(amount);
            double seconds = TimeUtils.nanosToUnit(nanos, BASE_TIME_UNIT);
            count.increment();
            totalSeconds.add(seconds);
            max.record(nanos, TimeUnit.NANOSECONDS);
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
            return TimeUtils.convert(totalSeconds.sum(), BASE_TIME_UNIT, unit);
        }

        @Override
        public double max(TimeUnit unit) {
            return max.poll(unit);
        }

        @Override
        public TimeUnit baseTimeUnit() {
            return BASE_TIME_UNIT;
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
        private final TimeWindowMax max;

        O11yDistributionSummary(Meter.Id id, Clock clock, DistributionStatisticConfig config,
                DoubleHistogram histogram, Attributes attrs, double scale) {
            super(id);
            this.histogram = histogram;
            this.attrs = attrs;
            this.scale = scale;
            this.max = new TimeWindowMax(clock, config);
        }

        @Override
        public void record(double amount) {
            if (amount < 0) {
                return;
            }
            double scaled = amount * scale;
            count.increment();
            total.add(scaled);
            max.record(scaled);
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
            return max.poll();
        }

        @Override
        public HistogramSnapshot takeSnapshot() {
            return HistogramSnapshot.empty(count(), totalAmount(), max());
        }
    }
}
