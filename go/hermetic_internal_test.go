package o11y

import (
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/resource"
)

func TestShadowEnvironmentSelectsAbsentKeys(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "team=ambient,region=ambient,host.name=ambient")
	t.Setenv("OTEL_SERVICE_NAME", "")
	const schema = "https://example.com/schema"
	res := resource.NewWithAttributes(schema, attribute.String("host.name", "library"))

	got := shadowEnvironment(res, func(k attribute.Key) bool { return k != "region" })

	if got.SchemaURL() != schema {
		t.Errorf("schema URL = %q, want %q", got.SchemaURL(), schema)
	}
	set := got.Set()
	if v, ok := set.Value("team"); !ok || v.AsString() != "" {
		t.Errorf("team = %q (present %v), want shadowed with an empty value", v.AsString(), ok)
	}
	if _, ok := set.Value("region"); ok {
		t.Error("region was shadowed although the selector rejected it")
	}
	if v, _ := set.Value("host.name"); v.AsString() != "library" {
		t.Errorf("host.name = %q, want the library value kept", v.AsString())
	}

	merged, err := resource.Merge(resource.Environment(), got)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	for _, kv := range merged.Attributes() {
		if kv.Value.AsString() == "ambient" && kv.Key != "region" {
			t.Errorf("provider-style merge kept ambient %s", kv.Key)
		}
	}
}

func TestShadowEnvironmentWithoutAmbientReturnsInput(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	t.Setenv("OTEL_SERVICE_NAME", "")
	res := resource.NewWithAttributes("s", attribute.String("k", "v"))
	if got := shadowEnvironment(res, shadowAll); got != res {
		t.Error("shadowEnvironment rebuilt the resource with no ambient attributes")
	}
}
