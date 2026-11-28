/** Test doubles for localStorage and a pair of linked BroadcastChannels. Tests only; never built. */
import type { BroadcastChannelLike } from "../session/local-store.ts";

export function createFakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & {
  readonly items: Map<string, string>;
} {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: (k) => void items.delete(k),
  };
}

/**
 * Channels that deliver to every other channel of the same hub, as tabs would: synchronously, or
 * with async in a later task, so two tabs can act before either hears the other.
 */
export function createChannelHub(opts: { readonly async?: boolean } = {}): {
  channel(): BroadcastChannelLike;
} {
  const members = new Set<{ listeners: Set<(e: { data: unknown }) => void> }>();
  return {
    channel() {
      const me = { listeners: new Set<(e: { data: unknown }) => void>() };
      members.add(me);
      return {
        postMessage(data) {
          const copy = structuredClone(data);
          const deliver = (): void => {
            for (const m of members) if (m !== me) for (const l of m.listeners) l({ data: copy });
          };
          if (opts.async === true) setTimeout(deliver, 0);
          else deliver();
        },
        addEventListener: (_t, l) => void me.listeners.add(l),
        removeEventListener: (_t, l) => void me.listeners.delete(l),
        close: () => void members.delete(me),
      };
    },
  };
}
