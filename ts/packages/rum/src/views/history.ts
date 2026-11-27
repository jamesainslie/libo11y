/**
 * Soft navigation detection without a router adapter: pushState, replaceState and popstate, by
 * path. A change of only the query or the fragment is not a navigation.
 */

export interface HistoryHost {
  readonly history: Pick<History, "pushState" | "replaceState">;
  readonly location: { readonly href: string };
  addEventListener(type: "popstate", l: () => void): void;
  removeEventListener(type: "popstate", l: () => void): void;
}

type HistoryMethod = History["pushState"];

/**
 * Calls onChange with the new URL whenever the path changes. Returns the uninstall, which restores
 * the original methods only when nothing patched over RUM's; otherwise RUM's wrapper stays in the
 * chain and reports nothing.
 */
export function watchHistory(host: HistoryHost, onChange: (url: URL) => void): () => void {
  let installed = true;
  let path = new URL(host.location.href).pathname;
  const check = (): void => {
    if (!installed) return;
    const url = new URL(host.location.href);
    if (url.pathname === path) return;
    path = url.pathname;
    onChange(url);
  };
  const h = host.history as { pushState: HistoryMethod; replaceState: HistoryMethod };
  const wrap = (original: HistoryMethod): HistoryMethod =>
    function (this: unknown, ...args: Parameters<HistoryMethod>) {
      original.apply(this, args);
      check();
    };
  const push = h.pushState;
  const replace = h.replaceState;
  const pushWrapper = wrap(push);
  const replaceWrapper = wrap(replace);
  h.pushState = pushWrapper;
  h.replaceState = replaceWrapper;
  host.addEventListener("popstate", check);
  return () => {
    installed = false;
    if (h.pushState === pushWrapper) h.pushState = push;
    if (h.replaceState === replaceWrapper) h.replaceState = replace;
    host.removeEventListener("popstate", check);
  };
}
