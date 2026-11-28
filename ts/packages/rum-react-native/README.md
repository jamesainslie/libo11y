# @libo11y/rum-react-native

Real user monitoring for React Native apps on Hermes, over
[`@libo11y/react-native`](../react-native). It records sessions, screens,
per-screen summaries and the app's start, gated on consent, and joins
them to the backend traces of the requests the app makes. The handle it
returns is the same `Rum` the browser's `@libo11y/rum` returns, so
[`@libo11y/rum-react`](../rum-react) and
[`@libo11y/rum-connect`](../rum-connect) work with it as they are.

```sh
npm install @libo11y/react-native @libo11y/rum-react-native
```

It needs React Native 0.88 or later as a peer dependency. It contains no
native code, so adding it changes no native build.

## Usage

An Expo app imports `setupRumExpo` from `@libo11y/rum-react-native/expo`,
which keeps everything RUM stores in the app's documents and fills in the
app version and the over-the-air update ID, as `setupExpo` does:

```ts
import { remoteConfig, screens } from "@libo11y/rum-react-native";
import { setupRumExpo } from "@libo11y/rum-react-native/expo";

export const telemetryReady = setupRumExpo({
  serviceName: "my-app",
  environment: "production",
  endpoint: "https://app.example.com/_o11y",
  consent: { initial: "pending" },
  instrumentations: { propagateTo: ["https://api.example.com"] },
  rum: {
    clientToken: "pub-my-app",
    collectors: [screens()],
    remoteConfig: remoteConfig(),
  },
});
```

A bare React Native app calls `setupRumReactNative` with the same options
and a `storage` of its own, such as AsyncStorage. Without one, RUM keeps
its state in memory and loses it when the app stops.

`telemetryReady` is a promise, because Metro bundles do not support
top-level `await`.
Until a router adapter names screens, the app reports them itself on the
telemetry it resolves with:

```ts
telemetry.rum.startView({ name: "/settings" }); // a new screen
telemetry.rum.setViewName("/"); // names the current screen
telemetry.rum.viewRendered(); // the screen's content is on screen
```

Call `rum.viewRendered()` once the first screen is up, for example in an
effect of the root component. It ends the first screen's span and the
`app_load` span.

## What it records

- **Sessions.** A session ends after 15 minutes without activity or 4
  hours after it started. It is stored in the app's storage once consent
  is granted, so a relaunch within the idle window continues it, and a
  crash and relaunch stay in one session. A new screen (`rum.startView`)
  and coming back to the foreground count as activity; touches do not
  yet, so a user who stays on one screen for 15 minutes starts a new
  session at the next screen. Sampling, the retention buffer of sessions not yet
  kept and the session events work as in `@libo11y/rum`; the buffer lives
  in the app's storage.
- **Screens.** Every view has `o11y.rum.view.kind` `screen`. The first is
  named `rum.initialViewName` (default `"app"`) until something names it.
  It starts when the app started, as `app_load` does.
  With `screens()` in `rum.collectors`, each screen gets a view span that
  ends at the first frame after `rum.viewRendered()`, or 10 seconds after
  it started. The first screen's span is a child of `app_load`; a later
  screen's is a root linked to the action that caused it. Going to the
  background (AppState `background`, or `inactive` on iOS) emits the
  screen's `o11y.rum.view.summary` and flushes.
- **App start.** One `app_load` span per process, from
  `performance.rnStartupTiming.startTime` (or, without it, when this
  package was loaded) to the first screen's render, at most 60 seconds.
  When consent is granted after the first screen rendered, even after
  other screens, the span is still recorded, with the times remembered
  from before the grant. An app that leaves its first screen before it
  rendered records the 60-second cap.
- **Requests.** `@libo11y/react-native`'s fetch and XHR spans count
  toward the screen's summary and leave breadcrumbs.
  `rum.onRequestStart` hooks run on each of them, which is how
  `connectRequestNaming` names Connect calls.

Revoking consent removes the session, the retention buffer and the
remote configuration cache from the app's storage, also when only an
earlier launch had consent.

The resource carries `o11y.rum.platform` `react_native`, and so do RUM's
own spans, summaries and `o11y.rum.session.start`. App metrics export
with delta temporality, which the RUM gateway requires. Requests from an app carry no `Origin`, so the gateway's
entry for the app sets `allow_missing_origin` and a `client_token`.

Context does not carry across `await` on Hermes, which has no
`AsyncLocalStorage`. A request made after an `await` in a tap handler is
not that tap's child.

## Status

In development. The package is not released and not on npm. Errors, taps
and the Expo Router adapter come in later steps.
