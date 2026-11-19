package o11y_test

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/appregistry"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// lorRegistry declares one attribute for each class the runtime treats
// differently.
const lorRegistry = `schema: libo11y.app-registry/v1
namespace: lor
attributes:
  lor.user.id:      {type: string, sensitivity: internal, cardinality: unbounded}
  lor.user.role:    {type: string, sensitivity: public, cardinality: enum, values: [studio, client]}
  lor.client.email: {type: string, sensitivity: pii, cardinality: unbounded}
  lor.api.token:    {type: string, sensitivity: secret, cardinality: unbounded}
`

// registryFS serves each name in files with the given contents.
func registryFS(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{}
	for name, body := range files {
		fsys[name] = &fstest.MapFile{Data: []byte(body)}
	}
	return fsys
}

func withLORRegistry() o11y.Option {
	return o11y.WithAppRegistry(registryFS(map[string]string{"o11y-registry.yaml": lorRegistry}), "o11y-registry.yaml")
}

// onlyRecord returns the single console record, failing the test when
// there is not exactly one.
func onlyRecord(t *testing.T, console *bytes.Buffer) map[string]any {
	t.Helper()
	records := consoleRecords(t, console)
	if len(records) != 1 {
		t.Fatalf("got %d console records, want 1", len(records))
	}
	return records[0]
}

func TestAppRegistryClassifiesLogAttributes(t *testing.T) {
	sdk, _, _, console := newHermetic(t, withLORRegistry())
	sdk.Logger().Info("event",
		"lor.user.id", "u-1", "lor.client.email", "a@example.com", "lor.api.token", "t0k")

	record := onlyRecord(t, console)
	if got := record["lor.user.id"]; got != "u-1" {
		t.Errorf("lor.user.id = %v, want u-1: internal keys pass", got)
	}
	for _, key := range []string{"lor.client.email", "lor.api.token"} {
		if value, present := record[key]; present {
			t.Errorf("%s = %v, want it dropped", key, value)
		}
	}
}

func TestAppRegistryHashesPIIUnderPIIHash(t *testing.T) {
	sdk, _, _, console := newHermetic(t, withLORRegistry(),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	sdk.Logger().Info("event", "lor.client.email", "a@example.com")

	got, _ := onlyRecord(t, console)["lor.client.email"].(string)
	if !strings.HasPrefix(got, "hmac-sha256:") {
		t.Errorf("lor.client.email = %q, want an hmac-sha256 token", got)
	}
}

func TestAppRegistryClassifiesSpanAttributes(t *testing.T) {
	rec := o11ytest.Start(t, withLORRegistry())
	_, span := rec.SDK.TracerProvider().Tracer("test").Start(context.Background(), "op")
	span.SetAttributes(
		attribute.String("lor.user.id", "u-1"),
		attribute.String("lor.client.email", "a@example.com"),
		attribute.String("lor.api.token", "t0k"),
	)
	span.End()

	spans := rec.Spans()
	if len(spans) != 1 {
		t.Fatalf("got %d spans, want 1", len(spans))
	}
	attrs := attribute.NewSet(spans[0].Attributes()...)
	if v, ok := attrs.Value("lor.user.id"); !ok || v.AsString() != "u-1" {
		t.Errorf("lor.user.id = %q (present %v), want u-1", v.AsString(), ok)
	}
	for _, key := range []attribute.Key{"lor.client.email", "lor.api.token"} {
		if v, ok := attrs.Value(key); ok {
			t.Errorf("span carries %s = %q, want it dropped", key, v.AsString())
		}
	}
}

func TestAppRegistryClassifiesMetricAttributes(t *testing.T) {
	rec := o11ytest.Start(t, withLORRegistry())
	counter, err := rec.SDK.MeterProvider().Meter("test").Int64Counter("lor.logins")
	if err != nil {
		t.Fatalf("Int64Counter: %v", err)
	}
	counter.Add(context.Background(), 1, metric.WithAttributes(
		attribute.String("lor.user.role", "studio"),
		attribute.String("lor.client.email", "a@example.com"),
	))

	for _, sm := range rec.Metrics().ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "lor.logins" {
				continue
			}
			sum, ok := m.Data.(metricdata.Sum[int64])
			if !ok {
				t.Fatalf("lor.logins is %T, want an int64 sum", m.Data)
			}
			if len(sum.DataPoints) != 1 {
				t.Fatalf("lor.logins has %d data points, want 1", len(sum.DataPoints))
			}
			point := sum.DataPoints[0]
			if _, ok := point.Attributes.Value("lor.client.email"); ok {
				t.Error("metric point carries lor.client.email, want it dropped")
			}
			if v, ok := point.Attributes.Value("lor.user.role"); !ok || v.AsString() != "studio" {
				t.Errorf("lor.user.role = %q (present %v), want studio", v.AsString(), ok)
			}
			return
		}
	}
	t.Fatal("no lor.logins metric recorded")
}

