package ing.o11y.libo11y.internal;

import io.opentelemetry.api.baggage.Baggage;
import io.opentelemetry.api.baggage.BaggageBuilder;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.TextMapGetter;
import io.opentelemetry.context.propagation.TextMapPropagator;
import io.opentelemetry.context.propagation.TextMapSetter;
import java.util.Collection;
import java.util.function.Predicate;

/**
 * Wraps a {@link TextMapPropagator} so outgoing {@code inject} filters baggage keys
 * through an egress allowlist while leaving {@code extract} unaltered.
 */
public final class BaggageEgressPropagator implements TextMapPropagator {
    private final TextMapPropagator delegate;
    private final Predicate<String> allowKey;

    public BaggageEgressPropagator(TextMapPropagator delegate, Predicate<String> allowKey) {
        this.delegate = delegate;
        this.allowKey = allowKey;
    }

    @Override
    public Collection<String> fields() {
        return delegate.fields();
    }

    @Override
    public <C> void inject(Context context, C carrier, TextMapSetter<C> setter) {
        Context filtered = filterBaggage(context);
        delegate.inject(filtered, carrier, setter);
    }

    @Override
    public <C> Context extract(Context context, C carrier, TextMapGetter<C> getter) {
        return delegate.extract(context, carrier, getter);
    }

    public Context filterBaggage(Context context) {
        if (allowKey == null) {
            return context;
        }
        Baggage current = Baggage.fromContext(context);
        if (current.isEmpty()) {
            return context;
        }
        BaggageBuilder builder = Baggage.builder();
        current.forEach((key, entry) -> {
            if (allowKey.test(key)) {
                builder.put(key, entry.getValue(), entry.getMetadata());
            }
        });
        return context.with(builder.build());
    }
}
