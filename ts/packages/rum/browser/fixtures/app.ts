/**
 * The R3b fixture: a tiny app built with DOM calls, and setupRum with the collectors named in
 * window.__rumStart's options ("views", "actions", "errors", and "console" for errors({ console:
 * true })).
 */
import { actions, errors, type RumCollector, setupRum, views } from "@libo11y/rum";
import { runtimeOf } from "@libo11y/rum/internal";

interface FixtureOptions {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted";
  readonly sessionSampleRate?: number;
  readonly collectors?: readonly string[];
  readonly queryAllowList?: readonly string[];
}

function button(attrs: Record<string, string>, onClick?: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  b.textContent = attrs["data-o11y"] ?? attrs.id ?? "button";
  if (onClick !== undefined) b.addEventListener("click", onClick);
  return b;
}

function render(): void {
  const main = document.createElement("main");
  const out = document.createElement("section");
  out.id = "out";
  main.append(
    button({ "data-o11y": "Load" }, () => {
      void fetch("/echo?delay=200").then(() => {
        const p = document.createElement("p");
        p.textContent = "loaded";
        out.append(p);
      });
    }),
    button({ "data-o11y": "Open doc" }, () => {
      history.pushState(null, "", `${location.pathname}/docs/42`);
      setTimeout(() => {
        out.replaceChildren(Object.assign(document.createElement("h1"), { textContent: "Doc" }));
      }, 50);
    }),
    button({ id: "nothing" }),
    button({ "data-o11y": "Throw" }, () => {
      throw new Error("boom");
    }),
    button({ "data-o11y": "Reject" }, () => {
      void Promise.reject(new Error("nope"));
    }),
    button({ "data-o11y": "Bad image" }, () => {
      const img = document.createElement("img");
      img.src = `http://localhost:${location.port}/x.png?token=secret`;
      out.append(img);
    }),
    button({ "data-o11y": "Broken" }, () => {
      const img = document.createElement("img");
      img.src = "/missing.png?v=1";
      out.append(img);
    }),
    button({ "data-o11y": "Fetch page" }, () => {
      void fetch("/echo?page=2&token=x");
    }),
    out,
  );
  document.body.append(main);
}
render();

const w = globalThis as unknown as Record<string, unknown>;
w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const names = new Set(o.collectors ?? []);
  const collectors: RumCollector[] = [
    ...(names.has("views") ? [views()] : []),
    ...(names.has("actions") ? [actions()] : []),
    ...(names.has("errors") ? [errors({ console: names.has("console") })] : []),
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
      ...(o.queryAllowList === undefined ? {} : { queryAllowList: o.queryAllowList }),
    },
  });
  w.__rum = { telemetry, runtime: runtimeOf(telemetry) };
};
