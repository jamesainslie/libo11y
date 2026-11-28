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
import io.micrometer.core.instrument.observation.DefaultMeterObservationHandler;
import io.micrometer.core.instrument.observation.MeterObservationHandler;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationHandler;
import io.micrometer.observation.ObservationPredicate;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.tracing.CurrentTraceContext;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import io.micrometer.tracing.handler.DefaultTracingObservationHandler;
import io.micrometer.tracing.handler.PropagatingReceiverTracingObservationHandler;
import io.micrometer.tracing.handler.PropagatingSenderTracingObservationHandler;
import io.micrometer.tracing.handler.TracingObservationHandler;
import io.micrometer.tracing.otel.bridge.OtelSpan;
import io.micrometer.tracing.propagation.Propagator;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.context.Scope;
import jakarta.servlet.DispatcherType;
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
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.restclient.RestClientCustomizer;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.SmartLifecycle;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.http.client.observation.ClientRequestObservationContext;
import org.springframework.http.server.observation.ServerRequestObservationContext;
import org.springframework.web.client.RestClient;
import org.springframework.web.servlet.config.annotation.AsyncSupportConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Spring Boot auto-configuration wiring a single unified libo11y telemetry pipeline
 * across OpenTelemetry, Micrometer Metrics, Micrometer Tracing, Observation API,
 * SLF4J/Logback, Spring MVC, RestClient, and JDBC DataSources.
 *
 * <p>The {@link Telemetry} is not installed as the process-wide global unless
 * {@code libo11y.install-global=true}, so several application contexts (as in a cached Spring test
 * suite) can run in one JVM. libo11y contributes observation handlers and predicates to the
 * {@link ObservationRegistry} rather than owning it: Boot's registry when its observation
 * auto-configuration is present, or one from {@link O11yObservationAutoConfiguration} otherwise.
 * While libo11y instruments HTTP servers or clients it switches off Spring's own HTTP observations
 * for that side, so each request has one SERVER span and each call one CLIENT span.
 */
