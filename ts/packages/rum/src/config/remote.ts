/**
 * The remote configuration client (decision P15). It fetches the gateway's
 * GET /_o11y/v1/config?service=<service.name> with credentials omitted and cache no-cache, sending
 * If-None-Match with the cached ETag. A 200 whose body parseRemoteConfig accepts is the newest
 * document; a 304 changes nothing; a 404 means the app has no configuration any more; anything
 * else (a failure, a bad body, a request that takes longer than REQUEST_TIMEOUT_MILLIS) keeps what
 * the client has.
 *
 * The newest document and the one before it are cached in localStorage under CONFIG_STORAGE_KEY,
 * so a later page can apply the document of the session it resumes (find). setupRum creates the
 * client only once consent is granted, so nothing is stored before. clear (on revoke) removes the
 * cache, and a response still in flight is then not cached.
 */
import { O11yError } from "@libo11y/core";
import type { RumSettings } from "../contracts/runtime.ts";
import {
  clampConfig,
  parseRemoteConfig,
  type RemoteConfigDocument,
  type RemoteConfigLimits,
  resolveLimits,
} from "./clamp.ts";

export const CONFIG_STORAGE_KEY = "libo11y.rum.config";
/** A config request that has not answered by then counts as failed. */
export const REQUEST_TIMEOUT_MILLIS = 10_000;
/** The default refresh interval while the page is visible. */
export const DEFAULT_REFRESH_MILLIS = 300_000;

/** The timers the client runs on. */
export interface RemoteConfigTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RemoteConfigClient {
  /** The newest document known: from the cache of an earlier page, then from each fetch. */
  current(): RemoteConfigDocument | undefined;
  /**
   * The newest document, or the one before it, whose version is version: the document a session
   * started under. Undefined for undefined (a session that started without one); the newest for a
   * version the client no longer has.
   */
  find(version: string | undefined): RemoteConfigDocument | undefined;
  /** Fetches now. Resolves true when the newest document changed. Never rejects. */
  refresh(): Promise<boolean>;
  /** Refreshes now and every refreshMillis while visible, calling onChange when the newest document changed. */
  start(onChange: (doc: RemoteConfigDocument | undefined) => void): () => void;
  /** Removes the cache, and keeps a response in flight from being cached. */
  clear(): void;
}

export interface RemoteConfigClientOptions {
  /** The full config URL, service and client_token included. */
  readonly url: string;
  readonly refreshMillis: number;
  readonly fetch: typeof fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly timers: RemoteConfigTimers;
  readonly visible: () => boolean;
}

interface Cache {
  readonly etag?: string;
  readonly body?: unknown;
  readonly prior?: unknown;
}

interface State {
  etag: string | undefined;
  doc: RemoteConfigDocument | undefined;
  prior: RemoteConfigDocument | undefined;
}

const wire = (d: RemoteConfigDocument): unknown => {
  const { version, ...config } = d;
  return { version, config };
};

