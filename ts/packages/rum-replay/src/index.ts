/**
 * Privacy-first session replay for `@libo11y/rum`. replay() records the page with rrweb at its
 * strictest and scrubs every event before it is kept: text is masked unless the app's unmask
 * allow-list covers it, input values and editable content are never recorded, attributes follow an
 * allow-list and URLs lose their query and fragment. Self-contained segments of kept sessions
 * upload to the gateway's POST /_o11y/v1/replay, only while consent is granted.
 */
export { replay } from "./collector.ts";
export type { ReplayOptions, ReplayPrivacy } from "./options.ts";
export { VERSION } from "./version.ts";
