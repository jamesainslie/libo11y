import { createElement, type ReactElement } from "react";
import { Pressable, Text } from "react-native";

/** A screen whose button throws, for errors() and the symbolication check: src/app/boom.ts is in the map. */
export default function Boom(): ReactElement {
  return createElement(
    Pressable,
    {
      accessibilityRole: "button",
      onPress: () => {
        throw new Error("fixture boom");
      },
    },
    createElement(Text, null, "boom"),
  );
}
