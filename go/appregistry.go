package o11y

import (
	"fmt"
	"io/fs"
	"strings"

	"go.opentelemetry.io/otel/attribute"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// appRegistrySource names one registry file for New to load.
type appRegistrySource struct {
	fsys fs.FS
	path string
}

// WithAppRegistry loads an application attribute registry (schema
// libo11y.app-registry/v1, described in docs/SPEC.md section 5a) from path
// in fsys when the SDK is built. The sensitivity policy then classifies the
// registry's keys exactly like specification keys, on every signal: a key
// registered secret is always dropped, a key registered pii is dropped,
// hashed, or kept according to [WithPIIMode], and keys registered public or
// internal pass. path is an [fs.FS] path: slash-separated and unrooted,
// with no "." or ".." elements.
//
// [New] and [Setup] fail with an error wrapping [ErrInvalidAppRegistry]
// when fsys is nil (including a typed nil pointer) or the registry breaks a
// rule, and with the read or parse error when the file cannot be read or
// parsed. The option may be given more than once for registries with
// different namespaces; two registries that declare the same namespace are
// an error. Only sensitivity applies at runtime: types, cardinality
// budgets, and enum values are checked by the validator and by
// `libo11y registry check`, not on emitted telemetry.
//
// Embed the registry so the binary carries it:
//
//	//go:embed o11y-registry.yaml
//	var registryFS embed.FS
//
//	sdk, err := o11y.Setup(ctx, o11y.WithAppRegistry(registryFS, "o11y-registry.yaml"), ...)
func WithAppRegistry(fsys fs.FS, path string) Option {
	return func(s *settings) {
		s.appRegistries = append(s.appRegistries, appRegistrySource{fsys: fsys, path: path})
	}
}

// loadAppRegistries reads, parses, and validates every registry source and
// returns the sensitivity class of every registered key, or nil when no
// source is configured.
func loadAppRegistries(sources []appRegistrySource) (map[attribute.Key]spectables.Sensitivity, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	classes := map[attribute.Key]spectables.Sensitivity{}
	declaredBy := map[string]string{} // namespace -> path of the registry declaring it
	for _, src := range sources {
		if isNil(src.fsys) {
			return nil, fmt.Errorf("%w: %s: nil fs.FS", ErrInvalidAppRegistry, src.path)
		}
		raw, err := fs.ReadFile(src.fsys, src.path)
		if err != nil {
			return nil, fmt.Errorf("o11y: reading application registry: %w", err)
		}
		reg, err := appregistry.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("o11y: %s: %w", src.path, err) // Parse names the registry
		}
		if violations := reg.Validate(); len(violations) > 0 {
			lines := make([]string, len(violations))
			for i, v := range violations {
				lines[i] = v.String()
			}
			return nil, fmt.Errorf("%w: %s: %s", ErrInvalidAppRegistry, src.path, strings.Join(lines, "; "))
		}
		if first, dup := declaredBy[reg.Namespace]; dup {
			return nil, fmt.Errorf("%w: %s and %s both declare namespace %q",
				ErrInvalidAppRegistry, first, src.path, reg.Namespace)
		}
		declaredBy[reg.Namespace] = src.path
		for name, attr := range reg.Attributes {
			classes[attribute.Key(name)] = sensitivityClass(attr.Sensitivity)
		}
	}
	return classes, nil
}

// sensitivityClass maps a validated registry class to the table type.
// Validate has already refused any other value.
func sensitivityClass(class string) spectables.Sensitivity {
	switch class {
	case "public":
		return spectables.Public
	case "internal":
		return spectables.Internal
	case "pii":
		return spectables.PII
	case "secret":
		return spectables.Secret
	default:
		return spectables.Unclassified
	}
}
