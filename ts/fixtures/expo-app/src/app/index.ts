import { createElement, type ReactElement } from "react";
import { Text } from "react-native";

export default function Home(): ReactElement {
  return createElement(Text, null, "home");
}
