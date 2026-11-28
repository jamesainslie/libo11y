import { useRum } from "@libo11y/rum-react";
import { createElement, Fragment, type ReactElement } from "react";
import { Text } from "react-native";

/** The home screen. The root layout names it; it shows whether rum-react's provider reaches it. */
export default function Home(): ReactElement {
  const rum = useRum();
  return createElement(
    Fragment,
    null,
    createElement(Text, null, "home"),
    rum === undefined ? null : createElement(Text, null, "rum ready"),
  );
}
