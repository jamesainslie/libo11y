/**
 * The guard every errors() collector records through: an error raised while one is being recorded
 * (an exporter or a listener that throws or logs) is not recorded again, and nothing is recorded
 * once the collector stopped.
 */
import type { RUMErrorSource } from "@libo11y/spec";
import type { RumRuntime } from "../contracts/runtime.ts";
import { recordError } from "./record.ts";

export interface ErrorRecorder {
  /** Records through recordError, at performance.now() time at (default now), unless stopped or already recording. */
  record(source: RUMErrorSource, error: unknown, at?: number): void;
  /** True while an error is being recorded. */
  recording(): boolean;
  /** Records nothing from now on. */
  stop(): void;
}

export function createErrorRecorder(rt: RumRuntime): ErrorRecorder {
  let stopped = false;
  let busy = false;
  return {
    record(source, error, at) {
      if (stopped || busy) return;
      busy = true;
      try {
        recordError(rt, source, error, at === undefined ? {} : { at });
      } finally {
        busy = false;
      }
    },
    recording: () => busy,
    stop() {
      stopped = true;
    },
  };
}
