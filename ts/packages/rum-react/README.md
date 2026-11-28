# @libo11y/rum-react

React adapter for
[`@libo11y/rum`](https://github.com/jamesainslie/libo11y/tree/main/ts/packages/rum).
`RumProvider` puts the `Rum` handle in React context, `useRum` reads it,
and `RumErrorBoundary` records render errors as `o11y.rum.error` events
with source `boundary` and React's component stack.

```sh
npm install @libo11y/rum @libo11y/rum-react
```

It needs React 18.3 or 19 as a peer dependency.

## Status

The package is in development and is not on npm yet. It releases with
`@libo11y/rum` at the same version.

## Usage

```ts
import { errors, setupRum, views } from "@libo11y/rum";
import { RumErrorBoundary, RumProvider } from "@libo11y/rum-react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const telemetry = await setupRum({
  serviceName: "portal",
  environment: "production",
  serviceVersion: "2.1.0",
  endpoint: "/_o11y",
  rum: { collectors: [views(), errors()] },
});

createRoot(document.getElementById("root")!).render(
  createElement(
    RumProvider,
    { rum: telemetry.rum },
    createElement(RumErrorBoundary, { fallback: createElement(ErrorPage) }, createElement(App)),
  ),
);
```

The package ships no JSX, so it works without a JSX transform. In a JSX
app the same tree is
`<RumProvider rum={telemetry.rum}><RumErrorBoundary fallback={<ErrorPage />}><App /></RumErrorBoundary></RumProvider>`.

## The error boundary

`RumErrorBoundary` catches an error thrown while rendering its children,
records it through `rum.addError(error, { source: "boundary",
componentStack })` and renders `fallback` instead. `fallback` is a React
node, or a function that receives the error and returns one. The default
is `null`.

The boundary reports to its `rum` prop when given, else to the nearest
`RumProvider`. Without either it still renders the fallback and records
nothing. Like every error RUM records, a boundary error counts in the
view summary, keeps the session's detail and carries the breadcrumbs.
Nothing is recorded while consent is not granted.

React's own error reporting is unchanged, so one render error can be
recorded twice:

- React 19 logs a caught error with `console.error`. With
  `errors({ console: true })`, RUM records that call as a second error with
  source `console`.
- React 18 in development mode also rethrows a caught error to
  `window.onerror`, which `errors()` records with source `uncaught`. React
  18 production builds and React 19 do not.

The boundary keeps rendering its fallback until it unmounts. To recover on
navigation, give it a `key` that changes with the route.

## useRum

`useRum()` returns the nearest `RumProvider`'s `Rum`, or `undefined`
outside one. Use it to record a custom action from a component:

```ts
const rum = useRum();
const save = () => {
  rum?.addAction("save draft");
  // ...
};
```

An action name is a label, never user data.
