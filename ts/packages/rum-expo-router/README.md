# @libo11y/rum-expo-router

Expo Router adapter for
[`@libo11y/rum-react-native`](../rum-react-native). It names RUM screens
by route template, such as `/(studio)/projects/[projectId]`, never by the
path, which can carry IDs. It also marks each screen rendered, so the
screen's view span ends at the next frame, and the first screen ends the
`app_load` span instead of running to its 60-second cap.

```sh
npm install @libo11y/react-native @libo11y/rum-react-native @libo11y/rum-expo-router
```

It needs `expo-router` 58 or later and React 19 as peer dependencies,
and is tested on Expo SDK 58 only. It contains no native code, so adding
it changes no native build. It uses only Expo Router's stable hooks,
`useSegments` and `usePathname`.

## Usage

Call `useRumExpoRouter` once, in the root layout, with the RUM handle.
The handle is `undefined` until the telemetry is set up, and the hook
does nothing until then:

```ts
import { useRumExpoRouter } from "@libo11y/rum-expo-router";
import type { ReactNativeRumTelemetry } from "@libo11y/rum-react-native";
import { Stack } from "expo-router";
import { createElement, useEffect, useState } from "react";
import { telemetryReady } from "../telemetry";

export default function RootLayout() {
  const [telemetry, setTelemetry] = useState<ReactNativeRumTelemetry>();
  useEffect(() => {
    void telemetryReady.then(setTelemetry);
  }, []);
  useRumExpoRouter(telemetry?.rum);
  return createElement(Stack);
}
```

`RumExpoRouter` is the same hook as a component that renders nothing,
for a layout that prefers an element:
`createElement(RumExpoRouter, { rum: telemetry?.rum })`.

Put `screens()` in `rum.collectors`, so each screen gets a view span.
The app no longer calls `rum.startView`, `rum.setViewName` or
`rum.viewRendered` for its routes.

## What it records

- **The first screen.** The first route names the view RUM started at
  launch, which is the child of `app_load`. Once the route has settled,
  the hook calls `rum.viewRendered()`, which ends the screen's span and
  `app_load` at the next frame.
- **Navigation.** A route with a new pathname starts a screen through
  `rum.startView({ name })` after the route committed, and marks it
  rendered once it has settled. When a tap caused the navigation, the
  tap's action span is the screen's cause. Going back to an earlier
  screen is a navigation too.
- **The same pathname.** A change of search parameters alone, or a
  re-render, starts no screen.
- **Redirects.** A navigation that a `<Redirect>` or a `router.replace`
  in an effect replaces before it settled is one screen, named after the
  route that stayed. A sign-in redirect on launch renames the first
  screen, and `app_load` ends when the sign-in screen rendered.

A route has settled when a zero-delay timer after its commit has run. In
the jest-expo tests a redirect's render commits before that timer. A
redirect that waits longer, such as one after an `await`, is a
navigation of its own.

The screen's view span starts when the route commits, not when the
navigation was requested, so it covers the time from the commit to the
first frame.

Nothing is recorded while consent is not granted, as everywhere in RUM.

## Screen names

`routeTemplate(segments)` turns the segments `useSegments()` returns into
the view name: `/` followed by the segments joined with `/`. It keeps
groups such as `(studio)` and placeholders such as `[projectId]` and
`[...slug]`, and drops a trailing `index`. The root is `/`.

| File                                    | Path          | Screen name                      |
| --------------------------------------- | ------------- | -------------------------------- |
| `app/index.tsx`                         | `/`           | `/`                              |
| `app/(client)/index.tsx`                | `/`           | `/(client)`                      |
| `app/(studio)/projects/[projectId].tsx` | `/projects/7` | `/(studio)/projects/[projectId]` |
| `app/docs/[...slug].tsx`                | `/docs/a/b`   | `/docs/[...slug]`                |
| `app/+not-found.tsx`                    | `/nowhere`    | `/+not-found`                    |

A path no route matches is named `/+not-found` when the app has a
`+not-found` route. Without one, Expo Router shows its built-in screen
outside the root layout, where the hook does not run, so that screen is
not recorded. Add a `+not-found` route to record it.

## Lower-level building blocks

`createRouteTracker(rum, defer?)` is the logic the hook runs, for a
custom integration. Its `report(segments, pathname)` takes the route of
each commit. `defer` postpones `rum.viewRendered()` until the commit has
settled. It defaults to a zero-delay timer.

## Status

In development. The package is not released and not on npm. It first
ships with `@libo11y/rum-react-native` in the next TypeScript release,
after `ts/v0.4.0`.
