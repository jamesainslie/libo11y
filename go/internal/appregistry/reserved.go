package appregistry

// ReservedSemconvVersion is the semantic conventions release that
// reservedNamespaces reflects. A specgen test fails when
// spec/registry/manifest.yaml pins a different release, so a semconv bump
// forces a review of the list. The test lives in specgen because this
// package is in the core library's import graph, where spec/ is absent.
const ReservedSemconvVersion = "1.41.0"

// reservedNamespaces are the namespaces an application may not claim:
// libo11y's own (o11y), OpenTelemetry's (otel), and the semconv entries of
// the pinned release (ReservedSemconvVersion). The semconv entries are that
// release's model directory names plus its attribute roots, the first
// segment of every attribute it defines.
var reservedNamespaces = map[string]bool{
	"o11y": true, "otel": true,
	"android": true, "app": true, "artifact": true, "aspnetcore": true, "aws": true, "az": true,
	"azure": true, "browser": true, "cassandra": true, "cicd": true, "cli": true, "client": true,
	"cloud": true, "cloudevents": true, "cloudfoundry": true, "code": true, "container": true,
	"cpu": true, "cpython": true, "db": true, "deployment": true, "destination": true, "device": true,
	"disk": true, "dns": true, "dotnet": true, "elasticsearch": true, "enduser": true, "error": true,
	"event": true, "exception": true, "faas": true, "feature_flag": true, "file": true, "gcp": true,
	"gen_ai": true, "geo": true, "go": true, "graphql": true, "hardware": true, "heroku": true,
	"host": true, "http": true, "hw": true, "ios": true, "jsonrpc": true, "jvm": true, "k8s": true,
	"kestrel": true, "linux": true, "log": true, "mainframe": true, "mcp": true, "message": true,
	"messaging": true, "net": true, "network": true, "nfs": true, "nodejs": true, "oci": true,
	"onc_rpc": true, "openai": true, "openshift": true, "opentracing": true, "oracle": true, "oracle_cloud": true,
	"oracledb": true, "os": true, "peer": true, "pool": true, "pprof": true, "process": true,
	"profile": true, "rpc": true, "security_rule": true, "server": true, "service": true,
	"session": true, "signalr": true, "source": true, "system": true, "telemetry": true, "test": true,
	"thread": true, "tls": true, "url": true, "user": true, "user_agent": true, "v8js": true,
	"vcs": true, "webengine": true, "zos": true,
}
