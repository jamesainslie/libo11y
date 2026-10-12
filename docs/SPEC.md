# The libo11y telemetry specification

Version 1.0.0. Normative keywords (MUST, SHOULD, MAY) follow RFC 2119.

This document is the human-readable form of the machine registry under
[`spec/registry`](../spec/registry). The registry is the source of truth;
the generated attribute tables in `docs/taxonomy/` and the Go `spec` package
are produced from it. Where this prose and the registry disagree, the
registry wins.

Where the Go implementation does not yet enforce a requirement, this
document says so next to the requirement. Section 8 lists the enforcement
that exists today.

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
disabled for migration. With strict identity disabled, each unmet
requirement is counted on `o11y.schema.violations` (signal `resource`,
rules `identity_service_name`, `identity_environment`,
`identity_environment_invalid`).

| Attribute | Source | Notes |
|---|---|---|
| `service.name` | option or environment | never blank, never `unknown_service` |
| `service.version` | option, env, or build info | falls back to `0.0.0-unknown` with a flag, never an error |
| `deployment.environment.name` | option or environment | validated against `production`, `staging`, `development`, `test`, plus values the application adds in code (Go: `WithEnvironmentValues`) |
| `telemetry.sdk.*` | SDK | set automatically |
| `telemetry.distro.*` | SDK | recommended; the Go implementation does not set it yet |

### Tier 1: required by environment

Auto-derived; a missing tier-1 attribute the environment implies is a
specification violation, not an init error. The Go implementation does not
yet detect these violations (that belongs to the planned validating
processor, section 8).

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

### Forbidden keys

Keys that carry personal data or credentials are documented in a separate
forbidden group, classified so the sensitivity layer handles them wherever
they appear (section 5), and have no generated key constants: `host.ip`,
`host.mac`, `process.command_line`, `process.command_args`, and `device.id`
(PII), and `http.request.header.authorization`,
`http.request.header.proxy-authorization`, `http.request.header.cookie`,
and `http.response.header.set-cookie` (secret).

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
  attribute rides `target_info` or is shaped by the collector. This is a
  requirement on the metric pipeline that the Go implementation does not
  enforce (the metric-label allowlist is planned). Exemplars MUST be
  emitted (trace-based by default), each retaining trace ID, span ID,
  timestamp, value, and its filtered attributes minus any the sensitivity
  layer removes.
- **Log**: required record fields (below); resource tier 0 plus applicable
  tier 1; trace correlation whenever a span is active; `error.type` on
  ERROR and above; `event.name` on any registered event. The Go
  implementation enforces the record fields and correlation; `error.type`
  and the event-name rule are requirements on the caller that no runtime
  check verifies yet.

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
attribute. Bodies are not classified by the sensitivity layer (section 5),
so a value interpolated into a message escapes it.

### Naming and namespaces

Attribute names are lowercase, dot-delimited between namespaces, snake_case
within a segment, singular unless the value is an array, with no units in
the name. Applications MUST namespace their own attributes and MUST NOT mint
names inside `otel.*`, `o11y.*`, or any semconv-owned namespace.

### Events

An Event is a record emitted through the event API (`SDK.Event` in Go, and
`Record.EmitEvent`, which calls it): it carries the given name as
`event.name` and is force-emitted, so it is exempt from level gating. The
API accepts any name; the registered names below are contract-bearing (their
required attributes are checked by the conformance harness). The exemption
is structural. A record that merely carries an `event.name` attribute,
emitted through the ordinary logger without force-emit, is subject to the
level gate like any other record. No log sampler exists yet, so no record
is sampled. libo11y v1 registers:

| Event | Purpose |
|---|---|
| `o11y.telemetry.configured` | startup summary and initialization canary (emitted by `Setup` only); carries the resolved configuration as `o11y.config.<key>` attributes |
| `o11y.request.summary` | the per-request wide event (canonical log line) |
| `o11y.telemetry.dropped` | buffered telemetry that failed to flush at shutdown, emitted best effort to the sinks still running |

Exceptions are not a registered event. The semconv exception attributes
(`exception.type`, `exception.message`, `exception.stacktrace`) are
registered as record attributes required on exception records.

### Audit class

Records marked `o11y.record.class = audit` and emitted with force-emit are
exempt from sampling, level gates, and trace-based dropping, and SHOULD be
routed to a dedicated exporter. Marking is structural, never string
matching: in Go the exemption comes from `o11y.ForceEmit`, not from the
attribute, and dedicated audit routing is not implemented yet.

