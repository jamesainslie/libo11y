# libo11y Java

Java 21+ implementation of the libo11y telemetry contract ([docs/DESIGN.md](../docs/DESIGN.md)) built on OpenTelemetry Java SDK 1.68.0, Micrometer 1.18.0, Micrometer Tracing 1.8.0, and Spring Boot 4.2.0 (spec 1.3.0).

## Modules (`groupId: ing.o11y`)

| Artifact | Purpose |
|---|---|
| `libo11y-bom` | Bill of Materials aligning all `libo11y-*` modules |
| `libo11y-spec` | Generated spec constants, enums, validation tables, and strict `yaml.v3`-compatible application registry validator |
| `libo11y` | Core Java 21+ SDK (`O11y.setup` / `O11y.init`, `Telemetry`, `SensitivityPolicy`, `Redact`, `ForceEmit`, `O11yRecord`, `Detached`, `Proc`, `Signals`, SLF4J/Logback bridge, `O11yDataSource`, `O11yHttpClient`) |
| `libo11y-micrometer` | Single-pipeline Micrometer `O11yMeterRegistry` (with `SensitivityMeterFilter` and trace-based exemplars), `O11yMicrometerTracing`, and `O11yObservationHandler` |
| `libo11y-spring-boot-starter` | Spring Boot 4 auto-configuration (`@ConfigurationProperties("libo11y")`, `SmartLifecycle` graceful shutdown, `O11yFailureAnalyzer`, MVC `O11yServletFilter`, `RestClientCustomizer`, `DataSource` wrapping) |
| `libo11y-test` | Hermetic `O11yRecorder`, JUnit 5 `O11yExtension`, `assertConforms` / `assertCorrelated` / `assertTriangle`, and in-process `OtlpHttpReceiver` |
| `libo11y-cli` | `libo11y registry check` command-line validator |

## Installing

Every artifact shares one version. Import the BOM and leave the versions off
the dependencies:

```xml
<dependencyManagement>
    <dependencies>
        <dependency>
            <groupId>ing.o11y</groupId>
            <artifactId>libo11y-bom</artifactId>
            <version>0.1.0</version>
            <type>pom</type>
            <scope>import</scope>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <dependency>
        <groupId>ing.o11y</groupId>
        <artifactId>libo11y-spring-boot-starter</artifactId>
    </dependency>
    <dependency>
        <groupId>ing.o11y</groupId>
        <artifactId>libo11y-test</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
```

The artifacts are on Maven Central, so no repository needs declaring.

### Installing from a GitHub Release

Each `java/` release on GitHub also carries
`libo11y-java-vX.Y.Z-maven-repository.tar.gz`, which holds every artifact
with its POM, sources and javadoc in Maven repository layout. Download and
unpack it next to your build:

```sh
curl -fsSLO https://github.com/jamesainslie/libo11y/releases/download/java/v0.1.0/libo11y-java-v0.1.0-maven-repository.tar.gz
tar -xzf libo11y-java-v0.1.0-maven-repository.tar.gz
```

Then add the directory as a repository. In Maven:

```xml
<repositories>
    <repository>
        <id>libo11y-release</id>
        <url>file://${project.basedir}/libo11y-java-v0.1.0-maven-repository</url>
    </repository>
</repositories>
```

In Gradle:

```kotlin
repositories {
    maven { url = uri("libo11y-java-v0.1.0-maven-repository") }
    mavenCentral()
}
```

The third-party dependencies still come from Maven Central. `SHA256SUMS` on
the release lists the checksum of the archive and of each jar, and every
file in the archive has a detached OpenPGP signature (`.asc`) from the
release key `0D7ED402068BC76908086D34F73DED99417B74B2`.

## Quick start (Spring Boot + Micrometer)

Add `ing.o11y:libo11y-spring-boot-starter` and set your service identity in `application.yaml`:

```yaml
spring:
  application:
    name: checkout
libo11y:
  environment: production
```

Then inject standard Micrometer, Observation, SLF4J, and `O11yRecord` APIs in your controllers:

```java
@RestController
class CheckoutController {
    private final MeterRegistry meters;
    private final ObservationRegistry observations;

    CheckoutController(MeterRegistry meters, ObservationRegistry observations) {
        this.meters = meters;
        this.observations = observations;
    }

    @PostMapping("/orders/{id}")
    String placeOrder(@PathVariable String id) {
        O11yRecord.current().set("order.id", id);
        Counter.builder("checkout.orders").tag("payment.method", "card").register(meters).increment();
        return Observation.createNotStarted("checkout.place", observations)
                .lowCardinalityKeyValue("store", "primary")
                .observe(() -> "placed:" + id);
    }
}
```

Every HTTP request receives a route-aware `SERVER` span, `Server-Timing` header, `http.server.request.duration` histogram with trace exemplars, correlated SLF4J logs, and a single `o11y.request.summary` wide event. Micrometer metrics and `@Observed` / `Observation` timers flow through the same single OTel `SdkMeterProvider` with sensitivity filtering and trace-based exemplars.

## Quick start (Core Java 21+)

```java
import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yOptions;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.util.Map;

try (Telemetry telemetry = O11y.setup(O11yOptions.builder()
        .serviceName("checkout")
        .environment(Spec.DeploymentEnvironment.PRODUCTION)
        .build())) {
    Span span = telemetry.tracer("checkout").spanBuilder("checkout.place")
            .setAttribute("order.id", "ord-42")
            .startSpan();
    try (Scope ignored = span.makeCurrent()) {
        telemetry.logger().info("order placed", Map.of("order.id", "ord-42"));
        telemetry.meter("checkout").counterBuilder("checkout.orders")
                .setUnit("{order}")
                .build()
                .add(1L, Attributes.of(AttributeKey.stringKey("payment.method"), "card"), Context.current());
    } finally {
        span.end();
    }
}
```

## Testing

```java
@ExtendWith(O11yExtension.class)
class CheckoutTest {
    @Test
    void closesThreeSignalTriangle(O11yRecorder rec) {
        // Run code under test using rec.telemetry(), then assert:
        rec.assertConforms();
        rec.assertTriangle(traceId);
    }
}
```

## Building locally

```sh
make java-check          # compile with lint warnings as errors, and run every suite
make java-release-check  # build the release artifacts and run a consumer against them
```

Both need JDK 21 and Maven 3.9. [docs/CONVENTIONS.md](../docs/CONVENTIONS.md)
describes the toolchain and the release steps.
