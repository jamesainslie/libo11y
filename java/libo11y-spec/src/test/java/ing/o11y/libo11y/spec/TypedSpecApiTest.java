package ing.o11y.libo11y.spec;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Pins the typed generated API against the generated registry tables. */
class TypedSpecApiTest {

    /** The closed enums nested in {@link Spec}, found by reflection rather than listed by hand. */
    private static List<Class<?>> closedEnums() {
        List<Class<?>> enums = new ArrayList<>();
        for (Class<?> c : Spec.class.getDeclaredClasses()) {
            if (c.isEnum() && Spec.WireValue.class.isAssignableFrom(c)) {
                enums.add(c);
            }
        }
        return enums;
    }

    /** Every public constant of {@link Spec.Attributes}, by attribute name. */
    private static Map<String, Object> attributeConstants() throws IllegalAccessException {
        Map<String, Object> keys = new LinkedHashMap<>();
        for (Field f : Spec.Attributes.class.getDeclaredFields()) {
            if (Modifier.isPublic(f.getModifiers()) && Modifier.isStatic(f.getModifiers())) {
                Object k = f.get(null);
                String name = k instanceof Spec.Key<?> key
                        ? key.getKey()
                        : assertInstanceOf(Spec.TemplateKey.class, k, f.getName()).getKey();
                assertNull(keys.put(name, k), () -> "two constants for " + name);
            }
        }
        return keys;
    }

    private static Object invokeStatic(Class<?> type, String method, String arg) throws ReflectiveOperationException {
        Method m = type.getMethod(method, String.class);
        try {
            return m.invoke(null, arg);
        } catch (InvocationTargetException e) {
            throw new AssertionError(type.getSimpleName() + "." + method + "(" + arg + ") threw", e.getCause());
        }
    }

    @Test
    void everyEnumLookupRoundTripsItsWireValues() throws ReflectiveOperationException {
        List<Class<?>> enums = closedEnums();
        long enumKeys = SpecTables.ATTRIBUTE_TYPES.values().stream().filter("enum"::equals).count();
        assertEquals(enumKeys, enums.size(), "one Java enum per closed registry value set");
        for (Class<?> type : enums) {
            Set<String> wire = new HashSet<>();
            for (Object constant : type.getEnumConstants()) {
                String value = ((Spec.WireValue) constant).value();
                assertTrue(wire.add(value), () -> type.getSimpleName() + " repeats " + value);
                assertEquals(value, constant.toString(), "toString emits the wire value");
                assertEquals(Optional.of(constant), invokeStatic(type, "fromValue", value));
                assertEquals(Boolean.TRUE, invokeStatic(type, "isValid", value));
            }
            assertEquals(wire, type.getField("WIRE_VALUES").get(null), type.getSimpleName());
            for (String unknown : new String[] {null, "", "not-a-registered-value", "SUCCESS"}) {
                assertEquals(Optional.empty(), invokeStatic(type, "fromValue", unknown),
                        () -> type.getSimpleName() + ".fromValue(" + unknown + ")");
                assertEquals(Boolean.FALSE, invokeStatic(type, "isValid", unknown),
                        () -> type.getSimpleName() + ".isValid(" + unknown + ")");
            }
        }
    }

    @Test
    void everyKeyCarriesItsRegistryType() throws IllegalAccessException {
        Map<String, Object> keys = attributeConstants();
        assertEquals(SpecTables.ATTRIBUTE_TYPES.keySet(), keys.keySet(), "one typed key per registry attribute");
        for (Map.Entry<String, String> entry : SpecTables.ATTRIBUTE_TYPES.entrySet()) {
            String name = entry.getKey();
            String registryType = entry.getValue();
            Object k = keys.get(name);
            if (registryType.startsWith("template[")) {
                Spec.TemplateKey<?> template = assertInstanceOf(Spec.TemplateKey.class, k, name);
                String inner = registryType.substring("template[".length(), registryType.length() - 1);
                assertScalar(name, inner, template.getType(), template.getValueClass());
            } else if (registryType.equals("enum")) {
                Spec.Key<?> key = assertInstanceOf(Spec.Key.class, k, name);
                assertEquals(Spec.ValueType.STRING, key.getType(), name);
                assertTrue(key.getValueClass().isEnum(), () -> name + " is typed by its enum");
                assertTrue(closedEnums().contains(key.getValueClass()), name);
            } else {
                Spec.Key<?> key = assertInstanceOf(Spec.Key.class, k, name);
                assertScalar(name, registryType, key.getType(), key.getValueClass());
            }
        }
    }

