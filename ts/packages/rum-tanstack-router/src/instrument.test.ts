import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rum } from "@libo11y/rum";
import {
  instrumentTanStackRouter,
  type RouteMatchLike,
  type RouterNavigationEvent,
  routeTemplate,
  type TanStackRouterLike,
} from "./instrument.ts";

type EventName = "onBeforeNavigate" | "onResolved" | "onRendered";

interface FakeRouter extends TanStackRouterLike {
  matches: RouteMatchLike[];
  status: "pending" | "idle";
  resolved: boolean;
  emit(event: EventName, e?: Partial<RouterNavigationEvent>): void;
  listeners(): number;
}

function fakeRouter(): FakeRouter {
  const subs = new Map<string, Set<(e: RouterNavigationEvent) => void>>();
  const r: FakeRouter = {
    matches: [],
    status: "pending",
    resolved: false,
    get state() {
      return {
        status: r.status,
        matches: r.matches,
        ...(r.resolved ? { resolvedLocation: { pathname: "/" } } : {}),
      };
    },
    subscribe(event, fn) {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event)?.add(fn);
      return () => {
        subs.get(event)?.delete(fn);
      };
    },
    emit(event, e = {}) {
      for (const fn of subs.get(event) ?? []) fn({ pathChanged: true, ...e });
    },
    listeners: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
  };
  return r;
}

const FROM = { fromLocation: { pathname: "/before" } };

function recordingRum(): Rum & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sessionId: () => "s",
    identify: () => {},
    onRequestStart: () => () => {},
    startView: (o) => void calls.push(o?.name === undefined ? "start" : `start ${o.name}`),
    setViewName: (n) => void calls.push(`name ${n}`),
    viewRendered: () => void calls.push("rendered"),
    addAction: () => {},
    addError: () => {},
  };
}

test("the initial load names and completes the initial view without starting one", () => {
  const router = fakeRouter();
  const rum = recordingRum();
  instrumentTanStackRouter(router, rum);
  router.emit("onBeforeNavigate");
  router.matches = [{ routeId: "__root__" }, { routeId: "/documents/$docId", fullPath: "/documents/$docId" }];
  router.emit("onResolved");
  router.emit("onRendered");
  assert.deepEqual(rum.calls, ["name /documents/$docId", "rendered"]);
});

test("a path change starts, names and completes a soft view; a search change does not", () => {
  const router = fakeRouter();
  const rum = recordingRum();
  instrumentTanStackRouter(router, rum);
  router.emit("onBeforeNavigate");
  router.emit("onResolved");
  router.emit("onRendered");
  rum.calls.length = 0;
  router.emit("onBeforeNavigate", { ...FROM, pathChanged: false });
  router.emit("onResolved", { ...FROM, pathChanged: false });
  router.emit("onRendered", { ...FROM, pathChanged: false });
  router.matches = [{ routeId: "/_auth/settings/" }];
  router.emit("onBeforeNavigate", FROM);
  router.emit("onResolved", FROM);
  router.emit("onRendered", FROM);
  assert.deepEqual(rum.calls, ["start", "name /settings", "rendered"]);
});

test("a navigation superseded before it resolved leaves one soft view per navigation", () => {
  const router = fakeRouter();
  const rum = recordingRum();
  instrumentTanStackRouter(router, rum);
  router.emit("onBeforeNavigate");
  router.emit("onResolved");
  router.emit("onRendered");
  rum.calls.length = 0;
  router.emit("onBeforeNavigate", FROM);
  router.matches = [{ routeId: "/b", fullPath: "/b" }];
  router.emit("onBeforeNavigate", FROM);
  router.emit("onResolved", FROM);
  router.emit("onRendered", FROM);
  assert.deepEqual(rum.calls, ["start", "start", "name /b", "rendered"]);
});

