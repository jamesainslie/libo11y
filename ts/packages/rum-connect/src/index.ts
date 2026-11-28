/**
 * Connect adapter for `@libo11y/rum`: names the fetch spans of Connect and gRPC-Web RPCs by
 * service and method.
 */
export { type ConnectNamingOptions, connectRequestNaming, rpcOf } from "./naming.ts";
export { VERSION } from "./version.ts";
