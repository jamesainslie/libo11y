# @libo11y/rum-tanstack-router

TanStack Router adapter for
[`@libo11y/rum`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/rum).
It names RUM views by route template, such as `/documents/$docId`, never by
the URL, and times each soft navigation from its start until the first
paint after the new route rendered.

```sh
npm install @libo11y/rum @libo11y/rum-tanstack-router
```

It reads only router-core's lifecycle events and route matches, so it
works with a router from `@tanstack/react-router` or any other TanStack
Router framework adapter at 1.120 or later. It has no runtime dependency
on TanStack Router.

## Status

The package is in development and is not on npm yet. It releases with
`@libo11y/rum` at the same version.

## Usage

Install `views({ history: false })`, so the History API does not start
views as well, and instrument the router right after creating it, before
it renders:

```ts
import { actions, errors, setupRum, views } from "@libo11y/rum";
import { instrumentTanStackRouter } from "@libo11y/rum-tanstack-router";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

const telemetry = await setupRum({
  serviceName: "portal",
  environment: "production",
  serviceVersion: "2.1.0",
  endpoint: "/_o11y",
  rum: { collectors: [views({ history: false }), actions(), errors()] },
});

const router = createRouter({ routeTree });
instrumentTanStackRouter(router, telemetry.rum);
```

`instrumentTanStackRouter` returns a function that removes its listeners.

## What it records

- The initial load starts no new view. Once the router resolved, the
  initial view RUM started at page load is named after the matched route,
  and its view span ends at the first paint after the route rendered.
- A navigation that changes the path starts a soft view on
  `onBeforeNavigate`, through `rum.startView()`. When the navigation came
  from a click, the click's action span is the view's cause. `onResolved`
  names the view, and `onRendered` marks it rendered, so its view span
  ends at the next paint.
- A navigation that changes only the search or the hash starts no view.
- A navigation that a newer one replaces before it resolved still counts
  as a view. The newer navigation's view starts next.

## View names

`routeTemplate(matches)` names a view after the deepest route match: its
`fullPath`, such as `/documents/$docId`, with the trailing slash of an
index route removed. A match without a `fullPath` falls back to its
`routeId`, without pathless layout segments (`/_auth`), route groups
(`/(app)`) and the trailing underscore of a non-nested segment. The root
alone is `/`. The router's `basepath` is not part of the name.
