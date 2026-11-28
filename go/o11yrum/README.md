# o11yrum

o11yrum is the libo11y RUM gateway. It receives OTLP traces, logs and app
metrics from browsers, browser extensions and React Native apps, checks
and validates them against the libo11y specification, and forwards them to
your backend. The design is in
[the RUM design document](../../docs/design/2026-11-27-libo11y-rum-design.md).

o11yrum versions on its own line, tagged `go/o11yrum/vX.Y.Z`. Its changes
are in [`CHANGELOG.md`](CHANGELOG.md).

## Installing

Install the command:

```sh
go install github.com/jamesainslie/libo11y/go/o11yrum/cmd/o11yrum-gateway@v0.1.0
```

Or run the container image, built for `linux/amd64` and `linux/arm64`:

```sh
docker pull ghcr.io/jamesainslie/o11yrum-gateway:0.1.0
```

Each release tags the image `X.Y.Z`. A release without a `-prerelease`
suffix also tags `X.Y` and `latest`. Pin the image by digest in
production. The summary of the release workflow's `image` job prints the
digest. Every
image carries build provenance, which you can check before you mirror it:

```sh
gh attestation verify oci://ghcr.io/jamesainslie/o11yrum-gateway:0.1.0 --repo jamesainslie/libo11y
```

Use the module as a library with `go get
github.com/jamesainslie/libo11y/go/o11yrum@v0.1.0`. It requires
`github.com/jamesainslie/libo11y/go` v0.4.0 or later.

## Running the gateway

```sh
o11yrum-gateway -check-config -config gateway.yaml
o11yrum-gateway -config gateway.yaml
o11yrum-gateway -version
```

[`cmd/o11yrum-gateway/testdata/gateway.yaml`](cmd/o11yrum-gateway/testdata/gateway.yaml)
is a complete configuration. It listens on `127.0.0.1:0` for tests, so
remove `listen` or set it to `:8080` before you use it in the container.
`environment` is required and takes
`production`, `staging`, `development` or `test`. The gateway's own
telemetry follows the standard `OTEL_*` variables.

The gateway serves the RUM endpoints under `/_o11y/v1/`, liveness at
`/healthz` and readiness at `/readyz`. On SIGTERM or SIGINT, `/readyz`
answers 503 at once. The gateway keeps serving for `shutdown_delay`
(default 0), then stops accepting connections and drains. In-flight
requests get 15 seconds to finish and the gateway's own telemetry gets 10
seconds to flush. A second signal ends the process at once.

### The batch sink and the OTEL_EXPORTER_OTLP_* fallback

Batches go to the collector `sinks.otlp.endpoint` names, as OTLP/HTTP
protobuf. When the configuration leaves it unset, the gateway reads the
same variables its own telemetry uses:

- `OTEL_EXPORTER_OTLP_ENDPOINT` becomes the sink's endpoint. The signal
  specific variables, such as `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, are
  not read for the sink.
- `OTEL_EXPORTER_OTLP_HEADERS` adds its headers. A header the
  configuration sets wins.
- `OTEL_EXPORTER_OTLP_PROTOCOL` must be unset or `http/protobuf`, because
  that is what the sink speaks. When the endpoint comes from the
  environment, any other value stops the gateway at startup. Set `sinks.otlp.endpoint` to send the gateway's own telemetry
  over gRPC and the batches over HTTP.

With neither set, the gateway accepts and validates batches but forwards
them nowhere. It still derives metrics from them.

### The shared rate limit

Every request from one client spends the same budget,
`edge.rate_limit_per_minute` (default 60): ingest of traces, logs and app
metrics, and `GET /_o11y/v1/config`. A page load that fetches its
configuration spends one request of that budget. A failed source map
upload authentication spends it too. Authenticated uploads do not.
Clients behind one address, such as an office NAT, share one budget,
because the gateway keys the limiter on the client address it resolves.
Raise the limit when many users share an address.

## Derived metrics

The gateway derives the standard RUM metrics from view summaries,
evaluates each app's `metrics` definitions, and re-aggregates the app
metrics browsers post to `/_o11y/v1/metrics`. The command exports them
with its own metrics, through the reader `OTEL_METRICS_EXPORTER` selects.
Its producer is registered as `o11yrum` and as the fallback, so leave
`OTEL_METRICS_PRODUCERS` unset, or include `o11yrum` in it. The command
refuses to start when the variable is set without it. With
`OTEL_METRICS_EXPORTER=none`, the derived metrics are not exported at all.
The derived metrics are always cumulative.
`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` changes only the
gateway's own metrics.

## App metric labels

An app metric point keeps only the labels the specification classifies
bounded or enum, such as `o11y.rum.platform` and `os.name`. Every other
label is dropped, and the point is still counted. An app lists its own
label keys in `app_metric_labels` to keep them:

```yaml
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    app_metric_labels: [shop.checkout.step, shop.plan]
```

List only keys with a bounded set of values, because each distinct value
becomes its own series. A point may carry at most 16 labels, a key may be
at most 256 bytes, and longer values are cut to 256 bytes. Keys the
specification classifies PII, secret or unbounded, such as `session.id`,
are always dropped, whatever the app's `pii` mode, and a configuration
that lists one fails to load.

## Source maps and symbolication

With an object store configured, the gateway accepts source map uploads
and symbolicates the JavaScript stacks of `o11y.rum.error` records,
other records carrying `exception.stacktrace`, and span events named
`exception`. It runs after enrichment and before the sinks and metric
derivation, so the sinks and any operator metric see the resolved stack.

```yaml
object_store:
  # One of:
  filesystem: {root: /var/lib/o11yrum}
  # s3: {bucket: shop-sourcemaps, prefix: o11yrum/, region: us-east-1}
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    sourcemaps:
      upload_token_file: /run/secrets/shop-web-sourcemaps
