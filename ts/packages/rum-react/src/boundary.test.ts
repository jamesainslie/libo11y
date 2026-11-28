import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddErrorOptions, Rum } from "@libo11y/rum";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RumErrorBoundary } from "./boundary.ts";
import { RumProvider, useRum } from "./provider.ts";

function fakeRum(): Rum & { readonly errors: { error: unknown; opts: AddErrorOptions | undefined }[] } {
  const errors: { error: unknown; opts: AddErrorOptions | undefined }[] = [];
  return {
    errors,
    sessionId: () => "s1",
    identify: () => {},
    onRequestStart: () => () => {},
    startView: () => {},
    setViewName: () => {},
    viewRendered: () => {},
    addAction: () => {},
    addError: (error, opts) => void errors.push({ error, opts }),
  };
}

test("componentDidCatch records a boundary error with the component stack", () => {
  const rum = fakeRum();
  const b = new RumErrorBoundary({ rum });
  const err = new Error("render failed");
  b.componentDidCatch(err, { componentStack: "\n    at Broken" });
  assert.deepEqual(rum.errors, [
    { error: err, opts: { source: "boundary", componentStack: "\n    at Broken" } },
  ]);
});

test("componentDidCatch without a component stack records the boundary source alone", () => {
  const rum = fakeRum();
  new RumErrorBoundary({ rum }).componentDidCatch("x", { componentStack: null });
  assert.deepEqual(rum.errors, [{ error: "x", opts: { source: "boundary" } }]);
});

/** A boundary that reports while rendering, so a server render shows which rum React gave it. */
class ReportingBoundary extends RumErrorBoundary {
  override render(): ReactNode {
    this.componentDidCatch("x", {});
    return null;
  }
}

test("componentDidCatch uses the nearest provider's rum when no rum prop is given", () => {
  const rum = fakeRum();
  renderToStaticMarkup(createElement(RumProvider, { rum }, createElement(ReportingBoundary)));
  assert.deepEqual(rum.errors, [{ error: "x", opts: { source: "boundary" } }]);
});

test("a rum prop wins over the provider's", () => {
  const outer = fakeRum();
  const own = fakeRum();
  renderToStaticMarkup(
    createElement(RumProvider, { rum: outer }, createElement(ReportingBoundary, { rum: own })),
  );
  assert.equal(outer.errors.length, 0);
  assert.equal(own.errors.length, 1);
});

test("componentDidCatch with no rum at all does nothing", () => {
  assert.doesNotThrow(() => new RumErrorBoundary({}).componentDidCatch("x", {}));
});

test("getDerivedStateFromError switches to the fallback", () => {
  assert.deepEqual(RumErrorBoundary.getDerivedStateFromError("x"), { error: "x", failed: true });
});

test("render shows the children, then the fallback, which may be a function of the error", () => {
  const ok = renderToStaticMarkup(
    createElement(RumErrorBoundary, { fallback: "oops" }, createElement("p", null, "fine")),
  );
  assert.equal(ok, "<p>fine</p>");
  const b = new RumErrorBoundary({
    fallback: (e: unknown) => createElement("p", null, `failed: ${String(e)}`),
  });
  b.state = { error: "boom", failed: true };
  assert.equal(renderToStaticMarkup(b.render()), "<p>failed: boom</p>");
  const plain = new RumErrorBoundary({});
  plain.state = { error: "boom", failed: true };
  assert.equal(plain.render(), null);
});

/** Renders nothing and reports what useRum returned through onRum. */
function Probe(props: { readonly onRum: (rum: Rum | undefined) => void }): ReactNode {
  props.onRum(useRum());
  return null;
}

test("useRum returns the nearest provider's rum, or undefined without one", () => {
  const rum = fakeRum();
  const seen: (Rum | undefined)[] = [];
  const onRum = (r: Rum | undefined): void => void seen.push(r);
  renderToStaticMarkup(createElement(RumProvider, { rum }, createElement(Probe, { onRum })));
  renderToStaticMarkup(createElement(Probe, { onRum }));
  assert.deepEqual(seen, [rum, undefined]);
});
