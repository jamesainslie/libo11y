import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePolicy } from "./policy.ts";
import { type RrwebEvent, type ScrubContext, scrubEvent } from "./scrub.ts";

const policy = resolvePolicy(undefined, new Set(["page"]));
const none: ScrubContext = {
  textAllowed: () => false,
  parentTag: () => "p",
  editable: () => false,
  blocked: () => false,
};
const all: ScrubContext = {
  textAllowed: () => true,
  parentTag: () => "p",
  editable: () => false,
  blocked: () => false,
};

type Json = Record<string, unknown>;
const snapshot = (node: unknown): RrwebEvent => ({
  type: 2,
  timestamp: 1,
  data: { node, initialOffset: { top: 0, left: 0 } },
});
const el = (id: number, tagName: string, attributes: Json, childNodes: unknown[] = [], extra: Json = {}) => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes,
  ...extra,
});
const text = (id: number, textContent: string, extra: Json = {}) => ({ type: 3, id, textContent, ...extra });
const mutation = (data: Json): RrwebEvent => ({
  type: 3,
  timestamp: 1,
  data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data },
});
const scrubbed = (e: RrwebEvent, ctx: ScrubContext = none): string =>
  JSON.stringify(scrubEvent(e, policy, ctx));
const dataOf = (e: RrwebEvent | undefined): Json => {
  assert.ok(e, "the event was dropped");
  return e.data as Json;
};
const root = (e: RrwebEvent | undefined): Json => dataOf(e).node as Json;

test("text is masked by default", () => {
  const out = root(scrubEvent(snapshot(el(1, "p", {}, [text(2, "Jane Doe")])), policy, none));
  assert.deepEqual(out.childNodes, [{ type: 3, id: 2, textContent: "**** ***" }]);
});

test("allowed text is kept, allowed style text is kept, script text is emptied", () => {
  const ctx: ScrubContext = { ...none, textAllowed: (id) => id === 2 || id === 3 || id === 4 || id === 6 };
  const tree = el(9, "div", {}, [
    el(1, "p", {}, [text(2, "Welcome")]),
    el(3, "style", {}, [text(4, "a{color:red}", { isStyle: true })]),
    el(5, "script", {}, [text(6, "SCRIPT_PLACEHOLDER x()")]),
  ]);
  const out = scrubbed(snapshot(tree), ctx);
  assert.match(out, /"Welcome"/);
  assert.match(out, /a\{color:red\}/);
  assert.doesNotMatch(out, /x\(\)|SCRIPT_PLACEHOLDER/);
});

test("style text that is not allowed is masked: a style parent alone does not unmask", () => {
  const out = scrubbed(snapshot(el(3, "style", {}, [text(4, "secret")])));
  assert.doesNotMatch(out, /secret/);
});

test("allowed style text and inlined stylesheets have their URLs stripped", () => {
  const ctx: ScrubContext = { ...all };
  const tree = el(3, "style", { _cssText: "a{background:url(/a.png?token=SECRET1)}" }, [
    text(4, "b{background:url(data:image/png;base64,SECRET2)}", { isStyle: true }),
  ]);
  const out = scrubbed(snapshot(tree), ctx);
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /a\{background:url\(\\"\/a.png\\"\)\}/);
});

test("an inlined stylesheet is dropped when its element's text is not allowed", () => {
  const out = root(
    scrubEvent(snapshot(el(3, "style", { _cssText: "a::after{content:'Jane'}" })), policy, none),
  );
  assert.deepEqual(out.attributes, {});
});

test("input values and unknown attributes are removed, masked attributes masked, URLs stripped", () => {
  const out = root(
    scrubEvent(
      snapshot(
        el(1, "input", {
          type: "email",
          value: "jane@x.test",
          placeholder: "Email",
          "data-email": "j",
          onclick: "x()",
          src: "/a.png?token=1&page=3#f",
        }),
      ),
      policy,
      all,
    ),
  );
  assert.deepEqual(out.attributes, { type: "email", placeholder: "*****", src: "/a.png?page=3" });
});

