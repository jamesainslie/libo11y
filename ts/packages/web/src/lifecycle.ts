/**
 * WP3 (web platform and setup). Flushing when the page is hidden.
 */
import { diag } from "@opentelemetry/api";

/** The document events the flush listens to. */
export interface VisibilitySource extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

/**
 * Calls flush whenever target's visibilityState becomes "hidden" (visibilitychange) and on
 * pagehide from win, at most once per hide while that flush runs. flush runs while the page is
 * hidden, so the transport sends in "unload" mode. Returns a function that removes the listeners.
 *
 * A hide ends when the document is visible again, when win fires pageshow (a page restored from
 * the back-forward cache), or when its flush settles, so a tab closed while it was hidden in the
 * background (pagehide with no visibilitychange) still flushes what it recorded since. A flush that
 * throws or rejects is reported through diag.
 */
export function installFlushOnHide(
  target: VisibilitySource,
  win: EventTarget | undefined,
  flush: () => Promise<unknown>,
): () => void {
  let flushed = false;
  let generation = 0;
  const rearm = (): void => {
    flushed = false;
    generation++;
  };
  const run = (): void => {
    if (flushed) return;
    flushed = true;
    const mine = ++generation;
    const settled = (): void => {
      if (generation === mine) flushed = false;
    };
    try {
      flush().catch(report).finally(settled);
    } catch (err) {
      report(err);
      settled();
    }
  };
  const onVisibility = (): void => {
    if (target.visibilityState === "hidden") run();
    else rearm();
  };
  target.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", run);
  win?.addEventListener("pageshow", rearm);
  return () => {
    target.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", run);
    win?.removeEventListener("pageshow", rearm);
  };
}

function report(err: unknown): void {
  diag.warn("o11y: flush on hide failed", err);
}
