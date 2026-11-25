/**
 * WP5 (webext). setupContentScript for content scripts and extension pages.
 */
import type { ContentScriptSetupOptions, ContentScriptTelemetry } from "./options.ts";

/**
 * Builds and installs telemetry whose exporters forward to the worker. In order: the consent
 * controller from readStoredConsent (default "pending") and syncConsent; a memory queue; the
 * messaging transport; a delivery (mode "normal"); webPlatform with name "webext" and endpoints
 * set for all three signals to the marker "libo11y-webext:worker" (the batches never leave by
 * HTTP from here); setupWith with console defaulting to false; the instrumentations; flush on hide
 * when there is a document. Records cross to the worker as ExportMessages, and the application's
 * own messages carry context through the handle's sendMessage and onMessage.
 */
export function setupContentScript(options: ContentScriptSetupOptions = {}): Promise<ContentScriptTelemetry> {
  void options;
  throw new Error("not implemented");
}
