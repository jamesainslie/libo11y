/**
 * A scripted Transport for tests: each send records the request and answers with
 * the next scripted result, then { kind: "ok" }. Tests only; never built.
 */
import type { SendRequest, SendResult, Transport } from "../contracts/transport.ts";

/** A fake transport that also exposes what it was sent. */
export interface FakeTransport extends Transport {
  readonly requests: SendRequest[];
  /** Appends results to the script. */
  script(...results: SendResult[]): void;
}

export function createFakeTransport(...results: SendResult[]): FakeTransport {
  const script = [...results];
  const requests: SendRequest[] = [];
  return {
    requests,
    script: (...more) => {
      script.push(...more);
    },
    async send(req) {
      requests.push(req);
      return script.shift() ?? { kind: "ok" };
    },
  };
}
