/**
 * setupExpo in real React Native JavaScript under jest-expo: the package exports resolve, the ESM
 * in node_modules loads, the Expo modules (mocked in jest.setup.js) fill the resource, the retry
 * queue writes its files under the documents directory, and going to the background flushes.
 */
import { setupExpo } from "@libo11y/react-native/expo";
import { AppState } from "react-native";

declare global {
  var __fixtureFiles: Map<string, string>;
  var __fixtureRequests: { url: string; body: string }[];
}

type Listener = (state: string) => void;

/** React Native's jest mock of AppState records listeners as mock calls; this calls each one. */
function emitAppState(state: string): void {
  const add = AppState.addEventListener as unknown as jest.Mock<unknown, [string, Listener]>;
  for (const [type, listener] of add.mock.calls) if (type === "change") listener(state);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

const OPTIONS = { serviceName: "fx", environment: "test", endpoint: "https://gw.test/_o11y" } as const;

test("setupExpo builds the expo resource, keeps its queue in files and flushes on background", async () => {
  const t = await setupExpo({
    ...OPTIONS,
    consent: { initial: "granted" },
    instrumentations: { fetch: false, xhr: false },
  });
  try {
    const attrs = t.resource.attributes;
    expect(attrs["o11y.rum.platform"]).toBe("react_native");
    expect(attrs["o11y.rum.app.update_id"]).toBe("11111111-2222-4333-8444-555555555555");
    expect(attrs["o11y.rum.device.class"]).toBe("mobile");
    expect(attrs["service.version"]).toBe("1.0.0");
    expect(attrs["os.name"]).toBe("ios");

    t.tracerProvider.getTracer("fx").startSpan("background-flush").end();
    emitAppState("background");
    const flushed = (): boolean =>
      global.__fixtureRequests.some(
        (r) => r.url === "https://gw.test/_o11y/v1/traces" && r.body.includes("background-flush"),
      );
    await until(flushed);
    expect(flushed()).toBe(true);
    const files = [...global.__fixtureFiles.keys()];
    expect(files.some((u) => u.startsWith("file:///document/libo11y/"))).toBe(true);
  } finally {
    await t.shutdown();
  }
});

test("a second setupExpo without a shutdown rejects with ALREADY_SETUP", async () => {
  const t = await setupExpo(OPTIONS);
  try {
    await expect(setupExpo(OPTIONS)).rejects.toMatchObject({ code: "ALREADY_SETUP" });
  } finally {
    await t.shutdown();
  }
});
