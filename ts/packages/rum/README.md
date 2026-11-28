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
(sessions, consent, sampling, the retention buffer and view summaries) and
the `views()`, `actions()`, `errors()`, `vitals()`, `resources()` and
`longAnimationFrames()` collectors.

## Quick start

```ts
import { actions, errors, resources, setupRum, views, vitals } from "@libo11y/rum";

const telemetry = await setupRum({
  serviceName: "storefront",
  environment: "production",
  serviceVersion: "1.4.0",
  endpoint: "/_o11y",
  rum: {
    sessionSampleRate: 0.1,
    clientToken: "pub-storefront",
    collectors: [views(), actions(), errors(), vitals(), resources()],
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

Every error counts in the view summary, keeps the session, and is sent as
an `o11y.rum.error` event, at most 100 events per view. Each event carries
`o11y.rum.error.breadcrumbs`: the last 20 actions, view starts and
requests before it, oldest first, one per line, such as `click Sign
-1530ms`. A request breadcrumb is its method, host and status, such as
`fetch POST api.example.com 500`, never its path.

### `vitals()`

`vitals()` records Largest Contentful Paint (LCP), Interaction to Next
Paint (INP), Cumulative Layout Shift (CLS), First Contentful Paint (FCP)
and Time to First Byte (TTFB). It uses the attribution build of the
Chrome team's [`web-vitals`](https://github.com/GoogleChrome/web-vitals)
package, pinned to one version. CrUX and the web.dev thresholds are defined
against that package. It already handles back/forward cache restores,
prerendering, page visibility and how INP groups the events of one
interaction. The package adds about 5 KiB gzipped, and only apps that list
`vitals()` pay for it.

Vitals belong to the view that loaded the page: the initial or prerender
view, or the `bfcache_restore` view after a page comes back from the
back/forward cache. Soft views carry no vitals. INP and CLS therefore
cover the page until it is first hidden, as the page-level values of CrUX
do.

Each vital goes into the view summary once, as
`o11y.rum.summary.<vital>.value`, in the first summary sent after it is
known. FCP and TTFB are known when the browser reports them. LCP, CLS and
INP keep changing while the page is visible, so RUM takes their latest
values when the page is first hidden, just before that hide sends the
summary. A CLS or INP change after the page returns from hidden stays out
of the summary. A kept session still records it as detail. CrUX reports
the final value at page unload, so on long-lived pages the p75 of CLS and
INP can differ from CrUX. LCP, INP, FCP and TTFB are in seconds. CLS has no
unit.

Kept sessions also send each value as the semconv `browser.web_vital`
event. Its body holds the vital's `name` (`lcp`, `inp`, `cls`, `fcp` or
`ttfb`), `value`, `delta` since the last event for it, and `id`, in the
same units. Its attributes are the view, the session and the attribution:
the `o11y.rum.vital.attribution.*` phases of INP and LCP, the largest shift
of CLS, and the element as `o11y.rum.element.selector`. The selector is
built as for actions, never from text.

RUM never sends a rating. The gateway rates each vital against the
thresholds the spec publishes.

A browser that does not support a vital records nothing for it. Firefox
and WebKit, for example, report no CLS.

### `resources()`

`resources()` records a span for each script, stylesheet, image, font,
media file and frame the page loads, from the browser's resource timing
entries. The span is named `resource <type>`, such as `resource script`,
and carries `o11y.rum.resource.type`, `url.full` without the query
parameters you did not allow, `server.address`, the status code and the
encoded body size when the browser exposes them. A cross-origin server
must send `Timing-Allow-Origin` for those details.

- Requests made with `fetch`, XHR or `sendBeacon` get no resource span,
  because they have client spans of their own. RUM's own OTLP requests and
  the URLs in `instrumentations.ignoreUrls` are left out too.
- A resource that started during the page load is a child of `app_load`.
  A later resource is a root span linked to the span of its view.
- The type comes from the initiator. A font or an image that a stylesheet
  loads is typed by its file extension.
- When the response has a `Server-Timing` header, a `traceparent` entry
  links the span to the server span that served it. Every other entry
  becomes a `server_timing` span event with `o11y.rum.server_timing.name`
  and `o11y.rum.server_timing.duration` in seconds.
- At most 150 resource spans per view. Change it with
  `resources({ maxPerView })`.

Resource spans are detail, so only kept sessions send them. They are not
requests of the view, so they do not count in `o11y.rum.summary.requests`.

### `longAnimationFrames()`

`longAnimationFrames()` counts the browser's long animation frames into
the view summary as `o11y.rum.summary.long_animation_frames`. Only
Chromium-based browsers report long animation frames today. Elsewhere it
records nothing. It does not fall back to long tasks, which measure
something else, so the gateway's `o11y.rum.browser.long_animation_frames`
metric reflects Chromium-based browsers only.

## The `rum` handle

`telemetry.rum` has these methods. Each does nothing while consent is not
granted.

- `startView({ name })` ends the current view and starts a soft view.
- `setViewName(name)` names the current view, such as with its route
  template.
- `viewRendered()` marks the current view rendered. Its span ends at the
  next paint.
- `addAction(name)` records a custom action, such as a programmatic save.
- `addError(error, { source, componentStack })` records an error your app
  caught. Pass `source: "boundary"` and the component stack from a UI
  framework's error boundary.
