package ing.o11y.libo11y.test;

import org.junit.jupiter.api.extension.AfterEachCallback;
import org.junit.jupiter.api.extension.BeforeEachCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.ParameterContext;
import org.junit.jupiter.api.extension.ParameterResolver;

/**
 * JUnit 5 extension injecting a fresh hermetic {@link O11yRecorder} per test method and closing it afterward.
 */
public final class O11yExtension implements BeforeEachCallback, AfterEachCallback, ParameterResolver {
    private static final ExtensionContext.Namespace NS = ExtensionContext.Namespace.create(O11yExtension.class);
    private static final String KEY = "recorder";

    @Override
    public void beforeEach(ExtensionContext context) {
        context.getStore(NS).put(KEY, O11yRecorder.start());
    }

    @Override
    public void afterEach(ExtensionContext context) {
        O11yRecorder rec = context.getStore(NS).remove(KEY, O11yRecorder.class);
        if (rec != null) {
            rec.close();
        }
    }

    @Override
    public boolean supportsParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        return parameterContext.getParameter().getType() == O11yRecorder.class;
    }

    @Override
    public Object resolveParameter(ParameterContext parameterContext, ExtensionContext extensionContext) {
        return extensionContext.getStore(NS).get(KEY, O11yRecorder.class);
    }
}
