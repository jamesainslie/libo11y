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
 * pagehide from win, at most once per hide. flush runs while the page is hidden, so the
 * transport sends in "unload" mode. Returns a function that removes the listeners.
 *
 * A hide ends when the document is visible again or win fires pageshow (a page restored from the
 * back-forward cache). A flush that throws or rejects is reported through diag.
 */
export function installFlushOnHide(
  target: VisibilitySource,
  win: EventTarget | undefined,
  flush: () => Promise<unknown>,
): () => void {
  let flushed = false;
  const run = (): void => {
    if (flushed) return;
    flushed = true;
    try {
      flush().catch(report);
    } catch (err) {
      report(err);
    }
  };
  const onVisibility = (): void => {
    if (target.visibilityState === "hidden") run();
    else flushed = false;
  };
  const onShow = (): void => {
    flushed = false;
  };
  target.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", run);
  win?.addEventListener("pageshow", onShow);
  return () => {
    target.removeEventListener("visibilitychange", onVisibility);
    win?.removeEventListener("pagehide", run);
    win?.removeEventListener("pageshow", onShow);
  };
}

function report(err: unknown): void {
  diag.warn("o11y: flush on hide failed", err);
}
