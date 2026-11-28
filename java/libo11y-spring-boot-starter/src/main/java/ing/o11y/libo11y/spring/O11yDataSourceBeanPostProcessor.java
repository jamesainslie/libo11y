package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.jdbc.O11yDataSource;
import java.sql.Connection;
import java.util.Locale;
import javax.sql.DataSource;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.BeanPostProcessor;

/** Wraps Spring-managed {@link DataSource} beans in {@link O11yDataSource}. */
public final class O11yDataSourceBeanPostProcessor implements BeanPostProcessor {
    private final ObjectProvider<Telemetry> telemetryProvider;
    private final O11yProperties.Jdbc jdbcProps;

    public O11yDataSourceBeanPostProcessor(
            ObjectProvider<Telemetry> telemetryProvider,
            O11yProperties.Jdbc jdbcProps) {
        this.telemetryProvider = telemetryProvider;
        this.jdbcProps = jdbcProps;
    }

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) throws BeansException {
        if (!(bean instanceof DataSource ds) || bean instanceof O11yDataSource) {
            return bean;
        }
        Telemetry telemetry = telemetryProvider.getIfAvailable();
        if (telemetry == null) {
            return bean;
        }
        String system = jdbcProps.getDbSystem();
        if (system == null || system.isEmpty()) {
            system = detectDbSystem(ds);
        }
        return new O11yDataSource(ds, telemetry, system, jdbcProps.getDbNamespace());
    }

    static String detectDbSystem(DataSource ds) {
        try (Connection conn = ds.getConnection()) {
            String url = conn.getMetaData().getURL();
            if (url != null) {
                String lower = url.toLowerCase(Locale.ROOT);
                if (lower.startsWith("jdbc:postgresql:")) {
                    return "postgresql";
                }
                if (lower.startsWith("jdbc:mysql:")) {
                    return "mysql";
                }
                if (lower.startsWith("jdbc:mariadb:")) {
                    return "mariadb";
                }
                if (lower.startsWith("jdbc:sqlite:")) {
                    return "sqlite";
                }
                if (lower.startsWith("jdbc:h2:")) {
                    return "h2";
                }
            }
        } catch (Exception ignored) {
            // fall through to generic SQL
        }
        return "other_sql";
    }
}
