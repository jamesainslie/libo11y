/**
 * WP1 (transport). Delivery: the gate, persist-first, retry from the queue, Retry-After and drain.
 */
import type { Delivery, DeliveryOptions } from "../contracts/transport.ts";

/**
 * Builds a Delivery.
 *
 * deliver(batch): with the gate closed, "dropped" with no error and no side effect. With
 * persistFirst, the batch is put leased, sent, then removed on ok, removed on fatal, or rescheduled
 * on retry ("queued"); if put stores nothing the batch is still sent once. Without persistFirst it
 * is sent; a retry result puts it with notBefore from Retry-After or backoffDelay(1) ("queued"),
 * and a fatal one is "dropped" with an error. When isOnline() is false the batch skips the attempt
 * and is queued. Every "queued" outcome schedules a drain.
 *
 * drain(): as the contract says. Each claimed entry is sent; ok and fatal remove it, retry
 * reschedules it with Retry-After when given, else backoffDelay(attempts + 1). The "online" event
 * on events triggers a drain. Timers are cleared by clear and shutdown.
 */
export function createDelivery(opts: DeliveryOptions): Delivery {
  void opts;
  throw new Error("not implemented");
}
