/**
 * setupRumExpo in real React Native JavaScript under jest-expo: RUM's summaries, the app_load and
 * screen spans reach the gateway (the mocked fetch) when the app goes to the background, the
 * session is kept in the documents directory, and `@libo11y/rum-connect` names a Connect call
 * through the React Native handle.
 */
import { connectRequestNaming } from "@libo11y/rum-connect";
import { screens } from "@libo11y/rum-react-native";
import { setupRumExpo } from "@libo11y/rum-react-native/expo";
import { AppState } from "react-native";

declare global {
  var __fixtureFiles: Map<string, string>;
  var __fixtureRequests: { url: string; body: string }[];
}

type Listener = (state: string) => void;
type Attr = { key: string; value: { stringValue?: string } };

/** React Native's jest mock of AppState records listeners as mock calls; this calls each one. */
function emitAppState(state: string): void {
  const add = AppState.addEventListener as unknown as jest.Mock<unknown, [string, Listener]>;
  for (const [type, listener] of add.mock.calls) if (type === "change") listener(state);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

const strings = (attrs: readonly Attr[]): Record<string, string | undefined> =>
  Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));

/** The attributes of every log record sent to the gateway. */
function logs(): Record<string, string | undefined>[] {
  return global.__fixtureRequests
    .filter((r) => r.url.startsWith("https://gw.test/_o11y/v1/logs"))
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceLogs: { scopeLogs: { logRecords: { attributes: Attr[] }[] }[] }[];
      };
      return body.resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => strings(lr.attributes))),
      );
    });
}

/** Every span sent to the gateway: its name, IDs and string attributes. */
function spans(): {
  name: string;
  spanId: string;
  parentSpanId?: string;
  attrs: Record<string, string | undefined>;
}[] {
  return global.__fixtureRequests
    .filter((r) => r.url.startsWith("https://gw.test/_o11y/v1/traces"))
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceSpans: {
          scopeSpans: {
            spans: { name: string; spanId: string; parentSpanId?: string; attributes: Attr[] }[];
          }[];
        }[];
      };
      return body.resourceSpans.flatMap((rs) =>
        rs.scopeSpans.flatMap((ss) =>
          ss.spans.map((s) => ({
            name: s.name,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            attrs: strings(s.attributes),
          })),
        ),
      );
    });
}

test("setupRumExpo sends summaries, app_load and screens, and rum-connect names a call", async () => {
  const t = await setupRumExpo({
    serviceName: "fx",
    environment: "test",
    endpoint: "https://gw.test/_o11y",
    consent: { initial: "granted" },
    instrumentations: { propagateTo: ["https://api.fixture.test"], xhr: false },
    rum: { clientToken: "pub-fixture", collectors: [screens()] },
  });
  try {
    expect(t.resource.attributes["o11y.rum.platform"]).toBe("react_native");
    expect(t.resource.attributes["telemetry.sdk.language"]).toBe("javascript");
    const session = t.rum.sessionId();
    expect(session).toMatch(/^[0-9a-f-]{36}$/);

    t.rum.setViewName("/");
    t.rum.viewRendered();
    const off = connectRequestNaming(t.rum);
    await fetch("https://api.fixture.test/fixture.v1.ShopService/ListItems", { method: "POST" });
    off();
    // The screen span ends at the first frame after the render.
    await new Promise((r) => setTimeout(r, 50));

    emitAppState("background");
    const summary = (): Record<string, string | undefined> | undefined =>
      logs().find((l) => l["event.name"] === "o11y.rum.view.summary");
    await until(() => summary() !== undefined && spans().some((s) => s.name === "app_load"));
    expect(summary()).toMatchObject({
      "o11y.rum.platform": "react_native",
      "o11y.rum.view.kind": "screen",
      "o11y.rum.view.name": "/",
      "session.id": session,
    });
    expect(global.__fixtureRequests.some((r) => /\?sent_at=\d+&client_token=pub-fixture$/.test(r.url))).toBe(
      true,
    );

    const appLoad = spans().find((s) => s.name === "app_load");
    expect(appLoad?.attrs["o11y.rum.span.shape"]).toBe("app_load");
    const view = spans().find((s) => s.name === "view /");
    expect(view?.parentSpanId).toBe(appLoad?.spanId);
    expect(view?.attrs["o11y.rum.view.kind"]).toBe("screen");
    const call = spans().find((s) => s.name === "fixture.v1.ShopService/ListItems");
    expect(call?.attrs["session.id"]).toBe(session);

    const files = [...global.__fixtureFiles.keys()];
    expect(files.some((u) => u.startsWith("file:///document/libo11y/"))).toBe(true);
  } finally {
    await t.shutdown();
  }
});
