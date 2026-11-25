/**
 * WP5. A fake extension for tests: one shared message bus and storage area, and a ChromeLike per
 * context (the worker, an extension page, a content script in a tab). It behaves as Chrome does
 * where libo11y depends on it: messages and replies are JSON-serialized, delivered asynchronously
 * to every other context's listeners (never the sender's own), the first sendResponse wins, a
 * message nobody answers rejects, tabs.sendMessage reaches only that tab, and storage.local.set
 * reports onChanged to every context. Tests only; never built.
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

/** One context's view of the fake extension. */
export interface FakeContext {
  readonly chrome: ChromeLike;
  /** The runtime.onMessage listeners registered in this context now. */
  listeners(): readonly RuntimeMessageListener[];
}

/** The fake extension. */
export interface FakeExtension {
  readonly id: string;
  context(opts?: FakeContextOptions): FakeContext;
  /** The storage area, as stored (JSON values). */
  readonly stored: Map<string, unknown>;
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

  return {
    id,
    stored,
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
      const chrome: ChromeLike = {
        runtime: {
          id,
          getManifest: () => manifest,
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
                local: {
                  get: (key: string) =>
                    later(() => (stored.has(key) ? { [key]: roundTrip(stored.get(key)) } : {})),
                  set: (items: Record<string, unknown>) =>
                    later(() => {
                      writes.push(roundTrip(items) as Record<string, unknown>);
                      const changes: Record<string, StorageChangeLike> = {};
                      for (const [k, v] of Object.entries(items)) {
                        const old = stored.get(k);
                        stored.set(k, roundTrip(v));
                        changes[k] = {
                          ...(old === undefined ? {} : { oldValue: old }),
                          newValue: roundTrip(v),
                        };
                      }
                      for (const c of contexts) {
                        for (const l of [...c.onChanged.listeners]) void later(() => l(changes, "local"));
                      }
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
