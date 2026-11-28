/**
 * The privacy fixture: an adversarial page full of strings that start with "Leak", recorded by
 * rrweb with its masking switched off, so the raw stream really carries every one of them. Each
 * raw event also goes through the scrubber with the DOM-backed context, as the collector will run
 * it, under a code policy that unmasks ".public". The spec reads both streams from
 * window.__replay. Only text under .public that no mask covers may survive, and none of it starts
 * with "Leak".
 */
import { record } from "@rrweb/record";
import { domScrubContext } from "../../src/dom-context.ts";
import { resolvePolicy } from "../../src/policy.ts";
import { type RrwebEvent, scrubEvent } from "../../src/scrub.ts";

const HTML = `
<style>.bg{background:url(/s.png?token=LeakCss)}</style>
<div class="public" id="pub">
  <h1>Public headline</h1>
  <span data-o11y-mask id="masked-in-public">LeakMaskedInPublic</span>
  <input id="public-input" placeholder="LeakPlaceholder" value="LeakValue">
  <p data-user="LeakData" onclick="window.handler='LeakHandler'">Public paragraph</p>
  <x-pub id="pub-host"></x-pub>
</div>
<p data-o11y-unmask id="markup">LeakMarkup</p>
<p id="plain">LeakPlain</p>
<img alt="LeakAlt" title="LeakImgTitle" src="/x.png?token=LeakSrc"
  srcset="/x.png?token=LeakSrcset 1x, data:image/png;base64,LeakDataUrl 2x"
  style="background:url('/bg.png?token=LeakStyle')">
<button aria-label="LeakAria">LeakButton</button>
<a href="/p?email=LeakHref#LeakFrag">LeakLink</a>
<textarea id="ta">LeakTextarea</textarea>
<div contenteditable id="editor">LeakEditable<a href="/p?q=LeakEditorLinkQuery">x</a><img src="https://files.example/LeakEditorImg.png" alt="LeakEditorAlt"></div>
<div class="public"><span class="secret">LeakCodeMask</span></div>
<div class="chat" id="LeakChatId" title="LeakChatTitle"><img src="/LeakChatPath.png"><p>LeakChatText</p></div>
<canvas id="cv" width="20" height="20"></canvas>
<img id="inline" src="/asset?type=png">
<svg width="10" height="10"><text x="1" y="9">LeakSvg</text><title>LeakSvgTitle</title></svg>
<select><option value="LeakOptValue" selected>LeakOption</option></select>
<input type="password" id="pw">
<input type="text" id="email">
<div data-o11y-block>LeakBlocked</div>
<x-masked data-o11y-mask id="masked-host"></x-masked>
<x-plain id="plain-host"></x-plain>
<iframe id="frame"></iframe>
<iframe id="masked-frame" data-o11y-mask></iframe>
<!-- LeakComment -->
`;

interface ReplayWindow {
  __replay?: {
    raw: unknown[];
    scrubbed: RrwebEvent[];
    ready: boolean;
    mutate(): void;
    custom(): void;
  };
}

function shadow(id: string, html: string): void {
  const host = document.getElementById(id);
  if (host === null) throw new Error(`no #${id}`);
  host.attachShadow({ mode: "open" }).innerHTML = html;
}

function frame(id: string, html: string): void {
  const f = document.getElementById(id) as HTMLIFrameElement | null;
  const doc = f?.contentDocument;
  if (doc?.body === null || doc?.body === undefined) throw new Error(`no #${id} document`);
  doc.body.innerHTML = html;
}

document.body.insertAdjacentHTML("beforeend", HTML);
const meta = document.createElement("meta");
meta.name = "description";
meta.content = "LeakMeta";
document.head.append(meta);
shadow("pub-host", "<p>Shadow public</p>");
shadow("masked-host", '<p class="public">LeakShadowMasked</p>');
shadow("plain-host", "<p>LeakShadowPlain</p>");
frame("frame", "<p>LeakIframe</p>");
frame("masked-frame", '<p class="public">LeakIframeMasked</p>');

