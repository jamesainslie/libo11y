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
| Explicit init returning an owned handle, typed init errors | full | `Setup`/`New` -> `SDK`; `ErrAlreadySetup`, `ErrNoServiceName`, wrapped exporter errors |
| Idempotent bounded shutdown, per-signal errors | full | `Shutdown` with `sync.Once`, `errors.Join`, 5s default deadline |
| One trace identity across logs/spans/wire | full | active span context read at emission, W3C on egress, adoption on ingress |
| Propagation independent of process globals | full | `New`-built SDKs propagate identically; middleware takes `WithSDK` |
| W3C TraceContext + Baggage default propagator | full | composite, replaceable via variadic `WithPropagators` |
| Standard env interop (OTEL_*) | full | delegated to autoexport and resource detection; no proprietary env vars |
| Init canary (sink-verified startup) | full | startup summary record forced through the pipeline in `Setup`; a synchronously-rejecting sink fails Setup |
| Effective-config line | full | summary record + `SDK.EffectiveConfig()` |
| Always-emit mechanism for audit records | full | `o11y.ForceEmit(ctx)` context marker bypassing level gates |
| Attribute replacer across all sinks | full | `WithAttrReplacer`, uniform on console/OTLP/extra sinks |
| Capture-time redaction | full | `slog.LogValuer` + `o11y` struct tags (`redact.Secret`, `redact.Masked`, `redact.Struct`); guards slog, fmt, and JSON surfaces |
| Middleware: HTTP server | full | `o11yhttp` over otelhttp, route-aware names, stable HTTP semconv |
| Middleware: HTTP client | full | `o11yhttp.NewTransport` |
| Middleware: gRPC | full | `o11ygrpc` stats handlers (server + client) |
| Middleware: alternative web framework | full | `o11ygin` (nested module, Gin) |
| Ignore lists for noise endpoints | full | `WithIgnorePaths` globs |
| Resource: host/process detectors | full | host, process runtime, telemetry SDK |
| Resource: container detector | full | `resource.WithContainer` (container.id) |
| Resource: Kubernetes identity | idiom | via Downward API + OTEL_RESOURCE_ATTRIBUTES; no in-process detector exists in otel-go |
| Resource: build info | full | `debug.ReadBuildInfo` detector: service.version (when real), vcs.revision/time/modified; `WithoutBuildInfo` opt-out |
| Runtime metrics | full | contrib runtime, on by default |
| Histogram bucket control | full | `WithHistogramBuckets`, `WithViews` |
| Exemplars (metric-to-trace reconciliation) | full | on by default (trace-based); `WithExemplarFilter` + OTEL_METRICS_EXEMPLAR_FILTER; verified through otelhttp instruments; `o11ytest.Recorder.Exemplars` for consumer assertions |
| Sampler configuration | full | OTEL_TRACES_SAMPLER + `WithTraceSampler` |
| TLS for exporters | full | standard OTEL_EXPORTER_OTLP_CERTIFICATE et al. (env-driven, exporter-owned) |
| Signal-driven shutdown helper | full | `SDK.ShutdownOnSignals` (blocks, restores handling on first signal, bounded flush) |
| Hermetic test harness | full | `o11ytest` with span/metric/log recorders, correlation and conformance assertions (`AssertConforms`, `AssertCorrelated`) |
| Centralized telemetry specification | full | semconv-format registry under `spec/`, Go policy checks (`make spec-check`), code generation to `go/spec` + `go/internal/spectables`, `docs/taxonomy` |
| Tiered resource identity enforced at init | full | tier-0 required (`service.name`, `deployment.environment.name` enum-validated, `service.version` fallback); `WithEnvironment`, `WithServiceNamespace`, `WithoutStrictIdentity` |
| service.instance.id derivation | full | UUIDv5 from k8s pod identity (Downward API), else UUIDv4 |
| Single schema URL per resource | full | `spec.SchemaURL` restamped on the composed resource |
| Sensitivity classification driving redaction | full | generated table drives an unbypassable emit-time replacer; `WithPIIMode`; `o11y.schema.violations` self-metric |
| Event API and wide events | full | `SDK.Event`, `Record` accumulator, `o11yhttp.WithCanonicalLine` |
| Emit-time span validator | planned | dev-on/prod-observe validating span processor and metric-label allowlist |
| Cross-language OTLP conformance (golden corpus) | planned | harness is language-agnostic; wired when a second language starts |
| Log/span event deduplication | excluded | a Rust-ecosystem bridge concern (dual emission through the tracing/OTEL layers); the problem does not exist in Go's slog architecture |
| Config file layering (YAML/TOML) | excluded | superseded by OTEL declarative config; adopt contrib otelconf (OTEL_CONFIG_FILE) once its Go implementation stabilizes |
| Metrics cardinality cap + gauge | planned | blocked on otel-go: the SDK's cardinality limit is still experimental (env-only); revisit when the API stabilizes |

## Policy-layer capabilities (out of scope for a generic library)

| Policy capability | Generic mechanism in libo11y |
|---|---|
| Fixed catalogs of regulatory compliance events | `o11y.ForceEmit` gives applications the always-emit primitive; event catalogs are application policy |
| Proprietary environment-variable namespaces | standard OTEL_* only |
| Legacy trace-header interop | W3C only; additional propagators can be composed via `WithPropagators` |
| Vendor-prefixed metric naming schemes | OTEL stable semantic conventions |
| Organization-specific source-link rewriting | plain VCS attributes from build info |

## Rust / Java / Zig

Planned. Each implementation will be tracked here against the same baseline
when it starts, with its own idiom column (for example: Rust expresses
capture-time redaction as a derive macro with Display-only output; Java
expresses the harness over the OTEL Java testing SDK).
