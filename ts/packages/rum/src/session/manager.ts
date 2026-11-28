/**
 * The session manager. It keeps the session in memory, so current() is synchronous for the span
 * processor, and saves to the store on every change and on activity at most every saveEveryMillis.
 *
 * Rules. A session is expired when now - lastActivityAt >= idleMillis or now - startedAt >=
 * maxMillis. There is no session before start() has loaded the stored one. current() rotates an
 * expired session: records made after expiry start a new session, and only touch() extends one.
 * Rotation creates a session whose sampled flag is sessionSampled(id, rate), retained head_sampled
 * when sampled, saves it, emits end (local) for the old one, then start (local, with previous).
 *
 * On another context's change: the same ID merges (the latest lastActivityAt, retained kept once
 * set, emitting kept with local false when it newly became kept). A different ID is adopted when
 * this context has none, or when its startedAt is later, or equal with a smaller ID, emitting start
 * with local false. A removed session is forgotten, so the next current() creates one, with the
 * removed session as its previous.
 *
 * decide(id): a missing ID means the current session. The current session sends when kept and
 * buffers otherwise. Any of the last four sessions this context knew sends when it was kept and
 * drops otherwise. An unknown ID drops.
 */
import type {
  SessionDecision,
  SessionEvent,
  SessionManager,
  SessionState,
  SessionStore,
} from "../contracts/session.ts";
import { randomUuid } from "../ids.ts";
import { sessionSampled } from "./sampling.ts";

const RECENT = 4;

export interface SessionManagerOptions {
  readonly store: SessionStore;
  /** Read when a session is created. */
  readonly sampleRate: () => number;
  readonly idleMillis: number;
  readonly maxMillis: number;
  /** The least time between two activity saves. Default 5000. */
  readonly saveEveryMillis?: number;
  /** Read when a session is created. */
  readonly configVersion?: () => string | undefined;
  /** Epoch milliseconds. Default Date.now. */
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export function createSessionManager(opts: SessionManagerOptions): SessionManager {
  const now = opts.now ?? Date.now;
  const randomId = opts.randomId ?? randomUuid;
  const saveEvery = opts.saveEveryMillis ?? 5000;
  const listeners = new Set<(e: SessionEvent) => void>();
  /** Sessions this context knew, newest last, with whether each was kept. */
  const recent = new Map<string, boolean>();
  let state: SessionState | undefined;
  /** start() was called and not cleared since. */
  let started = false;
  /** The stored session has loaded: until then there is no session, so none is created early. */
  let ready = false;
  let lastSave = 0;
  let unsubscribe: (() => void) | undefined;
  /** The session another context removed, so the next one starts with it as previous. */
  let forgotten: SessionState | undefined;
  /** Bumped by clear(), so a start() whose load resolves after a clear does nothing. */
  let generation = 0;

  const emit = (e: SessionEvent): void => {
    for (const l of listeners) l(e);
  };
  const remember = (s: SessionState): void => {
    recent.delete(s.id);
    recent.set(s.id, s.retained !== undefined);
    while (recent.size > RECENT) recent.delete(recent.keys().next().value as string);
  };
  const expired = (s: SessionState, t: number): boolean =>
    t - s.lastActivityAt >= opts.idleMillis || t - s.startedAt >= opts.maxMillis;
  const save = (s: SessionState | undefined): void => {
    lastSave = now();
    opts.store.save(s);
  };

  const rotate = (t: number): SessionState => {
    const ended = state;
    const previous = state ?? forgotten;
    forgotten = undefined;
    const id = randomId();
    const sampled = sessionSampled(id, opts.sampleRate());
    const version = opts.configVersion?.();
    const next: SessionState = {
      id,
      startedAt: t,
      lastActivityAt: t,
      sampled,
      ...(sampled ? { retained: "head_sampled" as const } : {}),
      ...(version === undefined ? {} : { configVersion: version }),
    };
    state = next;
    remember(next);
    save(next);
    if (ended !== undefined) emit({ type: "end", session: ended, local: true });
    emit({ type: "start", session: next, ...(previous === undefined ? {} : { previous }), local: true });
    return next;
  };

  const live = (): SessionState | undefined => {
    if (!ready) return undefined;
    const t = now();
    if (state === undefined || expired(state, t)) return rotate(t);
    return state;
  };

  const adopt = (incoming: SessionState | undefined): void => {
    if (incoming === undefined) {
      forgotten = state ?? forgotten;
      state = undefined;
      return;
    }
    if (state !== undefined && incoming.id === state.id) {
      const becameKept = state.retained === undefined && incoming.retained !== undefined;
      const retained = state.retained ?? incoming.retained;
      state = {
        ...state,
        lastActivityAt: Math.max(state.lastActivityAt, incoming.lastActivityAt),
        ...(retained === undefined ? {} : { retained }),
      };
      remember(state);
      if (becameKept) emit({ type: "kept", session: state, local: false });
      return;
    }
    const newer =
      state === undefined ||
      incoming.startedAt > state.startedAt ||
      (incoming.startedAt === state.startedAt && incoming.id < state.id);
    if (!newer) return;
    const previous = state;
    state = incoming;
    remember(incoming);
    emit({ type: "start", session: incoming, ...(previous === undefined ? {} : { previous }), local: false });
  };

  return {
    async start() {
      if (started) return;
      started = true;
      const gen = generation;
      unsubscribe = opts.store.onChange(adopt);
      const stored = await opts.store.load();
      if (gen !== generation) return; // cleared while loading
      ready = true;
      if (stored !== undefined && state === undefined) {
        state = stored;
        remember(stored);
        // A live stored session was started elsewhere. An expired one is ended here:
        // live() below rotates it and emits its local end.
        if (!expired(stored, now())) emit({ type: "start", session: stored, local: false });
      }
      live();
    },
    current: live,
    touch() {
      const s = live();
      if (s === undefined) return;
      const t = now();
      state = { ...s, lastActivityAt: t };
      if (t - lastSave >= saveEvery) save(state);
    },
    kept: () => live()?.retained !== undefined,
    retain(reason) {
      const s = live();
      if (s === undefined || s.retained !== undefined) return false;
      state = { ...s, retained: reason };
      remember(state);
      save(state);
      emit({ type: "kept", session: state, local: true });
      return true;
    },
    decide(sessionId): SessionDecision {
      const s = live();
      const id = sessionId ?? s?.id;
      if (id === undefined) return "drop";
      if (s !== undefined && id === s.id) return s.retained === undefined ? "buffer" : "send";
      return recent.get(id) === true ? "send" : "drop";
    },
    clear() {
      generation++;
      forgotten = undefined;
      state = undefined;
      recent.clear();
      started = false;
      ready = false;
      unsubscribe?.();
      unsubscribe = undefined;
      save(undefined);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      unsubscribe?.();
      opts.store.close();
      listeners.clear();
    },
  };
}
