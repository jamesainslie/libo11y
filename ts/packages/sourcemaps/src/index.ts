/**
 * Uploads JavaScript source maps to the libo11y RUM gateway, which uses them to symbolicate the
 * stack traces of browser and React Native errors. It runs on Bun and Node.
 *
 * ```ts
 * import { uploadSourceMaps } from "@libo11y/sourcemaps";
 *
 * await uploadSourceMaps({
 *   endpoint: "https://shop.example",
 *   token: process.env.O11Y_SOURCEMAPS_TOKEN ?? "",
 *   service: "shop-web",
 *   version: "1.4.2",
 *   urlPrefix: "/assets/",
 *   directory: "dist/assets",
 *   deleteAfterUpload: true,
 * });
 * ```
 *
 * The `libo11y-sourcemaps` command does the same from a build job.
 *
 * @packageDocumentation
 */
export { findSourceMaps, type SourceMapFile } from "./find.ts";
export { UploadError, type UploadedMap, type UploadOptions, uploadSourceMaps } from "./upload.ts";
export { VERSION } from "./version.ts";
