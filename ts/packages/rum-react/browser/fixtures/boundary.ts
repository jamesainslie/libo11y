/**
 * The rum-react fixture: after window.__rumStart, a React 19 root with a RumProvider around a
 * RumErrorBoundary around Broken, a component that throws while rendering once its button is
 * clicked. The errors() collector runs too, so a render error that also reached window.onerror
 * would show up as a second o11y.rum.error.
 */
import { actions, errors, setupRum, views } from "@libo11y/rum";
import { RumErrorBoundary, RumProvider } from "@libo11y/rum-react";
import { createElement, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";

interface FixtureOptions {
  readonly endpoint: string;
}

function Broken(): ReactNode {
  const [broken, setBroken] = useState(false);
  if (broken) throw new Error("render failed");
  return createElement(
    "button",
    { type: "button", "data-o11y": "Break", onClick: () => setBroken(true) },
    "Break",
  );
}

const w = globalThis as unknown as Record<string, unknown>;
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const telemetry = await setupRum({
    serviceName: "rum-react-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: "granted" },
    transport: { compression: "none" },
    rum: { collectors: [views(), actions(), errors()] },
  });
  w.__rum = { telemetry };
  const main = document.createElement("main");
  document.body.append(main);
  createRoot(main).render(
    createElement(
      RumProvider,
      { rum: telemetry.rum },
      createElement(
        RumErrorBoundary,
        { fallback: (e: unknown) => createElement("p", { id: "fallback" }, `Something broke: ${String(e)}`) },
        createElement(Broken),
      ),
    ),
  );
};
