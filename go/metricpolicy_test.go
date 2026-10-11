package o11y_test

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
)

func collectSums(t *testing.T, reader *sdkmetric.ManualReader) map[string][]metricdata.DataPoint[int64] {
	t.Helper()
	var md metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &md); err != nil {
		t.Fatal(err)
	}
	out := map[string][]metricdata.DataPoint[int64]{}
	for _, sm := range md.ScopeMetrics {
		for _, m := range sm.Metrics {
			if sum, ok := m.Data.(metricdata.Sum[int64]); ok {
				out[m.Name] = append(out[m.Name], sum.DataPoints...)
			}
		}
	}
	return out
}

func recordClassified(t *testing.T, sdk *o11y.SDK) {
	t.Helper()
	ctx, span := sdk.TracerProvider().Tracer("t").Start(context.Background(), "op")
	defer span.End()
	c, err := sdk.MeterProvider().Meter("t").Int64Counter("c")
	if err != nil {
		t.Fatal(err)
	}
	c.Add(ctx, 1, metric.WithAttributes(
		attribute.String("host.ip", "10.9.8.7"),
		attribute.String("test.secret", "s3"),
		attribute.String("route", "/x")))
}

func assertPointClean(t *testing.T, dp metricdata.DataPoint[int64], wantRoute bool) {
	t.Helper()
	for _, key := range []attribute.Key{"host.ip", "test.secret"} {
		if _, ok := dp.Attributes.Value(key); ok {
			t.Errorf("data point carries %s", key)
		}
	}
	if _, ok := dp.Attributes.Value("route"); ok != wantRoute {
		t.Errorf("route present = %v, want %v", ok, wantRoute)
	}
	if len(dp.Exemplars) == 0 {
		t.Fatal("no exemplar recorded inside a sampled span")
	}
	for _, ex := range dp.Exemplars {
		for _, kv := range ex.FilteredAttributes {
			if kv.Key == "host.ip" || kv.Key == "test.secret" {
				t.Errorf("exemplar filtered attributes carry %s", kv.Key)
			}
		}
	}
}

func TestMetricPolicyDropsClassifiedAttributes(t *testing.T) {
	t.Parallel()
	for name, opts := range map[string][]o11y.Option{
		"drop": nil,
		"hash": {o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey)},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			sdk, _, reader, _ := newHermetic(t, append(opts, o11y.WithSensitivityForTest(secretTable))...)
			recordClassified(t, sdk)
			points := collectSums(t, reader)["c"]
			if len(points) != 1 {
				t.Fatalf("got %d points for c", len(points))
			}
			assertPointClean(t, points[0], true)
		})
	}
}

func TestMetricPolicyComposesWithUserViews(t *testing.T) {
	t.Parallel()
	rename := sdkmetric.NewView(sdkmetric.Instrument{Name: "c"},
		sdkmetric.Stream{Name: "c.renamed", AttributeFilter: attribute.NewDenyKeysFilter("route")})
	copyView := sdkmetric.NewView(sdkmetric.Instrument{Name: "c"}, sdkmetric.Stream{Name: "c.copy"})
	sdk, _, reader, _ := newHermetic(t, o11y.WithViews(rename, copyView), o11y.WithSensitivityForTest(secretTable))
	recordClassified(t, sdk)
	sums := collectSums(t, reader)
	if len(sums["c.renamed"]) != 1 || len(sums["c.copy"]) != 1 || len(sums["c"]) != 0 {
		t.Fatalf("view semantics changed: %v", sums)
	}
	assertPointClean(t, sums["c.renamed"][0], false) // user filter still removes route
	assertPointClean(t, sums["c.copy"][0], true)
}

// PIIAllow keeps PII on metrics; secrets are dropped under every mode.
func TestMetricPolicyPIIAllowKeepsPII(t *testing.T) {
	t.Parallel()
	sdk, _, reader, _ := newHermetic(t, o11y.WithPIIMode(o11y.PIIAllow), o11y.WithSensitivityForTest(secretTable))
	recordClassified(t, sdk)
	points := collectSums(t, reader)["c"]
	if len(points) != 1 {
		t.Fatalf("got %d points for c", len(points))
	}
	if v, ok := points[0].Attributes.Value("host.ip"); !ok || v.AsString() != "10.9.8.7" {
		t.Errorf("PIIAllow host.ip = %q (present %v), want 10.9.8.7", v.AsString(), ok)
	}
	if _, ok := points[0].Attributes.Value("test.secret"); ok {
		t.Error("secret attribute kept under PIIAllow")
	}
}

// The policy strips only classified keys from exemplar filtered attributes:
// a key a user view filtered out of the data point still reaches the
// exemplar, as the SDK documents.
func TestMetricPolicyKeepsUnclassifiedExemplarAttributes(t *testing.T) {
	t.Parallel()
	deny := sdkmetric.NewView(sdkmetric.Instrument{Name: "c"},
		sdkmetric.Stream{AttributeFilter: attribute.NewDenyKeysFilter("route")})
	sdk, _, reader, _ := newHermetic(t, o11y.WithViews(deny), o11y.WithSensitivityForTest(secretTable))
	recordClassified(t, sdk)
	points := collectSums(t, reader)["c"]
	if len(points) != 1 {
		t.Fatalf("got %d points for c", len(points))
	}
	assertPointClean(t, points[0], false)
	for _, ex := range points[0].Exemplars {
		found := false
		for _, kv := range ex.FilteredAttributes {
			found = found || kv.Key == "route"
		}
		if !found {
			t.Errorf("exemplar lost the unclassified filtered attribute route: %v", ex.FilteredAttributes)
		}
	}
}

// The catch-all view the policy adds for instruments no user view matches
// must reproduce the SDK's default stream: name, description, and unit.
func TestMetricPolicyKeepsDefaultStreamIdentity(t *testing.T) {
	t.Parallel()
	sdk, _, reader, _ := newHermetic(t)
	c, err := sdk.MeterProvider().Meter("t").Int64Counter("plain",
		metric.WithDescription("a plain counter"), metric.WithUnit("{item}"))
	if err != nil {
		t.Fatal(err)
	}
	c.Add(context.Background(), 1)
	var md metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &md); err != nil {
		t.Fatal(err)
	}
	for _, sm := range md.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == "plain" {
				if m.Description != "a plain counter" || m.Unit != "{item}" {
					t.Errorf("stream identity changed: description %q unit %q", m.Description, m.Unit)
				}
				return
			}
		}
	}
	t.Fatal("metric plain not collected under its instrument name")
}
