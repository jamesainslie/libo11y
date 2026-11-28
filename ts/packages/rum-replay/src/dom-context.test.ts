/**
 * domScrubContext against a small fake DOM: elements match the selectors listed in their
 * `sels` (matches tests them), closest walks parentElement, and getRootNode returns a fake document or shadow root.
 * The browser spec (browser/privacy.pw.ts) runs the same context against Chromium's DOM.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { domScrubContext } from "./dom-context.ts";
import { resolvePolicy } from "./policy.ts";

interface FakeRoot {
  readonly nodeType: 9 | 11;
  readonly host?: FakeElement;
  readonly designMode?: string;
  readonly defaultView?: { readonly frameElement: FakeElement | null };
}

class FakeElement {
  readonly nodeType = 1;
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | FakeRoot | null = null;
  root: FakeRoot;
  isContentEditable = false;
  assignedSlot: FakeElement | null = null;
  readonly tagName: string;
  readonly sels: readonly string[];
  constructor(tagName: string, matches: readonly string[], root: FakeRoot) {
    this.tagName = tagName;
    this.sels = matches;
    this.root = root;
  }
  get ownerDocument(): FakeRoot {
    return this.root.nodeType === 9 ? this.root : (this.root.host?.ownerDocument ?? this.root);
  }
  getRootNode(): FakeRoot {
    return this.root;
  }
  matches(selectors: string): boolean {
    const parts = selectors.split(",").map((s) => s.trim());
    if (parts.includes("::bad")) throw new SyntaxError("bad selector");
    return parts.some((p) => this.sels.includes(p));
  }
  closest(selectors: string): FakeElement | null {
    const parts = selectors.split(",").map((s) => s.trim());
    if (parts.includes("::bad")) throw new SyntaxError("bad selector");
    for (let el: FakeElement | null = this; el !== null; el = el.parentElement) {
      if (parts.some((p) => el?.sels.includes(p))) return el;
    }
    return null;
  }
  add(child: FakeElement | FakeText): void {
    child.parentElement = this;
    child.parentNode = this;
    if (child instanceof FakeElement) child.root = this.root;
  }
}

class FakeText {
  readonly nodeType = 3;
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | FakeRoot | null = null;
}

const doc: FakeRoot = { nodeType: 9, designMode: "off", defaultView: { frameElement: null } };

function tree(): { nodes: Map<number, unknown>; text: (parent: FakeElement) => number } {
  const nodes = new Map<number, unknown>();
  let next = 100;
  return {
    nodes,
    text: (parent) => {
      const t = new FakeText();
      parent.add(t);
      nodes.set(next, t);
      return next++;
    },
  };
}

const ctxFor = (unmask: readonly string[], nodes: Map<number, unknown>, mask: readonly string[] = []) =>
  domScrubContext(
    resolvePolicy({ unmask, mask }, new Set()),
    (id) => (nodes.get(id) as Node | undefined) ?? null,
  );

test("text under an unmask selector is allowed only when the code lists the selector", () => {
  const { nodes, text } = tree();
  const pub = new FakeElement("P", [".public", "[data-o11y-unmask]"], doc);
  const id = text(pub);
  assert.equal(ctxFor([".public"], nodes).textAllowed(id), true);
  assert.equal(ctxFor([], nodes).textAllowed(id), false);
  // The element carries data-o11y-unmask, but markup alone does not unmask.
  assert.equal(ctxFor([".other"], nodes).textAllowed(id), false);
  assert.equal(ctxFor(["[data-o11y-unmask]"], nodes).textAllowed(id), true);
});

test("mask and block win over unmask, the fixed ones and the code ones", () => {
  const { nodes, text } = tree();
  const pub = new FakeElement("DIV", [".public"], doc);
  const masked = new FakeElement("SPAN", ["[data-o11y-mask]"], doc);
  const input = new FakeElement("INPUT", ["input"], doc);
  const secret = new FakeElement("SPAN", [".secret"], doc);
  const blocked = new FakeElement("DIV", ["[data-o11y-block]"], doc);
  for (const c of [masked, input, secret, blocked]) pub.add(c);
  const ctx = ctxFor([".public"], nodes, [".secret"]);
  for (const el of [masked, input, secret, blocked])
    assert.equal(ctx.textAllowed(text(el)), false, el.tagName);
  assert.equal(ctx.textAllowed(text(pub)), true);
});

test("a masked shadow host masks its shadow content, even an unmasked element inside it", () => {
  const { nodes, text } = tree();
  const host = new FakeElement("X-CARD", ["[data-o11y-mask]"], doc);
  const shadow: FakeRoot = { nodeType: 11, host };
  const inner = new FakeElement("P", [".public"], shadow);
  const id = text(inner);
  assert.equal(ctxFor([".public"], nodes).textAllowed(id), false);
});

test("an unmasked shadow host unmasks its shadow content", () => {
  const { nodes, text } = tree();
  const host = new FakeElement("X-CARD", [".public"], doc);
  const inner = new FakeElement("P", [], { nodeType: 11, host });
  assert.equal(ctxFor([".public"], nodes).textAllowed(text(inner)), true);
});

test("a text node directly in a shadow root follows the host", () => {
  const nodes = new Map<number, unknown>();
  const host = new FakeElement("X-CARD", ["[data-o11y-mask]"], doc);
  const shadow: FakeRoot = { nodeType: 11, host };
  const t = new FakeText();
  t.parentNode = shadow;
  nodes.set(1, t);
  const ctx = ctxFor(["*"], nodes);
  assert.equal(ctx.textAllowed(1), false);
});

test("a masked iframe masks its document, even an unmasked element inside it", () => {
  const { nodes, text } = tree();
  const frame = new FakeElement("IFRAME", ["[data-o11y-mask]"], doc);
  const frameDoc: FakeRoot = { nodeType: 9, defaultView: { frameElement: frame } };
  const inner = new FakeElement("P", [".public"], frameDoc);
  assert.equal(ctxFor([".public"], nodes).textAllowed(text(inner)), false);
});

test("style text is allowed unless it is under a mask; script and others are not", () => {
  const { nodes, text } = tree();
  const style = new FakeElement("STYLE", [], doc);
  const maskedStyle = new FakeElement("STYLE", [], doc);
  new FakeElement("DIV", ["[data-o11y-mask]"], doc).add(maskedStyle);
  const link = new FakeElement("LINK", [], doc);
  nodes.set(1, link);
  const ctx = ctxFor([], nodes);
  assert.equal(ctx.textAllowed(text(style)), true);
  assert.equal(ctx.textAllowed(text(maskedStyle)), false);
  assert.equal(ctx.textAllowed(1), true);
  assert.equal(ctx.textAllowed(text(new FakeElement("SCRIPT", [], doc))), false);
});

test("editable content: textarea, contenteditable, isContentEditable and designMode", () => {
  const { nodes, text } = tree();
  const ta = new FakeElement("TEXTAREA", ["textarea"], doc);
  const ce = new FakeElement("DIV", ['[contenteditable]:not([contenteditable="false"])'], doc);
  const inherited = new FakeElement("SPAN", [], doc);
  inherited.isContentEditable = true;
  const plain = new FakeElement("P", [], doc);
  const ctx = ctxFor([], nodes);
  assert.equal(ctx.editable(text(ta)), true);
  assert.equal(ctx.editable(text(ce)), true);
  assert.equal(ctx.editable(text(inherited)), true);
  assert.equal(ctx.editable(text(plain)), false);
  const designDoc: FakeRoot = { nodeType: 9, designMode: "on", defaultView: { frameElement: null } };
  assert.equal(ctx.editable(text(new FakeElement("P", [], designDoc))), true);
});

test("unknown ids, detached nodes and selectors that throw are never allowed", () => {
  const { nodes, text } = tree();
  nodes.set(1, new FakeText());
  const pub = new FakeElement("P", [".public"], doc);
  const id = text(pub);
  const ctx = ctxFor([".public"], nodes);
  assert.equal(ctx.textAllowed(999), false);
  assert.equal(ctx.textAllowed(1), false);
  assert.equal(ctx.parentTag(999), undefined);
  assert.equal(ctxFor([".public", "::bad"], nodes).textAllowed(id), false);
  assert.equal(ctxFor([".public"], nodes, ["::bad"]).textAllowed(id), false);
});

test("parentTag is the lowercase tag of the parent element", () => {
  const { nodes, text } = tree();
  const id = text(new FakeElement("TEXTAREA", [], doc));
  assert.equal(ctxFor([], nodes).parentTag(id), "textarea");
});

test("blocked is composed across shadow roots and iframes and covers the code's block selectors", () => {
  const { nodes, text } = tree();
  const host = new FakeElement("X-CHAT", [".chat"], doc);
  const inner = new FakeElement("P", [".public"], { nodeType: 11, host });
  nodes.set(1, host);
  const ctx = domScrubContext(
    resolvePolicy({ unmask: [".public"], block: [".chat"] }, new Set()),
    (id) => (nodes.get(id) as Node | undefined) ?? null,
  );
  assert.equal(ctx.blocked(1), true);
  assert.equal(ctx.blocked(text(inner)), true);
  assert.equal(ctx.textAllowed(text(inner)), false);
  assert.equal(ctx.blocked(text(new FakeElement("P", [], doc))), false);
});

test("a walk past the hop limit fails closed: masked, blocked and editable, never unmasked", () => {
  const { nodes, text } = tree();
  let host = new FakeElement("DIV", ["[data-o11y-mask]"], doc);
  for (let i = 0; i < 5000; i++) {
    const next = new FakeElement("X-H", [], { nodeType: 11, host });
    host = next;
  }
  const inner = new FakeElement("P", [".public"], { nodeType: 11, host });
  const id = text(inner);
  const ctx = ctxFor([".public"], nodes);
  assert.equal(ctx.textAllowed(id), false);
  assert.equal(ctx.blocked(id), true);
  assert.equal(ctx.editable(id), true);
});

test("slotted light DOM follows its slot: a mask around the slot masks it", () => {
  const { nodes, text } = tree();
  const outer = new FakeElement("DIV", [".public"], doc);
  const host = new FakeElement("X-CARD", [], doc);
  outer.add(host);
  const shadow: FakeRoot = { nodeType: 11, host };
  const maskWrap = new FakeElement("DIV", ["[data-o11y-mask]"], shadow);
  const slot = new FakeElement("SLOT", [], shadow);
  maskWrap.add(slot);
  const slotted = new FakeElement("SPAN", [], doc);
  host.add(slotted);
  slotted.assignedSlot = slot;
  assert.equal(ctxFor([".public"], nodes).textAllowed(text(slotted)), false);
});
