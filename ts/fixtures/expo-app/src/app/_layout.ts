import { RumErrorBoundary, RumProvider } from "@libo11y/rum-react";
import type { ReactNativeRumTelemetry } from "@libo11y/rum-react-native";
import { Stack } from "expo-router";
import { createElement, type ReactElement, useEffect, useState } from "react";
import { telemetryReady } from "../telemetry";

/** The root layout: the routes inside RUM's provider and error boundary once telemetry is set up. */
export default function RootLayout(): ReactElement {
  const [telemetry, setTelemetry] = useState<ReactNativeRumTelemetry | undefined>(undefined);
  useEffect(() => {
    void telemetryReady.then(setTelemetry);
  }, []);
  if (telemetry === undefined) return createElement(Stack);
  return createElement(
    RumProvider,
    { rum: telemetry.rum },
    createElement(RumErrorBoundary, { fallback: null }, createElement(Stack)),
  );
}
