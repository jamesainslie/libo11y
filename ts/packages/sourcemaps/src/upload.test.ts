import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type FakeGateway, startFakeGateway } from "./test-support/gateway.ts";
import { tempDirs } from "./test-support/tmp.ts";
import { UploadError, uploadSourceMaps, uploadSourceMapsWith } from "./upload.ts";

const tempDir = tempDirs();

function buildDir(n = 2): string {
  const dir = tempDir("sm-up-");
  mkdirSync(join(dir, "assets"));
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `assets/app-${i}.js`), `f${i}()\n//# sourceMappingURL=app-${i}.js.map\n`);
    writeFileSync(join(dir, `assets/app-${i}.js.map`), `{"version":3,"file":"app-${i}.js"}`);
  }
  return dir;
}

async function withGateway(gw: Promise<FakeGateway>, fn: (gw: FakeGateway) => Promise<void>): Promise<void> {
  const g = await gw;
  try {
    await fn(g);
  } finally {
    await g.close();
  }
}

const noSleep = { sleep: async (): Promise<void> => {} };

test("uploads every map once, gzipped, with the bearer token and the release", async () => {
  await withGateway(startFakeGateway(), async (gw) => {
    const dir = buildDir();
    const uploaded = await uploadSourceMaps({
      endpoint: `${gw.url}/`,
      token: "t",
      service: "shop-web",
      version: "1.4.2",
      updateId: "u-1",
      urlPrefix: "/assets/",
      directory: join(dir, "assets"),
    });
    assert.equal(gw.uploads.length, 2);
    const sorted = [...gw.uploads].sort((a, b) => (a.query.url ?? "").localeCompare(b.query.url ?? ""));
    for (const [i, u] of sorted.entries()) {
      assert.equal(u.method, "POST");
      assert.equal(u.path, "/_o11y/v1/sourcemaps");
      assert.equal(u.authorization, "Bearer t");
      assert.equal(u.encoding, "gzip");
      assert.deepEqual(u.query, {
        service: "shop-web",
        version: "1.4.2",
        update_id: "u-1",
        url: `/assets/app-${i}.js`,
      });
      assert.equal(u.body, `{"version":3,"file":"app-${i}.js"}`);
    }
    assert.deepEqual(
      uploaded.map((u) => u.url),
      ["/assets/app-0.js", "/assets/app-1.js"],
    );
    assert.ok(uploaded.every((u) => /^k-\d$/.test(u.key)));
    assert.equal(uploaded[0]?.script, join(dir, "assets/app-0.js"));
  });
});

test("leaves update_id out when none is given, and keeps a path on the endpoint", async () => {
  await withGateway(startFakeGateway(), async (gw) => {
    await uploadSourceMaps({
      endpoint: `${gw.url}/rum`,
      token: "t",
      service: "s",
      version: "1",
      urlPrefix: "/",
      directory: buildDir(1),
    });
    assert.equal(gw.uploads[0]?.path, "/rum/_o11y/v1/sourcemaps");
    assert.equal("update_id" in (gw.uploads[0]?.query ?? {}), false);
  });
});

test("retries a 503 and succeeds", async () => {
  await withGateway(
    startFakeGateway((i) => (i === 0 ? 503 : 201)),
    async (gw) => {
      const slept: number[] = [];
      const uploaded = await uploadSourceMapsWith(
        { endpoint: gw.url, token: "t", service: "s", version: "1", urlPrefix: "/", directory: buildDir(1) },
        {
          sleep: async (ms) => {
            slept.push(ms);
          },
        },
      );
      assert.equal(uploaded.length, 1);
      assert.equal(gw.uploads.length, 2);
      assert.deepEqual(slept, [200]);
    },
  );
});

test("gives up after three attempts", async () => {
  await withGateway(
    startFakeGateway(() => 429),
    async (gw) => {
      await assert.rejects(
        uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: buildDir(1),
          },
          noSleep,
        ),
        (err: unknown) => err instanceof UploadError && err.status === 429,
      );
      assert.equal(gw.uploads.length, 3);
    },
  );
});

test("a 401 throws UploadError without retrying", async () => {
  await withGateway(
    startFakeGateway(() => 401),
    async (gw) => {
      const dir = buildDir(1);
      await assert.rejects(
        uploadSourceMapsWith(
          { endpoint: gw.url, token: "t", service: "s", version: "1", urlPrefix: "/", directory: dir },
          noSleep,
        ),
        (err: unknown) =>
          err instanceof UploadError &&
          err.status === 401 &&
          err.script === join(dir, "assets/app-0.js") &&
          err.name === "UploadError",
      );
      assert.equal(gw.uploads.length, 1);
    },
  );
});

