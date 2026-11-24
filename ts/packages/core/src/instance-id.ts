/**
 * service.instance.id from Kubernetes pod identity: a UUIDv5 of the pod UID, else of
 * "<namespace>/<pod name>", else a random UUIDv4. Every libo11y implementation derives the same ID
 * from the same identity (conformance/vectors/instance-id.json).
 */
import { hexEncode, utf8Encode } from "./utf8.ts";

/** The semconv-sanctioned UUIDv5 namespace for service.instance.id. */
export const INSTANCE_ID_NAMESPACE = "4d63009a-8d0f-11ee-aad7-4c796ed8e320";

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** The RFC 4122 version 5 UUID of name under namespace, lowercase and hyphenated. */
export async function uuidV5(
  namespace: string,
  name: string,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  const ns = uuidBytes(namespace);
  const nameBytes = utf8Encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const b = (await sha1(input)).slice(0, 16);
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = hexEncode(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Derives service.instance.id as Go's instanceIDFor does. */
export async function instanceIdFor(
  podUid: string,
  podName: string,
  namespace: string,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
  randomUUID: () => string,
): Promise<string> {
  if (podUid !== "") return uuidV5(INSTANCE_ID_NAMESPACE, podUid, sha1);
  if (podName !== "") return uuidV5(INSTANCE_ID_NAMESPACE, `${namespace}/${podName}`, sha1);
  return randomUUID();
}
