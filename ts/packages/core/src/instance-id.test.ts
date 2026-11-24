import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { INSTANCE_ID_NAMESPACE, instanceIdFor, uuidV5 } from "./instance-id.ts";
import { sha1 } from "./sha1.ts";

const vectors = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "..", "..", "..", "..", "conformance", "vectors", "instance-id.json"),
    "utf8",
  ),
) as { name: string; k8s_pod_uid: string; k8s_pod_name: string; k8s_namespace_name: string; want: string }[];

const pureSha1 = async (d: Uint8Array) => sha1(d);
const nodeSha1 = async (d: Uint8Array) => new Uint8Array(createHash("sha1").update(d).digest());
const noRandom = () => {
  throw new Error("randomUUID must not be called when pod identity is present");
};

for (const v of vectors) {
  test(`instance id: ${v.name}`, async () => {
    for (const hash of [pureSha1, nodeSha1]) {
      assert.equal(
        await instanceIdFor(v.k8s_pod_uid, v.k8s_pod_name, v.k8s_namespace_name, hash, noRandom),
        v.want,
      );
    }
  });
}

test("without pod identity the id is the platform's random uuid", async () => {
  assert.equal(await instanceIdFor("", "", "lor", pureSha1, () => "random-id"), "random-id");
});

test("uuidV5 matches the RFC 4122 DNS example", async () => {
  // python3 -c 'import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"))'
  assert.equal(
    await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org", pureSha1),
    "886313e1-3b8a-5372-9b90-0c9aee199e5d",
  );
  assert.equal(INSTANCE_ID_NAMESPACE, "4d63009a-8d0f-11ee-aad7-4c796ed8e320");
});
