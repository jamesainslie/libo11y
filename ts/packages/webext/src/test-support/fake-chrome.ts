/**
 * WP5. A fake extension for tests: one shared message bus and storage area, and a ChromeLike per
 * context (the worker, an extension page, a content script in a tab). It behaves as Chrome does
 * where libo11y depends on it: messages and replies are JSON-serialized, delivered asynchronously
 * to every other context's listeners (never the sender's own), the first sendResponse wins, a
 * message nobody answers rejects, tabs.sendMessage reaches only that tab, and storage.local.set
 * and remove report onChanged to every context. storage.session is shared the same way, but a
 * content script can use it, and hears its changes, only after setAccessLevel opened it to
 * untrusted contexts, as in Chrome. Tests only; never built.
 */
import type {
  ChromeLike,
  ExtensionEvent,
  MessageSenderLike,
  RuntimeMessageListener,
  StorageChangeLike,
} from "../chrome.ts";

type StorageListener = (changes: Record<string, StorageChangeLike>, areaName: string) => void;

/** What a context is. */
export interface FakeContextOptions {
  /** The content script's tab. Absent for the worker and extension pages. */
  readonly tabId?: number;
  /** The sender URL other contexts see. */
  readonly url?: string;
  /** The extension ID the sender reports. Default the extension's own, as Chrome does. */
  readonly senderId?: string;
  /** Leave storage out of this context's ChromeLike. */
  readonly withoutStorage?: boolean;
}

/** A storage area of the fake: get, set and remove. */
export interface FakeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The access levels of storage.session. */
export type FakeAccessLevel = "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";

/** ChromeLike with the storage areas the fake has beyond it, and runtime.getURL. */
export type FakeChrome = ChromeLike & {
  readonly runtime: ChromeLike["runtime"] & { getURL(path: string): string };
  readonly storage?: NonNullable<ChromeLike["storage"]> & {
    readonly local: FakeStorageArea;
    readonly session: FakeStorageArea & {
      setAccessLevel(o: { readonly accessLevel: FakeAccessLevel }): Promise<void>;
    };
  };
};

/** One context's view of the fake extension. */
export interface FakeContext {
  readonly chrome: FakeChrome;
  /** The runtime.onMessage listeners registered in this context now. */
  listeners(): readonly RuntimeMessageListener[];
}

/** The fake extension. */
export interface FakeExtension {
  readonly id: string;
  context(opts?: FakeContextOptions): FakeContext;
  /** The storage area, as stored (JSON values). */
  readonly stored: Map<string, unknown>;
  /** storage.session, as stored (JSON values). */
  readonly sessionStored: Map<string, unknown>;
  /** Every storage.local.set call, in order. */
  readonly writes: Record<string, unknown>[];
  /** Every message sent by any context, as delivered (after JSON serialization). */
  readonly sent: unknown[];
  /** Resolves once every queued delivery has run. */
  settle(): Promise<void>;
}

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
const PORT_CLOSED = "The message port closed before a response was received.";