export function createRemoteConfig(o: RemoteConfigClientOptions): RemoteConfigClient {
  let state: State | undefined;
  /** Bumped by clear and stop, so a response that outlives them is not used. */
  let generation = 0;
  /** The request in flight, and the generation it belongs to. */
  let inflight: { readonly gen: number; readonly done: Promise<boolean> } | undefined;

  const load = (): State => {
    if (state !== undefined) return state;
    let cache: Cache = {};
    try {
      const raw = o.storage?.getItem(CONFIG_STORAGE_KEY);
      if (raw != null) cache = JSON.parse(raw) as Cache;
    } catch {
      cache = {};
    }
    const doc = parseRemoteConfig(cache?.body);
    state = {
      etag: doc !== undefined && typeof cache.etag === "string" ? cache.etag : undefined,
      doc,
      prior: parseRemoteConfig(cache?.prior),
    };
    return state;
  };
  const save = (s: State): void => {
    const cache: Cache = {
      ...(s.etag === undefined ? {} : { etag: s.etag }),
      ...(s.doc === undefined ? {} : { body: wire(s.doc) }),
      ...(s.prior === undefined ? {} : { prior: wire(s.prior) }),
    };
    try {
      o.storage?.setItem(CONFIG_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // A full or blocked storage keeps the document in memory for this page only.
    }
  };

  const fetchOnce = async (gen: number): Promise<boolean> => {
    const s = load();
    const headers: Record<string, string> = s.etag === undefined ? {} : { "If-None-Match": s.etag };
    const abort = typeof AbortController === "function" ? new AbortController() : undefined;
    let timer: unknown;
    // The timeout covers the headers and the body, so a stalled body cannot hold the client.
    const answer = async (): Promise<{ status: number; etag: string | null; body?: unknown }> => {
      const res = await o.fetch(o.url, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        headers,
        ...(abort === undefined ? {} : { signal: abort.signal }),
      });
      if (res.status !== 200) return { status: res.status, etag: null };
      return { status: 200, etag: res.headers.get("ETag"), body: await res.json() };
    };
    let got: { status: number; etag: string | null; body?: unknown };
    try {
      got = await Promise.race([
        answer(),
        new Promise<never>((_, reject) => {
          timer = o.timers.setTimeout(() => {
            abort?.abort();
            reject(new Error("timeout"));
          }, REQUEST_TIMEOUT_MILLIS);
        }),
      ]);
    } catch {
      return false;
    } finally {
      o.timers.clearTimeout(timer);
    }
    if (gen !== generation) return false;
    if (got.status === 404) {
      if (s.doc === undefined) return false;
      state = { etag: undefined, doc: undefined, prior: s.doc };
      save(state);
      return true;
    }
    if (got.status !== 200) return false;
    const doc = parseRemoteConfig(got.body);
    if (doc === undefined) return false;
    const etag = got.etag ?? `"${doc.version}"`;
    const changed = doc.version !== s.doc?.version;
    state = changed ? { etag, doc, prior: s.doc ?? s.prior } : { ...s, etag };
    save(state);
    return changed;
  };

  const refresh = (): Promise<boolean> => {
    // A request from before a clear or stop is not reused: its answer is dropped.
    if (inflight?.gen === generation) return inflight.done;
    const mine = {
      gen: generation,
      done: fetchOnce(generation).finally(() => {
        if (inflight === mine) inflight = undefined;
      }),
    };
    inflight = mine;
    return mine.done;
  };

  return {
    current: () => load().doc,
    find(version) {
      if (version === undefined) return undefined;
      const known = (s: State): RemoteConfigDocument | undefined =>
        s.doc?.version === version ? s.doc : s.prior?.version === version ? s.prior : undefined;
      const here = known(load());
      if (here !== undefined) return here;
      // Another tab may have cached the document a session it started runs under.
      state = undefined;
      return known(load()) ?? load().doc;
    },
    refresh,
    start(onChange) {
      const gen = generation;
      let timer: unknown;
      const run = (): void => {
        void refresh().then((changed) => {
          if (changed && gen === generation) onChange(load().doc);
        });
      };
      const tick = (): void => {
        timer = o.timers.setTimeout(() => {
          if (gen !== generation) return;
          if (o.visible()) run();
          tick();
        }, o.refreshMillis);
      };
      run();
      tick();
      return () => {
        if (gen === generation) generation++;
        o.timers.clearTimeout(timer);
      };
    },
    clear() {
      generation++;
      state = { etag: undefined, doc: undefined, prior: undefined };
      try {
        o.storage?.removeItem(CONFIG_STORAGE_KEY);
      } catch {
        // Nothing more can be done.
      }
    },
  };
}

/** Options for remoteConfig. */
export interface RemoteConfigOptions {
  /**
   * The config URL. Default: the export endpoint's /v1/config, such as /_o11y/v1/config next to
   * /_o11y/v1/traces. setupRum adds the service and client_token query parameters.
   */
  readonly url?: string;
  /** How often to look for a new version while the page is visible. Default 300000. */
  readonly refreshMillis?: number;
  /** The range remote configuration may move a value within. Default: no change. */
  readonly limits?: RemoteConfigLimits;
}

/** What setupRum hands remoteConfig once consent is granted. */
export interface RemoteConfigOpenOptions {
  /** The full config URL, service and client_token included. */
  readonly url: string;
  readonly fetch: typeof fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly timers: RemoteConfigTimers;
  readonly visible: () => boolean;
}

/** An open remote configuration: the client, and the clamp to the limits code set. */
export interface RemoteConfigConnection extends RemoteConfigClient {
  /** code with doc applied within the limits. */
  apply<S extends RumSettings>(
    code: S,
    doc: RemoteConfigDocument | undefined,
  ): S & { readonly enabledByRemote: boolean };
}

/** Remote configuration from the RUM gateway, for RumOptions.remoteConfig. */
export interface RemoteConfig {
  /** RemoteConfigOptions.url. */
  readonly url?: string;
  /** Called by setupRum once consent is granted. */
  open(o: RemoteConfigOpenOptions): RemoteConfigConnection;
}

/**
 * Remote configuration from the RUM gateway (GET /_o11y/v1/config). A fetched document applies to
 * the next session, except that enabled false switches RUM off at once and enabled true switches it
 * back on. Remote values never go beyond the limits given here, and never switch on a collector the
 * app did not install. Throws O11yError INVALID_OPTION for invalid limits or refreshMillis.
 */
export function remoteConfig(opts: RemoteConfigOptions = {}): RemoteConfig {
  const refreshMillis = opts.refreshMillis ?? DEFAULT_REFRESH_MILLIS;
  if (!(Number.isFinite(refreshMillis) && refreshMillis > 0)) {
    throw new O11yError("INVALID_OPTION", "rum.remoteConfig.refreshMillis must be a positive number");
  }
  resolveLimits(0, opts.limits);
  return {
    ...(opts.url === undefined ? {} : { url: opts.url }),
    open(o) {
      return {
        ...createRemoteConfig({ ...o, refreshMillis }),
        apply: (code, doc) => clampConfig(code, doc, resolveLimits(code.sessionSampleRate, opts.limits)),
      };
    },
  };
}
