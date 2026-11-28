/** The o11y.rum.device.class of the device a React Native app runs on. */
import type { ReactNativeEnv } from "./contracts/env.ts";

/** An Android screen whose shorter side is at least this many dp is a tablet (Android's sw600dp). */
const TABLET_MIN_DP = 600;

/**
 * "tv" on a TV, "tablet" on an iPad or an Android screen whose shorter side is 600 dp or more, else
 * "mobile", also when the screen size is unknown.
 */
export function deviceClassOf(
  env: Pick<ReactNativeEnv, "os" | "isPad" | "isTV" | "screen">,
): "mobile" | "tablet" | "tv" {
  if (env.isTV) return "tv";
  if (env.os === "ios") return env.isPad ? "tablet" : "mobile";
  let shorter = Number.NaN;
  try {
    const s = env.screen();
    if (s !== undefined) shorter = Math.min(s.width, s.height);
  } catch {
    // An unknown screen is a phone.
  }
  return shorter >= TABLET_MIN_DP ? "tablet" : "mobile";
}
