/** The naming fixture: window.__naming(html, selector) runs the action naming on real DOM. */
import { actionName, actionTarget, elementSelector } from "@libo11y/rum/internal";

const w = globalThis as unknown as Record<string, unknown>;
w.__naming = (html: string, selector: string) => {
  document.body.innerHTML = html;
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`no element matches ${selector}`);
  const target = actionTarget(el);
  return {
    name: actionName(target) ?? null,
    selector: elementSelector(target),
    target: target.tagName.toLowerCase(),
    resolves: document.querySelector(elementSelector(target)) === target,
  };
};
