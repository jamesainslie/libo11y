package o11y_test

import (
	"context"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
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
// keyed by signal, plus the collected metrics.
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

	if sdk.Resource().SchemaURL() != spec.SchemaURL {
		t.Errorf("schema URL = %q", sdk.Resource().SchemaURL())
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
	return map[string][]attribute.KeyValue{
		"SDK":     sdk.Resource().Attributes(),
		"span":    ended[0].Resource().Attributes(),
		"metrics": md.Resource.Attributes(),
		"log":     recs[0].Resource().Attributes(),
	}, md
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
		o11y.WithResourceAttributes(attribute.String("host.ip", "10.9.8.7")))
	for where, attrs := range resources {
		m := resourceMap(attrs)
		if _, leaked := m["host.ip"]; leaked {
			t.Errorf("%s resource carries host.ip", where)
		}
		checkIdentity(t, where, m)
	}

	var resourceViolations int64
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
				signal, _ := p.Attributes.Value(spec.SignalKey)
				rule, _ := p.Attributes.Value(spec.RuleKey)
				if signal.AsString() == string(spec.SignalResource) && rule.AsString() == "pii_attribute" {
					resourceViolations += p.Value
				}
			}
		}
	}
	if resourceViolations != 1 {
		t.Errorf("resource pii_attribute violations = %d, want 1", resourceViolations)
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
