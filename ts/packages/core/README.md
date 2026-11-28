# @libo11y/core

The platform-neutral libo11y core for TypeScript. It resolves the
configuration, enforces the identity contract and the sensitivity policy,
and builds the trace, metric and log pipelines over the OpenTelemetry JS
SDK 3.x. It has no runtime dependencies beyond OpenTelemetry and
`@libo11y/spec`.

Core does not detect resources, build exporters or carry async context by
itself. A runtime package supplies those as a `Platform`. On Bun and Node
that package is [`@libo11y/server`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/server), which exports `setup` and
`createTelemetry` with its platform already bound. In a browser it is
[`@libo11y/web`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/web),
and in a Manifest V3 extension
[`@libo11y/webext`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/webext).

```sh
npm install @libo11y/server @libo11y/core @opentelemetry/api
```

An application calls `setup` from `@libo11y/server`, which also re-exports
the `Telemetry`, `TelemetryOptions`, `Logger`, `SignalReport` and
`LifecycleOptions` types and `O11yError`. It imports from core directly
only for `forceEmit`, `startRecord` and `currentRecord`, and for the other
types, such as `LogAttributes` and `WideRecord`.

## Quick start

```ts
import { currentRecord, forceEmit } from "@libo11y/core";
import { instrumentServe, setup } from "@libo11y/server";
import { context } from "@opentelemetry/api";

const telemetry = await setup({ serviceName: "checkout", environment: "production" });

telemetry.logger.info("ready", { "server.port": 8080 });
telemetry.event("checkout.completed", { "checkout.order.items": 3 });

// An audit record that the level gate never drops.
context.with(forceEmit(), () => telemetry.logger.debug("refund approved"));

// With canonicalLine, each request emits one o11y.request.summary event, and
// currentRecord() inside the handler adds to it.
const handler = instrumentServe(
  async () => {
    currentRecord().set({ "checkout.cart.size": 3 });
    return new Response("ok");
  },
  { telemetry, canonicalLine: true },
);
Bun.serve({ port: 8080, fetch: handler });
```

`setupWith(options, platform)` and `createTelemetryWith(options, platform)`
are the entry points that `@libo11y/server` binds. `setupWith` is Go's
`Setup`. It emits the `o11y.telemetry.configured` canary, then installs the
context manager, the tracer, meter and logger providers, the propagator and
a rate-limited error handler globally. `createTelemetryWith` is Go's `New`.
It installs nothing in the OpenTelemetry globals and emits no canary.

Two options still reach outside a `createTelemetryWith` handle:

- `captureConsole: true` patches the platform's console object until
  `shutdown`. On `@libo11y/server` that is `globalThis.console`. It is off
  by default. Leave it off for a handle that must touch nothing global.
  The arguments of a captured call become the record body, which the
  sensitivity policy never classifies.
- `runtimeMetrics`, on by default, starts the platform's runtime metrics.
  On `@libo11y/server` upstream's instrumentation installs a
  require-in-the-middle hook on `Module.prototype.require`, and the hook
  stays for the life of the process, after `shutdown` too. Pass
  `runtimeMetrics: false` to avoid it.

## Options

Each option beats its `OTEL_*` variable, which beats the default.

An option that takes a closed set of values is checked when the telemetry
is built. `logLevel`, `console`, `piiMode` and `exemplarFilter` must be one
of the values the table names, and `strictIdentity`, `captureConsole`,
`logExport`, `runtimeMetrics`, `startupSummary` and `hermetic` must be
`true` or `false`. Anything else, such as `logLevel: "verbose"` or
`runtimeMetrics: "false"`, fails `setupWith` and `createTelemetryWith` with
`INVALID_OPTION`, and the message names the option, the value and the
allowed values. An option that is `undefined` or `null` is not given and
takes its default. The `OTEL_*` variables are not checked this way. Each
keeps its own rule.

