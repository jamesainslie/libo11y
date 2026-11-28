import { useRum } from "@libo11y/rum-react";
import { createElement, type ReactElement, useEffect } from "react";
import { Text } from "react-native";

/** The home screen, which tells RUM it is on screen. */
export default function Home(): ReactElement {
  const rum = useRum();
  useEffect(() => {
    rum?.setViewName("/");
    rum?.viewRendered();
  }, [rum]);
  return createElement(Text, null, "home");
}