    private static void assertScalar(String name, String registryType, Spec.ValueType type, Class<?> valueClass) {
        switch (registryType) {
            case "string" -> {
                assertEquals(Spec.ValueType.STRING, type, name);
                assertEquals(String.class, valueClass, name);
            }
            case "int" -> {
                assertEquals(Spec.ValueType.LONG, type, name);
                assertEquals(Long.class, valueClass, name);
            }
            case "double" -> {
                assertEquals(Spec.ValueType.DOUBLE, type, name);
                assertEquals(Double.class, valueClass, name);
            }
            case "boolean" -> {
                assertEquals(Spec.ValueType.BOOLEAN, type, name);
                assertEquals(Boolean.class, valueClass, name);
            }
            default -> throw new AssertionError(name + " has registry type " + registryType + " with no Java key type");
        }
    }

    @Test
    void enumKeysTieToTheirEnum() {
        Spec.Key<Spec.Outcome> outcome = Spec.Attributes.OUTCOME;
        assertEquals("o11y.outcome", outcome.getKey());
        assertEquals(Spec.Outcome.class, outcome.getValueClass());
        assertEquals("failure", outcome.wireValue(Spec.Outcome.FAILURE));
        assertNull(outcome.wireValue(null));
        Spec.Key<Double> duration = Spec.Attributes.DURATION;
        assertEquals(0.5, duration.wireValue(0.5));
        assertEquals("o11y.outcome", outcome.toString());
    }

    @Test
    void templateKeysBuildTypedKeysFromASuffix() {
        Spec.Key<String> region = Spec.Attributes.LABEL.of("region");
        assertEquals("o11y.label.region", region.getKey());
        assertEquals(Spec.ValueType.STRING, region.getType());
        assertEquals(String.class, region.getValueClass());
        assertEquals(region, Spec.Attributes.LABEL.of("region"));
        assertEquals(region.hashCode(), Spec.Attributes.LABEL.of("region").hashCode());
        assertNotEquals(region, Spec.Attributes.LABEL.of("zone"));
        assertEquals("o11y.label", Spec.Attributes.LABEL.getKey());
        assertThrows(IllegalArgumentException.class, () -> Spec.Attributes.LABEL.of(""));
        assertThrows(NullPointerException.class, () -> Spec.Attributes.LABEL.of(null));
    }

    @Test
    void keysOfTheSameNameAndTypeAreEqual() {
        assertSame(Spec.Attributes.RULE, Spec.Attributes.RULE);
        assertNotEquals(Spec.Attributes.RULE, Spec.Attributes.SIGNAL);
        assertFalse(Spec.Attributes.RULE.equals("o11y.rule"), "a key never equals its plain name");
    }

    @Test
    void deploymentEnvironmentStaysOpen() {
        assertFalse(Spec.DeploymentEnvironment.class.isEnum(), "applications register more environments");
        assertEquals(SpecTables.ENVIRONMENT_VALUES, Spec.DeploymentEnvironment.REGISTERED);
        assertTrue(Spec.DeploymentEnvironment.isRegistered(Spec.DeploymentEnvironment.PRODUCTION));
        assertFalse(Spec.DeploymentEnvironment.isRegistered("qa"));
        assertFalse(Spec.DeploymentEnvironment.isRegistered(null));
    }
}
