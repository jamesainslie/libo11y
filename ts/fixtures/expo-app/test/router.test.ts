/**
 * `@libo11y/rum-expo-router` under expo-router's own test renderer: screens are named by route
 * template as the router navigates, a redirect before a route settled is one screen, the first
 * screen is marked rendered, and an unmatched path is the +not-found route.
 */

import { RumExpoRouter, useRumExpoRouter } from "@libo11y/rum-expo-router";
import type { Rum } from "@libo11y/rum-react-native";
import { Redirect, router, Slot, Stack } from "expo-router";
import { act, renderRouter } from "expo-router/testing-library";
import { createElement, Fragment, type ReactElement, useState } from "react";

type Call = readonly [string, string?];

/** A Rum that records the calls the adapter makes. */
function recordingRum(): { rum: Rum; calls: Call[] } {
  const calls: Call[] = [];
  const rum = {
    startView: (o?: { readonly name?: string }) => {
      calls.push(o?.name === undefined ? ["startView"] : ["startView", o.name]);
    },
    setViewName: (name: string) => {
      calls.push(["setViewName", name]);
    },
    viewRendered: () => {
      calls.push(["viewRendered"]);
    },
  } as unknown as Rum;
  return { rum, calls };
}

/** The handle the layouts pass to the adapter; each test sets it. */
let current: Rum | undefined;

/** A root layout with the hook, around a Stack. */
function Layout(): ReactElement {
  useRumExpoRouter(current);
  return createElement(Stack);
}

/** Hands LateLayout its handle, after it rendered without one. */
let provide: (r: Rum) => void = () => {};

/** A root layout whose handle arrives after the first render, as setup's promise resolves. */
function LateLayout(): ReactElement {
  const [handle, setHandle] = useState<Rum | undefined>(undefined);
  provide = setHandle;
  return createElement(Fragment, null, createElement(RumExpoRouter, { rum: handle }), createElement(Slot));
}

/** Runs the zero-delay timers renderRouter's fake timers hold, inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
}

async function navigate(fn: () => void): Promise<void> {
  await act(async () => fn());
  await settle();
}

const empty = (): null => null;

afterEach(() => {
  jest.useRealTimers();
});

test("screens are named by route template as the router navigates, the first one included", async () => {
  const { rum, calls } = recordingRum();
  current = rum;
  await renderRouter(
    {
      _layout: Layout,
      index: empty,
      "(shop)/_layout": () => createElement(Stack),
      "(shop)/items/[itemId]": empty,
      "docs/[...slug]": empty,
    },
    { initialUrl: "/" },
  );
  await settle();
  await navigate(() => router.push("/items/42"));
  await navigate(() => router.setParams({ tab: "reviews" }));
  await navigate(() => router.push("/items/43"));
  await navigate(() => router.push("/docs/guides/setup"));
  await navigate(() => router.back());
  expect(calls).toEqual([
    ["setViewName", "/"],
    ["viewRendered"],
    ["startView", "/(shop)/items/[itemId]"],
    ["viewRendered"],
    ["startView", "/(shop)/items/[itemId]"],
    ["viewRendered"],
    ["startView", "/docs/[...slug]"],
    ["viewRendered"],
    ["startView", "/(shop)/items/[itemId]"],
    ["viewRendered"],
  ]);
});

test("a redirect of the first screen renames it, and it is rendered once", async () => {
  const { rum, calls } = recordingRum();
  current = rum;
  await renderRouter(
    {
      _layout: Layout,
      index: () => createElement(Redirect, { href: "/sign-in" }),
      "(auth)/sign-in": empty,
    },
    { initialUrl: "/" },
  );
  await settle();
  expect(calls).toEqual([["setViewName", "/"], ["setViewName", "/(auth)/sign-in"], ["viewRendered"]]);
});

test("a navigation a redirect replaces before it settled is one screen", async () => {
  const { rum, calls } = recordingRum();
  current = rum;
  await renderRouter(
    {
      _layout: Layout,
      index: empty,
      "(app)/settings": () => createElement(Redirect, { href: "/sign-in" }),
      "(auth)/sign-in": empty,
    },
    { initialUrl: "/" },
  );
  await settle();
  await navigate(() => router.push("/settings"));
  expect(calls).toEqual([
    ["setViewName", "/"],
    ["viewRendered"],
    ["startView", "/(app)/settings"],
    ["setViewName", "/(auth)/sign-in"],
    ["viewRendered"],
  ]);
});

test("an unmatched path is the +not-found route, as the router reports it", async () => {
  const { rum, calls } = recordingRum();
  current = rum;
  await renderRouter(
    { _layout: Layout, index: empty, "+not-found": empty, "items/[itemId]": empty },
    { initialUrl: "/nowhere/7" },
  );
  await settle();
  await navigate(() => router.push("/items/7"));
  await navigate(() => router.push("/also/nowhere"));
  expect(calls).toEqual([
    ["setViewName", "/+not-found"],
    ["viewRendered"],
    ["startView", "/items/[itemId]"],
    ["viewRendered"],
    ["startView", "/+not-found"],
    ["viewRendered"],
  ]);
});

test("nothing is reported until the handle arrives, then the current route names the view", async () => {
  const { rum, calls } = recordingRum();
  await renderRouter(
    { _layout: LateLayout, index: empty, "items/[itemId]": empty },
    { initialUrl: "/items/9" },
  );
  await navigate(() => router.push("/"));
  expect(calls).toEqual([]);
  await act(async () => provide(rum));
  await settle();
  expect(calls).toEqual([["setViewName", "/"], ["viewRendered"]]);
});