```

The S3 store authenticates with the AWS SDK's default credential chain,
so on EKS Pod Identity or IRSA supplies the credentials and no static key
is configured. `endpoint` and `use_path_style` point it at an
S3-compatible store instead. Grant the gateway's role `s3:GetObject`,
`s3:PutObject` and `s3:ListBucket` on the bucket: without `s3:ListBucket`,
S3 answers a missing map with 403 rather than 404, and every frame of a
release without maps counts as `error` rather than `miss`. The library
builds the filesystem store from
the configuration. An S3 store comes from the `s3store` package through
`WithObjectStore`, which the command does for you.

`POST /_o11y/v1/sourcemaps?service=&version=&url=[&update_id=]` takes one
map as the body, optionally gzipped, with the app's upload token as
`Authorization: Bearer`. It answers 201 with the object key. A map is
checked by parsing it (422 when it is not a version 3 map, or is an index
map) and kept under
`sourcemaps/<namespace>/<service.version>/<update_id or _>/<hash of the script path>.map`.
The script path is the URL's path, so one upload serves every origin and
`chrome-extension://` URLs. `sourcemaps.namespace` defaults to the
`service_name`. The gateway never serves a map back. A wrong token, an
unknown app and an app without uploads all answer 401, and each failed
attempt spends the client's rate limit. Authenticated uploads are not
rate limited. `@libo11y/sourcemaps` and its `libo11y-sourcemaps` command
upload a build's maps. That package is not on npm yet.

