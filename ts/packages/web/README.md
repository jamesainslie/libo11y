# @libo11y/web

The libo11y browser platform for TypeScript. It binds
[`@libo11y/core`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/core) to the browser:
`setup()` over the OpenTelemetry JS providers with a pluggable context manager, the browser
resource, an OTLP/HTTP JSON transport (gzip, unload-time `fetch` keepalive and `sendBeacon`, an
IndexedDB retry queue that honours `429` and `Retry-After`), a consent gate, and `fetch`, XHR and
document-load spans that send `traceparent` only to the page's origin and an allow-list.

It has no RUM features. Those are `@libo11y/rum`.

Status: under construction for `ts/v0.2.0`.

```ts
import { setup } from "@libo11y/web";

const telemetry = await setup({
  serviceName: "lor-site",
  environment: "production",
  endpoint: "https://otlp.example.com",
  instrumentations: { propagateTo: ["https://api.example.com"] },
});
cmp.onAccept(() => telemetry.consent.grant());
cmp.onWithdraw(() => telemetry.consent.revoke());
```
