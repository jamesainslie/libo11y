package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.context.Context;
import java.io.File;
import java.io.StringWriter;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.SimpleJavaFileObject;
import javax.tools.ToolProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The record accepts the generated typed keys and closed enums, and the compiler enforces their value types. */
class TypedRecordTest {

    @Test
    void typedKeysStoreWireValues() {
        O11yRecord rec = O11yRecord.create(null, "typed");
        rec.set(Spec.Attributes.DURATION, 0.25)
                .set(Spec.Attributes.RUM_SUMMARY_SEQ, 3L)
                .set(Spec.Attributes.LABEL.of("region"), "emea")
                .setOutcome(Spec.Outcome.FAILURE);
        Map<String, Object> attrs = rec.snapshot();
        assertEquals(0.25, attrs.get("o11y.duration"));
        assertEquals(3L, attrs.get("o11y.rum.summary.seq"));
        assertEquals("emea", attrs.get("o11y.label.region"));
        assertEquals("failure", attrs.get("o11y.outcome"), "an enum is stored as its wire string");
    }

    @Test
    void typedSetIgnoresNullsLikeTheStringForm() {
        O11yRecord rec = O11yRecord.create(null, "typed");
        rec.set((Spec.Key<String>) null, "x").set(Spec.Attributes.RULE, null).setOutcome(null);
        assertTrue(rec.snapshot().isEmpty());
    }

    @Test
    void recordErrorSetsTheFailureOutcome() {
        O11yRecord rec = O11yRecord.create(null, "typed");
        rec.recordError(new IllegalStateException("boom"));
        assertEquals("failure", rec.snapshot().get(Spec.Attributes.OUTCOME.getKey()));
    }

    @Test
    void theCompilerRejectsAValueOfTheWrongType(@TempDir Path out) throws Exception {
        assertTrue(compiles(out, "r.set(Spec.Attributes.DURATION, 0.5).setOutcome(Spec.Outcome.SUCCESS);"),
                "the well-typed control must compile, or the probe proves nothing");
        for (String call : List.of(
                "r.set(Spec.Attributes.DURATION, \"slow\");",
                "r.set(Spec.Attributes.RUM_SUMMARY_SEQ, \"3\");",
                "r.set(Spec.Attributes.RULE, 7L);",
                "r.set(Spec.Attributes.OUTCOME, \"success\");",
                "r.setOutcome(\"success\");")) {
            assertFalse(compiles(out, call), () -> "compiled, but the value type is wrong: " + call);
        }
    }

    private static boolean compiles(Path out, String statement) throws URISyntaxException {
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull(javac, "tests run on a JDK");
        String source = "import ing.o11y.libo11y.O11yRecord;\n"
                + "import ing.o11y.libo11y.spec.generated.Spec;\n"
                + "class Probe {\n"
                + "    void probe(O11yRecord r) {\n"
                + "        " + statement + "\n"
                + "    }\n"
                + "}\n";
        JavaFileObject file = new SimpleJavaFileObject(
                URI.create("string:///Probe.java"), JavaFileObject.Kind.SOURCE) {
            @Override
            public CharSequence getCharContent(boolean ignoreEncodingErrors) {
                return source;
            }
        };
        String classpath = String.join(File.pathSeparator,
                location(O11yRecord.class), location(Spec.class), location(Context.class), location(Severity.class));
        List<String> options = List.of("-proc:none", "-d", out.toString(), "-classpath", classpath);
        return javac.getTask(new StringWriter(), null, null, options, null, List.of(file)).call();
    }

    private static String location(Class<?> type) throws URISyntaxException {
        return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString();
    }
}