test("onRendered without a path change completes a view still waiting to render", () => {
  // react-router's Transitioner emits onRendered with fromLocation equal to toLocation when the
  // router loaded before RouterProvider mounted.
  const router = fakeRouter();
  const rum = recordingRum();
  instrumentTanStackRouter(router, rum);
  router.matches = [{ routeId: "/", fullPath: "/" }];
  router.emit("onBeforeNavigate");
  router.emit("onResolved");
  router.emit("onRendered", { pathChanged: false, fromLocation: { pathname: "/" } });
  router.emit("onRendered", { pathChanged: false, fromLocation: { pathname: "/" } });
  assert.deepEqual(rum.calls, ["name /", "rendered"]);
});

test("a router that resolved before instrumentation names and completes the current view at once", () => {
  const router = fakeRouter();
  router.matches = [{ routeId: "/documents/$docId", fullPath: "/documents/$docId" }];
  router.status = "idle";
  router.resolved = true;
  const rum = recordingRum();
  instrumentTanStackRouter(router, rum);
  assert.deepEqual(rum.calls, ["name /documents/$docId", "rendered"]);
});

test("the returned function unsubscribes every listener", () => {
  const router = fakeRouter();
  const off = instrumentTanStackRouter(router, recordingRum());
  assert.equal(router.listeners(), 3);
  off();
  assert.equal(router.listeners(), 0);
});

test("routeTemplate prefers fullPath and strips pathless layouts, groups and trailing slashes", () => {
  assert.equal(routeTemplate([{ routeId: "/_auth/_layout/documents/$docId/" }]), "/documents/$docId");
  assert.equal(routeTemplate([{ routeId: "/(app)/settings" }]), "/settings");
  assert.equal(routeTemplate([{ routeId: "/_auth/settings/", fullPath: "/settings/" }]), "/settings");
  assert.equal(routeTemplate([{ routeId: "/files/$", fullPath: "/files/$" }]), "/files/$");
  assert.equal(routeTemplate([{ routeId: "__root__" }]), "/");
  assert.equal(routeTemplate([{ routeId: "__root__", fullPath: "/" }]), "/");
  assert.equal(routeTemplate([{ routeId: "/_auth", fullPath: "" }]), "/");
  assert.equal(routeTemplate([]), undefined);
});

test("against the real router-core, navigations call the same sequence", async () => {
  // router-core picks its server build under Node and Bun unless NODE_ENV is test, and only the
  // client build emits onResolved and onRendered.
  process.env.NODE_ENV = "test";
  // The client build resets the window scroll after each navigation; Node has no window.
  (globalThis as { scrollTo?: unknown }).scrollTo ??= () => {};
  const {
    BaseRootRoute,
    BaseRoute,
    RouterCore,
    createNonReactiveMutableStore,
    createNonReactiveReadonlyStore,
  } = await import("@tanstack/router-core");
  const { createMemoryHistory } = await import("@tanstack/history");
  const root = new BaseRootRoute();
  const index = new BaseRoute({ getParentRoute: () => root, path: "/" });
  const doc = new BaseRoute({ getParentRoute: () => root, path: "/documents/$docId" });
  const router = new RouterCore(
    {
      routeTree: root.addChildren([index, doc]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      isServer: false,
      origin: "http://app.test",
    },
    // The store factory a framework adapter passes; this one is the non-reactive core pair.
    () => ({
      createMutableStore: createNonReactiveMutableStore,
      createReadonlyStore: createNonReactiveReadonlyStore,
      batch: (fn) => fn(),
    }),
  );
  // A framework adapter's startTransition reports that it rendered; the core's default does not.
  router.startTransition = async (fn) => {
    fn();
    return true;
  };
  const rum = recordingRum();
  const off = instrumentTanStackRouter(router, rum);
  await router.load();
  await router.navigate({ to: "/documents/$docId", params: { docId: "42" } });
  await router.navigate({ to: "/documents/$docId", params: { docId: "42" }, search: { page: 2 } });
  off();
  assert.deepEqual(rum.calls, ["name /", "rendered", "start", "name /documents/$docId", "rendered"]);
});
