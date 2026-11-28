import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startFakeGateway } from "./test-support/gateway.ts";
import { tempDirs } from "./test-support/tmp.ts";
import { VERSION } from "./version.ts";

const tempDir = tempDirs();

const CLI = resolve(import.meta.dirname, "cli.ts");

interface Result {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// cli runs the command the way npm's bin link does, with the current runtime: Node strips the
// types, Bun runs the TypeScript directly.
function cli(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<Result> {
  return new Promise((done, fail) => {
    const { O11Y_SOURCEMAPS_TOKEN: _, ...inherited } = process.env;
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...inherited, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function buildDir(): string {
  const dir = tempDir("sm-cli-");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets/app.js"), "x()\n//# sourceMappingURL=app.js.map\n");
  writeFileSync(join(dir, "assets/app.js.map"), '{"version":3}');
  return dir;
}

test("uploads and prints one line per map", async () => {
  const gw = await startFakeGateway();
  try {
    const r = await cli(
      [
        "upload",
        "--endpoint",
        gw.url,
        "--service",
        "shop-web",
        "--release",
        "1.4.2",
        "--url-prefix",
        "/static/",
        "--update-id",
        "u1",
        "--token-env",
        "MY_TOKEN",
        buildDir(),
      ],
      { MY_TOKEN: "secret" },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "uploaded /static/assets/app.js -> k-0\n");
    assert.equal(gw.uploads[0]?.authorization, "Bearer secret");
    assert.equal(gw.uploads[0]?.query.update_id, "u1");
  } finally {
    await gw.close();
  }
});

test("reads the token from O11Y_SOURCEMAPS_TOKEN by default", async () => {
  const gw = await startFakeGateway();
  try {
    const r = await cli(
      ["upload", "--endpoint", gw.url, "--service", "s", "--release", "1", "--url-prefix", "/", buildDir()],
      { O11Y_SOURCEMAPS_TOKEN: "t" },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gw.uploads[0]?.authorization, "Bearer t");
  } finally {
    await gw.close();
  }
});

test("usage errors exit 2", async () => {
  const full = ["--endpoint", "http://127.0.0.1:1", "--service", "s", "--release", "1", "--url-prefix", "/"];
  for (const [name, args, env, want] of [
    [
      "missing --service",
      ["upload", ...full.slice(0, 2), ...full.slice(4), "dir"],
      { O11Y_SOURCEMAPS_TOKEN: "t" },
      /--service/,
    ],
    ["no command", [], {}, /usage/],
    ["unknown command", ["download", "dir"], {}, /usage/],
    ["no directory", ["upload", ...full], { O11Y_SOURCEMAPS_TOKEN: "t" }, /usage/],
    ["unknown flag", ["upload", ...full, "--token", "t", "dir"], {}, /--token/],
    ["token unset", ["upload", ...full, "dir"], {}, /O11Y_SOURCEMAPS_TOKEN/],
    [
      "bad concurrency",
      ["upload", ...full, "--concurrency", "0", "dir"],
      { O11Y_SOURCEMAPS_TOKEN: "t" },
      /concurrency/,
    ],
    [
      "bad endpoint",
      ["upload", "--endpoint", "nope", ...full.slice(2), "dir"],
      { O11Y_SOURCEMAPS_TOKEN: "t" },
      /endpoint/,
    ],
    ["bad token", ["upload", ...full, "dir"], { O11Y_SOURCEMAPS_TOKEN: "a\nsecret-value" }, /token/],
  ] as const) {
    const r = await cli(args, env);
    assert.equal(r.code, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, want, name);
    assert.equal(r.stderr.includes("secret-value"), false, `${name}: the token was printed`);
  }
});

test("--help prints usage and --version the version", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^usage: libo11y-sourcemaps upload/);
  const version = await cli(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `${VERSION}\n`);
});

test("a refused upload exits 1", async () => {
  const gw = await startFakeGateway(() => 401);
  try {
    const r = await cli(
      ["upload", "--endpoint", gw.url, "--service", "s", "--release", "1", "--url-prefix", "/", buildDir()],
      { O11Y_SOURCEMAPS_TOKEN: "wrong" },
    );
    assert.equal(r.code, 1);
    assert.match(r.stderr, /401/);
    assert.equal(r.stderr.includes("wrong"), false, "the token must not be printed");
  } finally {
    await gw.close();
  }
});

test("a directory with no maps exits 1", async () => {
  const r = await cli(
    [
      "upload",
      "--endpoint",
      "http://127.0.0.1:1",
      "--service",
      "s",
      "--release",
      "1",
      "--url-prefix",
      "/",
      tempDir("sm-empty-"),
    ],
    { O11Y_SOURCEMAPS_TOKEN: "t" },
  );
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no source maps/);
});

test("a partial failure still lists the maps that uploaded", async () => {
  const gw = await startFakeGateway((_i, q) => (q.url === "/assets/b.js" ? 401 : 201));
  try {
    const dir = tempDir("sm-cli-");
    mkdirSync(join(dir, "assets"));
    for (const n of ["a", "b"]) {
      writeFileSync(join(dir, `assets/${n}.js`), `x()\n//# sourceMappingURL=${n}.js.map\n`);
      writeFileSync(join(dir, `assets/${n}.js.map`), '{"version":3}');
    }
    const r = await cli(
      [
        "upload",
        "--endpoint",
        gw.url,
        "--service",
        "s",
        "--release",
        "1",
        "--url-prefix",
        "/",
        "--concurrency",
        "1",
        dir,
      ],
      { O11Y_SOURCEMAPS_TOKEN: "t" },
    );
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "uploaded /assets/a.js -> k-0\n");
  } finally {
    await gw.close();
  }
});
