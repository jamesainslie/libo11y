/**
 * The only module that names rrweb, and it loads it lazily: replay() bundles
 * no recorder. loadRecorder imports @rrweb/record the first time a session will actually record,
 * so a page that never records never downloads it. Until it has loaded nothing is recorded. A failed
 * import is kept, so replay stays off for the page rather than retrying.
 *
 * rrweb records at its strictest: inputs masked and emptied, no canvas, fonts, inline images or
 * cross-origin iframes, scripts, comments and head metadata slimmed, block selectors replaced by
 * placeholders. That is a first line only. Every event goes through libo11y's scrubber
 * synchronously inside rrweb's emit callback, while the DOM still matches the event, with the
 * DOM-backed context reading nodes through rrweb's mirror. A scrubbed-away event never leaves this
 * module.
 */
import type { record } from "@rrweb/record";
import { domScrubContext } from "./dom-context.ts";
import type { ReplayPolicy } from "./policy.ts";
import { type RrwebEvent, scrubEvent } from "./scrub.ts";

/** rrweb's record function, with its mirror and takeFullSnapshot. */
export type RecordFn = typeof record;

export interface Recorder {
  /** Takes a new full snapshot now (a segment cut). */
  checkout(): void;
  stop(): void;
}

export type StartRecorder = (
  policy: ReplayPolicy,
  onEvent: (e: RrwebEvent) => void,
  onError: (err: unknown) => void,
) => Recorder | undefined;

/** The recorder once loaded, or the load in flight (which rejects when the import failed). */
export type LoadRecorder = () => StartRecorder | Promise<StartRecorder>;

/** A recorder over rrweb's record: rrweb at its strictest, every event scrubbed before onEvent sees it. Undefined when rrweb cannot start. */
export function recorderOver(rec: RecordFn): StartRecorder {
  return (policy, onEvent, onError) => {
    const ctx = domScrubContext(policy, (id) => rec.mirror.getNode(id) as Node | null);
    let stop: (() => void) | undefined;
    try {
      stop = rec({
        emit: (e) => {
          let s: RrwebEvent | undefined;
          try {
            s = scrubEvent(e as RrwebEvent, policy, ctx);
          } catch (err) {
            onError(err);
            return;
          }
          if (s !== undefined) onEvent(s);
        },
        maskAllInputs: true,
        maskInputFn: () => "",
        blockSelector: policy.block.join(","),
        recordCanvas: false,
        recordCrossOriginIframes: false,
        inlineImages: false,
        collectFonts: false,
        inlineStylesheet: true,
        slimDOMOptions: "all",
        userTriggeredOnInput: false,
        sampling: { input: "last", mousemove: 50, scroll: 150, media: 800 },
        errorHandler: (err) => {
          onError(err);
          return true;
        },
      });
    } catch (err) {
      onError(err);
      return undefined;
    }
    if (stop === undefined) return undefined;
    return {
      checkout: () => {
        try {
          rec.takeFullSnapshot(true);
        } catch (err) {
          onError(err);
        }
      },
      stop: () => stop?.(),
    };
  };
}

/**
 * A loader over importRecord. The first call starts the import and returns it as a promise, as do
 * calls while it runs. Once it has loaded, calls return the recorder itself, so a later session
 * starts recording without waiting. A failed import is kept: every later call returns the same
 * rejected promise and nothing is imported again.
 */
export function createRecorderLoader(
  importRecord: () => Promise<{ readonly record: RecordFn }>,
): LoadRecorder {
  let loaded: StartRecorder | undefined;
  let pending: Promise<StartRecorder> | undefined;
  return () => {
    if (loaded !== undefined) return loaded;
    if (pending === undefined) {
      let started: Promise<{ readonly record: RecordFn }>;
      try {
        started = importRecord();
      } catch (err) {
        started = Promise.reject(err);
      }
      pending = started.then((m) => {
        loaded = recorderOver(m.record);
        return loaded;
      });
    }
    return pending;
  };
}

/** Loads rrweb's recorder on first use, in a chunk of its own. */
export const loadRecorder: LoadRecorder = createRecorderLoader(() => import("@rrweb/record"));
