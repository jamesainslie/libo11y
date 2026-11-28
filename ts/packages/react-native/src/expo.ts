/**
 * The libo11y React Native platform for Expo apps: setupReactNative with the retry queue in a
 * directory of the app's documents (expo-file-system), the app version (expo-application), the ID
 * of the over-the-air update the app runs (expo-updates) and the device class (expo-device). An
 * app that imports this entry installs those four modules; they are optional peer dependencies of
 * the package, and the main entry imports none of them.
 */
/// <reference path="./expo/modules.d.ts" />

import * as Application from "expo-application";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import * as Updates from "expo-updates";
import type { KeyValueStorage } from "./contracts/storage.ts";
import { type ExpoAppInfo, expoAppInfoFrom } from "./expo/app-info.ts";
import { expoFileStorageWith } from "./expo/file-storage.ts";
import { type ExpoOptions, expoOptionsFrom, withExpoOptions } from "./expo/options.ts";
import { setupReactNative } from "./index.ts";
import type { ReactNativeSetupOptions, ReactNativeTelemetry } from "./options.ts";

export type { KeyValueStorage } from "./contracts/storage.ts";
export type { ReactNativeSetupOptions, ReactNativeTelemetry } from "./options.ts";
export type { ExpoAppInfo, ExpoOptions };

/** The directory under the app's documents that expoFileStorage keeps its files in. */
const DIRECTORY = "libo11y";

/**
 * A KeyValueStorage with one file per key in the libo11y directory of the app's documents
 * (Paths.document), which the operating system keeps across launches and updates. The directory
 * is created on the first write, not before. getAllKeys lists only the files of that directory.
 */
export function expoFileStorage(): KeyValueStorage {
  const dir = new Directory(Paths.document, DIRECTORY);
  return expoFileStorageWith({
    directoryExists: () => dir.exists,
    createDirectory: () => dir.create({ intermediates: true, idempotent: true }),
    fileNames: () => dir.list().flatMap((e) => (e instanceof File ? [e.name] : [])),
    file: (name) => new File(dir, name),
    replace: (from, to) => new File(dir, from).move(new File(dir, to), { overwrite: true }),
  });
}

/**
 * The app version from expo-application, the update ID from expo-updates only when the app runs an
 * over-the-air update (absent for the embedded bundle, in development and with updates disabled),
 * and the device class from expo-device.
 */
export function expoAppInfo(): ExpoAppInfo {
  return expoAppInfoFrom({ application: Application, updates: Updates, device: Device });
}

/**
 * The options Expo fills in: storage is expoFileStorage(), serviceVersion the app version, and
 * resourceAttributes carry o11y.rum.app.update_id and o11y.rum.device.class from expoAppInfo().
 */
export function expoOptions(): ExpoOptions {
  return expoOptionsFrom(expoAppInfo(), expoFileStorage());
}

/**
 * setupReactNative with expoOptions() under the app's own options: an option the app sets wins,
 * and resourceAttributes merge key by key with the app's winning. So a batch saved just before
 * the app stops goes out on the next launch, and the gateway finds the source maps of the update
 * the app runs.
 */
export function setupExpo(options: ReactNativeSetupOptions = {}): Promise<ReactNativeTelemetry> {
  return setupReactNative(withExpoOptions(expoOptions(), options));
}
