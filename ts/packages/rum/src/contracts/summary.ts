/** The per-view counters behind o11y.rum.view.summary. */
import type { RUMErrorSource, RUMFrustrationType, RUMViewKind } from "@libo11y/spec";

export type SummaryCountKey =
  | `errors.${RUMErrorSource}`
  | `frustrations.${RUMFrustrationType}`
  | "requests"
  | "long_animation_frames";

export type VitalName = "lcp" | "inp" | "cls" | "fcp" | "ttfb";

export interface SummaryView {
  readonly id: string;
  readonly name: string;
  readonly kind: RUMViewKind;
  readonly sessionId: string;
}

export interface SummaryAccumulator {
  /** Tracks view as the current view; its time on view runs while the page is visible. */
  open(view: SummaryView): void;
  /** Sends the view's summary (at least once) and stops its clock. Late vitals still reach it. */
  close(viewId: string): void;
  rename(viewId: string, name: string): void;
  /** Adds n (default 1) to a count of the current view. */
  count(key: SummaryCountKey, n?: number): void;
  /** Records a vital of a view once; later values for the same view and vital are ignored. Seconds, CLS unitless. */
  vital(viewId: string, name: VitalName, value: number): void;
  visibility(visible: boolean): void;
  /** Pins a view: while pinned, a closed view is not forgotten, so vitals held for it still reach it. */
  pin(viewId: string, pinned: boolean): void;
  /** Sends a summary for every view with unsent data. */
  flush(): void;
  /** Drops everything unsent (consent revoked). */
  reset(): void;
}
