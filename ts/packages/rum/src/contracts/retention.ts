/** Contract, frozen by R3a. The retention buffer for sessions not yet kept. */
import type { Delivery, OtlpBatch, QueueSize } from "@libo11y/web/internal";
import type { SessionDecision } from "./session.ts";

export interface RetentionBuffer {
  /** Stores a batch. Never rejects. */
  put(batch: OtlpBatch): Promise<void>;
  /** Sends every stored batch through delivery and removes it. Resolves with the batches handed over. */
  flush(delivery: Delivery): Promise<number>;
  clear(): Promise<void>;
  size(): Promise<QueueSize>;
  close(): void;
}

/** What the retaining exporters ask. */
export interface RetentionRouting {
  decide(sessionId: string | undefined): SessionDecision;
  /** Hands a serialized batch of buffered records to the retention buffer. */
  buffer(batch: OtlpBatch): void;
}
