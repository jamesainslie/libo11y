package o11y_test

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
	"github.com/jamesainslie/libo11y/go/spec"
)

func resourceMap(attrs []attribute.KeyValue) map[string]string {
	m := map[string]string{}
	for _, kv := range attrs {
		m[string(kv.Key)] = kv.Value.String()
	}
	return m
}

// exportedResources emits one span, one metric point, and one log record
// through sdk and returns the resource attributes each signal exported with,
// keyed by signal, plus the collected metrics. It asserts that every exported
// resource carries the libo11y schema URL.
func exportedResources(t *testing.T, opts ...o11y.Option) (map[string][]attribute.KeyValue, metricdata.ResourceMetrics) {
	t.Helper()
	exp := &memLogExporter{}
	sdk, spans, reader, _ := newHermetic(t, append([]o11y.Option{o11y.WithLogExporter(exp)}, opts...)...)

	ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
	counter, err := sdk.MeterProvider().Meter("t").Int64Counter("c")
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(ctx, 1)
	sdk.Logger().InfoContext(ctx, "m")
	span.End()
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}

	ended := spans.Ended()
	if len(ended) != 1 {
		t.Fatalf("got %d spans", len(ended))
	}
	var md metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &md); err != nil {
		t.Fatal(err)
	}
	recs := exp.snapshot()
	if len(recs) == 0 {
		t.Fatal("no log exported")
	}
	resources := map[string]*resource.Resource{
		"SDK":     sdk.Resource(),
		"span":    ended[0].Resource(),
		"metrics": md.Resource,
		"log":     recs[0].Resource(),
	}
	attrs := make(map[string][]attribute.KeyValue, len(resources))
	for where, res := range resources {
		if res.SchemaURL() != spec.SchemaURL {
			t.Errorf("%s resource schema URL = %q, want %q", where, res.SchemaURL(), spec.SchemaURL)
		}
		attrs[where] = res.Attributes()
	}
	return attrs, md
}

func checkIdentity(t *testing.T, where string, m map[string]string) {
	t.Helper()
	if m["service.name"] != "libo11y-test" || m["deployment.environment.name"] != "test" || m["service.instance.id"] == "" {
		t.Errorf("%s resource lost identity: %v", where, m)
	}
}

func TestResourcePIIEnforcedOnEveryExportedSignal(t *testing.T) {
	t.Parallel()
	resources, md := exportedResources(t,
		o11y.WithResourceAttributes(
			attribute.String("host.ip", "10.9.8.7"),
			attribute.String("host.mac", "aa:bb:cc:dd:ee:ff")))
	for where, attrs := range resources {
		m := resourceMap(attrs)
		for _, key := range []string{"host.ip", "host.mac"} {
			if _, leaked := m[key]; leaked {
				t.Errorf("%s resource carries %s", where, key)
			}
		}
		checkIdentity(t, where, m)
	}

	var points []metricdata.DataPoint[int64]
	for _, scope := range md.ScopeMetrics {
		for _, metric := range scope.Metrics {
			if metric.Name != "o11y.schema.violations" {
				continue
			}
			sum, ok := metric.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("o11y.schema.violations data is %T", metric.Data)
			}
			for _, p := range sum.DataPoints {
				if signal, _ := p.Attributes.Value(spec.SignalKey); signal.AsString() == string(spec.SignalResource) {
					points = append(points, p)
				}
			}
		}
	}
	if len(points) != 1 {
		t.Fatalf("got %d resource violation points, want 1: %+v", len(points), points)
	}
	if rule, _ := points[0].Attributes.Value(spec.RuleKey); rule.AsString() != "pii_attribute" || points[0].Value != 2 {
		t.Errorf("resource violation = %s x %d, want pii_attribute x 2", rule.AsString(), points[0].Value)
	}
}

// TestResourceSecretFromEnvironment covers a secret-classified key that
// arrives through OTEL_RESOURCE_ATTRIBUTES: it must be shadowed (present with
// an empty value) on every exported resource, whatever the PII mode.
func TestResourceSecretFromEnvironment(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "o11y.test.secret=s3cr3t")
	secret := o11y.WithSensitivityForTest(map[attribute.Key]spectables.Sensitivity{
		"o11y.test.secret": spectables.Secret,
	})
	for name, opts := range map[string][]o11y.Option{
		"default": {secret},
		"allow":   {secret, o11y.WithPIIMode(o11y.PIIAllow)},
		"hash":    {secret, o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey)},
	} {
		t.Run(name, func(t *testing.T) {
			resources, _ := exportedResources(t, opts...)
			for where, attrs := range resources {
				m := resourceMap(attrs)
				for key, value := range m {
					if strings.Contains(value, "s3cr3t") {
						t.Errorf("%s resource %s carries the environment secret: %q", where, key, value)
					}
				}
				if got := m["o11y.test.secret"]; got != "" {
					t.Errorf("%s resource o11y.test.secret = %q, want shadowed empty", where, got)
				}
				checkIdentity(t, where, m)
			}
		})
	}
}

func TestResourcePIIHashedWithKey(t *testing.T) {
	t.Parallel()
	resources, _ := exportedResources(t,
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey),
		o11y.WithResourceAttributes(attribute.String("host.ip", "10.9.8.7")))
	for where, attrs := range resources {
		m := resourceMap(attrs)
		if got := m["host.ip"]; !strings.HasPrefix(got, tokenPrefix) || len(got) != len(tokenPrefix)+32 {
			t.Errorf("%s resource host.ip = %q, want an HMAC token", where, got)
		}
		checkIdentity(t, where, m)
	}
}

// TestResourcePIIFromEnvironment covers PII that arrives through
// OTEL_RESOURCE_ATTRIBUTES. The OTel providers merge the environment resource
// underneath the library's on every signal, so dropping the key from the
// library resource is not enough: the library must win the merge. Under
// PIIDrop the key is shadowed (present with an empty value, or absent); under
// PIIHash it carries the token.
func TestResourcePIIFromEnvironment(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "host.ip=10.9.8.7,o11y.test.env=kept")
	for name, tc := range map[string]struct {
		opts  []o11y.Option
		check func(got string) bool
	}{
		"drop": {nil, func(got string) bool { return got == "" }},
		"hash": {
			[]o11y.Option{o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey)},
			func(got string) bool { return strings.HasPrefix(got, tokenPrefix) && len(got) == len(tokenPrefix)+32 },
		},
	} {
		t.Run(name, func(t *testing.T) {
			resources, _ := exportedResources(t, tc.opts...)
			for where, attrs := range resources {
				m := resourceMap(attrs)
				for key, value := range m {
					if strings.Contains(value, "10.9.8.7") {
						t.Errorf("%s resource %s carries the raw environment PII: %q", where, key, value)
					}
				}
				if got := m["host.ip"]; !tc.check(got) {
					t.Errorf("%s resource host.ip = %q", where, got)
				}
				if got := m["o11y.test.env"]; got != "kept" {
					t.Errorf("%s resource lost a public environment attribute: o11y.test.env = %q", where, got)
				}
				checkIdentity(t, where, m)
			}
		})
	}
}
