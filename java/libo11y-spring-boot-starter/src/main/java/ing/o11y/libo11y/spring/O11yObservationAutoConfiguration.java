package ing.o11y.libo11y.spring;

import io.micrometer.observation.ObservationHandler;
import io.micrometer.observation.ObservationPredicate;
import io.micrometer.observation.ObservationRegistry;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;

/**
 * Provides an {@link ObservationRegistry} only when nothing else does, typically because Boot's
 * observation auto-configuration ({@code spring-boot-micrometer-observation}, part of the
 * actuator) is not on the classpath. It registers the {@link ObservationHandler} and
 * {@link ObservationPredicate} beans, libo11y's among them, in their bean order. When Boot's
 * registry is present, Boot registers the same beans and applies its customizers and
 * {@code management.observations.*} properties, and this configuration backs off.
 */
@AutoConfiguration(
        after = O11yAutoConfiguration.class,
        afterName = "org.springframework.boot.micrometer.observation.autoconfigure.ObservationAutoConfiguration")
@ConditionalOnProperty(prefix = "libo11y", name = "enabled", havingValue = "true", matchIfMissing = true)
public class O11yObservationAutoConfiguration {

    /** A registry carrying every observation handler and predicate bean. */
    @Bean
    @ConditionalOnMissingBean
    public ObservationRegistry libo11yObservationRegistry(
            ObjectProvider<ObservationPredicate> predicates,
            ObjectProvider<ObservationHandler<?>> handlers) {
        ObservationRegistry registry = ObservationRegistry.create();
        predicates.orderedStream().forEach(registry.observationConfig()::observationPredicate);
        handlers.orderedStream().forEach(registry.observationConfig()::observationHandler);
        return registry;
    }
}