func TestAppRegistryClassifiesResourceAttributes(t *testing.T) {
	sdk, _, _, _ := newHermetic(t, withLORRegistry(), o11y.WithResourceAttributes(
		attribute.String("lor.api.token", "t0k"),
		attribute.String("lor.user.id", "u-1"),
	))
	set := sdk.Resource().Set()
	if v, ok := set.Value("lor.api.token"); ok {
		t.Errorf("resource carries lor.api.token = %q, want it dropped", v.AsString())
	}
	if v, ok := set.Value("lor.user.id"); !ok || v.AsString() != "u-1" {
		t.Errorf("resource lor.user.id = %q (present %v), want u-1", v.AsString(), ok)
	}
}

func TestAppRegistryMergesNamespaces(t *testing.T) {
	const shopRegistry = `schema: libo11y.app-registry/v1
namespace: shop
attributes:
  shop.card.number: {type: string, sensitivity: secret, cardinality: unbounded}
`
	sdk, _, _, console := newHermetic(t, withLORRegistry(),
		o11y.WithAppRegistry(registryFS(map[string]string{"shop.yaml": shopRegistry}), "shop.yaml"))
	sdk.Logger().Info("event", "lor.api.token", "t0k", "shop.card.number", "4111", "lor.user.id", "u-1")

	record := onlyRecord(t, console)
	for _, key := range []string{"lor.api.token", "shop.card.number"} {
		if value, present := record[key]; present {
			t.Errorf("%s = %v, want it dropped", key, value)
		}
	}
	if got := record["lor.user.id"]; got != "u-1" {
		t.Errorf("lor.user.id = %v, want u-1", got)
	}
}

func TestAppRegistryErrors(t *testing.T) {
	reserved := strings.Replace(lorRegistry, "namespace: lor", "namespace: o11y", 1)
	cases := []struct {
		name    string
		opts    []o11y.Option
		wantIs  error // nil: only the message is checked
		wantMsg string
	}{
		{"missing file", []o11y.Option{o11y.WithAppRegistry(registryFS(nil), "absent.yaml")}, fs.ErrNotExist, "absent.yaml"},
		{"empty file", []o11y.Option{o11y.WithAppRegistry(registryFS(map[string]string{"r.yaml": ""}), "r.yaml")}, appregistry.ErrEmpty, "r.yaml"},
		{"parse error", []o11y.Option{o11y.WithAppRegistry(registryFS(map[string]string{"r.yaml": "schema: [\n"}), "r.yaml")}, nil, "parsing application registry"},
		{"rule violation", []o11y.Option{o11y.WithAppRegistry(registryFS(map[string]string{"r.yaml": reserved}), "r.yaml")}, o11y.ErrInvalidAppRegistry, "libo11y_app_namespace_reserved"},
		{"duplicate namespace", []o11y.Option{withLORRegistry(), withLORRegistry()}, o11y.ErrInvalidAppRegistry, `both declare namespace "lor"`},
		{"nil fs", []o11y.Option{o11y.WithAppRegistry(nil, "r.yaml")}, o11y.ErrInvalidAppRegistry, "nil fs.FS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sdk, err := o11y.New(context.Background(), append(hermeticOptions(t.Name()), tc.opts...)...)
			if err == nil {
				_ = sdk.Shutdown(context.Background()) // the missing error is the failure being reported
				t.Fatal("New succeeded, want an application registry error")
			}
			if tc.wantIs != nil && !errors.Is(err, tc.wantIs) {
				t.Errorf("error %q does not wrap %v", err, tc.wantIs)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err, tc.wantMsg)
			}
		})
	}
}
