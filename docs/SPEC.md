# The libo11y telemetry specification

Version 1.0.0. Normative keywords (MUST, SHOULD, MAY) follow RFC 2119.

This document is the human-readable form of the machine registry under
[`spec/registry`](../spec/registry). The registry is the source of truth;
the generated attribute tables in `docs/taxonomy/` and the Go `spec` package
are produced from it. Where this prose and the registry disagree, the
registry wins.

## 1. Purpose

A single, versioned specification that every libo11y implementation enforces
in native idiom: a resource-attribute taxonomy, per-signal minimum
attributes, structured-logging rules, and a sensitivity classification that
drives redaction. The specification extends OpenTelemetry semantic
conventions; it never redefines stable upstream attributes, and it pins one
semconv version per release (currently v1.41.0) and stamps exactly one
schema URL on every resource.

## 2. Resource taxonomy

Attributes are tiered by how strongly they are required. The full generated
tables (source, entity role, sensitivity, signals) are in
[`docs/taxonomy/resource.md`](taxonomy/resource.md).

### Tier 0: required at init

An implementation MUST refuse to start telemetry (typed error, never a
panic) when these are unresolvable, unless strict identity is explicitly
disabled for migration.

| Attribute | Source | Notes |
|---|---|---|
| `service.name` | option or environment | never blank, never `unknown_service` |
| `service.version` | option, env, or build info | falls back to `0.0.0-unknown` with a flag, never an error |
| `deployment.environment.name` | option or environment | validated against `production`, `staging`, `development`, `test`, plus registered extensions |
| `telemetry.sdk.*`, `telemetry.distro.*` | SDK | set automatically |

### Tier 1: required by environment

Auto-derived; a missing tier-1 attribute the environment implies is an
observed violation, not an init error.

- `service.instance.id`: derived when absent. In Kubernetes, a UUIDv5 over
  the pod identity (namespace UUID `4d63009a-8d0f-11ee-aad7-4c796ed8e320`)
  so it is stable across process restarts in the same pod; otherwise a
  random UUIDv4 per process.
- `service.namespace`: required when the organization runs multiple teams.
- Kubernetes (`k8s.namespace.name`, `k8s.pod.name`, `k8s.pod.uid`) MUST come
  from the Downward API environment; the SDK MUST NOT call the Kubernetes
  API. Cluster and workload names (`k8s.cluster.name`,
  `k8s.deployment.name`, ...) are the collector's responsibility.
- `container.id`, and per-environment `cloud.*`, `host.*`, `faas.*`.

### Tiers 2 and 3

Tier 2 (recommended): build provenance (`vcs.ref.head.revision`,
`o11y.build.time`, `o11y.build.modified`), ownership (`o11y.team.name`),
runtime facts. Tier 3 (opt-in): tenancy (`o11y.tenant.id`, resource form
only for single-tenant deployments), `o11y.cost_center`,
`o11y.data.classification`, and the `o11y.label.<key>` free-form map.

### SDK versus collector

The SDK owns `service.*`, environment, version, `telemetry.*`, and
Downward-API-sourced pod identity. The collector owns cluster and workload
metadata, cloud and host enrichment at the gateway, and ownership and cost
labels from pod labels. On conflict, SDK-set values win; collector
processors MUST be configured non-destructively.

## 3. Per-signal minimums

- **Trace**: resource tier 0 plus applicable tier 1; span name is
  `{method} {low-cardinality target}`, never a raw path; HTTP spans carry
  the stable semconv required set; status is ERROR only per semconv.
- **Metric**: only the identity quintet (`service.name`,
  `service.namespace`, `service.instance.id`, `deployment.environment.name`,
  `service.version`) may be effective labels; every other resource
  attribute rides `target_info` or is shaped by the collector. Exemplars
  MUST be emitted (trace-based by default), each retaining trace ID, span
  ID, timestamp, value, and any filtered attributes.
- **Log**: required record fields (below); resource tier 0 plus applicable
  tier 1; trace correlation whenever a span is active; `error.type` on
  ERROR and above; `event.name` on any registered event.

## 4. Structured logging

### Record fields

