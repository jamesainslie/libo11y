# @libo11y/rum-connect

Connect adapter for
[`@libo11y/rum`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/rum).
It names the fetch spans of Connect and gRPC-Web RPCs by service and
method, such as `lor.signing.v1.SigningService/SignDocument`, the way
`go/o11yconnect` names its client spans, and sets `rpc.system.name` and
`rpc.method` on them.

```sh
npm install @libo11y/rum @libo11y/rum-connect
```

It works from the request URL, so it needs no Connect interceptor and has
no runtime dependency on `@connectrpc/connect`. It suits connect-web 1.x
and 2.x transports.

## Status

The package first ships in `ts/v0.3.0`, and it releases with
`@libo11y/rum` at the same version. Neither is on npm yet. Until their
first npm publish, install both from the tarballs attached to the
[`ts/v0.4.0` GitHub Release](https://github.com/jamesainslie/libo11y/releases/tag/ts/v0.4.0),
whose notes list the exact URLs:

```sh
npm install \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.4.0/libo11y-rum-0.4.0.tgz \
  https://github.com/jamesainslie/libo11y/releases/download/ts/v0.4.0/libo11y-rum-connect-0.4.0.tgz
```

## Usage

```ts
import { setupRum, views } from "@libo11y/rum";
import { connectRequestNaming } from "@libo11y/rum-connect";
import { createConnectTransport } from "@connectrpc/connect-web";

const telemetry = await setupRum({
  serviceName: "portal",
  environment: "production",
  serviceVersion: "2.1.0",
  endpoint: "/_o11y",
  rum: { collectors: [views()] },
});

connectRequestNaming(telemetry.rum, { services: ["lor.signing.v1.SigningService"] });

const transport = createConnectTransport({ baseUrl: "/api" });
```

connect-web calls `globalThis.fetch` on every request, so its requests
pass through the fetch instrumentation `setupRum` installs. A transport
given its own `fetch` option must not bypass `globalThis.fetch`.

`connectRequestNaming` returns a function that removes the hook.

## Options

- `services`: the fully qualified services to name. Default: any.
- `system`: the `rpc.system.name` value, `"connectrpc"` by default. Pass
  `"grpc"` for a gRPC-Web transport, as `go/o11yconnect` does.

## What counts as an RPC

A request is an RPC when its path ends in `/<package.Service>/<Method>`,
where the service has at least one package segment, the service's own
name and the method are PascalCase, as the protobuf style guide requires,
and it is a `POST`,
or a `GET` with the Connect protocol's `connect=v1` query parameter. Any
base path before the service is allowed, so a transport with base URL
`/api` is covered. A REST path with a dotted segment, such as
`/users/jane.doe/follow`, is not an RPC. Every other request keeps its
span, named by its HTTP method.

The span's name and `rpc.method` are `<service>/<method>`. RUM's
breadcrumbs then label the request `rpc <service>/<method>` instead of
`<METHOD> <host> <status>`.
