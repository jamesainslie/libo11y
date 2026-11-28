/**
 * The overhead benchmark fixture: a list of 200 items, a router-like soft navigation (pushState
 * and a swap of the 200 nodes) and a button whose handler updates 50 nodes. With ?rum=1 it starts
 * RUM with every collector; without, it runs the same page bare. The page's query names the sink
 * endpoint. window.__benchReady is set once the page (and RUM) is ready; when setup fails,
 * window.__benchError holds the message instead.
 */
import { actions, errors, setupRum, views } from "@libo11y/rum";

const params = new URLSearchParams(location.search);
const list = document.createElement("ul");
const items: HTMLLIElement[] = [];
for (let i = 0; i < 200; i++) {
  const li = document.createElement("li");
  li.textContent = `item ${i}`;
  items.push(li);
}
list.append(...items);
const update = document.createElement("button");
update.id = "update";
update.textContent = "Update";
let clicks = 0;
update.addEventListener("click", () => {
  clicks++;
  for (let i = 0; i < 50; i++) {
    const li = items[i];
    if (li !== undefined) li.textContent = `item ${i} updated ${clicks}`;
  }
});
document.body.append(update, list);

const w = globalThis as unknown as Record<string, unknown>;
/** A soft navigation: a new URL and the list's 200 nodes replaced. */
w.__navigate = (n: number): void => {
  history.pushState(null, "", `/page/rum-bench/item/${n}`);
  const fresh: HTMLLIElement[] = [];
  for (let i = 0; i < 200; i++) {
    const li = document.createElement("li");
    li.textContent = `view ${n} item ${i}`;
    fresh.push(li);
  }
  items.splice(0, items.length, ...fresh);
  list.replaceChildren(...fresh);
};

async function start(): Promise<void> {
  if (params.get("rum") === "1") {
    w.__rum = await setupRum({
      serviceName: "rum-bench",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint: params.get("endpoint") ?? "",
      consent: { initial: "granted" },
      runtimeMetrics: false,
      transport: { compression: "none" },
      rum: { collectors: [views(), actions(), errors()] },
    });
  }
  w.__benchReady = true;
}
start().catch((e: unknown) => {
  w.__benchError = e instanceof Error ? e.message : String(e);
});
