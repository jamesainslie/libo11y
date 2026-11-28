/**
 * The R3d remote configuration fixture: a button, and setupRum with views() and actions() and
 * remoteConfig() fetching from the sink's /v1/config.
 */
import { actions, type RumCollector, remoteConfig, setupRum, views } from "@libo11y/rum";
import { runtimeOf } from "@libo11y/rum/internal";

interface FixtureOptions {
  readonly endpoint: string;
  readonly collectors?: readonly string[];
  readonly remoteConfig?: { readonly refreshMillis?: number };
}

const b = document.createElement("button");
b.setAttribute("data-o11y", "Go");
b.textContent = "Go";
b.addEventListener("click", () => {
  const p = document.createElement("p");
  p.textContent = "went";
  document.body.append(p);
});
document.body.append(b);

const w = globalThis as unknown as Record<string, unknown>;
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const names = new Set(o.collectors ?? []);
  const collectors: RumCollector[] = [
    ...(names.has("views") ? [views()] : []),
    ...(names.has("actions") ? [actions()] : []),
  ];
  const telemetry = await setupRum({
    serviceName: "rum-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: "granted" },
    runtimeMetrics: false,
    transport: { compression: "none" },
    rum: {
      collectors,
      remoteConfig: remoteConfig({ refreshMillis: o.remoteConfig?.refreshMillis ?? 500 }),
    },
  });
  w.__rum = { telemetry, runtime: runtimeOf(telemetry) };
};
