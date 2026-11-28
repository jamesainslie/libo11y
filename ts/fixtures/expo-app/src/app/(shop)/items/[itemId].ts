import { useLocalSearchParams } from "expo-router";
import { createElement, type ReactElement } from "react";
import { Text } from "react-native";

/** An item screen: the path carries the ID, the screen name the template /(shop)/items/[itemId]. */
export default function Item(): ReactElement {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  return createElement(Text, null, `item ${itemId}`);
}
