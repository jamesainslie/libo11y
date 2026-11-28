# o11yrum

o11yrum is the libo11y RUM gateway. It receives OTLP traces, logs and app
metrics from browsers, browser extensions and React Native apps, checks
and validates them against the libo11y specification, and forwards them to
your backend. The design is in
[the RUM design document](../../docs/design/2026-11-27-libo11y-rum-design.md).

In development; not yet released.

## Running the gateway

From `go/o11yrum`:

```sh
go install ./cmd/o11yrum-gateway
o11yrum-gateway -check-config -config gateway.yaml
o11yrum-gateway -config gateway.yaml
```

[`cmd/o11yrum-gateway/testdata/gateway.yaml`](cmd/o11yrum-gateway/testdata/gateway.yaml)
is a complete configuration. `environment` is required and takes
`production`, `staging`, `development` or `test`. Without
`sinks.otlp.endpoint`, batches go to `OTEL_EXPORTER_OTLP_ENDPOINT` with
`OTEL_EXPORTER_OTLP_HEADERS`, which must use the `http/protobuf` protocol.
The gateway's own telemetry follows the standard `OTEL_*` variables.

The config endpoint shares the ingest rate limit, so a page load that
fetches its configuration spends one request of the client's budget.

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
upload a build's maps.

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
