package o11yrum

import (
	"maps"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// oneMetricApp is a one-app config whose app defines the metric def, a
// YAML flow mapping.
func oneMetricApp(def string) string {
	return "apps:\n  - service_name: shop-web\n    origins: [\"https://shop.example\"]\n    metrics:\n      - " + def + "\n"
}

const validNetworkErrors = `{name: shop.rum.network_errors, instrument: counter, unit: "{error}", event: o11y.rum.error, where: {o11y.rum.error.source: network}, group_by: [o11y.rum.view.name, o11y.rum.platform]}`

const validViewTime = `{name: shop.rum.view_time, instrument: histogram, unit: s, event: o11y.rum.view.summary, value: o11y.rum.summary.time_on_view, group_by: [o11y.rum.view.name]}`

func TestMetricDefinitionValidation(t *testing.T) {
	for name, tc := range map[string]struct{ yaml, want string }{
		"reserved":          {oneMetricApp(`{name: o11y.rum.custom, instrument: counter, event: e}`), "reserved"},
		"reserved gateway":  {oneMetricApp(`{name: o11yrum.custom, instrument: counter, event: e}`), "reserved"},
		"bad name":          {oneMetricApp(`{name: Bad Name, instrument: counter, event: e}`), `name "Bad Name"`},
		"single segment":    {oneMetricApp(`{name: views, instrument: counter, event: e}`), `name "views"`},
		"instrument":        {oneMetricApp(`{name: shop.x, instrument: gauge, event: e}`), "instrument"},
		"no event":          {oneMetricApp(`{name: shop.x, instrument: counter, event: ""}`), "event is empty"},
		"unbounded":         {oneMetricApp(`{name: shop.x, instrument: counter, event: e, group_by: [session.id]}`), "group_by session.id is unbounded"},
		"unclassified":      {oneMetricApp(`{name: shop.x, instrument: counter, event: e, group_by: [shop.cart.size]}`), "group_by shop.cart.size is not classified bounded or enum by the specification"},
		"repeated group_by": {oneMetricApp(`{name: shop.x, instrument: counter, event: e, group_by: [o11y.rum.platform, o11y.rum.platform]}`), "group_by o11y.rum.platform is repeated"},
		"no value":          {oneMetricApp(`{name: shop.x, instrument: histogram, event: e}`), "value is required"},
		"value not numeric": {oneMetricApp(`{name: shop.x, instrument: histogram, event: e, value: o11y.rum.view.name}`), "value o11y.rum.view.name is not numeric"},
		"buckets decrease":  {oneMetricApp(`{name: shop.x, instrument: histogram, event: e, value: v, buckets: [2, 1]}`), "buckets must increase"},
		"buckets repeat":    {oneMetricApp(`{name: shop.x, instrument: histogram, event: e, value: v, buckets: [1, 1]}`), "buckets must increase"},
		"counter buckets":   {oneMetricApp(`{name: shop.x, instrument: counter, event: e, buckets: [1]}`), "buckets apply only to histograms"},
		"duplicate": {
			"apps:\n  - service_name: shop-web\n    origins: [\"https://shop.example\"]\n    metrics:\n      - " + validNetworkErrors + "\n      - " + validNetworkErrors + "\n",
			"duplicate metric shop.rum.network_errors",
		},
		"defined differently": {
			"apps:\n" +
				"  - {service_name: a, origins: [\"https://a\"], metrics: [{name: lor.signing_errors, instrument: counter, unit: \"{error}\", event: e}]}\n" +
				"  - {service_name: b, origins: [\"https://b\"], metrics: [{name: lor.signing_errors, instrument: counter, unit: \"1\", event: e}]}\n",
			"defined differently",
		},
		"buckets differ across apps": {
			"apps:\n" +
				"  - {service_name: a, origins: [\"https://a\"], metrics: [{name: lor.t, instrument: histogram, unit: s, event: e, value: v}]}\n" +
				"  - {service_name: b, origins: [\"https://b\"], metrics: [{name: lor.t, instrument: histogram, unit: s, event: e, value: v, buckets: [1]}]}\n",
			"defined differently",
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tc.yaml))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestMetricDefinitionValid(t *testing.T) {
	cfg, err := ParseConfig([]byte(oneMetricApp(validNetworkErrors) + "      - " + validViewTime + "\n"))
	if err != nil {
		t.Fatal(err)
	}
	defs := cfg.Apps[0].Metrics
	if len(defs) != 2 || defs[0].Where["o11y.rum.error.source"] != "network" {
		t.Fatalf("%+v", defs)
	}
	if !slices.Equal(defs[1].Buckets, secondsBounds) {
		t.Fatalf("histogram default buckets %v", defs[1].Buckets)
	}
	if defs[0].Buckets != nil {
		t.Fatalf("counter buckets %v", defs[0].Buckets)
	}
	// Two apps may share a metric defined the same way.
	shared := "apps:\n" +
		"  - {service_name: a, origins: [\"https://a\"], metrics: [{name: lor.signing_errors, instrument: counter, unit: \"{error}\", event: e}]}\n" +
		"  - {service_name: b, origins: [\"https://b\"], metrics: [{name: lor.signing_errors, instrument: counter, unit: \"{error}\", event: f}]}\n"
	if _, err := ParseConfig([]byte(shared)); err != nil {
		t.Fatal(err)
	}
}

func TestMetricDefinitionsAreCopied(t *testing.T) {
	cfg, err := ParseConfig([]byte(oneMetricApp(validNetworkErrors)))
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(NewMetricProducer()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	cfg.Apps[0].Metrics[0].Where["o11y.rum.error.source"] = "uncaught"
	cfg.Apps[0].Metrics[0].GroupBy[0] = "session.id"
	got := h.derive.defs["shop-web"][0]
	if got.where["o11y.rum.error.source"] != "network" || got.groupBy[0] != "o11y.rum.view.name" {
		t.Fatalf("handler shares the caller's config: %+v", got)
	}
}

// operatorLogs is one batch for shop-web holding the given records.
func operatorLogs(recs ...pcommon.Map) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	sl := rl.ScopeLogs().AppendEmpty()
	for _, attrs := range recs {
		lr := sl.LogRecords().AppendEmpty()
		attrs.CopyTo(lr.Attributes())
		if v, ok := attrs.Get("event.name"); ok {
			lr.SetEventName(v.Str())
			lr.Attributes().Remove("event.name")
		}
	}
	return ld
}

func rumError(source string) pcommon.Map {
	m := pcommon.NewMap()
	m.PutStr("event.name", eventRUMError)
	m.PutStr("o11y.rum.error.source", source)
	m.PutStr("exception.type", "TypeError")
	m.PutStr("session.id", "s1")
	m.PutStr("o11y.rum.view.id", "v0")
	m.PutStr("o11y.rum.view.name", "/")
	m.PutStr("o11y.rum.platform", "web")
	return m
}

func operatorDeriver(t *testing.T, yaml string) (*deriver, *MetricProducer) {
	t.Helper()
	cfg, err := ParseConfig([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	p := NewMetricProducer()
	h, err := NewHandler(WithConfig(cfg), WithMetricProducer(p))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h.derive, p
}

func TestOperatorMetrics(t *testing.T) {
	d, _ := operatorDeriver(t, oneMetricApp(validNetworkErrors)+"      - "+validViewTime+"\n")
	summary := baseSummary(0)
	summary.PutStr("event.name", eventViewSummary)
	summary.PutStr("o11y.rum.view.name", "/")
	d.logs("shop-web", operatorLogs(rumError("network"), rumError("uncaught"), summary))
	got := map[string]float64{}
	for k, v := range flatten(d.agg.Produce()) {
		if strings.HasPrefix(k, "shop.") {
			got[k] = v
		}
	}
	want := map[string]float64{
		"shop.rum.network_errors{o11y.rum.platform=web,o11y.rum.view.name=/,service.name=shop-web}": 1,
		"shop.rum.view_time{o11y.rum.view.name=/,service.name=shop-web}#count":                      1,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got\n%v\nwant\n%v", got, want)
	}
	for _, sm := range d.agg.Produce() {
		for _, m := range sm.Metrics {
			if strings.HasPrefix(m.Name, "shop.") && sm.Scope.Name != scopeName {
				t.Fatalf("%s in scope %s", m.Name, sm.Scope.Name)
			}
		}
	}
}

func TestOperatorMetricsAreAppScoped(t *testing.T) {
	// Another app's records never count toward shop-web's definitions.
	d, _ := operatorDeriver(t, oneMetricApp(validNetworkErrors)+"  - {service_name: other, origins: [\"https://o\"]}\n")
	d.logs("other", operatorLogs(rumError("network")))
	for k := range flatten(d.agg.Produce()) {
		if strings.HasPrefix(k, "shop.") {
			t.Fatalf("series %s", k)
		}
	}
}

func TestOperatorMetricValues(t *testing.T) {
	yaml := oneMetricApp(`{name: shop.items, instrument: counter, event: shop.cart, value: shop.cart.items}`) +
		"      - {name: shop.carts, instrument: counter, event: shop.cart}\n" +
		"      - {name: shop.total, instrument: histogram, event: shop.cart, value: shop.cart.total, buckets: [10, 100]}\n"
	d, _ := operatorDeriver(t, yaml)
	cart := func(items any, total any) pcommon.Map {
		m := pcommon.NewMap()
		m.PutStr("event.name", "shop.cart")
		switch v := items.(type) {
		case int:
			m.PutInt("shop.cart.items", int64(v))
		case string:
			m.PutStr("shop.cart.items", v)
		}
		switch v := total.(type) {
		case float64:
			m.PutDouble("shop.cart.total", v)
		case string:
			m.PutStr("shop.cart.total", v)
		}
		return m
	}
	d.logs("shop-web", operatorLogs(cart(3, 42.5), cart(nil, nil), cart("many", "lots"), cart(-2, 5.0)))
	got := flatten(d.agg.Produce())
	want := map[string]float64{
		// 3, then nothing for a missing, non-numeric or negative value.
		"shop.items{service.name=shop-web}": 3,
		// Every record counts when the counter has no value.
		"shop.carts{service.name=shop-web}": 4,
		// A histogram records only numeric values.
		"shop.total{service.name=shop-web}#count": 2,
	}
	if !maps.Equal(got, want) {
		t.Fatalf("got\n%v\nwant\n%v", got, want)
	}
}

func TestOperatorMetricGroupByNonString(t *testing.T) {
	d, _ := operatorDeriver(t, oneMetricApp(`{name: shop.requests, instrument: counter, event: shop.req, group_by: [o11y.build.modified]}`))
	rec := pcommon.NewMap()
	rec.PutStr("event.name", "shop.req")
	rec.PutBool("o11y.build.modified", true)
	d.logs("shop-web", operatorLogs(rec))
	if got := flatten(d.agg.Produce()); got["shop.requests{o11y.build.modified=true,service.name=shop-web}"] != 1 {
		t.Fatalf("%v", got)
	}
}

func TestOperatorMetricWhereMatchesEveryPair(t *testing.T) {
	d, _ := operatorDeriver(t, oneMetricApp(`{name: shop.web_network, instrument: counter, event: o11y.rum.error, where: {o11y.rum.error.source: network, o11y.rum.platform: web}}`))
	mobile := rumError("network")
	mobile.PutStr("o11y.rum.platform", "react_native")
	missing := rumError("network")
	missing.Remove("o11y.rum.platform")
	d.logs("shop-web", operatorLogs(rumError("network"), mobile, missing))
	if got := flatten(d.agg.Produce()); got["shop.web_network{service.name=shop-web}"] != 1 {
		t.Fatalf("%v", got)
	}
}
