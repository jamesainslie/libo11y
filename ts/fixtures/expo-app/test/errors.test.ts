/**
 * errors() in real React Native JavaScript under jest-expo: an error React Native's global handler
 * (ErrorUtils) sees reaches the gateway as source uncaught, with its stack rewritten to the
 * platform's bundle URL, and hands on to the handler installed before; a render error that
 * `@libo11y/rum-react`'s RumErrorBoundary catches is source boundary.
 */
import { RumErrorBoundary, RumProvider } from "@libo11y/rum-react";
import { errors } from "@libo11y/rum-react-native";
import { setupRumExpo } from "@libo11y/rum-react-native/expo";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { createElement, type ReactElement } from "react";
import { AppState, Platform, Text } from "react-native";
import Boom from "../src/app/boom";

declare global {
  var __fixtureRequests: { url: string; body: string }[];
}

type Handler = (error: unknown, isFatal?: boolean) => void;
type Attr = { key: string; value: { stringValue?: string } };

const errorUtils = (
  globalThis as unknown as {
    ErrorUtils: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void };
  }
).ErrorUtils;

function emitAppState(state: string): void {
  const add = AppState.addEventListener as unknown as jest.Mock<unknown, [string, (s: string) => void]>;
  for (const [type, listener] of add.mock.calls) if (type === "change") listener(state);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** The attributes of every o11y.rum.error record sent to the gateway. */
function errorRecords(): Record<string, string | undefined>[] {
  return global.__fixtureRequests
    .filter((r) => r.url.startsWith("https://gw.test/_o11y/v1/logs"))
    .flatMap((r) => {
      const body = JSON.parse(r.body) as {
        resourceLogs: { scopeLogs: { logRecords: { attributes: Attr[] }[] }[] }[];
      };
      return body.resourceLogs.flatMap((rl) =>
        rl.scopeLogs.flatMap((sl) =>
          sl.logRecords.map((lr) =>
            Object.fromEntries(lr.attributes.map((a) => [a.key, a.value.stringValue])),
          ),
        ),
      );
    })
    .filter((a) => a["event.name"] === "o11y.rum.error");
}

function Broken(): ReactElement {
  throw new Error("render boom");
}

test("an uncaught error and a boundary error reach the gateway; the previous handler still runs", async () => {
  global.__fixtureRequests.length = 0;
  const seen: unknown[] = [];
  const original = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((e) => void seen.push(e));
  const t = await setupRumExpo({
    serviceName: "fx",
    environment: "test",
    endpoint: "https://gw.test/_o11y",
    consent: { initial: "granted" },
    instrumentations: { xhr: false },
    rum: { collectors: [errors()] },
  });
  try {
    await render(createElement(Boom));
    await expect(fireEvent.press(screen.getByText("boom"))).rejects.toThrow("fixture boom");
    // Jest runs without Hermes. Give ErrorUtils the stack a native press would produce.
    const hermes = new Error("fixture boom");
    hermes.stack =
      "Error: fixture boom\n    at onPress (address at /data/user/0/fx/files/.expo-internal/7f3a:1:413)";
    errorUtils.getGlobalHandler()(hermes, false);
    expect(seen).toEqual([hermes]);

    const silence = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await render(
        createElement(
          RumProvider,
          { rum: t.rum },
          createElement(
            RumErrorBoundary,
            { fallback: createElement(Text, null, "fallback") },
            createElement(Broken),
          ),
        ),
      );
    } finally {
      silence.mockRestore();
    }
    expect(screen.getByText("fallback")).toBeTruthy();

    emitAppState("background");
    await until(() => errorRecords().length >= 2);
    const [uncaught] = errorRecords().filter((e) => e["o11y.rum.error.source"] === "uncaught");
    const bundle = Platform.OS === "android" ? "app:///index.android.bundle" : "app:///main.jsbundle";
    expect(uncaught?.["exception.message"]).toBe("fixture boom");
    expect(uncaught?.["exception.stacktrace"]).toBe(`Error: fixture boom\n    at onPress (${bundle}:1:414)`);
    const boundary = errorRecords().find((e) => e["o11y.rum.error.source"] === "boundary");
    expect(boundary?.["exception.message"]).toBe("render boom");
  } finally {
    await t.shutdown();
    errorUtils.setGlobalHandler(original);
  }
});
