/**
 * The calls @libo11y/react-native/expo makes on the Expo modules, typed against the real SDK and
 * the package's structural contracts. The package declares slices of these modules itself instead
 * of installing Expo, so `bun run typecheck` here fails when the SDK no longer fits them. Mirrors
 * expoFileStorage and expoAppInfo in ts/packages/react-native/src/expo.ts.
 */
import type { ExpoModulesLike, FileSystemLike } from "@libo11y/react-native/internal";
import * as Application from "expo-application";
import * as Device from "expo-device";
import { Directory, File, Paths } from "expo-file-system";
import * as Updates from "expo-updates";

const dir = new Directory(Paths.document, "libo11y");

export const fileSystem: FileSystemLike = {
  directoryExists: () => dir.exists,
  createDirectory: () => dir.create({ intermediates: true, idempotent: true }),
  fileNames: () => dir.list().flatMap((e) => (e instanceof File ? [e.name] : [])),
  file: (name) => new File(dir, name),
};

export const modules: ExpoModulesLike = { application: Application, updates: Updates, device: Device };
