/** RumProvider and useRum: the Rum handle in React context. */
import type { Rum } from "@libo11y/rum";
import { type Context, createContext, createElement, type ReactNode, useContext } from "react";

/** The context RumProvider fills. Internal: RumErrorBoundary reads it. */
export const RumContext: Context<Rum | undefined> = createContext<Rum | undefined>(undefined);

/** Props of RumProvider. */
export interface RumProviderProps {
  /** The handle setupRum returned, as telemetry.rum. */
  readonly rum: Rum;
  /** The tree that useRum and RumErrorBoundary can read rum from. */
  readonly children?: ReactNode;
}

/** Makes rum available to useRum and RumErrorBoundary below it. */
export function RumProvider(props: RumProviderProps): ReactNode {
  return createElement(RumContext.Provider, { value: props.rum }, props.children);
}

/** The Rum of the nearest RumProvider, or undefined without one. */
export function useRum(): Rum | undefined {
  return useContext(RumContext);
}
