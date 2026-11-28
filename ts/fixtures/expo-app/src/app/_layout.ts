import { Stack } from "expo-router";
import { createElement, type ReactElement } from "react";
import "../telemetry";

export default function RootLayout(): ReactElement {
  return createElement(Stack);
}
