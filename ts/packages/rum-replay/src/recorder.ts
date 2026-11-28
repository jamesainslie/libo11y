/**
 * The only module that imports rrweb (design decision P1). rrweb records at its strictest: inputs
 * masked and emptied, no canvas, fonts, inline images or cross-origin iframes, scripts, comments
 * and head metadata slimmed, block selectors replaced by placeholders. That is a first line only.
 * Every event goes through libo11y's scrubber synchronously inside rrweb's emit callback, while the
 * DOM still matches the event, with the DOM-backed context reading nodes through rrweb's mirror. A
 * scrubbed-away event never leaves this module.
 */
import { record } from "@rrweb/record";
import { domScrubContext } from "./dom-context.ts";
import type { ReplayPolicy } from "./policy.ts";
import { type RrwebEvent, scrubEvent } from "./scrub.ts";

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

/** Starts rrweb at its strictest and scrubs every event before onEvent sees it. Undefined when rrweb cannot start. */
export const startRecorder: StartRecorder = (policy, onEvent, onError) => {
  const ctx = domScrubContext(policy, (id) => record.mirror.getNode(id) as Node | null);
  let stop: (() => void) | undefined;
  try {
    stop = record({
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
        record.takeFullSnapshot(true);
      } catch (err) {
        onError(err);
      }
    },
    stop: () => stop?.(),
  };
};