| Option                                              | Effect                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`, `serviceVersion`, `serviceNamespace` | `service.name`, `service.version` and `service.namespace`                                                                        |
| `environment`, `environmentValues`                  | `deployment.environment.name`, and values accepted beyond production, staging, development and test                              |
| `strictIdentity`                                    | default `true`. With `false`, a missing or invalid identity is counted as a violation instead of thrown                          |
| `resourceAttributes`                                | extra resource attributes. They beat every other layer and are still classified                                                  |
| `registry`                                          | one or more application registries, raw or compiled. A raw registry is validated first                                           |
| `piiMode`, `piiHashKey`                             | `"drop"` (default), `"hash"` or `"allow"`. Hash mode needs `piiHashKey`, a `Uint8Array` of at least 32 bytes, never a string     |
| `logLevel`                                          | the lowest level logged: `"trace"`, `"debug"`, `"info"`, `"warn"`, `"error"` or `"fatal"`. Default `"info"`                      |
| `console`                                           | `"json"` (default), `"text"`, or `false` for no console sink                                                                     |
| `captureConsole`                                    | route `console.log`, `info`, `warn`, `error`, `debug` and `trace` into the logger. Default `false`                               |
| `attrReplacer`                                      | renames or drops log attributes before classification, on the console and OTLP legs                                              |
| `logExport`                                         | export logs over OTLP. Default `true`                                                                                            |
| `sampler`                                           | default `OTEL_TRACES_SAMPLER`, else `parentbased_always_on`                                                                      |
| `propagators`                                       | replaces the default W3C trace context and baggage, and beats `OTEL_PROPAGATORS`. The baggage egress filter still wraps it       |
| `views`, `histogramBuckets`                         | metric views, and explicit histogram boundaries by instrument name                                                               |
| `exemplarFilter`                                    | `"trace_based"`, `"always_on"` or `"always_off"`. Default `OTEL_METRICS_EXEMPLAR_FILTER`, else `"trace_based"`                   |
| `runtimeMetrics`                                    | runtime metrics where the platform has them. Default `true`                                                                      |
| `startupSummary`                                    | emit the startup canary in `setupWith`. Default `true`                                                                           |
| `hermetic`                                          | ignore every `OTEL_*` variable (Go `WithoutOTELEnv`). A signal with nothing injected is off                                      |
| `spanExporter`, `spanProcessor`                     | inject the trace pipeline. Exported spans are batched and redacted, and an injected processor's `onEnd` sees the redacted span   |
| `metricReader`                                      | inject a metric reader instead of the platform's                                                                                 |
| `logExporter`                                       | inject a log exporter. Records are batched and classified                                                                        |
| `logProcessor`                                      | a log record processor after the redacting processor, which sees each classified record synchronously (Go `WithExtraLogHandler`) |

`OTEL_PROPAGATORS` selects the propagators when the `propagators` option
is absent or empty. It is a comma-separated list. Each entry is trimmed,
an empty entry is dropped, and a name counts once, where it first appears.
Names are case-sensitive.

| Name           | Propagator                                                    |
| -------------- | ------------------------------------------------------------- |
| `tracecontext` | W3C trace context, the `traceparent` and `tracestate` headers |
| `baggage`      | W3C baggage, the `baggage` header                             |
| `none`         | nothing is injected or extracted                              |

The propagators apply in the order given. A list that names `none` carries
nothing, whatever else it names. An unset or empty variable leaves the
default, `tracecontext` then `baggage`. Any other name, such as `b3`,
`b3multi`, `jaeger`, `xray` or `ottrace`, fails `setupWith` and
`createTelemetryWith` with `UNSUPPORTED_PROPAGATOR`, even next to a
supported name. Go resolves those names. These packages ship no propagator
for them, so pass one through the `propagators` option. `hermetic` ignores
the variable. `effectiveConfig()` and the canary report the header fields
in the configured order, or `none`.

## Identity

| Attribute                     | Set with                                                                            | Error when missing or invalid                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `service.name`                | `serviceName`, `OTEL_SERVICE_NAME`, or `service.name` in `OTEL_RESOURCE_ATTRIBUTES` | `NO_SERVICE_NAME`                                                              |
| `deployment.environment.name` | `environment`, or `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES`       | `NO_ENVIRONMENT`, or `INVALID_ENVIRONMENT` for a value outside the allowed set |
| `service.version`             | `serviceVersion`, or the environment                                                | none. It falls back to `0.0.0-unknown`, and the canary reports the fallback    |

`service.instance.id` is a UUIDv5 of the Kubernetes pod UID, else of
`<namespace>/<pod name>`, else a random UUIDv4. Every libo11y
implementation derives the same ID from the same pod identity. The resource
carries one schema URL, `SCHEMA_URL` from `@libo11y/spec`.

## The telemetry handle

| Member                                              | What it is                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `logger`                                            | the libo11y logger                                                                          |
| `tracerProvider`, `meterProvider`, `loggerProvider` | the providers. The meter provider classifies every measurement and samples it for exemplars |
| `propagator`                                        | the configured propagator, wrapped by the baggage egress filter                             |
| `resource`                                          | the composed, classified resource                                                           |
| `effectiveConfig()`                                 | the resolved configuration on one line, as the canary reports it                            |
| `event(name, attrs?, ctx?)`                         | emits a named event at info under a forced context                                          |
| `forceFlush(opts?)`                                 | exports everything buffered, signal by signal                                               |
| `shutdown(opts?)`                                   | stops every signal. Every call returns the first call's promise                             |

`shutdown` stops logs, metrics and traces concurrently under one deadline,
5000 ms unless `timeoutMillis` says otherwise. Both `shutdown` and
`forceFlush` resolve with a `SignalReport` that holds one error per failed
signal, and they never reject.

`timeoutMillis` is a number of milliseconds. A negative value is 0, and
`Infinity` or anything above 2147483647 is 2147483647. A string that reads
as a finite number is taken as that number. `NaN` and any other value that
is not a number are the default.

A signal has failed when its provider rejects, when the deadline passes,
or when an export fails while the flush or the shutdown runs: an error
status from the collector, a refused connection, a timeout. Upstream's
batch log processor and periodic metric reader report a failed export to
the error handler only, so core watches each exporter itself. `shutdown`
also writes one `o11y.telemetry.dropped` event to the console for each
signal in the report, or to the diagnostic stream when the console sink is
off. Those events are never rate limited.

An export that fails outside any `forceFlush` or `shutdown`, such as one
the batch timer or the periodic reader started, is not in any report. Core
says it with the same `o11y.telemetry.dropped` event, naming the signal
and the class of the error, under `setup` and `createTelemetry` alike. The
event goes to the console sink. When the console sink is off, it goes to
the diagnostic stream instead. While a collector stays down every export
interval fails again, so each signal says so 5 times, then once every 30
seconds. A diagnostic line says how many were held back. The event is
never exported over OTLP. A later flush or shutdown does not report that
failure again.

Core watches the exporter of every signal it builds a processor for: the
platform's exporters, and an injected `spanExporter` or `logExporter`. An
injected `metricReader`, `spanProcessor` or `logProcessor` owns its
exporter, so core reports only what its `shutdown` or `forceFlush` rejects
with.

`forceFlush` flushes logs, then metrics, then traces. For each signal it
exports what is buffered and also waits for the exports that were already
in flight when that signal's turn came, such as a batch the timer had just
sent. It does not wait for an export that starts later, so flushes that
overlap do not hold each other back. An export that fails at any point
while the flush runs is in its report, whichever signal was flushing then.

A `forceFlush` that overlaps another still resolves only when what its
caller emitted before the call has been exported. Upstream's batch log
processor returns at once from a flush that overlaps another, so callers
that arrive while a flush of logs runs share one follow-up flush, which
starts when the running one ends. A caller waits for the rest of one flush
and one more, never longer. That makes `forceFlush` safe to call at the
end of every request in a function that is frozen afterwards.

`shutdown` waits, inside its deadline, until every watched exporter has
nothing in flight. Upstream's span processor sends its batches together
and gives up at the first that fails, and the other batches still get the
rest of the deadline to arrive. Then core fails every export still in
flight and calls `shutdown()` on its exporter. That clears the export
timers of upstream's batch processors and periodic reader, which would
otherwise keep the process alive until the export timeout, and it lets the
exporter release what it holds. An injected `spanExporter` or
`logExporter` is stopped the same way, so its `shutdown()` can be called
at the deadline while one of its exports is still in flight. The exporters
of `@libo11y/server` end their requests in flight there, so a process
exits when `shutdown` resolves. One case remains under Node, which the
server README describes: a name lookup that never answers cannot be
cancelled, and the process stays alive until the resolver gives up.

## The logger

The logger has six levels, `trace` to `fatal`, and `child(attrs)` for
bound attributes. `error` and `fatal` take an `Error` in place of the
attributes and expand it to `exception.type`, `exception.message` and
`exception.stacktrace`. `fatal` logs and returns. It never exits.

No logger method throws, and neither does `event`. The attributes are
read once, before anything classifies or writes them, and an array or a
plain object inside an array is copied as it is read. What goes wrong is
reported on the diagnostic stream, and the logger fails closed:

- An attribute that cannot be read or classified is dropped, and the rest
  of the record is emitted. A getter that throws and a revoked `Proxy` are
  two such attributes.
- An `attrReplacer` that throws drops the whole record: its message, its
  level and every attribute. Nothing leaves unredacted, and the record is
  absent from the console and from OTLP. The report on the diagnostic
  stream is the only trace of it, and it names the level and the key the
  replacer failed on.
- A sink that throws loses its copy of the record. The other sink still
  gets it.

A report is one `o11y: telemetry error` line. It names the step that
failed, the class of the error and the attribute key, for example
`o11y: log attribute "user" cannot be read and is dropped: TypeError`. It
never repeats the error's message, because a message can quote the value
that made the hook fail, as `new URL(value)` and `JSON.parse(value)` do.

The reports are rate limited to a burst of five, refilled one every 30 s.
The logger has that limit to itself. Exporter errors, which `setupWith`
routes through the global error handler, have another, and instrumentation
built on core, such as `instrumentServe`, has a third. A getter that fails
on every request therefore cannot silence an exporter failure.

The startup canary is the exception. A replacer or a sink that fails on it
fails `setupWith` with `CANARY_REJECTED`.

Each record goes to the console sink and to the OTLP leg, classified per
sink. Inside a valid span context, the console line carries `trace_id` and
`span_id`, and the OTLP record carries the span context.

## Sensitivity

The policy classifies by key, from the spec tables first and then from the
application registries.

| Surface                                           | Secret  | PII under `"drop"` | PII under `"hash"` | PII under `"allow"` |
| ------------------------------------------------- | ------- | ------------------ | ------------------ | ------------------- |
| logger console and OTLP legs                      | dropped | dropped            | HMAC token         | kept                |
| records from other bridges on the logger provider | dropped | dropped            | HMAC token         | kept                |
| span, span event and span link attributes         | dropped | dropped            | HMAC token         | kept                |
| resource                                          | dropped | dropped            | HMAC token         | kept                |
| metric attributes                                 | dropped | dropped            | dropped            | kept                |

Metric attributes are never tokenized, because a token per value would
multiply the series. Violations on logs, spans and the resource are counted
on `o11y.schema.violations`.

The policy classifies attribute values by key and nothing else. It does not
cover:

- a value under a key that neither the spec nor a loaded application
  registry classifies;
- log record bodies, which include the arguments of a captured `console`
  call, and the other free text: span names, span status descriptions and
  span event names;
- instrumentation scope attributes;
- metrics from a metric producer on an injected `metricReader`, which
  reach the reader without passing through the meter provider;
- the members of a map-valued span or metric attribute, which is judged on
  its own key only;
- the attributes an injected `spanProcessor` reads in `onStart` and
  `onEnding`, where it sees the live span. It gets the redacted span in
  `onEnd`;
- baggage, which crosses process boundaries unclassified.

A token is `hmac-sha256:` and 32 hex digits, computed over one canonical
rendering of the value. Every surface in the table uses that same
rendering, so a value has the same token on a log record, a span, a span
event, a span link and the resource, and the tokens join across signals.
The rendering is bounded, as in Go: the value costs one node and each
array element or map member one more, and past depth 16, on a cycle, or
once 2048 nodes are spent, the rest renders as `truncated`. A top-level
array therefore keeps its first 2047 elements, and two arrays that differ
only after them share a token.

`piiHashKey` must be bytes: a `Uint8Array`, which a Node `Buffer` is, of
at least 32 bytes. Decode a secret from its text form first:

```ts
const piiHashKey = Buffer.from(process.env.PII_HASH_KEY ?? "", "base64");
```

A key that is not a `Uint8Array` fails `setupWith` and
`createTelemetryWith` with `PII_HASH_KEY`, in every `piiMode`, and the
message never contains the key. Versions up to 0.2.0 accepted a string and
then hashed under an empty key, so treat tokens that were made with a
string key as unprotected.

## What can still throw

The logger, `Telemetry.event`, wide records (`set`, `add`, `max` and
`emitEvent`) and the instruments of the handle's meter provider (`add`,
`record` and an observable callback's `observe`) never throw into the
application. Each reads the attributes it is given once, drops what it
cannot read and keeps the rest, and reports the failure as the logger
does, without the message of what was thrown. An instrument and
`emitEvent` report through the telemetry's own handler. A wide record's
`set`, `add` and `max` have no telemetry, so they report to the
OpenTelemetry global error handler, which `setupWith` makes libo11y's.

An instrument copies the attributes it keeps into an object of its own,
so a change the caller makes afterwards does not reach the data point.
That costs one small object and one property write per attribute on each
measurement. The keys are listed once and each value is read once.

Three things are outside the guarantee:

- **Span attributes.** A span comes from upstream's tracer, and
  `startSpan`, `setAttribute`, `setAttributes` and `addEvent` read their
  attributes in upstream's code. An attributes object that cannot be read,
  such as a revoked `Proxy`, throws there.
- **Setup.** `setupWith` and `createTelemetryWith` reject on a
  configuration error, by design.
- **The application's own callbacks.** An observable callback that throws
  is the SDK's to handle, and a request handler's error still reaches the
  caller.

## Errors

Setup and configuration failures throw `O11yError`, whose `code` is one of
the following. The messages match Go's where Go has the same error.
`UNSUPPORTED_PROTOCOL`, `UNSUPPORTED_PROPAGATOR` and `INVALID_OPTION` are
this implementation's own.

| Code                                                       | Cause                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ALREADY_SETUP`                                            | `setupWith` ran again before the first telemetry shut down                    |
| `NO_SERVICE_NAME`, `NO_ENVIRONMENT`, `INVALID_ENVIRONMENT` | the identity contract failed under `strictIdentity`                           |
| `PII_HASH_KEY`                                             | a `piiHashKey` that is not a `Uint8Array`, or hash mode without 32 bytes      |
| `INVALID_APP_REGISTRY`                                     | an application registry broke a rule, or two registries declare one namespace |
| `CANARY_REJECTED`                                          | a sink rejected the startup canary synchronously                              |
| `UNSUPPORTED_PROTOCOL`                                     | an OTLP protocol other than `http/protobuf` or `http/json`                    |
| `UNSUPPORTED_PROPAGATOR`                                   | a name in `OTEL_PROPAGATORS` other than `tracecontext`, `baggage` or `none`   |
| `INVALID_OPTION`                                           | an option outside the closed set of values it takes, such as `logLevel`       |
| `EXPORTER`                                                 | an unknown `OTEL_*_EXPORTER` value, or an exporter that could not be built    |

