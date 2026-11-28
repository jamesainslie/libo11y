/**
 * The collector fixture: setupRum with views(), errors() and replay() unmasking ".public", driven
 * by window.__rumStart, uploading to the harness sink. Every string a privacy rule must remove ends
 * in a secret the spec looks for in the uploaded envelopes. The page builds its markup through a
 * named Trusted Types policy, so under csp=strict only replay and RUM themselves could raise a
 * violation; violations are collected in window.__violations from the first moment.
 */
import { errors, setupRum, views } from "@libo11y/rum";
import { runtimeOf } from "@libo11y/rum/internal";
import { replay } from "@libo11y/rum-replay";

const HTML = `
<p class="public" id="heading">Public heading</p>
<p class="private" id="name">Jane Doe</p>
<div class="public"><span data-o11y-mask id="masked">masked inside</span></div>
<input id="email" value="jane@x.test">
<textarea id="notes">draft</textarea>
<div contenteditable id="editor">typed</div>
<img id="img" alt="photo" src="/asset/a.png?token=s3cr3t&page=1">
<div data-o11y-block id="blocked">blocked text</div>
<button id="boom">Throw</button>
`;

interface FixtureOptions {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted";
}

type TrustedTypesLike = {
  createPolicy(name: string, rules: { createHTML(s: string): string }): { createHTML(s: string): string };
};

const w = globalThis as unknown as Record<string, unknown>;
const violations: string[] = [];
w.__violations = violations;
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push(`${e.violatedDirective}: ${e.blockedURI} ${e.sample}`);
});

const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
const policy = tt?.createPolicy("fixture", { createHTML: (s) => s });
const root = document.createElement("main");
root.innerHTML = (policy === undefined ? HTML : policy.createHTML(HTML)) as string;
document.body.append(root);
document.getElementById("boom")?.addEventListener("click", () => {
  throw new Error("boom from the replay fixture");
});

w.__rumStart = async (o: FixtureOptions): Promise<void> => {
  const telemetry = await setupRum({
    serviceName: "rum-replay-fixture",
    serviceVersion: "1.0.0",
    environment: "test",
    endpoint: o.endpoint,
    consent: { initial: o.consent ?? "granted" },
    transport: { compression: "none" },
    rum: {
      queryAllowList: ["page"],
      collectors: [
        views(),
        errors(),
        replay({ privacy: { unmask: [".public"] }, url: `${o.endpoint}/v1/replay` }),
      ],
    },
  });
  const runtime = runtimeOf(telemetry);
  w.__rum = { telemetry, sessionId: () => runtime?.session.current()?.id };
};