## 5. Sensitivity classification

Every attribute the specification defines carries a sensitivity class:
`public`, `internal`, `pii`, or `secret`. This is the machine-readable
annotation OpenTelemetry itself lacks. No signal group may reference a
secret-classified attribute (`libo11y_secret_referenced`). At runtime the
classification is applied by attribute key, by one policy per SDK, with
three PII modes: `drop` (the default), `hash`, and `allow`. `hash` replaces
the value with a keyed HMAC-SHA256 token, truncated to 128 bits, over one
canonical rendering of the value shared by every signal; it requires a key
of at least 32 bytes and refuses to start without one. `allow` emits PII in
the clear and requires an explicit opt-in with a data-handling
justification.

| Surface | Secret | PII, drop (default) | PII, hash | PII, allow |
|---|---|---|---|---|
| logs on every sink (console, extra sinks, OTLP), and records from any log bridge on the SDK's logger provider | dropped | dropped | HMAC token | kept |
| span attributes, span event attributes, span link attributes, as exported and as delivered to injected span processors at end | dropped | dropped | HMAC token | kept |
| resource (every signal) | dropped | dropped | HMAC token | kept |
| metric data point attributes and exemplar filtered attributes, on streams from the SDK's own instruments | dropped | dropped | dropped (a token per value would multiply series cardinality) | kept |
| metrics from metric producers (bridges that feed a reader directly) | not classified | not classified | not classified | not classified |
| baggage | not classified | not classified | not classified | not classified |

On logs, a grouped attribute is judged on its dotted effective key, and
composite values (maps, slices of maps, pointers) are walked so their
members are judged the same way; the walk fails closed at cycles, at a
depth bound, and at a node budget, dropping what it did not examine.

The sensitivity layer runs after any user attribute replacer (in Go, the
replacer runs on the slog sinks only), so renaming a key to a classified
name cannot bypass it. Each drop or rewrite on logs,
spans, and the resource is counted in the `o11y.schema.violations` metric
(rules `secret_attribute` and `pii_attribute`); metric-side drops are not
counted, because the filter runs on the measurement hot path.

The classification does not cover, and implementations MUST document that
it does not cover:

- values under keys the specification does not classify (capture-time
  redaction, the `redact` package in Go, protects those);
- log record bodies and other free text: span names, span status
  descriptions, and span event names;
- instrumentation scope attributes;
- metrics from metric producers (in Go, `OTEL_METRICS_PRODUCERS` through
  autoexport, or a reader built with `sdkmetric.WithProducer`, such as the
  Prometheus bridge), which bypass the SDK's views;
- members of map-valued span and metric attributes, which are judged on
  their own key only;
- attributes a span processor reads when a span starts, before redaction;
- baggage, which crosses process boundaries unclassified. The Go egress
  filter wraps every propagator but its default predicate allows every key;
- an environment-provided resource key that is dropped (or, in Go's
  hermetic mode, any environment key the library resource does not
  define): OpenTelemetry Go
  providers always merge the environment resource underneath the one they
  are given, so the key is exported with an empty value instead of being
  omitted, and collector processors that insert only absent keys treat it
  as present.

## 6. Metrics and spans

Metric names are lowercase and dot-namespaced, carry UCUM units in the unit
field only, never use `_total` or `.count` suffixes, and disambiguate sides
as `{area}.{client|server}.{name}` (for example
`http.server.request.duration`, a seconds histogram). Every metric
attribute carries a cardinality budget (`enum`, `bounded`, or `unbounded`);
an `unbounded` attribute MUST NOT be a metric label. The registry checks
enforce these rules for metrics the registry defines; they are not checked
on application instruments at runtime. HTTP span and metric conventions are
imported verbatim from stable semconv.

## 7. Versioning

The specification is versioned independently of the language modules. Each
release stamps one schema URL and pins one semconv version. A stable spec
item is never renamed or removed without a major version bump.

- **Schema URL.** The URL ends in the bare spec version:
  `https://jamesainslie.dev/schemas/libo11y/1.0.0` (`spec.SchemaURL` in
  Go), stamped on every resource.
