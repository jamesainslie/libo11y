/**
 * The DOM-backed ScrubContext: what the scrubber needs to know about a node it cannot see in the
 * event itself, read from the live page through rrweb's mirror (R6b wires getNode to
 * record.mirror.getNode).
 *
 * textAllowed(id) takes the node's element (a text node's parent element, or the host when its
 * parent is a shadow root) and decides, in this order:
 * 1. false under a block selector, then false under a mask selector (FIXED_MASK, code, remote);
 * 2. true for a style or link element, so stylesheets survive (their URLs are still stripped);
 * 3. true under an unmask selector, and only when the code's unmask list is not empty;
 * 4. false otherwise.
 * "Under" is composed: the walk continues from a shadow root to its host and from a same-origin
 * iframe's document to the iframe element, so a mask or block on a host or an iframe covers what is
 * inside it. Markup never unmasks: data-o11y-unmask counts only when the code lists it. An unknown
 * node, a detached node or a selector that throws is never allowed.
 *
 * editable(id) is true inside a textarea or a contenteditable element (composed the same way), for
 * an element whose isContentEditable is true, and in a document in designMode.
 */
import type { ReplayPolicy } from "./policy.ts";
import type { ScrubContext } from "./scrub.ts";

const EDITABLE = 'textarea, [contenteditable]:not([contenteditable="false"])';
const STYLESHEET_TAGS: ReadonlySet<string> = new Set(["style", "link"]);

const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The element a node's text and attributes belong to, or null when it has none. */
function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  if (node.nodeType === 1) return node as Element;
  if (node.parentElement !== null) return node.parentElement;
  const parent = node.parentNode as (Node & { host?: Element }) | null;
  return parent !== null && parent.nodeType === 11 && parent.host !== undefined ? parent.host : null;
}

/** Whether el or an ancestor, across shadow roots and same-origin iframes, matches selectors. Throws on a bad selector. */
function composedClosest(start: Element, selectors: string): boolean {
  let el: Element | null = start;
  for (let hops = 0; el !== null && hops < 64; hops++) {
    if (el.closest(selectors) !== null) return true;
    const root = el.getRootNode() as Node & { host?: Element; defaultView?: Window | null };
    if (root.nodeType === 11 && root.host !== undefined) {
      el = root.host;
    } else if (root.nodeType === 9) {
      el = (root.defaultView?.frameElement as Element | null | undefined) ?? null;
    } else {
      el = null;
    }
  }
  return false;
}

/** A ScrubContext over the live DOM. getNode resolves an rrweb node id. See the file comment. */
export function domScrubContext(policy: ReplayPolicy, getNode: (id: number) => Node | null): ScrubContext {
  const block = policy.block.join(",");
  const mask = policy.mask.join(",");
  const unmask = policy.unmask.join(",");
  const get = (id: number): Node | null => {
    try {
      return getNode(id);
    } catch {
      return null;
    }
  };
  return {
    textAllowed(id: number): boolean {
      const el = elementOf(get(id));
      if (el === null) return false;
      try {
        if (block !== "" && composedClosest(el, block)) return false;
        if (composedClosest(el, mask)) return false;
        if (STYLESHEET_TAGS.has(lower(el.tagName))) return true;
        return unmask !== "" && composedClosest(el, unmask);
      } catch {
        return false;
      }
    },
    parentTag(id: number): string | undefined {
      const tag = get(id)?.parentElement?.tagName;
      return tag === undefined ? undefined : lower(tag);
    },
    editable(id: number): boolean {
      const el = elementOf(get(id));
      if (el === null) return false;
      try {
        if ((el as HTMLElement).isContentEditable === true) return true;
        if (el.ownerDocument?.designMode === "on") return true;
        return composedClosest(el, EDITABLE);
      } catch {
        // A context that cannot tell treats the node as editable: its text is dropped.
        return true;
      }
    },
  };
}
