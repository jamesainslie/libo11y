package o11y

import (
	"fmt"
	"slices"
	"strings"

	"go.opentelemetry.io/contrib/propagators/autoprop"
	"go.opentelemetry.io/otel/propagation"
)

// envPropagators is the standard variable that names the propagators.
const envPropagators = "OTEL_PROPAGATORS"

// noPropagation names the propagator that carries nothing, as the
// OpenTelemetry specification names it in OTEL_PROPAGATORS.
const noPropagation = "none"

// fieldlessPropagation is what the effective configuration reports for a
// configured propagator that names no fields but is not the none
// propagator, such as a custom propagator or an empty composite. An empty
// value would be easy to misread.
const fieldlessPropagation = "custom"

// builtPropagator is the propagator the settings select, before the
// baggage egress filter wraps it, and the field list the effective
// configuration reports for it.
type builtPropagator struct {
	propagator propagation.TextMapPropagator
	// fields are the propagators' fields in their configured order, each
	// field once; "none" for the none propagator; "custom" for propagators
	// that name no fields.
	fields string
}

// buildPropagator resolves the propagator. [WithPropagators] wins.
// Otherwise OTEL_PROPAGATORS (ignored under [WithoutOTELEnv]) is read as a
// comma-separated list: each entry is trimmed of surrounding whitespace
// and empty entries are dropped, so a value with no names is unset. Each
// name is resolved by OpenTelemetry contrib's autoprop registry
// (tracecontext, baggage, b3, b3multi, jaeger, xray, ottrace, none), and
// names stay case-sensitive as the specification defines them. A name the
// registry does not know is an error, even next to known ones or next to
// none, rather than a silent fallback. A list that names none carries
// nothing. With no names the default composite of W3C Trace Context and
// W3C Baggage applies.
//
// autoprop's own environment reader is not used: it reports an unknown
// name through the global error handler and falls back, so it cannot fail
// construction, and it neither trims nor checks every name.
func buildPropagator(s *settings) (builtPropagator, error) {
	if len(s.propagators) > 0 {
		return composeInOrder(s.propagators), nil
	}
	var names []string
	for _, name := range strings.Split(s.getenv(envPropagators), ",") {
		if name = strings.TrimSpace(name); name != "" {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return composeInOrder([]propagation.TextMapPropagator{propagation.TraceContext{}, propagation.Baggage{}}), nil
	}
	props := make([]propagation.TextMapPropagator, 0, len(names))
	for _, name := range names {
		p, err := autoprop.TextMapPropagator(name)
		if err != nil {
			return builtPropagator{}, fmt.Errorf("o11y: building propagator: %q: %w", name, err)
		}
		props = append(props, p)
	}
	if slices.Contains(names, noPropagation) {
		return builtPropagator{propagator: propagation.NewCompositeTextMapPropagator(), fields: noPropagation}, nil
	}
	return composeInOrder(props), nil
}

// composeInOrder composes props, a non-empty list, into one propagator and
// lists their fields in order, keeping the first occurrence of each. A
// composite's own Fields method returns map order, so the list is built
// here instead.
func composeInOrder(props []propagation.TextMapPropagator) builtPropagator {
	var fields []string
	for _, p := range props {
		for _, f := range p.Fields() {
			if !slices.Contains(fields, f) {
				fields = append(fields, f)
			}
		}
	}
	built := builtPropagator{fields: strings.Join(fields, ",")}
	if built.fields == "" {
		built.fields = fieldlessPropagation
	}
	if len(props) == 1 {
		built.propagator = props[0]
	} else {
		built.propagator = propagation.NewCompositeTextMapPropagator(props...)
	}
	return built
}
