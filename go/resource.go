package o11y

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"

	"github.com/jamesainslie/libo11y/go/spec"
)

// instanceIDNamespace is the semconv-sanctioned UUIDv5 namespace for
// deriving service.instance.id from a stable inherent identifier.
var instanceIDNamespace = uuid.MustParse("4d63009a-8d0f-11ee-aad7-4c796ed8e320")

// serviceVersionFallback is recorded (with a startup-summary flag) when no
// version is resolvable, so version absence degrades telemetry rather than
// blocking startup.
const serviceVersionFallback = "0.0.0-unknown"

// buildResource composes the telemetry resource from detectors and explicit
// options, enforces the tier-0 identity contract, derives service.instance.id,
// applies the sensitivity policy, and stamps the single libo11y schema URL.
// It also returns how many resource attributes the policy dropped or
// tokenized per violation rule, for newSDK to record once the violation
// counter exists.
//
// Precedence, lowest to highest: build info, telemetry SDK identity, host,
// process runtime, and container detectors, then the environment
// (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME), then explicit option
// attributes. Detected values are library defaults, so the environment
// overrides them per the documented option-over-environment-over-default
// contract. Under [WithoutOTELEnv] the environment layer is skipped.
func buildResource(ctx context.Context, s *settings) (*resource.Resource, map[string]int, error) {
	explicit := make([]attribute.KeyValue, 0, len(s.resourceAttrs)+4)
	versionResolved := false
	if name := strings.TrimSpace(s.serviceName); name != "" {
		explicit = append(explicit, semconv.ServiceName(name))
	}
	if v := strings.TrimSpace(s.serviceVersion); v != "" {
		explicit = append(explicit, semconv.ServiceVersion(v))
		versionResolved = true
	}
	if ns := strings.TrimSpace(s.serviceNamespace); ns != "" {
		explicit = append(explicit, semconv.ServiceNamespace(ns))
	}
	if env := strings.TrimSpace(string(s.environment)); env != "" {
		explicit = append(explicit, semconv.DeploymentEnvironmentNameKey.String(env))
	}
	explicit = append(explicit, s.resourceAttrs...)

	opts := make([]resource.Option, 0, 8)
	if s.buildInfo {
		opts = append(opts, resource.WithDetectors(buildInfoDetector{}))
	}
	opts = append(opts,
		resource.WithTelemetrySDK(),
		resource.WithHost(),
		resource.WithProcessRuntimeName(),
		resource.WithProcessRuntimeVersion(),
		resource.WithContainer(),
	)
	if !s.ignoreEnv {
		// Immediately before the explicit attributes, so the environment
		// overrides detectors and options override the environment.
		opts = append(opts, resource.WithFromEnv())
	}
	opts = append(opts, resource.WithAttributes(explicit...))

	res, err := resource.New(ctx, opts...)
	if err != nil {
		// A partial resource (a detector failed, the rest succeeded) is
		// usable telemetry identity; refusing to start over a missing
		// container ID would violate the never-break-the-host contract.
		if res == nil || !errors.Is(err, resource.ErrPartialResource) {
			return nil, nil, fmt.Errorf("o11y: building resource: %w", err)
		}
	}

	res, err = enforceIdentity(res, s)
	if err != nil {
		return nil, nil, err
	}
	res, s.versionFallback = ensureServiceVersion(res, versionResolved)
	res = ensureInstanceID(res)

	// Apply the sensitivity policy, then stamp exactly one schema URL,
	// whatever the detectors carried, so resource merges downstream are
	// never undefined. Required identity survives classification because
	// tier-0 keys are classified public.
	policy := newSensitivityPolicy(s, nil)
	attrs, counts := classifyResourceAttrs(res.Attributes(), policy)
	res = resource.NewWithAttributes(spec.SchemaURL, attrs...)

	// The providers merge the environment resource underneath this one, so
	// an ambient key absent here reaches every signal with its ambient
	// value. Under WithoutOTELEnv every ambient key is shadowed. Otherwise
	// the keys the policy drops are shadowed, so a PII or secret value from
	// OTEL_RESOURCE_ATTRIBUTES cannot return through the merge; keys the
	// policy tokenizes are already present here with their token and win
	// the merge, and a tokenized key somehow absent here is shadowed rather
	// than leaked.
	shadow := func(key attribute.Key) bool { return policy.classOf(key) != actionKeep }
	if s.ignoreEnv {
		shadow = shadowAll
	}
	return shadowEnvironment(res, shadow), counts, nil
}

// classifyResourceAttrs applies the sensitivity policy to resource
// attributes once at startup, returning the surviving attributes and how
// many were removed or tokenized per rule (recorded after the violation
// counter exists).
func classifyResourceAttrs(attrs []attribute.KeyValue, p *sensitivityPolicy) ([]attribute.KeyValue, map[string]int) {
	kept := make([]attribute.KeyValue, 0, len(attrs))
	counts := map[string]int{}
	for _, kv := range attrs {
		switch p.classOf(kv.Key) {
		case actionDrop:
			counts[ruleFor(p.lookup(kv.Key))]++
		case actionRewrite:
			counts[ruleFor(p.lookup(kv.Key))]++
			kept = append(kept, kv.Key.String(p.token(canonicalAttr(kv.Value))))
		default:
			kept = append(kept, kv)
		}
	}
	return kept, counts
}

