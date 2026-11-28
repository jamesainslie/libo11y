/**
 * The DOM-backed ScrubContext: what the scrubber needs to know about a node it cannot see in the
 * event itself, read from the live page through rrweb's mirror (getNode is wired to
 * record.mirror.getNode). The collector must scrub synchronously inside rrweb's emit callback,
 * while the DOM still matches the event: a node read later may have moved or been detached.
 *
 * Every question walks the node's element and its composed ancestors: a slotted element continues
 * at its slot, an element at the top of a shadow tree at the host, and the root of a same-origin
 * iframe's document at the iframe element. So a mask or block on a host, around a slot or on an
 * iframe covers what renders inside it. A text node's element is its parent element, or the host
 * when its parent is a shadow root.
 *
 * - blocked(id): under a block selector (FIXED_BLOCK, code, remote).
 * - textAllowed(id), in this order: false when blocked, false under a mask selector, false for a
 *   style or link element itself (its text attributes, and a text change aimed at its own ID, are
 *   masked), true for a text node in a style element (so CSS survives; the scrubber strips its
 *   URLs), true under an unmask selector when the code's unmask list is not empty, false
 *   otherwise. Markup never unmasks: data-o11y-unmask counts only when the code lists it.
 * - stylesheetAllowed(id): true for a style or link element under no block or mask selector, so
 *   its inlined stylesheet survives, URLs stripped. False for every other node.
 * - editable(id): isContentEditable, a document in designMode, or under a textarea or a
 *   contenteditable element.
 *
 * Every answer fails closed. An unknown or detached node is not allowed and not editable (the
 * scrubber masks it). A selector that throws, or a walk longer than MAX_HOPS, counts as blocked,
 * masked and editable, and never as unmasked.
 */
import type { ReplayPolicy } from "./policy.ts";
import type { ScrubContext } from "./scrub.ts";

const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"])';
const STYLESHEET_TAGS: ReadonlySet<string> = new Set(["style", "link"]);
/** The longest composed ancestor walk. A longer one fails closed. */
export const MAX_HOPS = 4096;

const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

type Walk = "match" | "none" | "unknown";

/** The element a node's text and attributes belong to, or null when it has none. */
function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  if (node.nodeType === 1) return node as Element;
  if (node.parentElement !== null) return node.parentElement;
  const parent = node.parentNode as (Node & { host?: Element }) | null;
  return parent !== null && parent.nodeType === 11 && parent.host !== undefined ? parent.host : null;
}

/** el's parent in the composed tree, across slots, shadow roots and same-origin iframes. */
function composedParent(el: Element): Element | null {
  const slot = (el as Element & { assignedSlot?: Element | null }).assignedSlot;
  if (slot !== null && slot !== undefined) return slot;
  if (el.parentElement !== null) return el.parentElement;
  const root = el.getRootNode() as Node & { host?: Element; defaultView?: Window | null };
  if (root.nodeType === 11 && root.host !== undefined) return root.host;
  if (root.nodeType === 9) return (root.defaultView?.frameElement as Element | null | undefined) ?? null;
  return null;
}

/** Whether el or a composed ancestor matches selectors. "unknown" when a selector throws or the walk is too long. */
function walk(start: Element, selectors: string): Walk {
  if (selectors === "") return "none";
  try {
    let el: Element | null = start;
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      if (el === null) return "none";
      if (el.matches(selectors)) return "match";
      el = composedParent(el);
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** A ScrubContext over the live DOM. getNode resolves an rrweb node id. See the file comment. */
export function domScrubContext(policy: ReplayPolicy, getNode: (id: number) => Node | null): ScrubContext {
  const block = policy.block.join(",");
  const mask = policy.mask.join(",");
  const unmask = policy.unmask.join(",");
  const element = (id: number): Element | null => {
    try {
      return elementOf(getNode(id));
    } catch {
      return null;
    }
  };
  return {
    blocked(id: number): boolean {
      const el = element(id);
      return el !== null && walk(el, block) !== "none";
    },
    textAllowed(id: number): boolean {
      let node: Node | null;
      try {
        node = getNode(id);
      } catch {
        return false;
      }
      const el = element(id);
      if (node === null || el === null) return false;
      if (walk(el, block) !== "none" || walk(el, mask) !== "none") return false;
      const tag = lower(el.tagName);
      if (node.nodeType === 1 && STYLESHEET_TAGS.has(tag)) return false;
      if (node.nodeType === 3 && tag === "style" && node.parentElement === el) return true;
      return walk(el, unmask) === "match";
    },
    stylesheetAllowed(id: number): boolean {
      let node: Node | null;
      try {
        node = getNode(id);
      } catch {
        return false;
      }
      if (node === null || node.nodeType !== 1) return false;
      const el = node as Element;
      if (!STYLESHEET_TAGS.has(lower(el.tagName))) return false;
      return walk(el, block) === "none" && walk(el, mask) === "none";
    },
    parentTag(id: number): string | undefined {
      try {
        const tag = getNode(id)?.parentElement?.tagName;
        return tag === undefined ? undefined : lower(tag);
      } catch {
        return undefined;
      }
    },
    editable(id: number): boolean {
      const el = element(id);
      if (el === null) return false;
      try {
        if ((el as HTMLElement).isContentEditable === true) return true;
        if (el.ownerDocument?.designMode === "on") return true;
      } catch {
        return true;
      }
      return walk(el, EDITABLE) !== "none";
    },
  };
}