Each frame is looked up by the resource's `service.version` and
`o11y.rum.app.update_id` (a record's own update ID wins). A resolved frame
takes the original file, line and column, and the function name mapped at
its caller's call site. A stack is rewritten only when a frame resolved.
Every symbolicated record gets `o11y.rum.error.fingerprint`, 32 hex
digits over the exception type and the script path and function of the
first five frames with a URL, or over the message with digits folded when
there are none. A fingerprint a client sent is removed. The fingerprint is
taken after symbolication, so an error that arrives before its release's
maps are uploaded, or while the store is failing, groups apart from the
same error once its frames resolve. Upload maps before the release
serves traffic.

The `symbolication` section bounds the work: `cache_maps` (default 64) and
`cache_bytes` (default 256 MiB) bound the parsed maps held in memory,
`cache_ttl` (default 10m) is how long a parsed map is used before the
store is read again, `negative_ttl` (default 60s) is how long a missing or
broken map is not looked up again, and `max_frames` (default 50) caps the
frames kept per stack. An upload clears the cache entry on the replica
that took it at once; other replicas pick up a replaced map within
`cache_ttl`. One batch reads at most 16 maps from the store and starts no
read after 2 seconds, so a batch naming many scripts cannot hold a
request. Frames past that budget count as `skipped`. `o11yrum.symbolication.frames`
counts frames by `o11yrum.result`: `hit`, `unmapped`, `miss`, `error` and
`skipped`. `o11yrum.sourcemaps.uploads` counts uploads by outcome. A
failing store is logged at most once a minute.

## Deploying

### The container

The image holds one static binary on `gcr.io/distroless/static-debian12`.
It runs as user and group 65532, a numeric ID, so Kubernetes can enforce
`runAsNonRoot`. Its default arguments are `-config
/etc/o11yrum/config.yaml`. Setting `args` in Kubernetes replaces them, so
keep `-config` when you do. It listens on port 8080, the default `listen`
address. It writes nothing at
runtime, so it runs with a read-only root filesystem and every capability
dropped. A `filesystem` object store is the one exception: mount a
writable volume at its `root`. The image has no shell and no `sleep`, so
an `exec` probe or hook cannot work. Probe over HTTP.

### Kubernetes

Mount the configuration from a ConfigMap under the key `config.yaml`, and
each upload token from a Secret at the path its `upload_token_file`
names. `OTEL_EXPORTER_OTLP_ENDPOINT` names the collector for the
gateway's own telemetry, and for the batches too unless the configuration
sets `sinks.otlp.endpoint`. On EKS, give the
service account an S3 role through Pod Identity or IRSA when the object
store is `s3`.

```yaml
spec:
  terminationGracePeriodSeconds: 40
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: o11yrum-gateway
      image: ghcr.io/jamesainslie/o11yrum-gateway@sha256:<digest>
      ports:
        - {name: http, containerPort: 8080}
      env:
        - {name: OTEL_EXPORTER_OTLP_ENDPOINT, value: "http://otel-collector:4318"}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
      livenessProbe:
        httpGet: {path: /healthz, port: http}
      readinessProbe:
        httpGet: {path: /readyz, port: http}
        periodSeconds: 5
      lifecycle:
        preStop:
          sleep: {seconds: 5}
      volumeMounts:
        - {name: config, mountPath: /etc/o11yrum, readOnly: true}
  volumes:
    - name: config
      configMap: {name: o11yrum-gateway}
```

Keep the `preStop` sleep. Kubernetes takes a terminating pod out of its
Service endpoints on its own, but kube-proxy, the ingress controller and
any cloud load balancer learn of it a few seconds later. Until then they
still send it traffic. `/readyz` fails as soon as the gateway receives
SIGTERM, and the listener closes right after when `shutdown_delay` is 0.
A connection that arrives in that gap is refused. The sleep holds SIGTERM
back until the routers have caught up. The `sleep` action needs
Kubernetes 1.30 or later. On an older cluster, set `shutdown_delay: 5s`
in the configuration instead, which keeps the gateway serving with
`/readyz` failing for that long. Use one or the other, because the two
add up. `shutdown_delay` also suits a load balancer outside Kubernetes
that health-checks `/readyz` directly.

Size `terminationGracePeriodSeconds` to cover the `preStop` sleep or
`shutdown_delay`, plus 25 seconds: 15 for draining requests and 10 for
flushing the gateway's own telemetry. The default 30 seconds fits only
when both are 0.

### Behind a router

Route `/_o11y/*` on the app's own origin to the gateway, so browsers send
same-origin requests and need no CORS preflight. The gateway also answers
cross-origin requests from each app's `origins`, so it can run on its own
host instead.

Set `edge.trusted_proxies` to the addresses of the hops in front of the
gateway, such as the ingress controller's pod network. The gateway
believes the forwarding header only from those hops, and takes the first
address it cannot vouch for as the client.

### Trusting a CDN with trusted_from

`edge.country.trusted_from` lists the hops allowed to set the country
header, such as Cloudflare's `CF-IPCountry`. Those hops also count as
trusted proxies for the forwarding header. Listing a CDN's published
address ranges trusts everyone who can send traffic through that CDN, not
only your own zone. Another customer of the same CDN can point a worker or
a proxy rule at your origin and set any country, and any forwarding
header, on its requests. A forged forwarding header lets one sender
present a new client address on each request, which slips past the
per-client rate limit and skews the country breakdown.

Accept origin traffic only from your own CDN zone before you list its
ranges. Authenticated origin pulls (mutual TLS from the CDN), a tunnel
from the CDN to the cluster, or a shared secret header that the ingress
checks all do this. Better still, let the ingress controller that verifies
the CDN rewrite the headers, and list only that controller's addresses in
`trusted_proxies` and `trusted_from`.