test("attributes that carry text are masked: alt, title, placeholder, aria-label, label, content", () => {
  const attrs = {
    alt: "Jane Doe portrait",
    title: "Jane Doe",
    placeholder: "jane@x.test",
    "aria-label": "Jane Doe",
    "aria-valuetext": "Jane",
    label: "Jane",
    content: "Jane Doe",
    "ARIA-LABEL": "Jane Doe",
  };
  const out = scrubbed(snapshot(el(1, "img", attrs)));
  assert.doesNotMatch(out, /Jane|jane/);
  assert.match(out, /"alt":"\*\*\*\* \*\*\* \*\*\*\*\*\*\*\*"/);
});

test("masked attributes are kept only when the element's text is allowed", () => {
  const out = root(scrubEvent(snapshot(el(1, "img", { alt: "Logo", title: "Home" })), policy, all));
  assert.deepEqual(out.attributes, { alt: "Logo", title: "Home" });
});

test("input state, handlers, data attributes, srcdoc and rrweb pixel data are removed", () => {
  const attrs = {
    value: "SECRET",
    checked: true,
    selected: true,
    onclick: "steal('SECRET')",
    OnError: "SECRET",
    "data-user": "SECRET",
    srcdoc: "<p>SECRET</p>",
    rr_dataURL: "data:image/png;base64,SECRET",
    rr_src: "https://x.example/?SECRET",
    download: "SECRET.pdf",
    action: "/submit?SECRET",
    contenteditable: "true",
  };
  const out = root(scrubEvent(snapshot(el(1, "div", attrs)), policy, all));
  assert.deepEqual(out.attributes, {});
});

test("srcset, style and data URLs are stripped", () => {
  const attrs = {
    srcset: "data:image/png;base64,SECRET1 1x, /b.png?token=SECRET2 2x",
    style: "background-image:url('/avatar.png?u=SECRET3');color:red",
    href: "data:text/html,SECRET4",
    poster: "javascript:SECRET5",
    "xlink:href": "#icon",
  };
  const out = root(scrubEvent(snapshot(el(1, "img", attrs)), policy, none));
  assert.deepEqual(out.attributes, {
    srcset: "/b.png 2x",
    style: 'background-image:url("/avatar.png");color:red',
    href: "",
    poster: "",
    "xlink:href": "#icon",
  });
});

test("non-string values of URL, CSS and masked attributes are dropped", () => {
  const out = root(
    scrubEvent(snapshot(el(1, "a", { href: 3, style: true, title: 7, width: 10 })), policy, none),
  );
  assert.deepEqual(out.attributes, { width: 10 });
});

