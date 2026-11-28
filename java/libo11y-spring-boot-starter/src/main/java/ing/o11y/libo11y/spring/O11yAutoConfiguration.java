package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.logback.O11yLogbackAppender;
import ing.o11y.libo11y.micrometer.O11yMeterRegistry;
import ing.o11y.libo11y.micrometer.O11yMicrometerTracing;
import ing.o11y.libo11y.micrometer.O11yObservationHandler;
import ing.o11y.libo11y.micrometer.SensitivityMeterFilter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.config.MeterFilter;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.tracing.CurrentTraceContext;
import io.micrometer.tracing.Tracer;
import io.micrometer.tracing.propagation.Propagator;
import io.opentelemetry.api.OpenTelemetry;
import jakarta.servlet.Filter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.restclient.RestClientCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.env.Environment;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.web.client.RestClient;

/**
 * Spring Boot auto-configuration wiring a single unified libo11y telemetry pipeline
 * across OpenTelemetry, Micrometer Metrics, Micrometer Tracing, Observation API,
 * SLF4J/Logback, Spring MVC, RestClient, and JDBC DataSources.
 */
@AutoConfiguration(beforeName = {
    "org.springframework.boot.micrometer.metrics.autoconfigure.CompositeMeterRegistryAutoConfiguration",
    "org.springframework.boot.micrometer.metrics.autoconfigure.MetricsAutoConfiguration",
    "org.springframework.boot.micrometer.observation.autoconfigure.ObservationAutoConfiguration",
    "org.springframework.boot.micrometer.tracing.autoconfigure.MicrometerTracingAutoConfiguration",
    "org.springframework.boot.micrometer.tracing.opentelemetry.autoconfigure.OpenTelemetryTracingAutoConfiguration",
    "org.springframework.boot.opentelemetry.autoconfigure.OpenTelemetryAutoConfiguration"
})
@ConditionalOnProperty(prefix = "libo11y", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(O11yProperties.class)
public class O11yAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public Telemetry libo11yTelemetry(
            O11yProperties props,
            Environment springEnv,
            ResourceLoader resourceLoader,
            ObjectProvider<O11yOptionsCustomizer> customizers) throws IOException {
        O11yOptions.Builder builder = O11yOptions.builder();

        String serviceName = props.getServiceName();
        if (serviceName == null || serviceName.isBlank()) {
            serviceName = springEnv.getProperty("spring.application.name");
        }
        if (serviceName != null && !serviceName.isBlank()) {
            builder.serviceName(serviceName);
        }
        if (props.getServiceVersion() != null && !props.getServiceVersion().isBlank()) {
            builder.serviceVersion(props.getServiceVersion());
        }
        if (props.getServiceNamespace() != null && !props.getServiceNamespace().isBlank()) {
            builder.serviceNamespace(props.getServiceNamespace());
        }
        if (props.getEnvironment() != null && !props.getEnvironment().isBlank()) {
            builder.environment(props.getEnvironment());
        }
        if (!props.getExtraEnvironments().isEmpty()) {
            builder.extraEnvironments(props.getExtraEnvironments());
        }
        builder.strictIdentity(props.isStrictIdentity());
        builder.piiMode(props.getPiiMode());
        if (props.getPiiHashKey() != null && !props.getPiiHashKey().isEmpty()) {
            builder.piiHashKey(decodeKey(props.getPiiHashKey()));
        }
        if (props.getExemplarFilter() != null) {
            builder.exemplarFilter(props.getExemplarFilter());
        }
        builder.runtimeMetrics(props.isRuntimeMetrics());
        builder.consoleEnabled(props.isConsoleEnabled());
        builder.logLevel(props.getLogLevel());
        builder.shutdownTimeout(props.getShutdownTimeout());
        if (!props.getResourceAttributes().isEmpty()) {
            builder.resourceAttributes(props.getResourceAttributes());
        }
        if (props.isHermetic()) {
            builder.hermetic();
        }
        if (!props.getBaggageEgressAllow().isEmpty()) {
            Set<String> allowed = new HashSet<>(props.getBaggageEgressAllow());
            builder.baggageEgressAllow(allowed::contains);
        }
        for (String location : props.getAppRegistries()) {
            Resource res = resourceLoader.getResource(location);
            if (res.exists()) {
                String yaml = new String(res.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                builder.addAppRegistryYaml(yaml, location);
            } else {
                builder.addAppRegistryFile(Path.of(location));
            }
        }

        customizers.orderedStream().forEach(c -> c.customize(builder));

        O11yOptions opts = builder.build();
        Telemetry telemetry = props.isInstallGlobal() ? O11y.setup(opts) : O11y.init(opts);
        if (props.isInstallLogbackAppender()) {
            O11yLogbackAppender.install(telemetry);
        }
        return telemetry;
    }

    @Bean
    @ConditionalOnMissingBean
    public OpenTelemetry libo11yOpenTelemetry(Telemetry telemetry) {
        return telemetry.openTelemetry();
    }

    @Bean
    @ConditionalOnMissingBean
    public StructuredLogger libo11yStructuredLogger(Telemetry telemetry) {
        return telemetry.logger();
    }

    @Bean
    @ConditionalOnMissingBean
    public MeterFilter libo11ySensitivityMeterFilter(Telemetry telemetry) {
        return new SensitivityMeterFilter(telemetry.policy());
    }

    @Bean
    @ConditionalOnMissingBean(MeterRegistry.class)
    public O11yMeterRegistry libo11yMeterRegistry(Telemetry telemetry) {
        return new O11yMeterRegistry(telemetry);
    }

    @Bean
    @ConditionalOnMissingBean
    public O11yMicrometerTracing libo11yMicrometerTracing(Telemetry telemetry) {
        return O11yMicrometerTracing.create(telemetry);
    }

    @Bean
    @ConditionalOnMissingBean
    public Tracer libo11yMicrometerTracer(O11yMicrometerTracing tracing) {
        return tracing.tracer();
    }

    @Bean
    @ConditionalOnMissingBean
    public CurrentTraceContext libo11yCurrentTraceContext(O11yMicrometerTracing tracing) {
        return tracing.currentTraceContext();
    }

    @Bean
    @ConditionalOnMissingBean
    public Propagator libo11yMicrometerPropagator(O11yMicrometerTracing tracing) {
        return tracing.propagator();
    }

    @Bean
    @ConditionalOnMissingBean
    public O11yObservationHandler libo11yObservationHandler(Telemetry telemetry, O11yProperties props) {
        return new O11yObservationHandler(telemetry, props.isEmitObservationEvents());
    }

    @Bean
    @ConditionalOnMissingBean
    public ObservationRegistry libo11yObservationRegistry(
            O11yMicrometerTracing tracing,
            Telemetry telemetry,
            MeterRegistry meterRegistry,
            O11yProperties props) {
        ObservationRegistry registry = ObservationRegistry.create();
        return tracing.configureObservationRegistry(
                registry, telemetry, meterRegistry, props.isEmitObservationEvents());
    }

    /**
     * Graceful shutdown lifecycle running at low phase so Tomcat/Jetty drains HTTP traffic first,
     * then libo11y flushes all three signals concurrently within the configured deadline.
     */
    @Bean
    public SmartLifecycle libo11yShutdownLifecycle(Telemetry telemetry, O11yProperties props) {
        return new SmartLifecycle() {
            private final AtomicBoolean running = new AtomicBoolean(false);

            @Override
            public void start() {
                running.set(true);
            }

            @Override
            public void stop() {
                if (running.compareAndSet(true, false)) {
                    if (props.isInstallLogbackAppender()) {
                        O11yLogbackAppender.uninstall();
                    }
                    telemetry.shutdown(props.getShutdownTimeout());
                }
            }

            @Override
            public boolean isRunning() {
                return running.get();
            }

            @Override
            public int getPhase() {
                return Integer.MIN_VALUE + 1000;
            }
        };
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    @ConditionalOnClass({Filter.class, org.springframework.web.servlet.HandlerMapping.class})
    @ConditionalOnProperty(prefix = "libo11y.http", name = "enabled", havingValue = "true", matchIfMissing = true)
    static class ServletWebConfiguration {
        @Bean
        @ConditionalOnMissingBean(name = "libo11yServletFilterRegistration")
        public FilterRegistrationBean<O11yServletFilter> libo11yServletFilterRegistration(
                Telemetry telemetry,
                O11yProperties props) {
            FilterRegistrationBean<O11yServletFilter> reg = new FilterRegistrationBean<>();
            reg.setFilter(new O11yServletFilter(telemetry, props.getHttp()));
            reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
            reg.addUrlPatterns("/*");
            return reg;
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({RestClient.class, RestClientCustomizer.class})
    static class RestClientConfiguration {
        @Bean
        @ConditionalOnMissingBean
        public O11yRestClientInterceptor libo11yRestClientInterceptor(Telemetry telemetry) {
            return new O11yRestClientInterceptor(telemetry);
        }

        @Bean
        public RestClientCustomizer libo11yRestClientCustomizer(O11yRestClientInterceptor interceptor) {
            return builder -> builder.requestInterceptor(interceptor);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(DataSource.class)
    @ConditionalOnProperty(prefix = "libo11y.jdbc", name = "enabled", havingValue = "true", matchIfMissing = true)
    static class JdbcConfiguration {
        @Bean
        public static O11yDataSourceBeanPostProcessor libo11yDataSourceBeanPostProcessor(
                ObjectProvider<Telemetry> telemetryProvider,
                ObjectProvider<O11yProperties> properties) {
            return new O11yDataSourceBeanPostProcessor(telemetryProvider, properties);
        }
    }

    private static byte[] decodeKey(String raw) {
        if (raw.startsWith("base64:")) {
            return Base64.getDecoder().decode(raw.substring("base64:".length()));
        }
        if (raw.startsWith("hex:")) {
            return HexFormat.of().parseHex(raw.substring("hex:".length()));
        }
        return raw.getBytes(StandardCharsets.UTF_8);
    }
}
