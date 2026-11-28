/** RumErrorBoundary: records render errors as o11y.rum.error with source boundary. */
import type { Rum } from "@libo11y/rum";
import { Component, type Context, createElement, type ErrorInfo, Fragment, type ReactNode } from "react";
import { RumContext } from "./provider.ts";

/** Props of RumErrorBoundary. */
export interface RumErrorBoundaryProps {
  /** The Rum to report to. Default: the nearest RumProvider's. */
  readonly rum?: Rum;
  /** Rendered after an error. A function receives the error. Default null. */
  readonly fallback?: ReactNode | ((error: unknown) => ReactNode);
  /** The tree whose render errors the boundary catches. */
  readonly children?: ReactNode;
}

/** State of RumErrorBoundary. */
export interface RumErrorBoundaryState {
  /** The error caught, once failed. */
  readonly error: unknown;
  /** Whether a render error was caught, so the fallback renders. */
  readonly failed: boolean;
}

/**
 * An error boundary that records a render error through rum.addError with source boundary and
 * React's component stack, then renders its fallback. Without a rum prop or a RumProvider above
 * it, it renders the fallback and records nothing.
 */
export class RumErrorBoundary extends Component<RumErrorBoundaryProps, RumErrorBoundaryState> {
  /** Reads the nearest RumProvider's Rum. */
  static override contextType: Context<Rum | undefined> = RumContext;
  /** The nearest RumProvider's Rum, or undefined. */
  declare context: Rum | undefined;
  override state: RumErrorBoundaryState = { error: undefined, failed: false };

  /** Switches to the fallback after a render error. */
  static getDerivedStateFromError(error: unknown): RumErrorBoundaryState {
    return { error, failed: true };
  }

  /** Records the error through rum.addError with source boundary and the component stack. */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const rum = this.props.rum ?? this.context;
    const stack = info.componentStack;
    rum?.addError(error, { source: "boundary", ...(stack ? { componentStack: stack } : {}) });
  }

  /** The children, or the fallback after an error. */
  override render(): ReactNode {
    if (!this.state.failed) return createElement(Fragment, null, this.props.children);
    const f = this.props.fallback;
    return typeof f === "function" ? f(this.state.error) : (f ?? null);
  }
}