test("SVG text is masked and SVG geometry and references kept", () => {
  const tree = el(
    1,
    "svg",
    { viewBox: "0 0 10 10", xmlns: "http://www.w3.org/2000/svg" },
    [
      el(2, "text", { x: 1, y: 2 }, [text(3, "Jane Doe")], { isSVG: true }),
      el(4, "use", { href: "#icon-cart", fill: "url(#grad)" }, [], { isSVG: true }),
      el(5, "title", {}, [text(6, "Jane")], { isSVG: true }),
    ],
    { isSVG: true },
  );
  const out = scrubbed(snapshot(tree));
  assert.doesNotMatch(out, /Jane/);
  assert.match(out, /"viewBox":"0 0 10 10"/);
  assert.match(out, /"href":"#icon-cart"/);
  assert.match(out, /"fill":"url\(\\"#grad\\"\)"/);
});

test("text in shadow DOM follows its host: a masked host masks its shadow content", () => {
  const tree = el(1, "div", { "data-o11y-mask": "" }, [
    el(2, "x-card", {}, [el(3, "span", {}, [text(4, "Jane")], { isShadow: true })], { isShadowHost: true }),
  ]);
  // Even a context that allows the text cannot unmask it under a fixed mask in the same tree.
  const out = scrubbed(snapshot(tree), all);
  assert.doesNotMatch(out, /Jane/);
  assert.match(out, /"isShadowHost":true/);
  assert.match(out, /"isShadow":true/);
});

test("an iframe's document is scrubbed like the page, and a masked iframe masks it", () => {
  const doc = { type: 0, id: 10, childNodes: [el(11, "html", {}, [el(12, "body", {}, [text(13, "Jane")])])] };
  const page = el(1, "div", {}, [
    el(2, "iframe", { srcdoc: "<b>Jane</b>", src: "/frame?token=Jane" }, [doc]),
  ]);
  assert.doesNotMatch(scrubbed(snapshot(page)), /Jane/);
  const masked = el(1, "div", { "data-o11y-mask": "" }, [el(2, "iframe", {}, [doc])]);
  assert.doesNotMatch(scrubbed(snapshot(masked), all), /Jane/);
  // An iframe document added by a mutation is scrubbed too.
  assert.doesNotMatch(
    scrubbed(mutation({ adds: [{ parentId: 2, nextId: null, node: doc }], isAttachIframe: true })),
    /Jane/,
  );
});

test("fixed masks hold inside one tree whatever the context says", () => {
  const tree = el(1, "div", {}, [
    el(2, "select", {}, [el(3, "option", { value: "SECRET1", label: "SECRET2" }, [text(4, "SECRET3")])]),
    el(5, "span", { "data-o11y-mask": "" }, [el(6, "b", { title: "SECRET4" }, [text(7, "SECRET5")])]),
    el(8, "button", {}, [text(9, "Pay")]),
  ]);
  const out = scrubbed(snapshot(tree), all);
  assert.doesNotMatch(out, /SECRET/);
  assert.match(out, /"Pay"/);
});

test("markup alone cannot unmask: data-o11y-unmask is kept as an attribute and changes nothing", () => {
  const out = scrubbed(snapshot(el(1, "p", { "data-o11y-unmask": "" }, [text(2, "Jane Doe")])));
  assert.doesNotMatch(out, /Jane/);
  assert.match(out, /"data-o11y-unmask":""/);
});

test("textarea and contenteditable content is dropped, not just masked", () => {
  const tree = el(1, "form", {}, [
    el(2, "textarea", { value: "SECRET1" }, [text(3, "Dear Jane")]),
    el(4, "div", { contenteditable: "" }, [el(5, "p", {}, [text(6, "My diary")])]),
    el(7, "div", { contenteditable: "plaintext-only" }, [text(8, "notes")]),
    el(9, "div", { contenteditable: "TRUE" }, [
      el(10, "span", { contenteditable: "false" }, [text(11, "inner")]),
    ]),
    el(12, "div", { contenteditable: "false" }, [text(13, "Static")]),
  ]);
  const out = root(scrubEvent(snapshot(tree), policy, all));
  const kids = out.childNodes as Json[];
  const textOf = (n: Json | undefined): unknown => (n?.childNodes as Json[] | undefined)?.[0]?.textContent;
  assert.equal(textOf(kids[0]), "");
  assert.equal(textOf((kids[1]?.childNodes as Json[] | undefined)?.[0]), "");
  assert.equal(textOf(kids[2]), "");
  assert.equal(textOf((kids[3]?.childNodes as Json[] | undefined)?.[0]), "");
  assert.equal(textOf(kids[4]), "Static");
});

test("text the context says is editable is dropped, in a snapshot and in mutations", () => {
  const ctx: ScrubContext = { ...all, editable: (id) => id === 2 || id === 3 };
  assert.deepEqual(root(scrubEvent(snapshot(text(2, "typed")), policy, ctx)), {
    type: 3,
    id: 2,
    textContent: "",
  });
  const out = scrubbed(mutation({ texts: [{ id: 3, value: "typed more" }] }), ctx);
  assert.match(out, /"value":""/);
});

test("comments and CDATA lose their text", () => {
  const out = scrubbed(
    snapshot(
      el(1, "div", {}, [
        { type: 5, id: 2, textContent: "Jane" },
        { type: 4, id: 3, textContent: "Jane" },
      ]),
    ),
    all,
  );
  assert.doesNotMatch(out, /Jane/);
});

test("a blocked element keeps only its class and size, and none of its children", () => {
  const tree = el(
    1,
    "div",
    { "data-o11y-block": "", class: "ad", title: "Jane", rr_width: "10px", rr_height: "5px" },
    [text(2, "Jane")],
    {
      needBlock: true,
    },
  );
  const out = root(scrubEvent(snapshot(tree), policy, all));
  assert.deepEqual(out.attributes, { class: "ad", rr_width: "10px", rr_height: "5px" });
  assert.deepEqual(out.childNodes, []);
});

test("unknown node fields, unknown node types and malformed nodes are dropped", () => {
  const tree = el(
    1,
    "div",
    {},
    [
      text(2, "x", { secret: "Jane" }),
      { type: 9, id: 3, textContent: "Jane" },
      "Jane",
      { type: 3, textContent: "Jane" },
    ],
    {
      leak: "Jane",
    },
  );
  const out = root(scrubEvent(snapshot(tree), policy, all));
  assert.deepEqual(out, {
    type: 2,
    id: 1,
    tagName: "div",
    attributes: {},
    childNodes: [{ type: 3, id: 2, textContent: "x" }],
  });
});

test("document type and document nodes keep only their own fields", () => {
  const tree = {
    type: 0,
    id: 1,
    compatMode: "CSS1Compat",
    extra: "Jane",
    childNodes: [{ type: 1, id: 2, name: "html", publicId: "", systemId: "", x: "Jane" }],
  };
  assert.deepEqual(root(scrubEvent(snapshot(tree), policy, none)), {
    type: 0,
    id: 1,
    compatMode: "CSS1Compat",
    childNodes: [{ type: 1, id: 2, name: "html", publicId: "", systemId: "" }],
  });
});

test("input, canvas, font and log incremental events are dropped; custom, plugin, asset and annotation events too", () => {
  for (const source of [5, 9, 10, 11, 17, 99]) {
    assert.equal(
      scrubEvent(
        { type: 3, timestamp: 1, data: { source, id: 1, text: "SECRET", isChecked: false } },
        policy,
        all,
      ),
      undefined,
    );
  }
  for (const type of [5, 6, 7, 8, 9, -1])
    assert.equal(
      scrubEvent({ type, timestamp: 1, data: { tag: "x", payload: "SECRET" } }, policy, all),
      undefined,
    );
  assert.equal(scrubEvent({ type: 3, timestamp: 1, data: {} }, policy, all), undefined);
  assert.equal(
    scrubEvent(
      { type: 3, timestamp: "1" as unknown as number, data: { source: 3, id: 1, x: 0, y: 0 } },
      policy,
      all,
    ),
    undefined,
  );
});

test("pointer, scroll, viewport, media, selection and custom element events keep only their own numeric fields", () => {
  const cases: [Json, Json][] = [
    [
      { source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: -4, label: "Jane" }], x: "Jane" },
      { source: 1, positions: [{ x: 1, y: 2, id: 3, timeOffset: -4 }] },
    ],
    [
      { source: 2, type: 2, id: 5, x: 1, y: 2, pointerType: 0, text: "Jane" },
      { source: 2, type: 2, id: 5, x: 1, y: 2, pointerType: 0 },
    ],
    [
      { source: 3, id: 1, x: 0, y: 10, href: "Jane" },
      { source: 3, id: 1, x: 0, y: 10 },
    ],
    [
      { source: 4, width: 800, height: 600 },
      { source: 4, width: 800, height: 600 },
    ],
    [
      { source: 6, positions: [{ x: 1, y: "Jane", id: 3, timeOffset: 0 }] },
      { source: 6, positions: [] },
    ],
    [
      {
        source: 7,
        type: 0,
        id: 4,
        currentTime: 1.5,
        volume: 1,
        muted: false,
        loop: true,
        playbackRate: 1,
        src: "Jane",
      },
      { source: 7, type: 0, id: 4, currentTime: 1.5, volume: 1, muted: false, loop: true, playbackRate: 1 },
    ],
    [
      { source: 12, positions: [{ x: 1, y: 2, id: 3, timeOffset: 0 }] },
      { source: 12, positions: [{ x: 1, y: 2, id: 3, timeOffset: 0 }] },
    ],
    [
      { source: 14, ranges: [{ start: 1, startOffset: 0, end: 2, endOffset: 4, text: "Jane" }] },
      { source: 14, ranges: [{ start: 1, startOffset: 0, end: 2, endOffset: 4 }] },
    ],
    [
      { source: 16, define: { name: "x-card", extra: "Jane" } },
      { source: 16, define: { name: "x-card" } },
    ],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(
      scrubEvent({ type: 3, timestamp: 7, data: input }, policy, all),
      { type: 3, timestamp: 7, data: want },
      JSON.stringify(input),
    );
  }
});

