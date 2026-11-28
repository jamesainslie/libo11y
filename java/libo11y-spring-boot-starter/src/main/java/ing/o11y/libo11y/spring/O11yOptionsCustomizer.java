package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.O11yOptions;

/**
 * Callback interface for customizing the auto-configured {@link O11yOptions.Builder}
 * in Spring Boot applications.
 */
@FunctionalInterface
public interface O11yOptionsCustomizer {
    void customize(O11yOptions.Builder builder);
}
