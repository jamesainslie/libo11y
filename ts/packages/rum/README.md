# @libo11y/rum

Real user monitoring (RUM) for browsers, built on
[`@libo11y/web`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/web).
`setupRum()` runs the web platform with RUM wired in. It keeps one session
across the tabs of an origin, samples sessions, and sends a summary of
every view to the RUM gateway.

```sh
npm install @libo11y/rum
```

## Status

The package is in development and is not on npm yet. This release has the
core: sessions, consent, sampling, the retention buffer and view
summaries for the page load. The collectors for views, actions, errors,
vitals and resources arrive in later changes.

## Quick start

```ts
import { setupRum } from "@libo11y/rum";

const telemetry = await setupRum({
  serviceName: "storefront",
  environment: "production",
  serviceVersion: "1.4.0",
  endpoint: "/_o11y",
  rum: { sessionSampleRate: 0.1, clientToken: "pub-storefront" },
});

// Later, once the user agrees:
telemetry.consent.grant();
```

`setupRum` takes every option of the web `setup`. RUM's own options go
under `rum`. `clientToken` is the app's public token for the gateway. It
is not a secret.

## Consent

Nothing is recorded, stored or sent before `telemetry.consent.grant()`.
No session exists until then, and RUM writes nothing to `localStorage` or
IndexedDB. `telemetry.consent.revoke()` stops RUM, removes the session
from storage and empties the retention buffer. To start with consent
already given, pass `consent: { initial: "granted" }`.

## Sessions

A session belongs to the origin, so every tab shares it. It ends after 15
minutes without activity (`rum.sessionIdleMillis`) or 4 hours after it
started (`rum.sessionMaxMillis`). The next record after that starts a new
session. `telemetry.rum.sessionId()` returns the current session's ID.

`telemetry.rum.identify(userId)` sets `user.id` on later spans and events.
Pass a pseudonymous ID, never an email address: `identify` refuses a value
with an at sign.

## Sampling and retention

`rum.sessionSampleRate` is the share of sessions whose detail is sent from
the start. The decision is a hash of the session ID, so every tab agrees.
`docs/RUM.md` in the repository gives the formula.

Every consented session sends one `o11y.rum.view.summary` per view, so
counts and rates stay exact at any sample rate. A session that was not
sampled keeps its other records in a retention buffer in IndexedDB, at
most 2 MiB and 15 minutes old by default (`rum.retention`). When an error
or a frustration signal keeps the session, the buffer is sent. A session
that ends without being kept drops its buffer.

## Privacy

Recorded URLs keep only the query parameters in `rum.queryAllowList`.
View names come from the path, with every segment that holds a digit or is
longer than 24 characters replaced by `$id`, so a raw URL never becomes a
view name. Pass `rum.viewName` to name views yourself.