// enforceIdentity applies the tier-0 identity contract: a usable
// service.name and a valid deployment.environment.name, unless strict
// identity is disabled (in which case violations are left for the emit-time
// validator to observe).
func enforceIdentity(res *resource.Resource, s *settings) (*resource.Resource, error) {
	if !hasServiceName(res) {
		if s.strictIdentity {
			return nil, ErrNoServiceName
		}
	}

	env := resourceString(res, semconv.DeploymentEnvironmentNameKey)
	switch {
	case env == "":
		if s.strictIdentity {
			return nil, ErrNoEnvironment
		}
	case !s.environmentAllowed(env):
		if s.strictIdentity {
			return nil, fmt.Errorf("%w: %q (allowed: %s)", ErrInvalidEnvironment, env, s.allowedEnvironmentList())
		}
	}
	return res, nil
}

// ensureServiceVersion records the fallback version when none resolved,
// reporting whether the fallback was used.
func ensureServiceVersion(res *resource.Resource, resolved bool) (*resource.Resource, bool) {
	if resolved || resourceString(res, semconv.ServiceVersionKey) != "" {
		return res, false
	}
	// Merging a schemaless resource into res carries no schema-URL
	// conflict, so this error path is effectively unreachable; fall back to
	// the unmodified resource rather than dropping identity if it ever hits.
	merged, err := resource.Merge(res, resource.NewSchemaless(semconv.ServiceVersion(serviceVersionFallback)))
	if err != nil {
		return res, true
	}
	return merged, true
}

// ensureInstanceID derives service.instance.id when absent: UUIDv5 over the
// Kubernetes pod identity (from the Downward API resource attributes) when
// present, else a random UUIDv4 per process.
func ensureInstanceID(res *resource.Resource) *resource.Resource {
	if resourceString(res, semconv.ServiceInstanceIDKey) != "" {
		return res
	}
	var id string
	if podUID := resourceString(res, "k8s.pod.uid"); podUID != "" {
		id = uuid.NewSHA1(instanceIDNamespace, []byte(podUID)).String()
	} else if podName := resourceString(res, "k8s.pod.name"); podName != "" {
		ns := resourceString(res, "k8s.namespace.name")
		id = uuid.NewSHA1(instanceIDNamespace, []byte(ns+"/"+podName)).String()
	} else {
		id = uuid.NewString()
	}
	// As in ensureServiceVersion, a schemaless merge cannot conflict on the
	// schema URL, so the error path is unreachable in practice.
	merged, err := resource.Merge(res, resource.NewSchemaless(semconv.ServiceInstanceID(id)))
	if err != nil {
		return res
	}
	return merged
}

// buildInfoDetector records the compiled binary's identity from the Go
// build info: the main module version (as service.version) and the VCS
// stamp under the spec's names (vcs.ref.head.revision, o11y.build.time,
// o11y.build.modified).
type buildInfoDetector struct{}

// Detect implements [resource.Detector].
func (buildInfoDetector) Detect(context.Context) (*resource.Resource, error) {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return resource.Empty(), nil
	}
	return resource.NewSchemaless(buildInfoAttrs(info)...), nil
}

func buildInfoAttrs(info *debug.BuildInfo) []attribute.KeyValue {
	var attrs []attribute.KeyValue
	if version := info.Main.Version; version != "" && version != "(devel)" {
		attrs = append(attrs, semconv.ServiceVersion(version))
	}
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			if setting.Value != "" {
				attrs = append(attrs, attribute.String("vcs.ref.head.revision", setting.Value))
			}
		case "vcs.time":
			if setting.Value != "" {
				attrs = append(attrs, spec.BuildTime(setting.Value))
			}
		case "vcs.modified":
			if setting.Value != "" {
				attrs = append(attrs, spec.BuildModified(setting.Value == "true"))
			}
		}
	}
	return attrs
}

// hasServiceName reports whether the resource carries a usable service
// identity: non-blank after trimming and not the SDK's unknown_service
// fallback shape, regardless of which channel supplied it.
func hasServiceName(res *resource.Resource) bool {
	name := strings.TrimSpace(resourceString(res, semconv.ServiceNameKey))
	if name == "" || name == "unknown_service" || strings.HasPrefix(name, "unknown_service:") {
		return false
	}
	return true
}

func resourceString(res *resource.Resource, key attribute.Key) string {
	if res == nil {
		return ""
	}
	for _, kv := range res.Attributes() {
		if kv.Key == key {
			return kv.Value.AsString()
		}
	}
	return ""
}
