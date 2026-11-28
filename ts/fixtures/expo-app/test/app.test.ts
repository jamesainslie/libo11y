/**
 * The fixture app itself: expo-router renders the home route from src/app, the root layout's
 * import of src/telemetry.ts sets up RUM with the Expo resource, the home screen reaches the React
 * Native handle through rum-react's provider, and the layout's useRumExpoRouter names each screen
 * by route template and marks the first rendered, so app_load ends at the first render.
 */
import { runtimeOf } from "@libo11y/rum-react-native/internal";
import { router } from "expo-router";
import { act, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";
import { telemetryReady } from "../src/telemetry";

declare global {
  var __fixtureRequests: { url: string; body: string }[];
}

type Listener = (state: string) => void;
type Attr = { key: string; value: { stringValue?: string } };
type SentSpan = { name: string; spanId: string; parentSpanId?: string; attributes: Attr[] };

/** React Native's jest mock of AppState records listeners as mock calls; this calls each one. */
function emitAppState(state: string): void {
  const add = AppState.addEventListener as unknown as jest.Mock<unknown, [string, Listener]>;
  for (const [type, listener] of add.mock.calls) if (type === "change") listener(state);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** Every span sent to the gateway. */
function spans(): SentSpan[] {
  return global.__fixtureRequests
    .filter((r) => r.url.includes("/_o11y/v1/traces"))
    .flatMap((r) => {
      const body = JSON.parse(r.body) as { resourceSpans: { scopeSpans: { spans: SentSpan[] }[] }[] };
      return body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
    });
}

/** Runs what renderRouter's fake timers hold (the adapter's settle timer, then the next frame). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
  }
}

test("the app renders home with its telemetry, and its screens are named by route template", async () => {
  const t = await telemetryReady;
  try {
    await renderRouter("./src/app");
    expect(await screen.findByText("home")).toBeTruthy();
    expect(t.resource.attributes["service.name"]).toBe("libo11y-fixture");
    expect(t.resource.attributes["o11y.rum.app.update_id"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(t.consent.state()).toBe("granted");
    // rum-react's useRum reaches the handle inside the layout's RumProvider.
    expect(await screen.findByText("rum ready")).toBeTruthy();
    // The layout's useRumExpoRouter names the first screen after its route.
    await waitFor(() => expect(runtimeOf(t)?.views.current()?.name).toBe("/"));
    await settle();

    await act(async () => router.push("/items/42"));
    expect(await screen.findByText("item 42")).toBeTruthy();
    expect(runtimeOf(t)?.views.current()?.name).toBe("/(shop)/items/[itemId]");
    await settle();

    // The flush on going to the background needs real timers.
    jest.useRealTimers();
    emitAppState("background");
    const named = (name: string): SentSpan | undefined => spans().find((s) => s.name === name);
    await until(() => ["app_load", "view /", "view /(shop)/items/[itemId]"].every((n) => named(n)));
    // app_load ended at the first screen's render, so the background flush carries it.
    const appLoad = named("app_load");
    expect(appLoad).toBeDefined();
    expect(named("view /")?.parentSpanId).toBe(appLoad?.spanId);
    expect(named("view /(shop)/items/[itemId]")).toBeDefined();
    expect(spans().some((s) => s.name.includes("/items/42"))).toBe(false);
  } finally {
    // renderRouter turns on fake timers; the shutdown flush needs real ones.
    jest.useRealTimers();
    await t.shutdown();
  }
});
