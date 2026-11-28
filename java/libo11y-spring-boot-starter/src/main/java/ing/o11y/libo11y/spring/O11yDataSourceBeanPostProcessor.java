package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.jdbc.O11yDataSource;
import java.lang.reflect.Modifier;
import javax.sql.DataSource;
import org.aopalliance.intercept.MethodInterceptor;
import org.aopalliance.intercept.MethodInvocation;
import org.springframework.aop.ProxyMethodInvocation;
import org.springframework.aop.framework.Advised;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.util.ClassUtils;

/**
 * Instruments Spring-managed {@link DataSource} beans with {@link O11yDataSource}.
 *
 * <p>Each pool is wrapped in a Spring AOP proxy of its own class, so it can still be injected by its
 * concrete type (for example {@code HikariDataSource}). Only a final pool class falls back to a
 * proxy of its interfaces. The proxy intercepts {@code getConnection}, and {@code unwrap} and {@code
 * isWrapperFor} report the proxy itself for any type it implements and otherwise delegate to the
 * pool.
 *
 * <p>Nothing happens at startup: the telemetry and the properties are looked up lazily, no
 * connection is opened, and {@code db.system.name}, unless {@code libo11y.jdbc.db-system} sets it,
 * is read from the JDBC URL of the first connection the application borrows.
 */
public final class O11yDataSourceBeanPostProcessor implements BeanPostProcessor {
    private final ObjectProvider<Telemetry> telemetryProvider;
    private final ObjectProvider<O11yProperties> propertiesProvider;

    /**
     * Creates the post-processor. Neither provider is resolved until a data source is first used.
     *
     * @param telemetryProvider the telemetry that records the operations; when none is available,
     *     connections pass through uninstrumented
     * @param propertiesProvider the libo11y properties, for {@code libo11y.jdbc.db-system} and
     *     {@code libo11y.jdbc.db-namespace}
     */
    public O11yDataSourceBeanPostProcessor(
            ObjectProvider<Telemetry> telemetryProvider,
            ObjectProvider<O11yProperties> propertiesProvider) {
        this.telemetryProvider = telemetryProvider;
        this.propertiesProvider = propertiesProvider;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (!(bean instanceof DataSource) || bean instanceof O11yDataSource || isInstrumented(bean)) {
            return bean;
        }
        Interceptor interceptor = new Interceptor();
        if (bean instanceof Advised advised && !advised.isFrozen()) {
            advised.addAdvice(0, interceptor);
            return bean;
        }
        ProxyFactory factory = new ProxyFactory(bean);
        if (Modifier.isFinal(bean.getClass().getModifiers())) {
            factory.setInterfaces(ClassUtils.getAllInterfaces(bean));
        } else {
            factory.setProxyTargetClass(true);
        }
        factory.addAdvice(interceptor);
        return factory.getProxy(bean.getClass().getClassLoader());
    }

    private static boolean isInstrumented(Object bean) {
        if (!(bean instanceof Advised advised)) {
            return false;
        }
        for (var advisor : advised.getAdvisors()) {
            if (advisor.getAdvice() instanceof Interceptor) {
                return true;
            }
        }
        return false;
    }

    /**
     * Routes connections through an {@link O11yDataSource} that is built on first use around the
     * proxy's target, never the proxy itself, so the wrapper cannot call back into this interceptor.
     */
    private final class Interceptor implements MethodInterceptor {
        private volatile DataSource instrumented;

        @Override
        public Object invoke(MethodInvocation invocation) throws Throwable {
            Object[] args = invocation.getArguments();
            switch (invocation.getMethod().getName()) {
                case "getConnection" -> {
                    DataSource ds = instrumented((DataSource) invocation.getThis());
                    if (ds == null) {
                        return invocation.proceed();
                    }
                    return args.length == 2 ? ds.getConnection((String) args[0], (String) args[1]) : ds.getConnection();
                }
                case "unwrap" -> {
                    if (args.length == 1 && args[0] instanceof Class<?> iface && iface.isInstance(proxy(invocation))) {
                        return proxy(invocation);
                    }
                }
                case "isWrapperFor" -> {
                    if (args.length == 1 && args[0] instanceof Class<?> iface && iface.isInstance(proxy(invocation))) {
                        return true;
                    }
                }
                default -> {
                    // every other method goes straight to the pool
                }
            }
            return invocation.proceed();
        }

        private Object proxy(MethodInvocation invocation) {
            return invocation instanceof ProxyMethodInvocation pmi ? pmi.getProxy() : invocation.getThis();
        }

        /** Returns the instrumented view of the pool, or {@code null} while no telemetry exists. */
        private DataSource instrumented(DataSource target) {
            DataSource ds = instrumented;
            if (ds != null) {
                return ds;
            }
            synchronized (this) {
                if (instrumented == null) {
                    Telemetry telemetry = telemetryProvider.getIfAvailable();
                    if (telemetry == null) {
                        return null;
                    }
                    O11yProperties props = propertiesProvider.getIfAvailable(O11yProperties::new);
                    String system = props.getJdbc().getDbSystem();
                    String namespace = props.getJdbc().getDbNamespace();
                    instrumented = system == null || system.isBlank()
                            ? O11yDataSource.detectingSystem(target, telemetry, namespace)
                            : new O11yDataSource(target, telemetry, system, namespace);
                }
                return instrumented;
            }
        }
    }
}
