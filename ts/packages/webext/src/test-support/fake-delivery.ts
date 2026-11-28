/**
 * A recording Delivery for webext tests: deliver answers
 * "sent", and every call is logged in order. Tests only; never built.
 */
import type { Delivery, DeliveryOptions } from "@libo11y/web/internal";

export interface FakeDelivery extends Delivery {
  readonly calls: string[];
  readonly options: DeliveryOptions;
}

export function createFakeDelivery(options: DeliveryOptions, log: string[] = []): FakeDelivery {
  return {
    calls: log,
    options,
    async deliver(batch) {
      log.push(`deliver ${batch.signal}`);
      return { outcome: "sent" };
    },
    async drain() {
      log.push("drain");
    },
    async clear() {
      log.push("clear");
      await options.queue?.clear();
    },
    async shutdown() {
      log.push("shutdown");
      return { timedOut: [] };
    },
  };
}
