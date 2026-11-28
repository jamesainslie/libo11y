/**
 * The event scrubber: libo11y's own, authoritative pass over every rrweb event before it is
 * buffered (design decision P2). rrweb's options are a first line only; nothing here trusts them.
 * Everything is an allow-list, so a field, attribute, event type or source rrweb adds later is
 * dropped rather than leaked. The gateway runs the same rules in Go from the shared vectors in
 * conformance/rum-replay.
 *
 * Events:
 * - Kept types: 0 DomContentLoaded and 1 Load (with empty data), 2 FullSnapshot, 3
 *   IncrementalSnapshot and 4 Meta. Custom (5), Plugin (6), Asset (7), Annotation (8) and any
 *   other type are dropped. An event keeps only type, timestamp and data.
 * - Incremental sources dropped: Input (5), CanvasMutation (9), Font (10), Log (11) and any source
 *   not listed in incremental(). The rest keep only their own fields, numbers as numbers.
 * - Meta keeps href after stripUrl, width and height.
 *
 * Nodes (a full snapshot's tree, the node of each added-node mutation):
 * - Each node keeps only the fields of its type. A node without a numeric id or of an unknown type
 *   is dropped.
 * - Text is masked (maskText) unless the context allows it. Text under script is "". Text that is
 *   editable (under a textarea or a contenteditable element, or editable by the context) is "".
 *   Text under style follows the same rule and, when kept, has its URLs stripped.
 * - Within one tree, the fixed rules hold whatever the context says: everything under input,
 *   textarea, select, option, a contenteditable element or [data-o11y-mask] is masked, and an
 *   element with data-o11y-block keeps only its class and rrweb's size, and no children.
 * - Comments and CDATA have their text emptied.
 * - Attributes follow the allow-list in policy.ts. Masked attributes follow their element's text
 *   rule; the inlined stylesheet (_cssText) is kept, URLs stripped, only when its element's text is
 *   allowed.
 * - Trees deeper than MAX_DEPTH lose the children past it.
 *
 * Mutations: text changes follow the text rule of their node, attribute changes the attribute rules
 * (a removal, null, is kept only for an attribute the scrubber would keep; a style diff keeps its
 * properties with URLs stripped), removes and adds keep their own fields.
 *
 * The scrubber never mutates its input. It returns new objects.
 */
import { stripCssUrls } from "./css.ts";
import { maskText } from "./mask.ts";
import {
  CSS_ATTRIBUTES,
  KEPT_ATTRIBUTES,
  MASKED_ATTRIBUTES,
  type ReplayPolicy,
  URL_ATTRIBUTES,
} from "./policy.ts";
import { stripSrcset, stripUrl } from "./urls.ts";

/** An rrweb event: eventWithTime from @rrweb/types, read structurally. */
export type RrwebEvent = { readonly type: number; readonly timestamp: number; readonly data?: unknown };

/** What the scrubber needs to know about the live page. The DOM-backed context is dom-context.ts. */
export interface ScrubContext {
  /** True when the text and masked attributes of node id may be kept: under the unmask list, not under a mask or block selector. */
  textAllowed(id: number): boolean;
  /** The lowercase tag name of the parent element of node id, or undefined. */
  parentTag(id: number): string | undefined;
  /** True when node id is user-editable content (in a textarea or a contenteditable element), whose text is never recorded. */
  editable(id: number): boolean;
}

/** Trees are cut below this depth, so a pathological page cannot overflow the stack. */
export const MAX_DEPTH = 1000;

const FIXED_MASK_TAGS: ReadonlySet<string> = new Set(["input", "textarea", "select", "option"]);

type Json = Record<string, unknown>;
type Mutable = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The fields of o named in keys whose values are finite numbers. */
function numbers(o: Json, keys: readonly string[]): Mutable {
  const out: Mutable = {};
  for (const k of keys) if (isNum(o[k])) out[k] = o[k];
  return out;
}

/** The fields of o named in keys whose values are booleans. */
function booleans(o: Json, keys: readonly string[]): Mutable {
  const out: Mutable = {};
  for (const k of keys) if (typeof o[k] === "boolean") out[k] = o[k];
  return out;
}

const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** How a text value is recorded, given what is known about its node. */
interface TextRule {
  readonly parentTag: string | undefined;
  readonly allowed: boolean;
  readonly editable: boolean;
}