test("CSSOM edits keep their rules with URLs stripped", () => {
  const rule = {
    source: 8,
    id: 3,
    adds: [{ rule: "a{background:url(/x.png?token=SECRET)}", index: 0 }],
    removes: [{ index: [1, 2] }],
    replaceSync: "@import '/t.css?token=SECRET';",
  };
  assert.deepEqual(scrubEvent({ type: 3, timestamp: 1, data: rule }, policy, none), {
    type: 3,
    timestamp: 1,
    data: {
      source: 8,
      id: 3,
      adds: [{ rule: 'a{background:url("/x.png")}', index: 0 }],
      removes: [{ index: [1, 2] }],
      replaceSync: '@import "/t.css";',
    },
  });
  const decl = {
    source: 13,
    styleId: 2,
    index: [0, 1],
    set: { property: "background", value: "url(data:image/png,SECRET)", priority: "" },
  };
  assert.deepEqual(scrubEvent({ type: 3, timestamp: 1, data: decl }, policy, none)?.data, {
    source: 13,
    styleId: 2,
    index: [0, 1],
    set: { property: "background", value: 'url("")', priority: "" },
  });
  const adopted = {
    source: 15,
    id: 1,
    styleIds: [4],
    styles: [{ styleId: 4, rules: [{ rule: "b{background:url(/y?token=SECRET)}" }] }],
  };
  assert.doesNotMatch(
    JSON.stringify(scrubEvent({ type: 3, timestamp: 1, data: adopted }, policy, none)),
    /SECRET/,
  );
});

