# libo11y Java

Java 21+ implementation of the libo11y telemetry contract ([docs/DESIGN.md](../docs/DESIGN.md)) built on OpenTelemetry Java SDK 1.68.0, Micrometer 1.18.0, Micrometer Tracing 1.8.0, and Spring Boot 4.2.0 (spec 1.3.0).

## Modules (`groupId: ing.o11y`)

| Artifact | Purpose |
|---|---|
| `libo11y-bom` | Bill of Materials aligning all `libo11y-*` modules |
| `libo11y-spec` | Generated spec constants, enums, validation tables, and strict `yaml.v3`-compatible application registry validator |
| `libo11y` | Core Java 21+ SDK (`O11y.setup` / `O11y.init`, `Telemetry`, `SensitivityPolicy`, `Redact`, `ForceEmit`, `O11yRecord`, `Detached`, `Proc`, `Signals`, SLF4J/Logback bridge, `O11yDataSource`, `O11yHttpClient`) |
| `libo11y-micrometer` | Single-pipeline Micrometer `O11yMeterRegistry` (with `SensitivityMeterFilter` and trace-based exemplars), `O11yMicrometerTracing`, and `O11yObservationHandler` |
| `libo11y-spring-boot-starter` | Spring Boot 4 auto-configuration (`@ConfigurationProperties("libo11y")`, `SmartLifecycle` graceful shutdown, `O11yFailureAnalyzer`, MVC `O11yServletFilter`, `RestClientCustomizer`, `DataSource` instrumentation that keeps the bean type and never connects at startup) |
| `libo11y-test` | Hermetic `O11yRecorder`, JUnit 5 `O11yExtension`, `assertConforms` / `assertCorrelated` / `assertTriangle`, and in-process `OtlpHttpReceiver` |
| `libo11y-cli` | `libo11y registry check` command-line validator, with the same output and exit statuses as the Go binary |

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

## Sensitivity and redaction

The registry classifies every attribute key. libo11y applies that
classification to spans, metrics and logs before anything is exported.

- A `secret` attribute is dropped on every signal. Each drop adds one to
  `o11y.schema.violations`, with `o11y.rule` set to `secret_attribute`.
- A PII attribute follows `O11yOptions.Builder.piiMode`. `DROP`, the default,
  removes it. `HASH` replaces it with a keyed token on spans and logs and
  removes it from metrics. `KEEP` leaves it on every signal.
- Log records that another bridge writes to `Telemetry.loggerProvider()` pass
  through the same policy, including map and array values. Record bodies are
  not classified.
- Every meter from `Telemetry.meter(...)`, `Telemetry.meterProvider()` and the
  global provider applies the policy to data points and exemplars.
  `O11yOptions.Builder.addView` registers a view, and the policy still applies
  to the stream the view produces.
- `Redact.Secret`, `Redact.Masked` and `@Redact.O11yRedact` protect a value
  when it is captured. A protected value renders as `REDACTED`, as a run of
  `X` of the same length, or as nothing. A record's generated `toString()`
  still prints raw component values. Keep such a value in `Secret` or
  `Masked`, or log the record through the structured logger, which scrubs it.

## Logging

- `StructuredLogger.event(...)` and the request summary are emitted whatever
  the configured level.
- Caller attributes named `trace_id` or `span_id` are dropped, so a log line
  cannot claim a trace it does not belong to. The console line also ignores
  caller attributes named `time`, `level`, `msg` or `trace_flags`.
- `O11yLogbackAppender.install(telemetry)` returns an `AutoCloseable` that
  removes only its own appender. While libo11y's console output is on, the
  installation detaches the root logger's `ConsoleAppender`s, and the last
  installation to close restores them. Message arguments are scrubbed before
  the message is formatted. An ERROR record with a throwable carries
  `error.type` and `exception.stacktrace`.
- `O11yRecord.current()` never returns null. Outside a request it returns a
  record that ignores writes. `O11yRecord.fromContext(context)` returns null
  when no record is active.

## JDBC

`O11yDataSource` records `db.client.operation.duration` for every statement.
It creates a client span only when the caller already has a span, so pool
maintenance creates no root spans. `db.query.text` has every literal replaced
by `?` and every comment removed, and is cut to 4096 bytes. It is recorded
only for `postgresql`, `mysql`, `mariadb` and `sqlite`. Driver error messages
are never recorded, because they often quote statement values. `error.type`
carries the exception class name. A batch built with `addBatch` is recorded as
one `BATCH` operation with `db.operation.batch.size`. Connection pool metrics
are not recorded.

The Spring starter instruments each `DataSource` bean without changing its
type. It reads `db.system.name` from the JDBC URL of the first connection the
application borrows, unless `libo11y.jdbc.db-system` sets it.

## Micrometer

`O11yMeterRegistry` exports every Micrometer meter type through the one
OpenTelemetry meter provider.

| Micrometer meter | OpenTelemetry instrument |
|---|---|
| `Counter`, `FunctionCounter` | monotonic sum named after the meter |
| `Gauge`, `TimeGauge` | gauge named after the meter, a time gauge in seconds |
| `Timer`, `DistributionSummary` | explicit-bucket histogram |
| `FunctionTimer` | monotonic sums `<name>.count` and `<name>.sum` in seconds |
| `LongTaskTimer` | up-down sums `<name>.active` and `<name>.duration` in seconds |
| any other `Meter` | one instrument per measurement, named `<name>.<statistic>` |

Service level objectives, or the percentile histogram buckets between the
minimum and maximum expected values, become the bucket boundaries. A timer
with neither uses the semantic-convention seconds buckets from 0.005 to 10.
Client-side percentiles are not exported. Removing a meter, or closing the
registry, unregisters its callbacks.

An observation that runs inside a request adds its key values to the request
summary. It never sets `o11y.outcome`, `o11y.duration` or an error on that
record. The code that started the record sets those.

## Detached work

`Detached.capture` stores the current trace context and baggage in a carrier
for work that runs later, such as a queued job. `Detached.startLinked` starts
a new root span linked to the captured one and restores the baggage.
`Carrier.marshal()` writes the same text format as the Go implementation, so
one language can capture a carrier and another can resume from it.
`Carrier.unmarshal` rejects a malformed carrier with an `O11yException`.

## Registry check

`libo11y-cli` validates application registry files:

```sh
java -jar libo11y-cli-0.1.0.jar registry check registry.yaml
```

The dependency jars must sit beside the CLI jar. The command prints one
`FILE: ok (...)` line for each valid file. It exits 0 when every file is
valid, 1 when a file breaks a policy rule, and 2 on a usage, read or parse
error. The highest status wins when several files are given.

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
