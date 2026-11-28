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

The package is in development and is not on npm yet. It has the core
(sessions, consent, sampling, the retention buffer and view summaries),
the `views()`, `actions()` and `errors()` collectors, remote
configuration and the two-part loader. The collectors for vitals and
resources arrive in later changes.

## Quick start

```ts
import { actions, errors, setupRum, views } from "@libo11y/rum";

const telemetry = await setupRum({
  serviceName: "storefront",
  environment: "production",
  serviceVersion: "1.4.0",
  endpoint: "/_o11y",
  rum: {
    sessionSampleRate: 0.1,
    clientToken: "pub-storefront",
    collectors: [views(), actions(), errors()],
  },
});

// Later, once the user agrees:
telemetry.consent.grant();
```

`setupRum` takes every option of the web `setup`. RUM's own options go
under `rum`. `clientToken` is the app's public token for the gateway. It
is not a secret. Collectors run only while consent is granted.

App metrics from the Meter API export with delta temporality, because the
RUM gateway accepts only delta sums and histograms.

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

`telemetry.rum.identify(userId)` sets `user.id` on later spans and on the
events collectors emit. View summaries and session events do not carry it.
Pass a pseudonymous ID, never an email address: `identify` refuses a value
with an at sign.

## Sampling and retention

`rum.sessionSampleRate` is the share of sessions whose detail is sent from
the start. The decision is a hash of the session ID, so every tab agrees.
`docs/RUM.md` in the repository gives the formula.

Every consented session sends `o11y.rum.view.summary` records for every
view, each with the counts and time since the view's previous summary, so
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

## Collectors

Each collector is a factory you list in `rum.collectors`. A collector you
do not list is not in your bundle.

### `views()`

Every view gets a span named `view <view name>`. The initial view's span is
a child of `app_load`. A soft navigation's span is a root span, linked to
the action that caused it. A view span ends at the first paint after the
view rendered, and 10 seconds after it started at the latest. The view
summary, not the span, carries the time spent on the view.

By default (`views({ history: true })`) a change of the URL path through
`pushState`, `replaceState` or `popstate` starts a soft view. A change of
only the query or the fragment does not. A soft view counts as rendered
once the DOM has been quiet for 100 ms. With a router adapter, pass
`views({ history: false })`, and the adapter calls `rum.startView()` and
`rum.viewRendered()` instead.

A view name is the URL path with every segment that holds a digit, or is
longer than 24 characters, replaced by `$id`. The query and fragment are
dropped, so a raw URL never becomes a view name. Pass `rum.viewName` to
name views yourself, or call `rum.setViewName()` with a route template.

### `actions()`

A click, Enter or Space on a control, or a form submit is an action. The
span is named `action <type>`, such as `action click`. Its name comes only
from a `data-o11y` attribute on the element or an ancestor, or from the
`aria-label` of an interactive element. Visible text never becomes a name.
Nothing inside an element with `data-o11y-mask` gets a name. The span also
carries a CSS selector of the element, built from a stable ID, a
`data-o11y` label, or a short path of tags and classes. IDs and classes
that look generated are left out. The key a user pressed is never
recorded.

Requests started while an action is open are its children. An action ends
once none of its requests are pending and the page has been idle for
100 ms. Its end time is its last activity, a request end or a DOM change,
so the 100 ms wait is not part of its duration. An action ends 10 seconds
after it started at the latest, and at once when the next action starts.
Change the timing with `actions({ idleMillis, capMillis })`.

`actions()` also reports frustration signals. Turn them off with
`actions({ frustration: false })`.

- A rage click is three or more clicks on the same element within one
  second. It is reported once per burst.
- A dead click is a click that starts no request, changes no DOM and starts
  no view within one second. Clicks on form fields, labels, editable
  content and links, and clicks inside a text selection, are never dead.
- An error click is an error within one second of a click, or while its
  action is open.

Every frustration signal counts in the view summary, is sent as an
`o11y.rum.frustration` event, and keeps the session.

### `errors()`

`errors()` records uncaught errors, unhandled promise rejections,
resources that fail to load, Content Security Policy violations and
requests that fail without a response. `errors({ console: true })` also
records `console.error` calls, and still calls the original. Resource
error messages carry the URL without its query or fragment.

An error object is recorded once. React 19 logs an error that an error
boundary caught through `console.error` before the boundary's
`componentDidCatch` runs, so a `console.error` that logs an error object
waits one task. When `rum.addError` records the same object first, with
its component stack, the console call records nothing.

