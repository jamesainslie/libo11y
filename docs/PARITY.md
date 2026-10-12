# Cross-language feature parity

This matrix tracks feature parity between libo11y implementations against
the project's reference capability set: the design distilled in
[DESIGN.md](DESIGN.md), which every language must satisfy in its native
idiom. Parity means the capability exists idiomatically, not that APIs are
identical. Capabilities that belong to application or organizational policy
rather than to a general-purpose library are listed at the bottom with the
generic mechanism libo11y provides instead.

Legend: full = implemented, idiom = implemented in a deliberately different,
language-native form, planned = not yet started, excluded = will not be
implemented (rationale given).

## Go module status

| Capability | Go status | Go form |
|---|---|---|
| Three OTLP signals (traces, metrics, logs) | full | all three on by default |
| Explicit init returning an owned handle, typed init errors | full | `Setup`/`New` -> `SDK`; `ErrAlreadySetup`, `ErrNoServiceName`, `ErrNoEnvironment`, `ErrInvalidEnvironment`, `ErrPIIHashKey`, wrapped exporter errors |
| Idempotent bounded shutdown, per-signal errors | full | `Shutdown` runs once (atomic election), flushes all signals concurrently under one deadline (5s default), aggregates with `errors.Join`; later and concurrent callers get the same result or their own context error |
| One trace identity across logs/spans/wire | full | active span context read at emission, W3C on egress, adoption on ingress |
| Propagation independent of process globals | full | `New`-built SDKs propagate identically; middleware takes `WithSDK` |
| W3C TraceContext + Baggage default propagator | full | composite, replaceable via variadic `WithPropagators`; the baggage egress filter still wraps a replacement |
| Baggage egress filter | full | inject-only filter seam around every configured propagator, including one from `WithPropagators`; default predicate allows every key; extraction is never altered |
| Standard env interop (OTEL_*) | full | delegated to autoexport and resource detection; no proprietary env vars |
| Hermetic mode independent of OTEL_* | full | `WithoutOTELEnv`: options and library defaults only, un-injected signals disabled, environment resource keys shadowed with empty values; the experimental `OTEL_GO_X_PER_SERIES_START_TIMESTAMPS` and `OTEL_GO_X_DEPRECATED_RUNTIME_METRICS` switches have no overriding option and still apply |
| Init canary (sink-verified startup) | full | `o11y.telemetry.configured` event forced through the pipeline in `Setup`; a synchronously-rejecting sink fails Setup |
| Effective-config line | full | startup event with `o11y.config.*` attributes (endpoints without userinfo, query, or fragment) + `SDK.EffectiveConfig()` |
| Always-emit mechanism for audit records | full | `o11y.ForceEmit(ctx)` context marker bypassing level gates |
| Attribute replacer across all sinks | full | `WithAttrReplacer`, uniform on console/OTLP/extra sinks |
| Capture-time redaction | full | `slog.LogValuer` + `o11y` struct tags (`mask`, `redact`, `omit`, and the spec vocabulary `confidential` and `secret`) via `redact.Secret`, `redact.Masked`, `redact.Struct`; guards slog, fmt, and JSON surfaces; cycles and depth fail closed |
| Middleware: HTTP server | full | `o11yhttp` over otelhttp, route-aware names, stable HTTP semconv, `WithPublicEndpoint` |
| Middleware: HTTP client | full | `o11yhttp.NewTransport` |
| Middleware: gRPC | full | `o11ygrpc` stats handlers (server + client), `WithPublicEndpoint`, `WithIgnoreHealthChecks` |
| Middleware: alternative web framework | full | `o11ygin` (nested module, Gin): `WithFilter`, `WithIgnorePaths`, `WithSpanNameFormatter`; no public-endpoint or canonical-line counterpart (otelgin has no mechanism for either) |
| Ignore lists for noise endpoints | full | `WithIgnorePaths` globs (HTTP, Gin); `WithIgnoreHealthChecks` (gRPC) |
| Resource: host/process detectors | full | host, process runtime, telemetry SDK |
| Resource: container detector | full | `resource.WithContainer` (container.id) |
| Resource: Kubernetes identity | idiom | via Downward API + OTEL_RESOURCE_ATTRIBUTES; no in-process detector exists in otel-go |
| Resource: build info | full | `debug.ReadBuildInfo` detector: service.version (when real), `vcs.ref.head.revision`, `o11y.build.time`, `o11y.build.modified`; `WithoutBuildInfo` opt-out |
| Runtime metrics | full | contrib runtime, on by default |
| Histogram bucket control | full | `WithHistogramBuckets`, `WithViews` |
| Exemplars (metric-to-trace reconciliation) | full | on by default (trace-based); `WithExemplarFilter` + OTEL_METRICS_EXEMPLAR_FILTER; verified through otelhttp instruments; `o11ytest.Recorder.Exemplars` for consumer assertions |
| Sampler configuration | full | OTEL_TRACES_SAMPLER + `WithTraceSampler` |
| TLS for exporters | full | standard OTEL_EXPORTER_OTLP_CERTIFICATE et al. (env-driven, exporter-owned) |
| Signal-driven shutdown helper | full | `SDK.ShutdownOnSignals` (blocks, restores handling on first signal, bounded flush) |
| Hermetic test harness | full | `o11ytest` (built with `WithoutOTELEnv`) with span/metric/log recorders, correlation and conformance assertions (`AssertConforms`, `AssertCorrelated`) |
| OTLP wire-level verification | full | in-process OTLP gRPC and HTTP receivers assert exported payloads, sensitivity, and correlation, through injected exporters and through environment configuration |
| Centralized telemetry specification | full | semconv-format registry under `spec/`, Go policy checks (`make spec-check`), code generation to `go/spec` + `go/internal/spectables`, `docs/taxonomy` |
| Tiered resource identity enforced at init | full | tier-0 required (`service.name`, `deployment.environment.name` enum-validated, `service.version` fallback); `WithEnvironment`, `WithServiceNamespace`, `WithoutStrictIdentity` |
| service.instance.id derivation | full | UUIDv5 from k8s pod identity (Downward API), else UUIDv4 |
| Single schema URL per resource | full | `spec.SchemaURL` (`https://jamesainslie.dev/schemas/libo11y/1.0.0`) restamped on the composed resource; schema file generated to `spec/schemas/1.0.0`, not yet served |
| Sensitivity classification: one policy | full | one key-based policy per SDK, generated table; secrets dropped; PII dropped by default (`WithPIIMode`), keyed HMAC tokens under `PIIHash` (`WithPIIHashKey`); `o11y.schema.violations` self-metric. Not fail-closed for values under unclassified keys (use `redact`) |
| Sensitivity: slog sinks | full | classifying wrapper on the console, extra, and OTLP slog legs; grouped keys and Go maps, slices, and pointers walked with cycle detection and a 2048-node budget, failing closed |
| Sensitivity: OTLP log processor | full | redacting processor on the SDK's LoggerProvider classifies every record from other bridges, including through the global provider after `Setup`; record bodies not classified |
| Sensitivity: span redaction | full | exporter wrapper redacts span, event, and link attributes; each violation counted once |
| Sensitivity: span processor wrapping | full | injected processors receive redacted spans in `OnEnd`; `OnStart` sees the live span |
| Sensitivity: resource classification | full | resource classified at construction; dropped environment keys shadowed with empty values |
| Sensitivity: metric classification | full | wrapped views and exemplar reservoirs on every stream; PII dropped even under `PIIHash`; instrument advisory attribute keys no longer honored |
| Event API and wide events | full | `SDK.Event`, `Record` accumulator, `o11yhttp.WithCanonicalLine` |
| Emit-time span validator | planned | dev-on/prod-observe validating span processor and metric-label allowlist |
| Cross-language OTLP conformance (golden corpus) | planned | harness is language-agnostic; wired when a second language starts |
| Log/span event deduplication | excluded | a Rust-ecosystem bridge concern (dual emission through the tracing/OTEL layers); the problem does not exist in Go's slog architecture |
| Config file layering (YAML/TOML) | excluded | superseded by OTEL declarative config; adopt contrib otelconf (OTEL_CONFIG_FILE) once its Go implementation stabilizes |
| Metrics cardinality cap + gauge | planned | otel-go v1.47.0 now has `sdkmetric.WithCardinalityLimit` (default 2000, which `WithoutOTELEnv` pins; otherwise `OTEL_GO_X_CARDINALITY_LIMIT` applies); libo11y exposes no option for it yet |

## Policy-layer capabilities (out of scope for a generic library)

| Policy capability | Generic mechanism in libo11y |
|---|---|
| Fixed catalogs of regulatory compliance events | `o11y.ForceEmit` gives applications the always-emit primitive; event catalogs are application policy |
| Proprietary environment-variable namespaces | standard OTEL_* only |
| Legacy trace-header interop | W3C only; additional propagators can be composed via `WithPropagators` (still wrapped by the baggage egress filter) |
| Vendor-prefixed metric naming schemes | OTEL stable semantic conventions |
| Organization-specific source-link rewriting | plain VCS attributes from build info |

## Rust / Java / Zig

Planned. Each implementation will be tracked here against the same baseline
when it starts, with its own idiom column (for example: Rust expresses
capture-time redaction as a derive macro with Display-only output; Java
expresses the harness over the OTEL Java testing SDK).
