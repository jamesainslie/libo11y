/** The value types the libo11y logger accepts, shared by the logger, the policy and the sinks. */

/** A log level, lowest to highest. */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** One log attribute value. A plain object is a group: its members are judged on dotted keys. */
export type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Uint8Array
  | Error
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

/** The attributes of one log record. */
export type LogAttributes = { readonly [key: string]: LogValue };
