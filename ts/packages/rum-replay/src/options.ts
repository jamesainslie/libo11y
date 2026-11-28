/** The text privacy of a recording: which parts of the page keep their text. */
export interface ReplayPrivacy {
  /**
   * CSS selectors whose text is recorded. Default []: every character of text is masked. Markup
   * alone never unmasks: list "[data-o11y-unmask]" here to honour that attribute. Text under a
   * mask or block selector stays masked even under an unmasked element, and input values and
   * editable content are never recorded.
   */
  readonly unmask?: readonly string[];
  /** Further selectors whose text is always masked, even under an unmasked element. */
  readonly mask?: readonly string[];
  /** Further selectors replaced by an empty placeholder of the same size. */
  readonly block?: readonly string[];
}

/** The options of the replay collector. */
export interface ReplayOptions {
  /** The share of head-sampled sessions recorded, 0 to 1. Default 1. */
  readonly sampleRate?: number;
  /**
   * Also record sessions that are not head-sampled into a lead-up buffer in memory, uploaded only
   * if an error or frustration keeps the session. Default false.
   */
  readonly onRetain?: boolean;
  /** Which text is recorded. Remote configuration can only make it stricter. */
  readonly privacy?: ReplayPrivacy;
  /** The range remote configuration may move sampleRate within. Default [sampleRate, sampleRate]: no change. */
  readonly limits?: { readonly sampleRate?: readonly [min: number, max: number] };
  /** The replay endpoint. Default new URL("/_o11y/v1/replay", location.href). */
  readonly url?: string;
}
