/**
 * Privacy-first session replay for `@libo11y/rum`. In development: this release holds the privacy
 * core (masking, URL stripping, the event scrubber and the remote configuration clamp), not yet a
 * working collector.
 */
export type { ReplayOptions, ReplayPrivacy } from "./options.ts";
export { VERSION } from "./version.ts";
