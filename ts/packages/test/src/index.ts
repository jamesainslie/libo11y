/**
 * The libo11y test harness: a hermetic recorder over in-memory signals, with conformance and
 * correlation assertions, and an in-process OTLP/HTTP sink. Runs on Bun and Node, never in browsers.
 */

export {
  createRecorder,
  type RecordedExemplar,
  type RecordedLog,
  type Recorder,
  type RecorderOptions,
} from "./recorder.ts";
