/**
 * Replays the bootstrap buffer once the collectors started: each entry goes out on the bus as a
 * bootstrap signal with its original time, and the collector of its kind records it (errors()
 * the errors, actions() the clicks), so a kind whose collector the app did not install is dropped.
 * Nothing is replayed unless consent is granted.
 */
import type { RumRuntime } from "../contracts/runtime.ts";
import type { BootstrapBuffer } from "./buffer.ts";

/** Feeds the buffered entries to the collectors and returns how many. The buffer is stopped either way. */
export function replayBootstrap(rt: RumRuntime, buffer: BootstrapBuffer | undefined): number {
  if (buffer === undefined) return 0;
  buffer.stop();
  if (!rt.gate.recording()) return 0;
  for (const entry of buffer.entries) rt.bus.publish({ type: "bootstrap", entry });
  return buffer.entries.length;
}