test("mutations mask text changes and attribute changes", () => {
  const ev = mutation({
    texts: [{ id: 2, value: "Jane" }],
    attributes: [
      { id: 1, attributes: { title: "Jane", value: "x", style: { color: "red" }, href: "/u?email=j" } },
    ],
    adds: [{ parentId: 1, nextId: null, node: text(7, "Doe") }],
  });
  const out = scrubbed(ev);
  assert.doesNotMatch(out, /Jane|Doe|email|"value":"x"/);
  assert.match(out, /"color":"red"/);
  assert.match(out, /"href":"\/u"/);
});

test("a text mutation under script or textarea is emptied, under style it follows the CSS rule", () => {
  const ctx: ScrubContext = { ...all, parentTag: (id) => ({ 1: "script", 2: "textarea", 3: "style" })[id] };
  const out = scrubEvent(
    mutation({
      texts: [
        { id: 1, value: "x()" },
        { id: 2, value: "Dear Jane" },
        { id: 3, value: "a{background:url(/a?token=S)}" },
        { id: 4, value: null },
      ],
    }),
    policy,
    ctx,
  );
  assert.deepEqual(dataOf(out).texts, [
    { id: 1, value: "" },
    { id: 2, value: "" },
    { id: 3, value: 'a{background:url("/a")}' },
    { id: 4, value: null },
  ]);
});

