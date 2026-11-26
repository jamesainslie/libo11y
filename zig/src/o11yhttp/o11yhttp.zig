//! `o11yhttp`: zero-third-party-dependency OpenTelemetry HTTP server and client
//! instrumentation for Zig's `std.http.Server` and `std.http.Client`.
//!
//! Provides stable HTTP semantic conventions, route-aware server span naming,
//! `http.server.request.duration` and `http.client.request.duration` histograms
//! with trace exemplars, W3C trace context & baggage propagation, `public_endpoint`
//! span linking, `ignore_paths` globs, custom filters, `Server-Timing` traceparent
//! headers, and `canonical_line` (`o11y.request.summary`) wide events.

pub const common = @import("common.zig");
pub const glob = @import("glob.zig");
pub const server = @import("server.zig");
pub const client = @import("client.zig");

pub const scope_name = common.scope_name;
pub const duration_buckets = common.duration_buckets;

pub const Server = server.Server;
pub const ServerOptions = server.ServerOptions;
pub const ServerRequest = server.ServerRequest;
pub const FilterFn = server.FilterFn;
pub const RouteFn = server.RouteFn;

pub const Client = client.Client;
pub const ClientOptions = client.ClientOptions;
pub const ClientRequest = client.ClientRequest;
pub const PropagateFn = client.PropagateFn;

pub const pathMatch = glob.pathMatch;
pub const matchesAny = glob.matchesAny;
pub const MatchError = glob.MatchError;

pub const normalizeMethod = common.normalizeMethod;
pub const formatServerTiming = common.formatServerTiming;

test {
    _ = glob;
    _ = common;
    _ = server;
    _ = client;
}
