/**
 * A throwaway certificate authority for TLS tests: a CA, a server certificate for 127.0.0.1 and
 * localhost, and a client certificate, all made in the test run with node:crypto. Nothing is read
 * from disk and nothing outlives the process, so no key is ever committed. node:crypto signs but
 * does not build certificates, so the few DER structures an X.509 certificate needs are written
 * out here.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";

function der(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  let length: number[];
  if (body.length < 0x80) length = [body.length];
  else if (body.length < 0x100) length = [0x81, body.length];
  else length = [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const sequence = (...parts: Uint8Array[]): Buffer => der(0x30, ...parts);
const set = (...parts: Uint8Array[]): Buffer => der(0x31, ...parts);
const integer = (n: number): Buffer => der(0x02, Buffer.from(n < 0x80 ? [n] : [0x00, n]));
const utf8 = (s: string): Buffer => der(0x0c, Buffer.from(s, "utf8"));
const octets = (b: Uint8Array): Buffer => der(0x04, b);
const bits = (b: Uint8Array): Buffer => der(0x03, Buffer.from([0]), b);
const TRUE = der(0x01, Buffer.from([0xff]));

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const group = [arc & 0x7f];
    for (let n = arc >> 7; n > 0; n >>= 7) group.unshift((n & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(t: Date): Buffer {
  const text = `${t.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

const ECDSA_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const name = (commonName: string): Buffer => sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));

/** basicConstraints, critical: this certificate is a CA. */
const CA_EXTENSION = sequence(oid("2.5.29.19"), TRUE, octets(sequence(TRUE)));

/** subjectAltName: DNS localhost and IP 127.0.0.1. */
const LOOPBACK_EXTENSION = sequence(
  oid("2.5.29.17"),
  octets(sequence(der(0x82, Buffer.from("localhost", "ascii")), der(0x87, Buffer.from([127, 0, 0, 1])))),
);

function pem(label: string, body: Uint8Array): string {
  const lines =
    Buffer.from(body)
      .toString("base64")
      .match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

interface Issued {
  /** The certificate, PEM. */
  readonly cert: string;
  /** Its private key, PKCS#8 PEM. */
  readonly key: string;
  readonly privateKey: KeyObject;
}

function issue(opts: {
  subject: string;
  issuer: string;
  serial: number;
  /** The issuer's key. Default: the new key, for a self-signed certificate. */
  signer?: KeyObject;
  extensions: Buffer[];
}): Issued {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = Date.now();
  const tbs = sequence(
    der(0xa0, integer(2)),
    integer(opts.serial),
    ECDSA_SHA256,
    name(opts.issuer),
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    name(opts.subject),
    publicKey.export({ type: "spki", format: "der" }),
    ...(opts.extensions.length === 0 ? [] : [der(0xa3, sequence(...opts.extensions))]),
  );
  const signature = sign("sha256", tbs, opts.signer ?? privateKey);
  return {
    cert: pem("CERTIFICATE", sequence(tbs, ECDSA_SHA256, bits(signature))),
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    privateKey,
  };
}

/** A CA and the two certificates it signed, all PEM. */
export interface TestCertificates {
  readonly ca: string;
  readonly server: { readonly cert: string; readonly key: string };
  readonly client: { readonly cert: string; readonly key: string };
  /** The common name of the client certificate. */
  readonly clientName: string;
}

/** Makes a CA, a server certificate for 127.0.0.1 and localhost, and a client certificate. */
export function generateCertificates(): TestCertificates {
  const caName = "libo11y test CA";
  const clientName = "libo11y test client";
  const ca = issue({ subject: caName, issuer: caName, serial: 1, extensions: [CA_EXTENSION] });
  const server = issue({
    subject: "libo11y test collector",
    issuer: caName,
    serial: 2,
    signer: ca.privateKey,
    extensions: [LOOPBACK_EXTENSION],
  });
  const client = issue({
    subject: clientName,
    issuer: caName,
    serial: 3,
    signer: ca.privateKey,
    extensions: [],
  });
  return {
    ca: ca.cert,
    server: { cert: server.cert, key: server.key },
    client: { cert: client.cert, key: client.key },
    clientName,
  };
}