test("attribute mutations keep removals of known attributes only, and strip style diffs", () => {
  const ev = mutation({
    attributes: [
      {
        id: 1,
        attributes: {
          title: null,
          "data-user-jane": null,
          style: { background: ["url(/a?token=SECRET)", "important"], color: false },
        },
      },
      { id: 2, attributes: { "data-ssn": "SECRET" } },
    ],
  });
  assert.deepEqual(dataOf(scrubEvent(ev, policy, none)).attributes, [
    { id: 1, attributes: { title: null, style: { background: ['url("/a")', "important"], color: false } } },
  ]);
});

test("attribute mutations mask text attributes unless the context allows the element's text", () => {
  const ev = mutation({ attributes: [{ id: 1, attributes: { "aria-label": "Jane" } }] });
  assert.match(scrubbed(ev, all), /"aria-label":"Jane"/);
  assert.match(scrubbed(ev, none), /"aria-label":"\*\*\*\*"/);
  assert.match(scrubbed(ev, { ...all, editable: () => true }), /"aria-label":"\*\*\*\*"/);
});

test("removes and adds keep only their own fields", () => {
  const ev = mutation({
    removes: [{ parentId: 1, id: 2, isShadow: true, text: "Jane" }],
    adds: [{ parentId: 1, nextId: null, previousId: 4, node: text(5, "x"), html: "Jane" }],
  });
  const out = dataOf(scrubEvent(ev, policy, all));
  assert.deepEqual(out.removes, [{ parentId: 1, id: 2, isShadow: true }]);
  assert.deepEqual(out.adds, [
    { parentId: 1, nextId: null, previousId: 4, node: { type: 3, id: 5, textContent: "x" } },
  ]);
});

test("meta href is stripped and only width and height kept", () => {
  const out = scrubEvent(
    {
      type: 4,
      timestamp: 1,
      data: { href: "https://jane:pw@shop.example/u/1?email=j&page=2#x", width: 1, height: 2, title: "Jane" },
    },
    policy,
    none,
  );
  assert.deepEqual(out, {
    type: 4,
    timestamp: 1,
    data: { href: "https://shop.example/u/1?page=2", width: 1, height: 2 },
  });
});

test("load events carry no data and unknown top-level fields are dropped", () => {
  assert.deepEqual(scrubEvent({ type: 0, timestamp: 1, data: { x: "Jane" } } as RrwebEvent, policy, all), {
    type: 0,
    timestamp: 1,
    data: {},
  });
  assert.deepEqual(
    scrubEvent({ type: 1, timestamp: 1, data: {}, delay: 3, extra: "Jane" } as RrwebEvent, policy, all),
    { type: 1, timestamp: 1, data: {} },
  );
});

test("a full snapshot without a valid root node is dropped", () => {
  assert.equal(scrubEvent({ type: 2, timestamp: 1, data: { node: "Jane" } }, policy, all), undefined);
  assert.equal(scrubEvent({ type: 2, timestamp: 1 }, policy, all), undefined);
});

test("very deep trees are cut rather than overflowing the stack", () => {
  let node: Json = text(100_000, "deep");
  for (let i = 0; i < 20_000; i++) node = el(i, "div", {}, [node]);
  const out = scrubEvent(snapshot(node), policy, all);
  assert.ok(out);
  assert.doesNotMatch(JSON.stringify(out), /deep/);
});

test("the input event object is not mutated", () => {
  const ev = snapshot(el(1, "p", { title: "Jane" }, [text(2, "Jane")]));
  const before = JSON.stringify(ev);
  scrubEvent(ev, policy, none);
  assert.equal(JSON.stringify(ev), before);
});

test("an element the context blocks (code or remote block selectors) is reduced to its placeholder", () => {
  const ctx: ScrubContext = { ...all, blocked: (id) => id === 1 };
  const tree = el(
    1,
    "div",
    { class: "chat-widget", id: "chat-jane.doe", rr_width: "10px", rr_height: "5px" },
    [el(2, "img", { src: "https://cdn.example/users/jane.doe/avatar.png" })],
  );
  const out = root(scrubEvent(snapshot(el(9, "main", {}, [tree])), policy, ctx));
  assert.deepEqual((out.childNodes as Json[])[0], {
    type: 2,
    id: 1,
    tagName: "div",
    attributes: { class: "chat-widget", rr_width: "10px", rr_height: "5px" },
    childNodes: [],
  });
});

