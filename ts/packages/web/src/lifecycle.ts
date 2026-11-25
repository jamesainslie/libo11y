/**
 * WP3 (web platform and setup). Flushing when the page is hidden.
 */

/** The document events the flush listens to. */
export interface VisibilitySource extends EventTarget {
  readonly visibilityState: DocumentVisibilityState;
}

/**
 * Calls flush whenever target's visibilityState becomes "hidden" (visibilitychange) and on
 * pagehide from win, at most once per hide. flush runs while the page is hidden, so the
 * transport sends in "unload" mode. Returns a function that removes the listeners.
 */
export function installFlushOnHide(
  target: VisibilitySource,
  win: EventTarget | undefined,
  flush: () => Promise<unknown>,
): () => void {
  void target;
  void win;
  void flush;
  throw new Error("not implemented");
}
