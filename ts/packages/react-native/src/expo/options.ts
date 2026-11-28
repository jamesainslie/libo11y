/**
 * The setup options an Expo app gets from Expo, and how the app's own options go over them.
 */

import { ATTR_RUM_APP_UPDATE_ID, ATTR_RUM_DEVICE_CLASS } from "@libo11y/spec";
import type { Attributes } from "@opentelemetry/api";
import type { KeyValueStorage } from "../contracts/storage.ts";
import type { ReactNativeSetupOptions } from "../options.ts";
import type { ExpoAppInfo } from "./app-info.ts";

/**
 * The options Expo fills in: where the retry queue lives, the app version, and the update ID and
 * device class as resource attributes.
 */
export type ExpoOptions = Pick<ReactNativeSetupOptions, "storage" | "serviceVersion" | "resourceAttributes">;

/**
 * storage, serviceVersion from info, and resourceAttributes with o11y.rum.app.update_id and
 * o11y.rum.device.class from info. A field info lacks is left out.
 */
export function expoOptionsFrom(info: ExpoAppInfo, storage: KeyValueStorage): ExpoOptions {
  const attrs: Attributes = {
    ...(info.updateId === undefined ? {} : { [ATTR_RUM_APP_UPDATE_ID]: info.updateId }),
    ...(info.deviceClass === undefined ? {} : { [ATTR_RUM_DEVICE_CLASS]: info.deviceClass }),
  };
  return {
    storage,
    ...(info.serviceVersion === undefined ? {} : { serviceVersion: info.serviceVersion }),
    ...(Object.keys(attrs).length === 0 ? {} : { resourceAttributes: attrs }),
  };
}

/**
 * options over expo: an option the app sets beats expo's, and resourceAttributes merge key by key
 * with the app's winning. An option the app leaves undefined keeps expo's.
 */
export function withExpoOptions<O extends ReactNativeSetupOptions>(expo: ExpoOptions, options: O): O {
  const own = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as O;
  const attrs =
    expo.resourceAttributes === undefined && options.resourceAttributes === undefined
      ? undefined
      : { ...expo.resourceAttributes, ...options.resourceAttributes };
  return { ...expo, ...own, ...(attrs === undefined ? {} : { resourceAttributes: attrs }) };
}