test("mutations into a blocked element are dropped and its own attribute changes reduced", () => {
  const ctx: ScrubContext = { ...all, blocked: (id) => id === 20 || id === 21 || id === 22 };
  const ev = mutation({
    texts: [{ id: 22, value: "Jane" }],
    attributes: [
      {
        id: 20,
        attributes: {
          style: "background:url(/users/jane/photo.jpg)",
          id: "acct-99812",
          class: "box",
          href: "/u/jane",
        },
      },
      { id: 21, attributes: { title: "Jane" } },
    ],
    adds: [
      {
        parentId: 20,
        nextId: null,
        node: el(23, "img", { src: "https://cdn.example/patients/jane/xray.png", class: "x" }),
      },
      { parentId: 1, nextId: null, node: el(24, "p", {}) },
    ],
  });
  const out = dataOf(scrubEvent(ev, policy, ctx));
  assert.deepEqual(out.texts, []);
  assert.deepEqual(out.attributes, [{ id: 20, attributes: { class: "box" } }]);
  assert.deepEqual(
    (out.adds as Json[]).map((a) => a.parentId),
    [1],
  );
});

test("an element the context blocks inside an added subtree loses its children", () => {
  const ctx: ScrubContext = { ...all, blocked: (id) => id === 31 };
  const ev = mutation({
    adds: [
      {
        parentId: 1,
        nextId: null,
        node: el(30, "div", {}, [el(31, "div", { class: "ad" }, [text(32, "Jane")])]),
      },
    ],
  });
  assert.doesNotMatch(scrubbed(ev, ctx), /Jane|"id":32/);
});

test("URLs and CSS inside editable content are dropped: links and images there are user content", () => {
  const tree = el(1, "div", { contenteditable: "true" }, [
    el(2, "a", { href: "https://mybank.example/transfer/GB29NWBK60161331926819" }, [text(3, "x")]),
    el(4, "img", {
      src: "https://files.example/jane-passport.jpg",
      srcset: "/jane.png 1x",
      style: "background:url(/jane.png)",
    }),
  ]);
  const out = scrubbed(snapshot(tree), all);
  assert.doesNotMatch(out, /jane|GB29|mybank/i);
  const ctx: ScrubContext = { ...all, editable: (id) => id === 5 };
  const ev = mutation({
    attributes: [{ id: 5, attributes: { href: "https://x.example/jane", style: "color:red" } }],
  });
  assert.doesNotMatch(scrubbed(ev, ctx), /jane|color/);
});

test("selection ranges in editable text are dropped, since offsets track the caret", () => {
  const ctx: ScrubContext = { ...all, editable: (id) => id === 7 };
  const ev: RrwebEvent = {
    type: 3,
    timestamp: 1,
    data: {
      source: 14,
      ranges: [
        { start: 7, startOffset: 3, end: 7, endOffset: 3 },
        { start: 1, startOffset: 0, end: 2, endOffset: 1 },
      ],
    },
  };
  assert.deepEqual(dataOf(scrubEvent(ev, policy, ctx)).ranges, [
    { start: 1, startOffset: 0, end: 2, endOffset: 1 },
  ]);
});

test("a CSS declaration's priority is only ever important or empty", () => {
  const ev: RrwebEvent = {
    type: 3,
    timestamp: 1,
    data: { source: 13, index: [0], set: { property: "color", value: "red", priority: "jane@x.test" } },
  };
  assert.deepEqual(dataOf(scrubEvent(ev, policy, none)).set, { property: "color", value: "red" });
});

test("stylesheet elements never keep text attributes", () => {
  const out = root(
    scrubEvent(snapshot(el(1, "link", { rel: "stylesheet", title: "Jane", _cssText: "a{}" })), policy, all),
  );
  assert.deepEqual(out.attributes, { rel: "stylesheet", title: "****", _cssText: "a{}" });
});