- **Schema file.** The generator writes the matching OpenTelemetry schema
  file (file format 1.1.0) to `spec/schemas/<version>`, so 1.0.0 is
  `spec/schemas/1.0.0`. 1.0.0 is the first versioned release and declares
  no transformations.
- **Immutability.** A released schema file is immutable: a spec change
  bumps the version and adds a new file. From the next version on, renames
  MUST be recorded both as a registry tombstone and as a schema-file
  transform; until the registry can carry that version history, the
  generator refuses to render any version after 1.0.0. Renames made before
  1.0.0 are recorded only as registry tombstones (the
  pre-spec `vcs.revision`, `vcs.time`, and `vcs.modified` build-info keys).
- **Release steps.** Publishing a spec version means tagging the commit
  `spec/vX.Y.Z` and serving the schema file at its schema URL.

Status: neither step has been taken for 1.0.0. No `spec/v*` tag exists and
the schema URL is not yet served; the artifact exists only in this
repository.

## 8. Enforcement layers

1. **Generated typed API** (`go/spec`): typed keys and closed enums make
   many invalid states unrepresentable at compile time. Forbidden keys get
   no constants.
2. **Registry policy checks** (`make spec-check`, also run before every
   `make spec-generate`): strict decoding of every registry file (unknown
   fields fail with `libo11y_registry_unknown_field`, and the manifest's
   `schema_url` must be an absolute http(s) URL ending in a bare semantic
   version), followed by the rules below. Rule IDs are stable.
3. **Init-time** (`Setup`/`New`): tier-0 identity is validated and
   required; `hash` mode without a key fails.
4. **Emit-time** (always on): the sensitivity policy of section 5, applied
   at these points in Go:
   - the classifying wrapper on each slog sink (console, extra sinks, and
     the OTLP slog leg);
   - a processor on the SDK's OTLP logger provider, which classifies
     records from every other log bridge, including bridges on the global
     provider after `Setup`;
   - a wrapper around the span exporter and around each injected span
     processor's end-of-span callback (span, event, and link attributes);
   - resource classification at construction, with environment-provided
     keys the policy drops shadowed by empty values;
   - metric views (data point attributes) and exemplar reservoirs (filtered
     attributes) on every stream of the SDK's own instruments (metric
     producers bypass views and are not covered);
   - the baggage egress filter, a seam on every propagator's inject path
     whose default predicate allows every key.
5. **CI conformance** (`make spec-check` policy validation, the
   `make spec-drift` generation gate, and the language test harnesses,
   including `o11ytest.AssertConforms` in a consumer's own suite): the only
   layer that catches a developer bypassing the generated constants.

Planned, not implemented: a validating span and log processor (dev-on,
prod-observe) that checks per-signal minimums such as tier-1 attributes,
`error.type`, and event-name discipline at runtime, and a metric-label
allowlist enforcing the identity quintet.

### Spec-check rule IDs

| Area | Rule IDs |
|---|---|
| naming | `libo11y_attr_naming`, `libo11y_event_naming`, `libo11y_metric_naming`, `libo11y_go_name_collision` |
| ownership | `libo11y_namespace_ownership` |
| sensitivity | `libo11y_sensitivity_missing`, `libo11y_sensitivity_unknown`, `libo11y_secret_referenced`, `libo11y_classification_conflict` |
| cardinality | `libo11y_cardinality_missing`, `libo11y_cardinality_unknown`, `libo11y_cardinality_conflict`, `libo11y_unbounded_metric_label`, `libo11y_metric_label_unclassified` |
| references | `libo11y_ref_undefined`, `libo11y_attr_duplicate`, `libo11y_deprecated_target_undefined`, `libo11y_legacy_key_unrenamed`, `libo11y_legacy_key_invalid`, `libo11y_legacy_key_duplicate` |
| enums | `libo11y_enum_member_empty`, `libo11y_enum_value_whitespace`, `libo11y_enum_duplicate_value` |
| events | `libo11y_event_namespace`, `libo11y_event_stability` |
| metrics and units | `libo11y_instrument_unknown`, `libo11y_metric_total_suffix`, `libo11y_metric_count_suffix`, `libo11y_metric_unit_in_name`, `libo11y_metric_unit_missing`, `libo11y_metric_unit_invalid`, `libo11y_metric_namespace` |
| schema hygiene | `libo11y_stability_unknown`, `libo11y_requirement_unknown`, `libo11y_annotation_unknown` |
