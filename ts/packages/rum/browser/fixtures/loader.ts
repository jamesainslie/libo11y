/**
 * The R3d two-part loader fixture. The page's query names the consent and the sink endpoint. It
 * installs the bootstrap, delays the load event with a slow image, throws an error before RUM
 * loads, and loads RUM with errors() and actions() after the load event.
 */
import { afterLoad, installRumBootstrap } from "@libo11y/rum/bootstrap";

const params = new URLSearchParams(location.search);
const consent = params.get("consent") === "granted" ? "granted" : "pending";
const endpoint = params.get("endpoint") ?? "";
installRumBootstrap({ consent });

const b = document.createElement("button");
b.setAttribute("data-o11y", "Early");
b.textContent = "Early";
document.body.append(b);
const img = document.createElement("img");
img.src = "/echo?delay=1500";
document.body.append(img);
setTimeout(() => {
  throw new Error("early boom");
}, 0);

const w = globalThis as unknown as Record<string, unknown>;
afterLoad(() => {
  void import("@libo11y/rum").then(async ({ actions, errors, setupRum }) => {
    const telemetry = await setupRum({
      serviceName: "rum-fixture",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint,
      consent: { initial: consent },
      runtimeMetrics: false,
      transport: { compression: "none" },
      rum: { collectors: [errors(), actions()] },
    });
    w.__rum = { telemetry };
  });
});