Every error counts in the view summary, keeps the session, and is sent as
an `o11y.rum.error` event, at most 100 events per view. Each event carries
`o11y.rum.error.breadcrumbs`: the last 20 actions, view starts and
requests before it, oldest first, one per line, such as `click Sign
-1530ms`. A request breadcrumb is its method, host and status, such as
`fetch POST api.example.com 500`, never its path.

## The `rum` handle

`telemetry.rum` has these methods. Each records nothing while consent is not
granted, or while remote configuration has switched RUM off.

- `startView({ name })` ends the current view and starts a soft view.
- `setViewName(name)` names the current view, such as with its route
  template.
- `viewRendered()` marks the current view rendered. Its span ends at the
  next paint.
- `addAction(name)` records a custom action, such as a programmatic save.
- `addError(error, { source, componentStack })` records an error your app
  caught. Pass `source: "boundary"` and the component stack from a UI
  framework's error boundary.

`startView`, `setViewName` and `viewRendered` are remembered while consent
is not granted, so a router adapter can report the route before consent.
When consent is granted, the view RUM starts takes the last name the
adapter set and, if the route had rendered, counts as rendered. This
applies only while the URL path is still the one the adapter reported. The
initial view's span then ends when the route rendered, and a later view's
span at the next paint.

## Remote configuration

`rum.remoteConfig: remoteConfig()` lets the RUM gateway change a few
settings without a deploy. It is off unless you pass it, and a bundle
without it does not carry its code.

```ts
import { actions, errors, remoteConfig, setupRum, views } from "@libo11y/rum";

await setupRum({
  // ...
  endpoint: "/_o11y",
  rum: {
    sessionSampleRate: 0.1,
    collectors: [views(), actions(), errors()],
    remoteConfig: remoteConfig({ limits: { sessionSampleRate: [0.01, 0.5] } }),
  },
});
```

Once consent is granted, RUM fetches
`GET <endpoint>/v1/config?service=<service.name>`, such as
`/_o11y/v1/config`, with `client_token` when `rum.clientToken` is set.
Pass `remoteConfig({ url })` for another URL. The request uses the
uninstrumented `fetch`, sends no credentials, and sends `If-None-Match`
with the cached ETag, so an unchanged document costs a `304`. RUM looks
again every 5 minutes while the page is visible (`refreshMillis`). A
`404` means the app has no remote configuration, and a failure keeps what
RUM has.

The gateway answers `{"version": "<16 hex>", "config": {...}}`. RUM reads
three keys inside `config` and ignores the rest:

| Key                 | Type               | Effect                                                                                             |
| ------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `enabled`           | boolean            | `false` switches RUM off at once: the collectors stop and the view ends. `true` starts them again. |
| `sessionSampleRate` | number, 0 to 1     | The head-sampling rate of new sessions, kept within `limits.sessionSampleRate`.                    |
| `collectors`        | object of booleans | `false` switches off a collector you installed. `true` never adds one you did not install.         |

Code sets the limits. Without `limits.sessionSampleRate`, the range is
`[rate, rate]`, so the rate does not move. A document applies to the next
session, never to the running one, except for `enabled: false`. The
newest document and the one before it are cached in `localStorage` under
`libo11y.rum.config`, so a page that resumes a session keeps the document
that session started under. A new session takes the newest. Each session
records the version it started under as `o11y.rum.config.version` on its
`o11y.rum.session.start` event and its view summaries. Revoking consent
removes the cache.

## Loading

RUM is large next to the code a page needs to render, so load it in two
parts. `@libo11y/rum/bootstrap` is under 1 KiB minified and gzip-compressed
and imports nothing else. Put it in your entry chunk and import the rest
after the page loaded:

```ts
import { afterLoad, installRumBootstrap } from "@libo11y/rum/bootstrap";

installRumBootstrap({ consent: knownConsent });
afterLoad(() => import("./rum.ts"));
```

`./rum.ts` calls `setupRum` as usual. `afterLoad` runs its callback once
the page's `load` event has fired, in an idle callback where the browser
has one.

`installRumBootstrap` takes the consent state you will pass to
`setupRum`. With `"pending"`, the default, it records nothing at all. With
`"granted"`, it holds early uncaught errors, unhandled rejections, CSP
violations and clicks in memory, never in storage, up to 100 of them
(`maxEntries`), and stops listening after 30 seconds. When `setupRum`
starts with consent granted, the collectors you installed record these with
their original times: `errors()` the errors, `actions()` the clicks. A
page whose `setupRum` starts with consent pending discards them, even if
consent is granted later.
