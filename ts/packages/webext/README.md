# @libo11y/webext

The libo11y Manifest V3 extension platform for TypeScript. `setupWorker()` runs in the service
worker, which the browser can stop at any time, so every batch is persisted to IndexedDB before
it is sent and the queue is drained on the next wake. `setupContentScript()` runs in content
scripts and extension pages and forwards their records to the worker by runtime messaging. Trace
context crosses with every traced message. Consent is one state for the whole extension.

It has no RUM features. Those are `@libo11y/rum`.

Status: under construction for `ts/v0.2.0`.

```ts
// worker.ts
import { setupWorker } from "@libo11y/webext";
const telemetry = await setupWorker({
  serviceName: "lor-clipper",
  environment: "production",
  endpoint: "https://otlp.example.com",
});

// content.ts
import { setupContentScript } from "@libo11y/webext";
const telemetry = await setupContentScript({ serviceName: "lor-clipper", environment: "production" });
await telemetry.sendMessage({ kind: "clip", url: location.href });
```
