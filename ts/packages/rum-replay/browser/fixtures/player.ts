/**
 * The player fixture: window.__play(events) replays uploaded, scrubbed events with @rrweb/replay to
 * their end and returns the text the replayed page shows for the fixture's elements, which is what
 * a player built on the read API would show.
 */
import { Replayer } from "@rrweb/replay";

interface Played {
  readonly heading: string | null;
  readonly name: string | null;
  readonly masked: string | null;
  readonly email: string | null;
}

(globalThis as unknown as Record<string, unknown>).__play = async (events: unknown[]): Promise<Played> => {
  const root = document.createElement("div");
  document.body.append(root);
  const r = new Replayer(events as ConstructorParameters<typeof Replayer>[0], {
    root,
    mouseTail: false,
    triggerFocus: false,
  });
  r.pause(r.getMetaData().totalTime);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const doc = r.iframe.contentDocument;
  const text = (sel: string): string | null => doc?.querySelector(sel)?.textContent ?? null;
  return {
    heading: text("#heading"),
    name: text("#name"),
    masked: text("#masked"),
    email: doc?.querySelector("#email")?.getAttribute("value") ?? null,
  };
};
