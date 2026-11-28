/**
 * @libo11y/react-native/internal: the platform's building blocks, for @libo11y/rum-react-native.
 * For libo11y packages only: it follows the package version, carries no compatibility promise and
 * has no API report. Nothing reachable from here imports react-native, so node tests can load it.
 */

export type { AppLifecycle, AppStateLike, ReactNativeEnv } from "./contracts/env.ts";
export type { KeyValueStorage } from "./contracts/storage.ts";