function textValue(value: string, rule: TextRule, policy: ReplayPolicy): string {
  if (rule.parentTag === "script" || rule.parentTag === "textarea" || rule.editable) return "";
  if (!rule.allowed) return maskText(value);
  return rule.parentTag === "style" ? stripCssUrls(value, policy.queryAllowList) : value;
}

function styleDiff(diff: Json, policy: ReplayPolicy): Mutable {
  const out: Mutable = {};
  for (const [prop, v] of Object.entries(diff)) {
    if (typeof v === "string") out[prop] = stripCssUrls(v, policy.queryAllowList);
    else if (v === false) out[prop] = false;
    else if (Array.isArray(v) && typeof v[0] === "string") {
      out[prop] = [stripCssUrls(v[0], policy.queryAllowList), typeof v[1] === "string" ? v[1] : ""];
    }
  }
  return out;
}

/**
 * attrs reduced to the allow-list. textAllowed decides masked attributes, cssAllowed the inlined
 * stylesheet. A null value (a removal in a mutation) is kept for a known attribute when removals
 * is true.
 */
function attributes(
  attrs: Json,
  textAllowed: boolean,
  cssAllowed: boolean,
  removals: boolean,
  policy: ReplayPolicy,
): Mutable {
  const out: Mutable = {};
  const allow = policy.queryAllowList;
  for (const [name, value] of Object.entries(attrs)) {
    const key = lower(name);
    const known =
      KEPT_ATTRIBUTES.has(key) ||
      MASKED_ATTRIBUTES.has(key) ||
      URL_ATTRIBUTES.has(key) ||
      CSS_ATTRIBUTES.has(key) ||
      key === "_csstext";
    if (!known) continue;
    if (value === null) {
      if (removals) out[name] = null;
      continue;
    }
    if (MASKED_ATTRIBUTES.has(key)) {
      if (typeof value === "string") out[name] = textAllowed ? value : maskText(value);
    } else if (URL_ATTRIBUTES.has(key)) {
      if (typeof value === "string")
        out[name] = key === "srcset" ? stripSrcset(value, allow) : stripUrl(value, allow);
    } else if (CSS_ATTRIBUTES.has(key)) {
      if (typeof value === "string") out[name] = stripCssUrls(value, allow);
      else if (key === "style" && removals && isObj(value)) out[name] = styleDiff(value, policy);
    } else if (key === "_csstext") {
      if (typeof value === "string" && cssAllowed) out[name] = stripCssUrls(value, allow);
    } else if (typeof value === "string" || isNum(value) || typeof value === "boolean") {
      out[name] = value;
    }
  }
  return out;
}

/** Where a node sits in the tree being scrubbed. */
interface TreeState {
  readonly parentTag: string | undefined;
  readonly masked: boolean;
  readonly editable: boolean;
  readonly depth: number;
}

function attr(attrs: Json, name: string): unknown {
  for (const [k, v] of Object.entries(attrs)) if (lower(k) === name) return v;
  return undefined;
}

function common(n: Json, id: number): Mutable {
  const out: Mutable = { type: n.type, id };
  if (isNum(n.rootId)) out.rootId = n.rootId;
  if (typeof n.isShadowHost === "boolean") out.isShadowHost = n.isShadowHost;
  if (typeof n.isShadow === "boolean") out.isShadow = n.isShadow;
  return out;
}

