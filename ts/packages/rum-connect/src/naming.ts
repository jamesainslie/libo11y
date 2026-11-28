/**
 * connectRequestNaming: names the fetch spans of Connect and gRPC-Web RPCs as
 * <package.Service>/<Method>, the way go/o11yconnect names its client spans, with rpc.system.name
 * and rpc.method. RUM's breadcrumbs then label the request with the RPC method instead of
 * "<METHOD> <host> <status>".
 */
import type { Rum } from "@libo11y/rum";

const ATTR_RPC_SYSTEM_NAME = "rpc.system.name";
const ATTR_RPC_METHOD = "rpc.method";

/** The last two path segments: a package-qualified service and a method. */
const RPC_PATH = /\/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)\/([A-Za-z_]\w*)$/;

/** Options for connectRequestNaming. */
export interface ConnectNamingOptions {
  /** Only these fully qualified services, such as "lor.signing.v1.SigningService". Default: any. */
  readonly services?: readonly string[];
  /** The rpc.system.name value. Default "connectrpc"; pass "grpc" for a gRPC-Web transport. */
  readonly system?: "connectrpc" | "grpc";
}

/** The service and method of an RPC path, or undefined. Any base path before them is allowed. */
export function rpcOf(pathname: string): { readonly service: string; readonly method: string } | undefined {
  const m = RPC_PATH.exec(pathname);
  if (m === null) return undefined;
  const [, service, method] = m;
  return service === undefined || method === undefined ? undefined : { service, method };
}

/**
 * Names fetch and XHR spans of Connect RPCs as `<service>/<method>` with rpc.system.name and
 * rpc.method. A request is an RPC when its path ends in `/<package.Service>/<Method>` and it is a
 * POST, or a GET with the Connect protocol's connect=v1 query parameter. Returns the uninstall.
 */
export function connectRequestNaming(rum: Rum, opts: ConnectNamingOptions = {}): () => void {
  const services = opts.services === undefined ? undefined : new Set(opts.services);
  const system = opts.system ?? "connectrpc";
  return rum.onRequestStart((span, request) => {
    const method = request.method.toUpperCase();
    const isRpcMethod =
      method === "POST" || (method === "GET" && request.url.searchParams.get("connect") === "v1");
    if (!isRpcMethod) return;
    const rpc = rpcOf(request.url.pathname);
    if (rpc === undefined || (services !== undefined && !services.has(rpc.service))) return;
    const name = `${rpc.service}/${rpc.method}`;
    span.updateName(name);
    span.setAttribute(ATTR_RPC_SYSTEM_NAME, system);
    span.setAttribute(ATTR_RPC_METHOD, name);
  });
}