test("a failure stops further uploads from starting", async () => {
  await withGateway(
    startFakeGateway(() => 401),
    async (gw) => {
      await assert.rejects(
        uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: buildDir(10),
            concurrency: 1,
          },
          noSleep,
        ),
        UploadError,
      );
      assert.equal(gw.uploads.length, 1);
    },
  );
});

test("an unreachable gateway is an UploadError with status 0", async () => {
  const gw = await startFakeGateway();
  const url = gw.url;
  await gw.close();
  await assert.rejects(
    uploadSourceMapsWith(
      { endpoint: url, token: "t", service: "s", version: "1", urlPrefix: "/", directory: buildDir(1) },
      noSleep,
    ),
    (err: unknown) => err instanceof UploadError && err.status === 0,
  );
});

test("deleteAfterUpload removes uploaded maps and their comments only", async () => {
  await withGateway(
    startFakeGateway((_i, q) => (q.url === "/assets/app-1.js" ? 401 : 201)),
    async (gw) => {
      const dir = buildDir(2);
      await assert.rejects(
        uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: dir,
            deleteAfterUpload: true,
            concurrency: 2,
          },
          noSleep,
        ),
        UploadError,
      );
      assert.equal(existsSync(join(dir, "assets/app-0.js.map")), false);
      assert.equal(readFileSync(join(dir, "assets/app-0.js"), "utf8"), "f0()\n");
      assert.equal(existsSync(join(dir, "assets/app-1.js.map")), true);
      assert.equal(
        readFileSync(join(dir, "assets/app-1.js"), "utf8"),
        "f1()\n//# sourceMappingURL=app-1.js.map\n",
      );
    },
  );
});

test("deleteAfterUpload keeps a script without a comment unchanged", async () => {
  await withGateway(startFakeGateway(), async (gw) => {
    const dir = tempDir("sm-up-");
    writeFileSync(join(dir, "vendor.js"), "y()\n//# debugId=ABC\n");
    writeFileSync(join(dir, "vendor.js.map"), '{"version":3}');
    await uploadSourceMaps({
      endpoint: gw.url,
      token: "t",
      service: "s",
      version: "1",
      urlPrefix: "/",
      directory: dir,
      deleteAfterUpload: true,
    });
    assert.equal(existsSync(join(dir, "vendor.js.map")), false);
    assert.equal(readFileSync(join(dir, "vendor.js"), "utf8"), "y()\n//# debugId=ABC\n");
  });
});

test("concurrency bounds the requests in flight", async () => {
  await withGateway(startFakeGateway(undefined, 30), async (gw) => {
    await uploadSourceMaps({
      endpoint: gw.url,
      token: "t",
      service: "s",
      version: "1",
      urlPrefix: "/",
      directory: buildDir(8),
      concurrency: 2,
    });
    assert.equal(gw.uploads.length, 8);
    assert.equal(gw.maxInFlight(), 2);
  });
});

test("refuses options it cannot use", async () => {
  const base = { endpoint: "http://127.0.0.1:1", token: "t", service: "s", version: "1", urlPrefix: "/" };
  await assert.rejects(uploadSourceMaps({ ...base, directory: buildDir(1), token: "" }), /token/);
  await assert.rejects(uploadSourceMaps({ ...base, directory: buildDir(1), concurrency: 0 }), /concurrency/);
  await assert.rejects(
    uploadSourceMaps({ ...base, directory: buildDir(1), endpoint: "not a url" }),
    /endpoint/,
  );
});

test("the fetch option replaces the global fetch", async () => {
  const seen: string[] = [];
  const fake = async (input: string | URL | Request): Promise<Response> => {
    seen.push(String(input));
    return new Response(JSON.stringify({ key: "k" }), { status: 201 });
  };
  const uploaded = await uploadSourceMaps({
    endpoint: "https://gw.example",
    token: "t",
    service: "s",
    version: "1",
    urlPrefix: "/",
    directory: buildDir(1),
    fetch: fake as typeof fetch,
  });
  assert.equal(uploaded[0]?.key, "k");
  assert.match(seen[0] ?? "", /^https:\/\/gw\.example\/_o11y\/v1\/sourcemaps\?/);
});

