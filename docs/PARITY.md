# Cross-language feature parity

This matrix tracks feature parity between libo11y implementations, using the
GTS Rust client's capability set as the reference baseline. Parity means the
capability exists in each language's native idiom, not that APIs are
identical. Company-specific GTS capabilities are excluded by charter and
listed at the bottom with their generic replacements.

Legend: full = implemented, idiom = implemented in a deliberately different,
language-native form, planned = not yet started, excluded = will not be
implemented (rationale given).

## Go module status

| Capability (Rust reference) | Go status | Go form |
|---|---|---|
| Three OTLP signals (traces, metrics, logs) | full | all three on by default |
| Builder -> guard lifecycle, typed init errors | full | `Setup`/`New` -> `SDK`; `ErrAlreadySetup`, `ErrNoServiceName`, wrapped exporter errors |
| Idempotent bounded shutdown, per-pillar errors | full | `Shutdown` with `sync.Once`, `errors.Join`, 5s default deadline |
| One trace identity across logs/spans/wire | full | active span context read at emission, W3C on egress, adoption on ingress |
| Propagation independent of process globals | full | `New`-built SDKs propagate identically; middleware takes `WithSDK` |
| W3C TraceContext + Baggage default propagator | full | composite, replaceable via variadic `WithPropagators` |
| Standard env interop (OTEL_*) | full | delegated to autoexport and resource detection; no proprietary env vars |
| Init canary (sink-verified startup) | full | startup summary record forced through the pipeline in `Setup`; sink error fails Setup |
| Effective-config line | full | summary record + `SDK.EffectiveConfig()` |
| Force-emit guarantee | idiom | generic `o11y.ForceEmit(ctx)` context marker instead of a compliance event catalog |
| Attribute replacer across all sinks | full | `WithAttrReplacer`, uniform on console/OTLP/extra sinks |
| Capture-time redaction (derive) | idiom | `slog.LogValuer` + `o11y` struct tags (`redact.Secret`, `redact.Masked`, `redact.Struct`); guards slog, fmt, and JSON surfaces |
| Middleware: HTTP server (tower/axum) | full | `o11yhttp` over otelhttp, route-aware names, stable HTTP semconv |
| Middleware: HTTP client (reqwest) | full | `o11yhttp.NewTransport` |
| Middleware: gRPC (tonic) | full | `o11ygrpc` stats handlers (server + client) |
| Middleware: alternative web framework (actix) | full | `o11ygin` (nested module, Gin) |
| Ignore lists | full | `WithIgnorePaths` globs (Rust uses exact lists; globs are the Go-side improvement) |
| Resource: host/process detectors | full | host, process runtime, telemetry SDK |
| Resource: container detector | full | `resource.WithContainer` (container.id) |
| Resource: Kubernetes identity | idiom | via Downward API + OTEL_RESOURCE_ATTRIBUTES, matching the GTS Go RFC decision; no in-process detector exists in otel-go |
| Resource: build info (gts-build) | full | `debug.ReadBuildInfo` detector: service.version (when real), vcs.revision/time/modified; `WithoutBuildInfo` opt-out |
| Runtime metrics feature | full | contrib runtime, on by default |
| Histogram bucket control | full | `WithHistogramBuckets`, `WithViews` |
| Exemplars | full | SDK default (trace-based) |
| Sampler configuration | full | OTEL_TRACES_SAMPLER + `WithTraceSampler` |
| TLS for exporters | full | standard OTEL_EXPORTER_OTLP_CERTIFICATE et al. (env-driven, exporter-owned) |
| Signal-driven shutdown helper | full | `SDK.ShutdownOnSignals` (blocks, restores handling on first signal, bounded flush) |
| Hermetic test harness (`testing` feature) | full | `o11ytest` with span/metric/log recorders and correlation assertions |
| Log/span event deduplication | excluded | Rust-specific: the tracing/otel bridge dual-emission problem does not exist in Go's slog architecture |
| Config file layering (YAML/TOML) | excluded | superseded by OTEL declarative config; adopt contrib otelconf (OTEL_CONFIG_FILE) once its Go implementation stabilizes |
| Metrics cardinality cap + gauge | planned | blocked on otel-go: the SDK's cardinality limit is still experimental (env-only); revisit when the API stabilizes |

## GTS capabilities excluded by charter (company-specific)

| GTS capability | Generic replacement in libo11y |
|---|---|
| 50 gtcore compliance events (NYDFS catalog) | `o11y.ForceEmit` gives applications the always-emit mechanism; event catalogs are application policy |
| `GEICO_GTS_*` environment namespace | standard OTEL_* only |
| Legacy `X-Trace-Id` header interop | W3C only; extra propagators can be composed via `WithPropagators` |
| `gts_*` Prometheus-style metric names | OTEL stable semantic conventions |
| GEICO source-link rewriting in build info | plain VCS attributes |

## Rust / Java / Zig

Planned. Each implementation will be tracked here against the same baseline
when it starts, with its own idiom column (for example: Rust regains derive
redaction; Java expresses the harness over the OTEL Java testing SDK).