## Exemplars

Upstream sdk-metrics 3.1.1 records no exemplars, so the core samples them
itself. The meter provider offers each synchronous measurement to an
`ExemplarStore`, and `exemplarMetricExporter` attaches the samples to the
data points of each collection. `OtlpJsonMetricsSerializer` here and
`OtlpProtobufMetricsSerializer` in `@libo11y/server` write them to OTLP.
With several metric readers, the first reader to collect gets each sample.

## Writing a platform

A `Platform` supplies the environment, resource detection, a context
manager, exporters, console and diagnostic output, hashing and UUIDs, and
optionally runtime metrics. `@libo11y/core/testing` exports
`createTestPlatform`, which takes a context manager factory and any members
a test overrides. It fills in the rest hermetically and records the console
and diagnostic lines in arrays. `exemplarStoreOf(telemetry)` returns a
telemetry's exemplar store, for a platform's own metric exporter tests.

Core watches every exporter a platform builds, to report a failed export
and to stop the exporter at shutdown. Two things follow for a platform:

- Wrap the metric reader's exporter with
  `exemplarMetricExporter(exporter, req.exemplars)`. It attaches the
  exemplars, and it is also where core sees the reader's exports. A reader
  built without it reports only what its own `shutdown` rejects with.
- An exporter's `shutdown()` stops it. It should end what is still in
  flight and release what the exporter holds, such as sockets and timers,
  without waiting for the collector. Core calls it once every export has
  reported its result, or when the shutdown deadline has passed.

A telemetry handle carries a function under
`Symbol.for("libo11y.report")`. It takes one `Error` and writes it through
the handle's own rate-limited handler. Instrumentation built on core
reports its own failures through it, so they are written for a
`createTelemetryWith` handle too, which installs no global error handler.

## Parity

[docs/PARITY.md](https://github.com/jamesainslie/libo11y/blob/main/docs/PARITY.md)
lists where the TypeScript packages match Go and where they differ, with
the reasons.
