import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, relockPacks, sha512Integrity } from "./rn-fixture-lock.ts";

const LOCK = `{
  "packages": {
    "@libo11y/core": ["@libo11y/core@.packs/libo11y-core.tgz", { "dependencies": { "@libo11y/spec": "0.3.0" } }, "sha512-OLDcore=="],

    "@libo11y/spec": ["@libo11y/spec@.packs/libo11y-spec.tgz", { "bin": { "libo11y": "./dist/cli.js" } }, "sha512-OLDspec=="],

    "expo": ["expo@58.1.0", "", { "dependencies": {} }, "sha512-registry=="],
  }
}
`;

test("relockPacks puts each tarball's integrity on its entry and leaves registry entries alone", () => {
  const out = relockPacks(
    LOCK,
    new Map([
      ["libo11y-core.tgz", "sha512-NEWcore=="],
      ["libo11y-spec.tgz", "sha512-NEWspec=="],
    ]),
  );
  assert.match(out, /"@libo11y\/core@\.packs\/libo11y-core\.tgz", \{[^\n]*\}, "sha512-NEWcore=="\]/);
  assert.match(out, /"@libo11y\/spec@\.packs\/libo11y-spec\.tgz", \{[^\n]*\}, "sha512-NEWspec=="\]/);
  assert.match(out, /"sha512-registry=="/);
  assert.equal(out.split("\n").length, LOCK.split("\n").length);
});

test("relockPacks fails on a tarball the lock does not list, so a new package is relocked by hand", () => {
  assert.throws(() => relockPacks(LOCK, new Map([["libo11y-web.tgz", "sha512-x=="]])), /libo11y-web\.tgz/);
});

test("sha512Integrity is the subresource integrity of the bytes", () => {
  assert.equal(
    sha512Integrity(new TextEncoder().encode("abc")),
    "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==",
  );
});

test("main relocks the fixture's bun.lock from its .packs directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-fixture-lock-"));
  try {
    mkdirSync(join(dir, ".packs"));
    writeFileSync(join(dir, ".packs", "libo11y-core.tgz"), "abc");
    writeFileSync(join(dir, ".packs", "libo11y-spec.tgz"), "abc");
    writeFileSync(join(dir, "bun.lock"), LOCK);
    assert.equal(main([dir]), 0);
    const out = readFileSync(join(dir, "bun.lock"), "utf8");
    assert.equal(out.match(/sha512-3a81oZNherrMQ/g)?.length, 2);
    assert.equal(main([]), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
