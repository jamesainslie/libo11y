# libo11y resource taxonomy (spec 1.0.0)

Generated from `spec/registry`; do not edit. Semconv pin: v1.41.0.

## tier0

| Attribute | Requirement | Source | Role | Sensitivity | Signals |
|---|---|---|---|---|---|
| `service.name` | required | option-or-env | identifying | public | traces,logs,metrics |
| `service.version` | required | option-or-env-or-buildinfo | descriptive | public | traces,logs,metrics |
| `deployment.environment.name` | required | option-or-env | descriptive | public | traces,logs,metrics |
| `telemetry.sdk.name` | required | sdk | identifying | public | traces,logs |
| `telemetry.sdk.language` | required | sdk | identifying | public | traces,logs |
| `telemetry.sdk.version` | required | sdk | identifying | public | traces,logs |
| `telemetry.distro.name` | recommended | sdk | descriptive | public | traces,logs |
| `telemetry.distro.version` | recommended | sdk | descriptive | public | traces,logs |

## tier1

| Attribute | Requirement | Source | Role | Sensitivity | Signals |
|---|---|---|---|---|---|
| `service.instance.id` | required | derived | identifying | internal | traces,logs,metrics |
| `service.namespace` | conditionally_required | option-or-env | identifying | public | traces,logs,metrics |
| `k8s.namespace.name` | conditionally_required | downward-api | identifying | internal | traces,logs |
| `k8s.pod.name` | conditionally_required | downward-api | descriptive | internal | traces,logs |
| `k8s.pod.uid` | conditionally_required | downward-api | identifying | internal | traces,logs |
| `k8s.cluster.name` | recommended | collector | identifying | internal | traces,logs |
| `k8s.deployment.name` | recommended | collector | descriptive | internal | traces,logs |
| `k8s.container.name` | recommended | collector | descriptive | internal | traces,logs |
| `k8s.node.name` | recommended | collector | descriptive | internal | traces,logs |
| `container.id` | conditionally_required | detector | identifying | internal | traces,logs |
| `cloud.provider` | opt_in | detector-or-collector | descriptive | internal | traces,logs |
| `cloud.platform` | opt_in | detector-or-collector | descriptive | internal | traces,logs |
| `cloud.region` | opt_in | detector-or-collector | descriptive | internal | traces,logs |
| `cloud.availability_zone` | opt_in | detector-or-collector | descriptive | internal | traces,logs |
| `cloud.account.id` | opt_in | detector-or-collector | descriptive | internal | traces,logs |
| `host.id` | conditionally_required | detector | identifying | internal | traces,logs |
| `host.name` | recommended | detector | descriptive | internal | traces,logs |
| `faas.name` | conditionally_required | detector | identifying | internal | traces,logs |
| `faas.instance` | conditionally_required | detector | identifying | internal | traces,logs |
| `faas.version` | recommended | detector | descriptive | internal | traces,logs |

## tier2

| Attribute | Requirement | Source | Role | Sensitivity | Signals |
|---|---|---|---|---|---|
| `vcs.ref.head.revision` | recommended | buildinfo | identifying | public | traces,logs |
| `vcs.ref.head.name` | opt_in | buildinfo | descriptive | public | traces,logs |
| `o11y.build.modified` | recommended | buildinfo | descriptive | public | traces,logs |
| `o11y.build.time` | recommended | buildinfo | descriptive | public | traces,logs |
| `o11y.team.name` | recommended | option-or-collector | descriptive | public | traces,logs |
| `process.pid` | opt_in | detector | identifying | internal | traces,logs |
| `os.type` | opt_in | detector | identifying | public | traces,logs |
| `host.arch` | opt_in | detector | descriptive | public | traces,logs |
| `process.runtime.name` | recommended | detector | descriptive | public | traces,logs |
| `process.runtime.version` | recommended | detector | descriptive | public | traces,logs |

## tier3

| Attribute | Requirement | Source | Role | Sensitivity | Signals |
|---|---|---|---|---|---|
| `o11y.tenant.id` | opt_in | option | descriptive | internal | traces,logs |
| `o11y.cost_center` | opt_in | option-or-collector | descriptive | internal | traces,logs |
| `o11y.data.classification` | opt_in | option | descriptive | internal | traces,logs |
| `o11y.label` | opt_in | option | descriptive | internal | traces,logs |

## forbidden

| Attribute | Requirement | Source | Role | Sensitivity | Signals |
|---|---|---|---|---|---|
| `host.ip` | opt_in |  |  | pii |  |
| `host.mac` | opt_in |  |  | pii |  |
| `process.command_line` | opt_in |  |  | pii |  |
| `process.command_args` | opt_in |  |  | pii |  |
| `device.id` | opt_in |  |  | pii |  |

## Registered events

| Event | Required attributes |
|---|---|
| `o11y.telemetry.configured` | `o11y.config.<key>` |
| `o11y.request.summary` | `http.request.method`, `http.response.status_code`, `o11y.outcome`, `o11y.duration` |
| `o11y.telemetry.dropped` | `o11y.signal`, `error.type` |
