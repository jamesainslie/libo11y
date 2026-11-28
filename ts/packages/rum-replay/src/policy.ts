/**
 * The privacy policy of a recording (design decision P2). Code options are the ceiling: remote
 * configuration can only add to the mask and block lists and remove from the unmask list
 * (clamp.ts). The fixed rules here apply whatever the options say.
 *
 * Attributes are an allow-list. The scrubber keeps an attribute only when its name, lowercased in
 * ASCII, is in one of the lists below, so an attribute rrweb or the page adds later is dropped
 * rather than leaked:
 * - KEPT_ATTRIBUTES are kept as they are.
 * - MASKED_ATTRIBUTES carry text and follow the text rule of their element.
 * - URL_ATTRIBUTES are kept after stripUrl (srcset after stripSrcset).
 * - CSS_ATTRIBUTES are kept after stripCssUrls.
 * Every other attribute, including value, checked, selected, every on* handler, every data-*
 * attribute but libo11y's markers, srcdoc and rrweb's rr_dataURL and rr_src, is removed.
 */
import { O11yError } from "@libo11y/core";
import type { ReplayPrivacy } from "./options.ts";

/** Selectors whose text and masked attributes are always masked. */
export const FIXED_MASK: readonly string[] = Object.freeze([
  "input",
  "textarea",
  "select",
  "option",
  '[contenteditable]:not([contenteditable="false"])',
  "[data-o11y-mask]",
]);

/** Selectors always replaced by an empty placeholder of the same size. */
export const FIXED_BLOCK: readonly string[] = Object.freeze(["[data-o11y-block]"]);

/** Attributes whose value is text: masked unless the element's text is allowed. */
export const MASKED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "content",
  "summary",
  "abbr",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "aria-braillelabel",
  "aria-brailleroledescription",
]);

/** Attributes holding a URL, kept after stripUrl (srcset after stripSrcset). */
export const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "srcset", "xlink:href", "poster"]);

/** Attributes holding CSS, which may hold url(), kept after stripCssUrls. */
export const CSS_ATTRIBUTES: ReadonlySet<string> = new Set([
  "style",
  "fill",
  "stroke",
  "clip-path",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",
]);

/** Attributes kept unchanged. */
export const KEPT_ATTRIBUTES: ReadonlySet<string> = new Set([
  // structure, layout and state that is not user input
  "id",
  "class",
  "type",
  "role",
  "rel",
  "media",
  "sizes",
  "width",
  "height",
  "hidden",
  "disabled",
  "readonly",
  "required",
  "multiple",
  "dir",
  "lang",
  "colspan",
  "rowspan",
  "span",
  "scope",
  "tabindex",
  "open",
  "draggable",
  "crossorigin",
  "as",
  "charset",
  "name",
  "http-equiv",
  "for",
  "start",
  "reversed",
  "controls",
  "loop",
  "muted",
  "playsinline",
  "size",
  "cols",
  "rows",
  // ARIA state and relations, never ARIA text
  "aria-hidden",
  "aria-expanded",
  "aria-current",
  "aria-disabled",
  "aria-busy",
  "aria-pressed",
  "aria-haspopup",
  "aria-live",
  "aria-modal",
  "aria-invalid",
  "aria-required",
  "aria-readonly",
  "aria-level",
  "aria-orientation",
  "aria-sort",
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "aria-owns",
  // libo11y's markers
  "data-o11y",
  "data-o11y-mask",
  "data-o11y-unmask",
  "data-o11y-block",
  // SVG geometry and presentation
  "xmlns",
  "xmlns:xlink",
  "version",
  "viewbox",
  "preserveaspectratio",
  "d",
  "fill-rule",
  "fill-opacity",
  "clip-rule",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "opacity",
  "transform",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "dx",
  "dy",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "points",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "patternunits",
  "clippathunits",
  "maskunits",
  "text-anchor",
  "dominant-baseline",
  "font-size",
  "font-weight",
  "visibility",
  "display",
  "vector-effect",
  "shape-rendering",
  // rrweb's own serialization (rr_dataURL is canvas or image pixels and rr_src a hidden iframe URL: never kept)
  "rr_width",
  "rr_height",
  "rr_scrollleft",
  "rr_scrolltop",
  "rr_mediastate",
  "rr_mediacurrenttime",
  "rr_mediaplaybackrate",
  "rr_mediamuted",
  "rr_medialoop",
  "rr_mediavolume",
  "rr_open_mode",
]);

/** The privacy policy one recording runs under. */
export interface ReplayPolicy {
  /** Selectors whose text is kept. Empty by default. */
  readonly unmask: readonly string[];
  /** FIXED_MASK, then the code's selectors, then remote configuration's. */
  readonly mask: readonly string[];
  /** FIXED_BLOCK, then the code's selectors, then remote configuration's. */
  readonly block: readonly string[];
  /** Query parameters URLs keep: RUM's queryAllowList. */
  readonly queryAllowList: ReadonlySet<string>;
}

function selectors(name: string, list: readonly string[] | undefined): readonly string[] {
  for (const s of list ?? []) {
    if (typeof s !== "string" || s.trim() === "") {
      throw new O11yError("INVALID_OPTION", `replay privacy.${name} must hold non-empty CSS selectors`);
    }
  }
  return [...(list ?? [])];
}

/** The code-level policy: the fixed rules first, then the app's selectors. Throws O11yError INVALID_OPTION on an empty selector. */
export function resolvePolicy(
  privacy: ReplayPrivacy | undefined,
  queryAllowList: ReadonlySet<string>,
): ReplayPolicy {
  return Object.freeze({
    unmask: Object.freeze(selectors("unmask", privacy?.unmask)),
    mask: Object.freeze([...FIXED_MASK, ...selectors("mask", privacy?.mask)]),
    block: Object.freeze([...FIXED_BLOCK, ...selectors("block", privacy?.block)]),
    queryAllowList,
  });
}
