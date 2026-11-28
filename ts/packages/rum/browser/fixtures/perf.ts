/**
 * The R3c fixture: a page with a large heading, a script, a stylesheet and an image from /asset,
 * a button that blocks the main thread for 250 ms on click, and setupRum with the collectors named
 * in window.__rumStart's options ("vitals", "resources", "long_animation_frames", "actions",
 * "views"). window.__loadAssets(serverTiming?) appends the assets.
 */
import {
  actions,
  longAnimationFrames,
  type RumCollector,
  resources,
  setupRum,
  views,
  vitals,
} from "@libo11y/rum";
import { runtimeOf } from "@libo11y/rum/internal";

interface FixtureOptions {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted";
  readonly sessionSampleRate?: number;
  readonly collectors?: readonly string[];
}

function render(): void {
  const main = document.createElement("main");
  const h1 = document.createElement("h1");
  h1.id = "hero";
  h1.style.fontSize = "64px";
  h1.textContent = "The largest paint on this page";
  const slow = document.createElement("button");
  slow.setAttribute("data-o11y", "Slow");
  slow.textContent = "Slow";
  slow.addEventListener("click", () => {
    const until = performance.now() + 250;
    while (performance.now() < until) {
      // Busy: the handler holds the main thread, so the interaction's processing is long.
    }
    slow.textContent = "Done";
  });
  main.append(h1, slow);
  document.body.append(main);
}
render();

const w = globalThis as unknown as Record<string, unknown>;
w.__loadAssets = (serverTiming?: string): void => {
  const st = serverTiming === undefined ? "" : `&serverTiming=${encodeURIComponent(serverTiming)}`;
  const script = document.createElement("script");
  script.src = "/asset/app.js?type=js&delay=20";
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/asset/app.css?type=css&delay=20";
  const img = document.createElement("img");
  img.src = `/asset/hero.png?type=png&delay=20${st}`;
  document.head.append(script, css);
  document.body.append(img);
};
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const names = new Set(o.collectors ?? []);
  const collectors: RumCollector[] = [
    ...(names.has("views") ? [views()] : []),
    ...(names.has("actions") ? [actions()] : []),
    ...(names.has("vitals") ? [vitals()] : []),
    ...(names.has("resources") ? [resources()] : []),
    ...(names.has("long_animation_frames") ? [longAnimationFrames()] : []),
  ];
  const telemetry = await setupRum({
    serviceName: "rum-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: o.consent ?? "granted" },
    transport: { compression: "none" },
    rum: {
      collectors,
      ...(o.sessionSampleRate === undefined ? {} : { sessionSampleRate: o.sessionSampleRate }),
    },
  });
  w.__rum = { telemetry, runtime: runtimeOf(telemetry) };
};