function event<L>(): ExtensionEvent<L> & { readonly listeners: L[] } {
  const listeners: L[] = [];
  return {
    listeners,
    addListener(l) {
      if (!listeners.includes(l)) listeners.push(l);
    },
    removeListener(l) {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function roundTrip(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** A fresh fake extension with the given ID and manifest. */
export function createFakeExtension(
  id = "fakeextensionid",
  manifest: { name: string; version: string } = { name: "fake", version: "1.2.3" },
): FakeExtension {
  interface Ctx {
    readonly opts: FakeContextOptions;
    readonly onMessage: ReturnType<typeof event<RuntimeMessageListener>>;
    readonly onChanged: ReturnType<typeof event<StorageListener>>;
  }
  const contexts: Ctx[] = [];
  const stored = new Map<string, unknown>();
  const sessionStored = new Map<string, unknown>();
  let sessionAccess: FakeAccessLevel = "TRUSTED_CONTEXTS";
  const writes: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const later = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const p = new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          Promise.resolve(fn()).then(resolve, reject);
        } catch (err) {
          reject(err);
        }
      }, 0);
    });
    pending = Promise.allSettled([pending, p]);
    return p;
  };

  function deliver(from: Ctx, targets: readonly Ctx[], message: unknown): Promise<unknown> {
    const wire = roundTrip(message);
    sent.push(wire);
    return later(
      () =>
        new Promise<unknown>((resolve, reject) => {
          const sender: MessageSenderLike = {
            id: from.opts.senderId ?? id,
            ...(from.opts.tabId === undefined ? {} : { tab: { id: from.opts.tabId }, frameId: 0 }),
            ...(from.opts.url === undefined ? {} : { url: from.opts.url }),
          };
          const listeners = targets.flatMap((t) => [...t.onMessage.listeners]);
          if (listeners.length === 0) {
            reject(new Error(NO_RECEIVER));
            return;
          }
          let answered = false;
          let waiting = false;
          for (const l of listeners) {
            const keep = l(roundTrip(wire), sender, (response) => {
              if (answered) return;
              answered = true;
              resolve(roundTrip(response));
            });
            if (keep === true) waiting = true;
          }
          if (!answered && !waiting) reject(new Error(PORT_CLOSED));
        }),
    );
  }

  /** A storage area over map, reporting changes as areaName to the contexts hears accepts. */
  function area(
    map: Map<string, unknown>,
    areaName: string,
    allowed: () => boolean,
    hears: (c: Ctx) => boolean,
    record?: (items: Record<string, unknown>) => void,
  ): FakeStorageArea {
    const notify = (changes: Record<string, StorageChangeLike>): void => {
      for (const c of contexts) {
        if (!hears(c)) continue;
        for (const l of [...c.onChanged.listeners]) void later(() => l(changes, areaName));
      }
    };
    const denied = (): never => {
      throw new Error("Access to storage is not allowed from this context.");
    };
    return {
      get: (key) =>
        later(() => {
          if (!allowed()) denied();
          return map.has(key) ? { [key]: roundTrip(map.get(key)) } : {};
        }),
      set: (items) =>
        later(() => {
          if (!allowed()) denied();
          record?.(roundTrip(items) as Record<string, unknown>);
          const changes: Record<string, StorageChangeLike> = {};
          for (const [k, v] of Object.entries(items)) {
            const old = map.get(k);
            map.set(k, roundTrip(v));
            changes[k] = { ...(old === undefined ? {} : { oldValue: old }), newValue: roundTrip(v) };
          }
          notify(changes);
        }),
      remove: (key) =>
        later(() => {
          if (!allowed()) denied();
          if (!map.has(key)) return;
          const old = map.get(key);
          map.delete(key);
          notify({ [key]: { oldValue: old } });
        }),
    };
  }
  const local = area(
    stored,
    "local",
    () => true,
    () => true,
    (items) => writes.push(items),
  );
  const untrusted = (c: Ctx): boolean => c.opts.tabId !== undefined;
  const sessionOpen = (c: Ctx): boolean =>
    !untrusted(c) || sessionAccess === "TRUSTED_AND_UNTRUSTED_CONTEXTS";

  return {
    id,
    stored,
    sessionStored,
    writes,
    sent,
    async settle() {
      for (let i = 0; i < 20; i++) {
        await pending;
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    context(opts = {}) {
      const ctx: Ctx = { opts, onMessage: event(), onChanged: event() };
      contexts.push(ctx);
      const session = area(sessionStored, "session", () => sessionOpen(ctx), sessionOpen);
      const chrome: FakeChrome = {
        runtime: {
          id,
          getManifest: () => manifest,
          getURL: (path: string) => `chrome-extension://${id}/${path.replace(/^\//, "")}`,
          sendMessage: (message) =>
            deliver(
              ctx,
              contexts.filter((c) => c !== ctx && c.opts.tabId === undefined),
              message,
            ),
          onMessage: ctx.onMessage,
        },
        ...(opts.tabId === undefined
          ? {
              tabs: {
                sendMessage: (tabId: number, message: unknown) =>
                  deliver(
                    ctx,
                    contexts.filter((c) => c.opts.tabId === tabId),
                    message,
                  ),
              },
            }
          : {}),
        ...(opts.withoutStorage === true
          ? {}
          : {
              storage: {
                local,
                session: {
                  ...session,
                  setAccessLevel: (o: { readonly accessLevel: FakeAccessLevel }) =>
                    later(() => {
                      if (untrusted(ctx))
                        throw new Error("setAccessLevel is not allowed from a content script.");
                      sessionAccess = o.accessLevel;
                    }),
                },
                onChanged: ctx.onChanged,
              },
            }),
      };
      return { chrome, listeners: () => [...ctx.onMessage.listeners] };
    },
  };
}
