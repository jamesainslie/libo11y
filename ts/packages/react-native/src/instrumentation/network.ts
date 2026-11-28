/**
 * Fetch and XHR client spans on React Native, with the web instrumentation from
 * @libo11y/web/portable under the scope @libo11y/react-native. The global fetch and
 * XMLHttpRequest are patched separately, because Expo replaces fetch with expo/fetch, which uses
 * no XHR, while bare React Native's fetch is whatwg-fetch over XHR. While a traced fetch call runs
 * synchronously (whatwg-fetch opens and sends its XHR inside the call), the XHR patch records
 * nothing, so one request is one span either way. traceFetch wraps a fetch the patch cannot reach,
 * such as expo/fetch imported directly; a traced fetch that calls another traced fetch, such as an
 * app's wrapper over the patched global, records only the outer call.
 */
import {
  type HttpInstrumentationOptions,
  installXhrInstrumentationWith,
  instrumentFetchWith,
} from "@libo11y/web/portable";

/** The instrumentation scope of the React Native HTTP spans and duration histogram. */
export const RN_SCOPE = "@libo11y/react-native";

/** The web HTTP options, plus which globals to patch. */
export interface NetworkInstrumentationOptions extends HttpInstrumentationOptions {
  /** Patch the global fetch. Default true. */
  readonly fetch?: boolean;
  /** Patch globalThis.XMLHttpRequest. Default true. */
  readonly xhr?: boolean;
}

/** The installed instrumentation. */
export interface NetworkInstrumentation {
  /** Restores the globals that still hold the patches; every wrapper then passes calls straight through. */
  uninstall(): void;
  /** fetchImpl with a client span per request; a wrapped fetch is returned as it is. */
  traceFetch<F extends typeof fetch>(fetchImpl: F): F;
}

/**
 * Patches g.fetch (g defaults to globalThis) and globalThis.XMLHttpRequest as opts says, and
 * returns the uninstall and traceFetch.
 */
export function installNetworkInstrumentation(
  opts: NetworkInstrumentationOptions,
  g: { fetch?: typeof fetch } = globalThis,
): NetworkInstrumentation {
  // How many traced fetch calls are running synchronously right now.
  let depth = 0;
  let done = false;
  const xhrInternals = { scope: RN_SCOPE, skip: () => depth > 0 };
  const wrappers = new WeakMap<object, typeof fetch>();
  const wrapped = new WeakSet<object>();
  const traceFetch = <F extends typeof fetch>(f: F): F => {
    if (wrapped.has(f)) return f;
    const known = wrappers.get(f);
    if (known !== undefined) return known as F;
    const traced = instrumentFetchWith(f, opts, { scope: RN_SCOPE });
    const out = ((input: string | URL | Request, init?: RequestInit) => {
      if (done || depth > 0) return f(input, init);
      depth++;
      try {
        return traced(input, init);
      } finally {
        depth--;
      }
    }) as F;
    wrappers.set(f, out);
    wrapped.add(out);
    return out;
  };
  const undo: (() => void)[] = [];
  if (opts.fetch !== false && typeof g.fetch === "function") {
    const previous = g.fetch;
    const patched = traceFetch(previous);
    g.fetch = patched;
    undo.push(() => {
      if (g.fetch === patched) g.fetch = previous;
    });
  }
  if (opts.xhr !== false) undo.push(installXhrInstrumentationWith(opts, xhrInternals));
  return {
    uninstall: () => {
      if (done) return;
      done = true;
      for (const u of undo.reverse()) u();
    },
    traceFetch,
  };
}