function children(n: Json, state: TreeState, policy: ReplayPolicy, ctx: ScrubContext): unknown[] {
  if (state.depth >= MAX_DEPTH) return [];
  const out: unknown[] = [];
  for (const c of list(n.childNodes)) {
    const s = node(c, state, policy, ctx);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function node(n: unknown, state: TreeState, policy: ReplayPolicy, ctx: ScrubContext): Mutable | undefined {
  if (!isObj(n) || !isNum(n.id)) return undefined;
  const id = n.id;
  const out = common(n, id);
  const next = { ...state, depth: state.depth + 1 };
  switch (n.type) {
    case 0:
      if (typeof n.compatMode === "string") out.compatMode = n.compatMode;
      out.childNodes = children(n, { ...next, parentTag: undefined }, policy, ctx);
      return out;
    case 1:
      for (const k of ["name", "publicId", "systemId"]) out[k] = typeof n[k] === "string" ? n[k] : "";
      return out;
    case 2: {
      if (typeof n.tagName !== "string") return undefined;
      const tag = lower(n.tagName);
      const attrs = isObj(n.attributes) ? n.attributes : {};
      const ce = attr(attrs, "contenteditable");
      const editable =
        state.editable ||
        tag === "textarea" ||
        (ce !== undefined && ce !== null && lower(String(ce)) !== "false");
      const masked =
        state.masked || editable || FIXED_MASK_TAGS.has(tag) || attr(attrs, "data-o11y-mask") !== undefined;
      const allowed = !masked && ctx.textAllowed(id);
      let kept = attributes(attrs, allowed && !ctx.editable(id), allowed, false, policy);
      const blocked = attr(attrs, "data-o11y-block") !== undefined;
      if (blocked) {
        const reduced: Mutable = {};
        for (const k of ["class", "rr_width", "rr_height"])
          if (typeof kept[k] === "string") reduced[k] = kept[k];
        kept = reduced;
      }
      out.tagName = n.tagName;
      out.attributes = kept;
      out.childNodes = blocked
        ? []
        : children(n, { parentTag: tag, masked, editable, depth: next.depth }, policy, ctx);
      if (n.isSVG === true) out.isSVG = true;
      if (typeof n.needBlock === "boolean") out.needBlock = n.needBlock;
      if (n.isCustom === true) out.isCustom = true;
      return out;
    }
    case 3: {
      const parentTag = state.depth === 0 ? ctx.parentTag(id) : state.parentTag;
      const rule: TextRule = {
        parentTag,
        allowed: !state.masked && ctx.textAllowed(id),
        editable: state.editable || ctx.editable(id),
      };
      out.textContent = typeof n.textContent === "string" ? textValue(n.textContent, rule, policy) : "";
      if (n.isStyle === true && parentTag === "style") out.isStyle = true;
      return out;
    }
    case 4:
    case 5:
      out.textContent = "";
      return out;
    default:
      return undefined;
  }
}

const ROOT: TreeState = { parentTag: undefined, masked: false, editable: false, depth: 0 };

function rule(r: unknown, allow: ReadonlySet<string>): Mutable | undefined {
  if (!isObj(r) || typeof r.rule !== "string") return undefined;
  const out: Mutable = { rule: stripCssUrls(r.rule, allow) };
  if (isNum(r.index) || (Array.isArray(r.index) && r.index.every(isNum))) out.index = r.index;
  return out;
}

function defined<T>(xs: readonly (T | undefined)[]): T[] {
  return xs.filter((x): x is T => x !== undefined);
}

function mutationData(data: Json, policy: ReplayPolicy, ctx: ScrubContext): Mutable {
  const texts = defined(
    list(data.texts).map((t) => {
      if (!isObj(t) || !isNum(t.id)) return undefined;
      if (t.value === null) return { id: t.id, value: null };
      if (typeof t.value !== "string") return undefined;
      const r: TextRule = {
        parentTag: ctx.parentTag(t.id),
        allowed: ctx.textAllowed(t.id),
        editable: ctx.editable(t.id),
      };
      return { id: t.id, value: textValue(t.value, r, policy) };
    }),
  );
  const attrs = defined(
    list(data.attributes).map((a) => {
      if (!isObj(a) || !isNum(a.id) || !isObj(a.attributes)) return undefined;
      const allowed = ctx.textAllowed(a.id);
      const kept = attributes(a.attributes, allowed && !ctx.editable(a.id), allowed, true, policy);
      return Object.keys(kept).length > 0 ? { id: a.id, attributes: kept } : undefined;
    }),
  );
  const removes = defined(
    list(data.removes).map((r) => {
      if (!isObj(r) || !isNum(r.parentId) || !isNum(r.id)) return undefined;
      return { parentId: r.parentId, id: r.id, ...booleans(r, ["isShadow"]) };
    }),
  );
  const adds = defined(
    list(data.adds).map((a) => {
      if (!isObj(a) || !isNum(a.parentId)) return undefined;
      const n = node(a.node, ROOT, policy, ctx);
      if (n === undefined) return undefined;
      const out: Mutable = { parentId: a.parentId, nextId: isNum(a.nextId) ? a.nextId : null };
      if (isNum(a.previousId) || a.previousId === null) out.previousId = a.previousId;
      out.node = n;
      return out;
    }),
  );
  return {
    source: 0,
    texts,
    attributes: attrs,
    removes,
    adds,
    ...(data.isAttachIframe === true ? { isAttachIframe: true } : {}),
  };
}

function positions(data: Json): Mutable[] {
  return defined(
    list(data.positions).map((p) => {
      if (!isObj(p)) return undefined;
      const kept = numbers(p, ["x", "y", "id", "timeOffset"]);
      return Object.keys(kept).length === 4 ? kept : undefined;
    }),
  );
}

/** An incremental snapshot's data reduced to the fields of its source, or undefined to drop it. */
function incremental(data: Json, policy: ReplayPolicy, ctx: ScrubContext): Mutable | undefined {
  const allow = policy.queryAllowList;
  const source = data.source;
  switch (source) {
    case 0:
      return mutationData(data, policy, ctx);
    case 1:
    case 6:
    case 12:
      return { source, positions: positions(data) };
    case 2:
      return { source, ...numbers(data, ["type", "id", "x", "y", "pointerType"]) };
    case 3:
      return { source, ...numbers(data, ["id", "x", "y"]) };
    case 4:
      return { source, ...numbers(data, ["width", "height"]) };
    case 7:
      return {
        source,
        ...numbers(data, ["type", "id", "currentTime", "volume", "playbackRate"]),
        ...booleans(data, ["muted", "loop"]),
      };
    case 8: {
      const out: Mutable = { source, ...numbers(data, ["id", "styleId"]) };
      if (Array.isArray(data.adds)) out.adds = defined(data.adds.map((r) => rule(r, allow)));
      if (Array.isArray(data.removes)) {
        out.removes = defined(
          data.removes.map((r) =>
            isObj(r) && (isNum(r.index) || (Array.isArray(r.index) && r.index.every(isNum)))
              ? { index: r.index }
              : undefined,
          ),
        );
      }
      if (typeof data.replace === "string") out.replace = stripCssUrls(data.replace, allow);
      if (typeof data.replaceSync === "string") out.replaceSync = stripCssUrls(data.replaceSync, allow);
      return out;
    }
    case 13: {
      const out: Mutable = { source, ...numbers(data, ["id", "styleId"]) };
      out.index = list(data.index).filter(isNum);
      if (isObj(data.set) && typeof data.set.property === "string") {
        const v = data.set.value;
        out.set = {
          property: data.set.property,
          value: typeof v === "string" ? stripCssUrls(v, allow) : null,
          ...(typeof data.set.priority === "string" ? { priority: data.set.priority } : {}),
        };
      }
      if (isObj(data.remove) && typeof data.remove.property === "string")
        out.remove = { property: data.remove.property };
      return out;
    }
    case 14:
      return {
        source,
        ranges: defined(
          list(data.ranges).map((r) => {
            if (!isObj(r)) return undefined;
            const kept = numbers(r, ["start", "startOffset", "end", "endOffset"]);
            return Object.keys(kept).length === 4 ? kept : undefined;
          }),
        ),
      };
    case 15: {
      const out: Mutable = { source, ...numbers(data, ["id"]), styleIds: list(data.styleIds).filter(isNum) };
      if (Array.isArray(data.styles)) {
        out.styles = defined(
          data.styles.map((s) =>
            isObj(s) && isNum(s.styleId)
              ? { styleId: s.styleId, rules: defined(list(s.rules).map((r) => rule(r, allow))) }
              : undefined,
          ),
        );
      }
      return out;
    }
    case 16:
      return {
        source,
        ...(isObj(data.define) && typeof data.define.name === "string"
          ? { define: { name: data.define.name } }
          : {}),
      };
    default:
      return undefined;
  }
}

/** event with the privacy rules applied, or undefined when it must not be recorded. See the file comment. */
export function scrubEvent(
  event: RrwebEvent,
  policy: ReplayPolicy,
  ctx: ScrubContext,
): RrwebEvent | undefined {
  if (!isObj(event) || !isNum(event.type) || !isNum(event.timestamp)) return undefined;
  const { type, timestamp } = event;
  const data = isObj(event.data) ? event.data : {};
  switch (type) {
    case 0:
    case 1:
      return { type, timestamp, data: {} };
    case 2: {
      const root = node(data.node, ROOT, policy, ctx);
      if (root === undefined) return undefined;
      const offset = isObj(data.initialOffset) ? numbers(data.initialOffset, ["top", "left"]) : {};
      return { type, timestamp, data: { node: root, initialOffset: { top: 0, left: 0, ...offset } } };
    }
    case 3: {
      const out = incremental(data, policy, ctx);
      return out === undefined ? undefined : { type, timestamp, data: out };
    }
    case 4:
      return {
        type,
        timestamp,
        data: {
          href: typeof data.href === "string" ? stripUrl(data.href, policy.queryAllowList) : "",
          ...numbers(data, ["width", "height"]),
        },
      };
    default:
      return undefined;
  }
}
