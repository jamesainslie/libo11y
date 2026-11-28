import assert from "node:assert/strict";
import { test } from "node:test";
import { openStorageQueue } from "../storage/queue.ts";
import { fakeFileSystem } from "../test-support/fake-fs.ts";
import { expoFileStorageWith } from "./file-storage.ts";

test("one file per key, created lazily, keys round trip through file names", async () => {
  const fs = fakeFileSystem();
  const s = expoFileStorageWith(fs);
  assert.equal(await s.getItem("libo11y/index"), null);
  assert.deepEqual(await s.getAllKeys(), []);
  await s.removeItem("libo11y/index");
  assert.equal(fs.directoryCreated(), false, "reads and removes create nothing");
  await s.setItem("libo11y/index", "{}");
  assert.equal(fs.directoryCreated(), true);
  assert.deepEqual(await s.getAllKeys(), ["libo11y/index"]);
  assert.equal(await s.getItem("libo11y/index"), "{}");
  await s.setItem("libo11y/index", "[]");
  assert.equal(await s.getItem("libo11y/index"), "[]");
  await s.removeItem("libo11y/index");
  await s.removeItem("libo11y/index");
  assert.deepEqual(await s.getAllKeys(), []);
  assert.equal(await s.getItem("libo11y/index"), null);
});

test("file names are lowercase and safe, so keys differing in case stay apart on iOS", async () => {
  const fs = fakeFileSystem();
  const s = expoFileStorageWith(fs);
  const keys = ["Body/A", "body/a", "..", ".", "a b%c", "é/ü", "x_y-z"];
  for (const [i, k] of keys.entries()) await s.setItem(k, String(i));
  for (const name of fs.files.keys()) assert.match(name, /^[a-z0-9_%-]+$/, name);
  assert.equal(new Set([...fs.files.keys()].map((n) => n.toLowerCase())).size, keys.length);
  assert.deepEqual([...(await s.getAllKeys())].sort(), [...keys].sort());
  for (const [i, k] of keys.entries()) assert.equal(await s.getItem(k), String(i));
});

test("getAllKeys lists only this storage's files, not subdirectories or stray files", async () => {
  const fs = fakeFileSystem({ exists: true });
  fs.directories.add("nested");
  fs.files.set("Notes.txt", "someone else's");
  fs.files.set("%zz", "not ours");
  const s = expoFileStorageWith(fs);
  await s.setItem("k", "v");
  assert.deepEqual(await s.getAllKeys(), ["k"]);
});

test("setItem resolves only once the file is written", async () => {
  const fs = fakeFileSystem();
  const s = expoFileStorageWith(fs);
  const release = fs.holdWrites();
  let done = false;
  const p = s.setItem("k", "v").then(() => {
    done = true;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(done, false);
  release();
  await p;
  assert.equal(fs.files.size, 1);
});

test("a failing file system rejects, as KeyValueStorage allows", async () => {
  const fs = fakeFileSystem({ exists: true });
  const s = expoFileStorageWith({
    ...fs,
    file: (name) => ({
      ...fs.file(name),
      exists: true,
      text: () => Promise.reject(new Error("io")),
    }),
  });
  await assert.rejects(s.getItem("k"), /io/);
});

test("the storage queue works over it, and opening it creates nothing", async () => {
  const fs = fakeFileSystem();
  const q = await openStorageQueue({ storage: expoFileStorageWith(fs) });
  assert.equal(fs.directoryCreated(), false);
  await q.put({ signal: "traces", body: "{}" });
  assert.equal(fs.directoryCreated(), true);
  const claimed = await q.claim(Date.now(), 10, 60_000);
  assert.equal(claimed.length, 1);
  await q.close();
});