test("a token a header cannot carry is refused without echoing it", async () => {
  for (const token of ["sec\nret", "sec ret", "sécret"]) {
    await assert.rejects(
      uploadSourceMaps({
        endpoint: "http://127.0.0.1:1",
        token,
        service: "s",
        version: "1",
        urlPrefix: "/",
        directory: buildDir(1),
      }),
      (err: unknown) => err instanceof TypeError && /token/.test(err.message) && !err.message.includes(token),
    );
  }
});

test("network errors name their cause and never the token", async () => {
  const gw = await startFakeGateway();
  const url = gw.url;
  await gw.close();
  await assert.rejects(
    uploadSourceMapsWith(
      { endpoint: url, token: "tok-123", service: "s", version: "1", urlPrefix: "/", directory: buildDir(1) },
      noSleep,
    ),
    (err: unknown) =>
      err instanceof UploadError &&
      /ECONNREFUSED|refused|connect/i.test(err.message) &&
      !err.message.includes("tok-123"),
  );
});

test("an attempt that hangs times out and is retried", async () => {
  await withGateway(startFakeGateway(undefined, 2000), async (gw) => {
    const started = Date.now();
    await assert.rejects(
      uploadSourceMapsWith(
        { endpoint: gw.url, token: "t", service: "s", version: "1", urlPrefix: "/", directory: buildDir(1) },
        { ...noSleep, timeoutMillis: 100 },
      ),
      (err: unknown) =>
        err instanceof UploadError && err.status === 0 && /timed out|abort/i.test(err.message),
    );
    assert.ok(Date.now() - started < 1500);
    assert.equal(gw.uploads.length, 3);
  });
});

test("Retry-After sets the wait before a retry, capped at ten seconds", async () => {
  for (const [header, want] of [
    ["3", 3000],
    ["600", 10_000],
    ["soon", 200],
  ] as const) {
    await withGateway(
      startFakeGateway((i) => (i === 0 ? 503 : 201), 0, header),
      async (gw) => {
        const slept: number[] = [];
        await uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: buildDir(1),
          },
          {
            sleep: async (ms) => {
              slept.push(ms);
            },
          },
        );
        assert.deepEqual(slept, [want], `Retry-After ${header}`);
      },
    );
  }
});

test("a failed upload reports the maps that did upload", async () => {
  await withGateway(
    startFakeGateway((_i, q) => (q.url === "/assets/app-1.js" ? 401 : 201)),
    async (gw) => {
      await assert.rejects(
        uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: buildDir(2),
            concurrency: 2,
          },
          noSleep,
        ),
        (err: unknown) =>
          err instanceof UploadError &&
          err.uploaded.length === 1 &&
          err.uploaded[0]?.url === "/assets/app-0.js",
      );
    },
  );
});

test("deleteAfterUpload keeps the bytes of a script that is not UTF-8", async () => {
  await withGateway(startFakeGateway(), async (gw) => {
    const dir = tempDir("sm-up-");
    const head = Buffer.from([0x78, 0xff, 0xfe, 0x0a]);
    writeFileSync(
      join(dir, "app.js"),
      Buffer.concat([head, Buffer.from("//# sourceMappingURL=app.js.map\n")]),
    );
    writeFileSync(join(dir, "app.js.map"), '{"version":3}');
    await uploadSourceMaps({
      endpoint: gw.url,
      token: "t",
      service: "s",
      version: "1",
      urlPrefix: "/",
      directory: dir,
      deleteAfterUpload: true,
    });
    assert.deepEqual(readFileSync(join(dir, "app.js")), head);
  });
});

test("deleteAfterUpload keeps a map shared with a script that failed", async () => {
  await withGateway(
    startFakeGateway((_i, q) => (q.url === "/b.js" ? 401 : 201)),
    async (gw) => {
      const dir = tempDir("sm-up-");
      writeFileSync(join(dir, "a.js"), "a()\n//# sourceMappingURL=shared.map\n");
      writeFileSync(join(dir, "b.js"), "b()\n//# sourceMappingURL=shared.map\n");
      writeFileSync(join(dir, "shared.map"), '{"version":3}');
      await assert.rejects(
        uploadSourceMapsWith(
          {
            endpoint: gw.url,
            token: "t",
            service: "s",
            version: "1",
            urlPrefix: "/",
            directory: dir,
            deleteAfterUpload: true,
            concurrency: 2,
          },
          noSleep,
        ),
        UploadError,
      );
      assert.equal(existsSync(join(dir, "shared.map")), true);
    },
  );
});
