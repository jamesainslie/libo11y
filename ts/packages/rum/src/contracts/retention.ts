/** Contract, frozen by R3a. The retention buffer for sessions not yet kept. */
import type { Delivery, OtlpBatch, QueueSize } from "@libo11y/web/internal";
import type { SessionDecision } from "./session.ts";

export interface RetentionBuffer {
  /** Stores a batch. Never rejects: a storage failure is reported through diag and the batch is lost. */
  put(batch: OtlpBatch): Promise<void>;
  /**
   * Sends every stored batch that keep accepts (default every batch) through delivery, and removes
   * every batch it claimed, sent or not. Resolves with the batches handed over. Never rejects.
   */
  flush(delivery: Delivery, keep?: (batch: OtlpBatch) => boolean): Promise<number>;
  /** Removes every stored batch. Never rejects. */
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
