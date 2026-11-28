# @libo11y/sourcemaps

Uploads JavaScript source maps to the libo11y RUM gateway (`o11yrum`). The
gateway uses them to symbolicate the stack traces of browser and React
Native errors before it exports them, and to give each error a stable
fingerprint. It runs on Bun 1.3.13 and Node 24.

```sh
npm install --save-dev @libo11y/sourcemaps
```

The package first ships in `ts/v0.3.0`. It is not on npm yet. Until its
first npm publish, install it from the tarball attached to the
[`ts/v0.3.0` GitHub Release](https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.3.0),
whose notes list the exact URL:

```sh
npm install --save-dev \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.3.0/libo11y-sourcemaps-0.3.0.tgz
```

The gateway stores each map under the app's `service.name`, the release's
`service.version`, the over-the-air update ID when there is one, and the
path of the script the map describes. It never serves a map back, so maps
can be deleted from the build output once they are uploaded.

## The command

```sh
export O11Y_SOURCEMAPS_TOKEN=...   # the app's upload token
libo11y-sourcemaps upload \
  --endpoint https://shop.example \
  --service shop-web \
  --release 1.4.2 \
  --url-prefix /assets/ \
  --delete \
  dist/assets
```

| Flag                  | Meaning                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `--endpoint URL`      | the gateway's base URL, under which it serves `/_o11y/v1/`                             |
| `--service NAME`      | the app's `service.name`                                                               |
| `--release VERSION`   | the release's `service.version`                                                        |
| `--url-prefix PREFIX` | the URL path the directory is served at, such as `/assets/`, or `~/` for the site root |
| `--update-id ID`      | the over-the-air update the maps belong to (`o11y.rum.app.update_id`)                  |
| `--token-env VAR`     | the environment variable holding the upload token. Default `O11Y_SOURCEMAPS_TOKEN`     |
| `--concurrency N`     | uploads in flight at once. Default 4                                                   |
| `--delete`            | removes each uploaded map, and its script's `sourceMappingURL` comment, from the build |

The token is read only from the environment, so it never appears in a
process list. The flag is `--release` so that `--version` prints the
tool's version. The command prints `uploaded <url> -> <key>` for each map
that uploaded, also when a later one fails.
It exits 0 when every map uploaded, 1 when an upload failed or the
directory holds no maps, and 2 on a usage error.

## The library

```ts
import { uploadSourceMaps } from "@libo11y/sourcemaps";

const uploaded = await uploadSourceMaps({
  endpoint: "https://shop.example",
  token: process.env.O11Y_SOURCEMAPS_TOKEN ?? "",
  service: "shop-web",
  version: "1.4.2",
  urlPrefix: "/assets/",
  directory: "dist/assets",
});
```

`findSourceMaps(directory, urlPrefix)` lists the scripts that have an
external source map, without uploading anything. A script's map is the
file its last-line `//# sourceMappingURL=` comment names, or a sibling
`<script>.map` when it has no comment. Inline `data:` maps, maps whose
real path is outside the directory, `node_modules`, and symbolically
linked scripts and directories are skipped. URLs are percent-encoded the
way browsers report them, so `a b.js` is uploaded as `a%20b.js`. Android
(`index.android.bundle`) and iOS (`main.jsbundle`) React Native bundles
are found too.

Each map is sent gzipped to `POST /_o11y/v1/sourcemaps` with the token as
a bearer token. An attempt that takes longer than two minutes is
abandoned. A 429, a 5xx, a timeout or a network failure is retried, up to
three attempts, after the response's `Retry-After` (at most ten seconds)
or a short backoff. Once an upload fails no further upload starts, and
the first failure is thrown as an `UploadError` carrying the HTTP
`status` (0 when the gateway could not be reached or the map could not be
read), the `script`, and the maps that did upload in `uploaded`. A token
that holds white space or characters an HTTP header cannot carry is
refused before anything is sent, and no message ever includes the token.
With `deleteAfterUpload`, a map is removed only once every script it
describes has uploaded.

## The gateway side

An app accepts uploads when the gateway configuration names its token
file and an object store:

```yaml
object_store:
  s3: { bucket: shop-sourcemaps, prefix: o11yrum/ }
apps:
  - service_name: shop-web
    origins: ["https://shop.example"]
    sourcemaps: { upload_token_file: /run/secrets/shop-web-sourcemaps }
```

See the [o11yrum README](../../../go/o11yrum/README.md) for the gateway.
