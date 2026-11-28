/**
 * The session: one per user visit, shared by every tab of an origin (and
 * every context of an extension), ending after sessionIdleMillis without activity or after
 * sessionMaxMillis.
 */
import type { RUMSessionRetained } from "@libo11y/spec";

/** The shared session record, as stored. Times are epoch milliseconds. */
export interface SessionState {
  readonly id: string;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  /** The head-sampling decision: sessionSampled(id, rate) at creation. */
  readonly sampled: boolean;
  /** Why the session is kept, once it is. head_sampled from creation when sampled. */
  readonly retained?: RUMSessionRetained;
  /** The remote configuration version the session started under. */
  readonly configVersion?: string;
}

/** Where the session is shared. localStorage plus BroadcastChannel on the web, chrome.storage.session in extensions. */
export interface SessionStore {
  /** Reads the stored session. Resolves undefined when there is none or it is unreadable. Never rejects. */
  load(): Promise<SessionState | undefined>;
  /** Stores state (undefined removes it) and tells the other contexts. Never throws. */
  save(state: SessionState | undefined): void;
  /** Calls listener when another context saves. Returns a function that unsubscribes. */
  onChange(listener: (state: SessionState | undefined) => void): () => void;
  close(): void;
}

/** What the retention router does with a record of a session. */
export type SessionDecision = "send" | "buffer" | "drop";

/** local is true when this context caused the change. */
export type SessionEvent =
  | {
      readonly type: "start";
      readonly session: SessionState;
      readonly previous?: SessionState;
      readonly local: boolean;
    }
  | { readonly type: "end"; readonly session: SessionState; readonly local: boolean }
  | { readonly type: "kept"; readonly session: SessionState; readonly local: boolean };

export interface SessionManager {
  /** Loads the shared session and starts listening. Called when consent is granted. */
  start(): Promise<void>;
  /** The live session, rotating an expired one. Undefined before start and after clear. */
  current(): SessionState | undefined;
  /** User activity: extends the session, or rotates it when it expired. */
  touch(): void;
  /** Whether the current session is kept (head-sampled or retained). */
  kept(): boolean;
  /** Keeps the current session for reason. True when this call changed it from unkept to kept. */
  retain(reason: "error" | "frustration"): boolean;
  /** send for a kept session, buffer for the current unkept one, drop for an old unkept one. */
  decide(sessionId: string | undefined): SessionDecision;
  /** Forgets the session and removes it from the store (consent revoked). */
  clear(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  close(): void;
}
