import { Stack } from "expo-router";
import { createElement, type ReactElement } from "react";

/** The shop group: its own stack, so the route template keeps the (shop) group. */
export default function ShopLayout(): ReactElement {
  return createElement(Stack);
}