const policy = resolvePolicy({ unmask: [".public"], mask: [".secret"], block: [".chat"] }, new Set());
const cv = document.getElementById("cv") as HTMLCanvasElement | null;
const g = cv?.getContext("2d");
if (g) {
  g.fillStyle = "#c00";
  g.fillRect(0, 0, 20, 20);
}
const ctx = domScrubContext(policy, (id) => record.mirror.getNode(id) as Node | null);
const raw: unknown[] = [];
const scrubbed: RrwebEvent[] = [];

record({
  emit(event) {
    raw.push(event);
    const s = scrubEvent(event as RrwebEvent, policy, ctx);
    if (s !== undefined) scrubbed.push(s);
  },
  // rrweb at its laxest: the raw stream must carry every secret, so the scrubber alone protects it.
  maskAllInputs: false,
  maskInputOptions: { password: false },
  inlineStylesheet: true,
  recordCanvas: true,
  inlineImages: true,
  collectFonts: false,
});

(window as unknown as ReplayWindow).__replay = {
  raw,
  scrubbed,
  ready: true,
  mutate(): void {
    const h1 = document.querySelector("#pub h1");
    if (h1 !== null) h1.textContent = "Public update";
    const plain = document.getElementById("plain");
    if (plain !== null) {
      plain.textContent = "LeakMutatedText";
      plain.setAttribute("title", "LeakMutatedTitle");
      plain.setAttribute("data-o11y-unmask", "");
      plain.append(" LeakAfterMarkup");
    }
    const added = document.createElement("p");
    added.textContent = "LeakAdded";
    added.setAttribute("aria-label", "LeakAddedAria");
    document.body.append(added);
    document.getElementById("masked-in-public")?.append(" LeakAddedInMask");
    const inPublic = document.createElement("strong");
    inPublic.textContent = "Public added";
    document.getElementById("pub")?.append(inPublic);
    const plainShadow = document.getElementById("plain-host")?.shadowRoot?.querySelector("p");
    if (plainShadow) plainShadow.textContent = "LeakShadowMutated";
    const maskedShadow = document.getElementById("masked-host")?.shadowRoot?.querySelector("p");
    if (maskedShadow) maskedShadow.textContent = "LeakShadowMaskedMutated";
    const f = document.getElementById("frame") as HTMLIFrameElement | null;
    const fp = f?.contentDocument?.querySelector("p");
    if (fp) fp.textContent = "LeakIframeMutated";
    const mf = document.getElementById("masked-frame") as HTMLIFrameElement | null;
    const mfp = mf?.contentDocument?.querySelector("p");
    if (mfp) mfp.textContent = "LeakIframeMaskedMutated";
    document.querySelector("img")?.setAttribute("srcset", "/y.png?token=LeakSrcsetMutated 2x");
    document.querySelector("img")?.setAttribute("style", "background:url(/z.png?token=LeakStyleMutated)");
    const chat = document.querySelector(".chat");
    chat?.setAttribute("data-x", "LeakChatAttr");
    chat?.setAttribute("aria-label", "LeakChatAria");
    const intoChat = document.createElement("p");
    intoChat.textContent = "LeakIntoChat";
    chat?.append(intoChat);
    chat?.querySelector("p")?.replaceChildren("LeakChatTextMutated");
    const sheet = document.styleSheets[0];
    sheet?.insertRule(".x{background:url(/r.png?token=LeakInsertRule)}", 0);
    (sheet?.cssRules[0] as CSSStyleRule | undefined)?.style.setProperty(
      "background",
      "url(/c.png?token=LeakDecl)",
    );
    const adopted = new CSSStyleSheet();
    adopted.replaceSync(".y{background:url(/a.png?token=LeakAdopted)}");
    document.adoptedStyleSheets = [adopted];
    document
      .getElementById("plain")
      ?.style.setProperty("background-image", "url(/b.png?token=LeakSetProperty)");
    if (g) g.fillText("LeakCanvasText", 0, 10);
  },
  custom(): void {
    record.addCustomEvent("profile", { email: "LeakCustom" });
  },
};
