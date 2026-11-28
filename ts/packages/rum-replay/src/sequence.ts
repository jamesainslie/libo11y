/**
 * Segment numbers shared by every tab of a session (design decision P6). o11y.rum.replay.segment is
 * the index of a segment in its session, and tabs share a session, so the next index lives in
 * localStorage under SEQUENCE_KEY as { "session": "<id>", "next": <n> } and is read and written
 * inside a Web Lock (navigator.locks) of the same name, so two tabs never take the same index. A
 * counter of another session, or one that does not parse, starts again at 0.
 *
 * Where storage throws (blocked site data), the counter falls back to this tab's memory, so the tab
 * still numbers its own segments without reusing one.
 */

export const SEQUENCE_KEY = "libo11y.rum.replay.seq";
export const SEQUENCE_LOCK = "libo11y.rum.replay.seq";

/** The part of navigator.locks the counter uses. */
export interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T> | T): Promise<T>;
}

type Counter = { readonly session: string; readonly next: number };

/** The counter of a storage that throws, kept per storage object. */
const memory = new WeakMap<object, Counter>();

function read(raw: string | null, sessionId: string): number {
  try {
    const v = JSON.parse(raw ?? "null") as { session?: unknown; next?: unknown } | null;
    if (
      typeof v === "object" &&
      v !== null &&
      v.session === sessionId &&
      typeof v.next === "number" &&
      Number.isInteger(v.next) &&
      v.next >= 0
    ) {
      return v.next;
    }
  } catch {
    // unreadable: start again
  }
  return 0;
}

/**
 * Takes the next segment index of sessionId under the lock. proceed is checked once the lock is
 * granted, which can be long after the call: when it is false (consent was revoked meanwhile) the
 * counter is neither read nor written and the promise rejects. Otherwise it rejects only when the
 * lock does.
 */
export function allocateSegment(
  sessionId: string,
  storage: Pick<Storage, "getItem" | "setItem">,
  locks: LockManagerLike,
  proceed: () => boolean = () => true,
): Promise<number> {
  return locks.request(SEQUENCE_LOCK, () => {
    if (!proceed()) throw new Error("rum-replay: segment numbering is no longer allowed");
    const counter: Counter = { session: sessionId, next: 0 };
    let next: number;
    try {
      next = read(storage.getItem(SEQUENCE_KEY), sessionId);
      storage.setItem(SEQUENCE_KEY, JSON.stringify({ ...counter, next: next + 1 }));
    } catch {
      const kept = memory.get(storage);
      next = kept?.session === sessionId ? kept.next : 0;
      memory.set(storage, { ...counter, next: next + 1 });
    }
    return next;
  });
}

/** Removes the counter (consent revoked). Never throws. */
export function clearSequence(storage: Pick<Storage, "removeItem">): void {
  memory.delete(storage);
  try {
    storage.removeItem(SEQUENCE_KEY);
  } catch {
    // nothing stored to remove
  }
}