Every record MUST carry `Timestamp`, `ObservedTimestamp`, `SeverityNumber`
and `SeverityText`, `Body`, and the resource. `TraceId`/`SpanId` MUST be
injected from context when a span is active and MUST NOT be caller-settable;
`trace_id` and `span_id` are reserved top-level console keys.

### Severity

The slog-to-OTel mapping is normative: `SeverityNumber = slog.Level + 9`
(Debug=5, Info=9, Warn=13, Error=17).

| Level | Belongs here |
|---|---|
| DEBUG | developer diagnosis; never required to operate; sampleable |
| INFO | lifecycle facts, state changes, wide events |
| WARN | degraded but handled; must be eventually actionable; never sampled |
| ERROR | operation failed and was not recovered; logged once at the handling boundary; carries `error.type`; never sampled |

### Body discipline

A string `Body` MUST be a constant template; values belong in attributes. A
map `Body` is permitted only on records whose event name is registered with
a body schema. Any field used for filtering or grouping MUST be an
attribute.

### Naming and namespaces

Attribute names are lowercase, dot-delimited between namespaces, snake_case
within a segment, singular unless the value is an array, with no units in
the name. Applications MUST namespace their own attributes and MUST NOT mint
names inside `otel.*`, `o11y.*`, or any semconv-owned namespace.

### Events

A record with a registered event name is an Event: contract-bearing, never
sampled, never level-gated. libo11y v1 registers:

| Event | Purpose |
|---|---|
| `o11y.telemetry.configured` | startup summary and initialization canary |
| `o11y.request.summary` | the per-request wide event (canonical log line) |
| `o11y.telemetry.dropped` | buffered telemetry that failed to flush at shutdown |
| `exception` | the semconv exception convention |

### Audit class

Records marked `o11y.record.class = audit` and emitted with force-emit are
exempt from sampling, level gates, and trace-based dropping, and SHOULD be
routed to a dedicated exporter. Marking is structural, never string
matching.

## 5. Sensitivity classification

Every attribute the specification defines carries a sensitivity class:
`public`, `internal`, `pii`, or `secret`. This is the machine-readable
annotation OpenTelemetry itself lacks. Enforcement:

- `secret`: MUST NOT be emitted. No signal group may reference a
  secret-classified attribute; the emit-time layer drops any that appear.
- `pii`: dropped by default (or hashed, per configuration); emitted in the
  clear only by explicit opt-in with a data-handling justification.
- The sensitivity layer runs after any user attribute replacer, so renaming
  a key to a classified name cannot bypass it. Each action is counted in
  the `o11y.schema.violations` metric.

## 6. Metrics and spans

Metric names are lowercase and dot-namespaced, carry UCUM units in the unit
field only, never use `_total` or `.count` suffixes, and disambiguate sides
as `{area}.{client|server}.{name}` (for example
`http.server.request.duration`, a seconds histogram). Every metric
attribute carries a cardinality budget (`enum`, `bounded`, or `unbounded`);
an `unbounded` attribute MUST NOT be a metric label. HTTP span and metric
conventions are imported verbatim from stable semconv.

## 7. Versioning

The specification is versioned independently of the language modules
(`spec/vX.Y.Z`). Each release stamps one schema URL, pins one semconv
version, and records renames as both a registry tombstone and a schema
transform. A stable spec item is never renamed or removed without a major
version bump.

The schema URL ends in the bare spec version
(`https://jamesainslie.dev/schemas/libo11y/1.0.0`). The generator writes
the matching OpenTelemetry schema file to `spec/schemas/<version>`;
publishing that file at the schema URL is a release step. A released
schema file is immutable: a spec change bumps the version and adds a new
file. Renames made before 1.0.0, the first versioned release, are recorded
only as registry tombstones.

## 8. Enforcement layers

1. **Generated typed API** (`go/spec`): typed keys and closed enums make
   many invalid states unrepresentable at compile time.
2. **Init-time** (`Setup`/`New`): tier-0 identity is validated and required.
3. **Emit-time** (log pipeline): the sensitivity layer, always on; an
   optional validating processor and metric-label allowlist, dev-on and
   prod-observe.
4. **CI conformance** (`make spec-check` policy validation, the
   `make spec-drift` generation gate, and the language test harnesses):
   the only layer that catches a developer bypassing the generated
   constants.
