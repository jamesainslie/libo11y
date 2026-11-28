/**
 * Action names and element selectors (design, Privacy). A name is the data-o11y label on the
 * element or its closest ancestor, else the aria-label of an interactive element, never visible
 * text, and nothing inside [data-o11y-mask]. A selector identifies the element by structure: an ID
 * that is not ID-like, a data-o11y label, or a short path of tags, stable classes and positions.
 */

/** What an action acts on: the closest of these to the event target. */
export const INTERACTIVE =
  "button,a,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[data-o11y]";
const MAX_NAME = 64;
const MAX_SELECTOR = 200;
const MAX_STEPS = 5;
/** An ID or class with a run of three digits, or any digit for classes, looks generated or user-specific. */
const ID_LIKE = /\d{3}/;

export type CssEscape = (s: string) => string;

function defaultEscape(): CssEscape {
  const css = (globalThis as { CSS?: { escape?: CssEscape } }).CSS;
  return css?.escape === undefined ? (s) => s.replace(/["\\]/g, "\\$&") : (s) => css.escape?.(s) ?? s;
}

/** The element a click acts on: the closest interactive element, else the target itself. */
export function actionTarget(el: Element): Element {
  return el.closest(INTERACTIVE) ?? el;
}

/** The action's name, at most 64 characters, or undefined when there is no privacy-safe one. */
export function actionName(el: Element): string | undefined {
  if (el.closest("[data-o11y-mask]") !== null) return undefined;
  const labelled = el.closest("[data-o11y]")?.getAttribute("data-o11y");
  const name = labelled ?? (el.matches(INTERACTIVE) ? el.getAttribute("aria-label") : null);
  const trimmed = name?.replace(/\s+/g, " ").trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed.slice(0, MAX_NAME);
}

function stableId(el: Element): boolean {
  return el.id !== "" && !ID_LIKE.test(el.id);
}

function step(el: Element, esc: CssEscape): string {
  const tag = el.tagName.toLowerCase();
  const cls = [...el.classList]
    .filter((c) => !/\d/.test(c))
    .slice(0, 2)
    .map((c) => `.${esc(c)}`)
    .join("");
  const parent = el.parentElement;
  if (parent === null) return tag + cls;
  const same = [...parent.children].filter((c) => c.tagName === el.tagName);
  return same.length > 1 ? `${tag}${cls}:nth-of-type(${same.indexOf(el) + 1})` : tag + cls;
}

/** A short CSS selector for el, at most 200 characters. */
export function elementSelector(el: Element, esc: CssEscape = defaultEscape()): string {
  if (stableId(el)) return `#${esc(el.id)}`;
  const label = el.getAttribute("data-o11y");
  if (label !== null && el.closest("[data-o11y-mask]") === null) return `[data-o11y="${esc(label)}"]`;
  const steps: string[] = [];
  for (let cur: Element | null = el; cur !== null && steps.length < MAX_STEPS; cur = cur.parentElement) {
    if (stableId(cur)) {
      steps.unshift(`#${esc(cur.id)}`);
      break;
    }
    steps.unshift(step(cur, esc));
    if (cur.tagName === "BODY") break;
  }
  return steps.join(" > ").slice(0, MAX_SELECTOR);
}
