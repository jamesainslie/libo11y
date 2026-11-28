/**
 * The rum-tanstack-router fixture: after window.__rumStart, a @tanstack/react-router app under
 * the page's own path with two routes, / and /documents/$docId. The document route's loader takes
 * LOADER_MILLIS, and its component records window.__renderedAt (epoch milliseconds) once React
 * committed it. RUM runs views({ history: false }) with the router adapter.
 */
import { actions, errors, setupRum, views } from "@libo11y/rum";
import { instrumentTanStackRouter } from "@libo11y/rum-tanstack-router";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement, type ReactNode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

interface FixtureOptions {
  readonly endpoint: string;
}

const LOADER_MILLIS = 150;
const w = globalThis as unknown as Record<string, unknown>;

function DocPage(): ReactNode {
  const { docId } = docRoute.useParams();
  useLayoutEffect(() => {
    w.__renderedAt = Date.now();
  }, []);
  return createElement("h1", null, `Doc ${docId}`);
}

const rootRoute = createRootRoute({ component: () => createElement("main", null, createElement(Outlet)) });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () =>
    // Link's props type has no data attributes; it passes them through to the anchor.
    createElement(Link, { to: "/documents/42", ...({ "data-o11y": "Open doc" } as object) }, "Open doc"),
});
const docRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/documents/$docId",
  loader: () => new Promise<void>((resolve) => setTimeout(resolve, LOADER_MILLIS)),
  component: DocPage,
});

w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const telemetry = await setupRum({
    serviceName: "rum-router-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: "granted" },
    transport: { compression: "none" },
    rum: { collectors: [views({ history: false }), actions(), errors()] },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, docRoute]),
    basepath: location.pathname,
  });
  instrumentTanStackRouter(router, telemetry.rum);
  w.__rum = { telemetry };
  const root = document.createElement("div");
  document.body.append(root);
  createRoot(root).render(createElement(RouterProvider, { router }));
};