@AutoConfiguration(beforeName = {
    "org.springframework.boot.micrometer.metrics.autoconfigure.CompositeMeterRegistryAutoConfiguration",
    "org.springframework.boot.micrometer.metrics.autoconfigure.MetricsAutoConfiguration",
    "org.springframework.boot.micrometer.tracing.autoconfigure.MicrometerTracingAutoConfiguration",
    "org.springframework.boot.micrometer.tracing.opentelemetry.autoconfigure.OpenTelemetryTracingAutoConfiguration",
    "org.springframework.boot.opentelemetry.autoconfigure.OpenTelemetryAutoConfiguration"
})
@ConditionalOnProperty(prefix = "libo11y", name = "enabled", havingValue = "true", matchIfMissing = true)
@EnableConfigurationProperties(O11yProperties.class)
public class O11yAutoConfiguration {
    private static final String BOOT_TRACING_AUTO_CONFIGURATION =
            "org.springframework.boot.micrometer.tracing.autoconfigure.MicrometerTracingAutoConfiguration";

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
        // Boot's console appender already prints every SLF4J line the appender forwards.
        Boolean console = props.getConsoleEnabled();
        builder.consoleEnabled(console != null ? console : !props.isInstallLogbackAppender());
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
        return props.isInstallGlobal() ? O11y.setup(opts) : O11y.init(opts);
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
    @ConditionalOnMissingBean(SensitivityMeterFilter.class)
    public SensitivityMeterFilter libo11ySensitivityMeterFilter(Telemetry telemetry) {
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

    /**
     * Turns observations into spans through libo11y's tracer, in Micrometer's canonical
     * sender, receiver, default order. Boot's own tracing auto-configuration, when present,
     * registers the same handlers from the {@link Tracer} and {@link Propagator} beans instead.
     */
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    @ConditionalOnMissingClass(BOOT_TRACING_AUTO_CONFIGURATION)
    public ObservationHandler.FirstMatchingCompositeObservationHandler libo11yTracingObservationHandler(
            Tracer tracer, Propagator propagator) {
        return new ObservationHandler.FirstMatchingCompositeObservationHandler(
                new PropagatingSenderTracingObservationHandler<>(tracer, propagator),
                new PropagatingReceiverTracingObservationHandler<>(tracer, propagator),
                new DefaultTracingObservationHandler(tracer));
    }

    /**
     * Records observation timers with trace exemplars. Ordered ahead of Boot's default meter
     * handler, which Boot groups with it so only the first one runs.
     */
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE + 1)
    @ConditionalOnMissingBean(ExemplarPreservingMeterObservationHandler.class)
    public ExemplarPreservingMeterObservationHandler libo11yMeterObservationHandler(MeterRegistry meterRegistry) {
        return new ExemplarPreservingMeterObservationHandler(meterRegistry);
    }

    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE + 2)
    @ConditionalOnMissingBean
    public O11yObservationHandler libo11yObservationHandler(Telemetry telemetry, O11yProperties props) {
        return new O11yObservationHandler(telemetry, props.isEmitObservationEvents());
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

    /**
     * Routes SLF4J/Logback logging through this context's {@link Telemetry}. Each context attaches
     * its own appender to the root logger when the bean is created and detaches exactly that
     * appender when it stops, before the telemetry shuts down, so contexts sharing a JVM do not
     * replace or remove each other's appenders.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(name = "ch.qos.logback.classic.LoggerContext")
    @ConditionalOnProperty(prefix = "libo11y", name = "install-logback-appender", havingValue = "true", matchIfMissing = true)
    static class LogbackConfiguration {
        @Bean
        public LogbackAppenderRegistration libo11yLogbackAppenderRegistration(Telemetry telemetry) {
            return new LogbackAppenderRegistration(telemetry);
        }
    }

    /** One context's {@link O11yLogbackAppender} on the Logback root logger. */
    static final class LogbackAppenderRegistration implements SmartLifecycle, DisposableBean {
        private final ch.qos.logback.classic.Logger root;
        private final O11yLogbackAppender appender;
        private final AtomicBoolean attached = new AtomicBoolean(false);

        LogbackAppenderRegistration(Telemetry telemetry) {
            if (org.slf4j.LoggerFactory.getILoggerFactory() instanceof ch.qos.logback.classic.LoggerContext lc) {
                this.root = lc.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
                this.appender = new O11yLogbackAppender(telemetry);
                this.appender.setContext(lc);
                this.appender.start();
                this.root.addAppender(this.appender);
                this.attached.set(true);
            } else {
                this.root = null;
                this.appender = null;
            }
        }

        private void detach() {
            if (attached.compareAndSet(true, false)) {
                root.detachAppender(appender);
                appender.stop();
            }
        }

        @Override
        public void start() {
            // Attached on creation, so startup logging is captured too.
        }

        @Override
        public void stop() {
            detach();
        }

        @Override
        public boolean isRunning() {
            return attached.get();
        }

        /** Stops just before the telemetry shutdown lifecycle, so no log reaches a closed pipeline. */
        @Override
        public int getPhase() {
            return Integer.MIN_VALUE + 1001;
        }

        @Override
        public void destroy() {
            detach();
        }
    }

    /**
     * Restores the observation's span while Micrometer's default meter handler records the timer
     * in {@code onStop}, which runs after the observation's scope has closed, so the timer gets a
     * trace exemplar. Delegates everything else unchanged.
     */
    static final class ExemplarPreservingMeterObservationHandler
            implements MeterObservationHandler<Observation.Context> {
        private final DefaultMeterObservationHandler delegate;

        ExemplarPreservingMeterObservationHandler(MeterRegistry meterRegistry) {
            this.delegate = DefaultMeterObservationHandler.builder(meterRegistry).build();
        }

        @Override
        public void onStart(Observation.Context context) {
            delegate.onStart(context);
        }

        @Override
        public void onError(Observation.Context context) {
            delegate.onError(context);
        }

        @Override
        public void onEvent(Observation.Event event, Observation.Context context) {
            delegate.onEvent(event, context);
        }

        @Override
        public void onStop(Observation.Context context) {
            TracingObservationHandler.TracingContext tc = context.get(TracingObservationHandler.TracingContext.class);
            Span span = tc != null ? tc.getSpan() : null;
            io.opentelemetry.api.trace.Span otelSpan = span != null ? OtelSpan.toOtel(span) : null;
            if (otelSpan == null) {
                delegate.onStop(context);
                return;
            }
            try (Scope ignored = otelSpan.makeCurrent()) {
                delegate.onStop(context);
            }
        }

        @Override
        public boolean supportsContext(Observation.Context context) {
            return delegate.supportsContext(context);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    @ConditionalOnClass({Filter.class, org.springframework.web.servlet.HandlerMapping.class})
    @ConditionalOnProperty(prefix = "libo11y.http", name = "enabled", havingValue = "true", matchIfMissing = true)
    static class ServletWebConfiguration {
        /**
         * Registers the filter for request, async and error dispatches: the request dispatch
         * starts the span, the others only run with its context current.
         */
        @Bean
        @ConditionalOnMissingBean(name = "libo11yServletFilterRegistration")
        public FilterRegistrationBean<O11yServletFilter> libo11yServletFilterRegistration(
                Telemetry telemetry,
                O11yProperties props) {
            FilterRegistrationBean<O11yServletFilter> reg = new FilterRegistrationBean<>();
            reg.setFilter(new O11yServletFilter(telemetry, props.getHttp()));
            reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 10);
            reg.addUrlPatterns("/*");
            reg.setDispatcherTypes(DispatcherType.REQUEST, DispatcherType.ASYNC, DispatcherType.ERROR);
            return reg;
        }

        /** Makes the request's span and wide record current while a controller's {@code Callable} runs. */
        @Bean
        public WebMvcConfigurer libo11yAsyncContextConfigurer() {
            return new WebMvcConfigurer() {
                @Override
                public void configureAsyncSupport(AsyncSupportConfigurer configurer) {
                    configurer.registerCallableInterceptors(new O11yServletFilter.ContextPropagatingCallableInterceptor());
                }
            };
        }

        /** libo11y owns HTTP server telemetry, so Spring's server request observations are off. */
        @Bean
        @ConditionalOnClass(ServerRequestObservationContext.class)
        public ObservationPredicate libo11yServerHttpObservationPredicate() {
            return (name, context) -> !(context instanceof ServerRequestObservationContext);
        }
    }

    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({RestClient.class, RestClientCustomizer.class})
    @ConditionalOnProperty(prefix = "libo11y.http", name = "client-enabled", havingValue = "true", matchIfMissing = true)
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

        /**
         * libo11y owns HTTP client telemetry, so Spring's client request observations, which
         * {@code RestClient} and {@code RestTemplate} share, are off.
         */
        @Bean
        @ConditionalOnClass(ClientRequestObservationContext.class)
        public ObservationPredicate libo11yClientHttpObservationPredicate() {
            return (name, context) -> !(context instanceof ClientRequestObservationContext);
        }

        /**
         * Instruments {@code RestTemplate} too, so switching off Spring's client observations does
         * not leave it untraced. {@code RestTemplate} is deprecated for removal in Spring Framework
         * 7.1; this goes when it does.
         */
        @Configuration(proxyBeanMethods = false)
        @ConditionalOnClass(name = {
            "org.springframework.web.client.RestTemplate",
            "org.springframework.boot.restclient.RestTemplateCustomizer"
        })
        @SuppressWarnings("removal")
        static class RestTemplateConfiguration {
            @Bean
            public org.springframework.boot.restclient.RestTemplateCustomizer libo11yRestTemplateCustomizer(
                    O11yRestClientInterceptor interceptor) {
                return restTemplate -> restTemplate.getInterceptors().add(interceptor);
            }
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
