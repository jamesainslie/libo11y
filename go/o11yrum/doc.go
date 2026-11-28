// Package o11yrum is the libo11y RUM gateway. NewHandler returns an
// http.Handler that serves /_o11y/v1/ for browsers, browser extensions and
// React Native apps: OTLP ingest of traces, logs and app metrics, remote
// configuration, source map uploads and session replay segments.
//
// Handler.ReplayReadHandler returns the session replay read API, which
// lists, reads and erases stored recordings. It is cluster-internal only.
// ServeHTTP does not serve it, so it runs on a listener of its own. The
// read API never serves a segment older than replay.retention. A
// background sweeper deletes such segments every replay.sweep_interval
// until Close, and a sweep_interval of 0s turns it off.
//
// Each ingest request passes edge checks (rate limit, body size caps,
// app identification by service.name, origin allow-list), validation
// against the libo11y specification, enrichment (user agent, country,
// clock skew), symbolication of JavaScript stacks, export to every Sink,
// and metric derivation. The gateway is stateless apart from its object
// store and in-memory aggregates, so it scales by adding replicas.
//
// The gateway never stores, logs or exports a client address.
package o11yrum
