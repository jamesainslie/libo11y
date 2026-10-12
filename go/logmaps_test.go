package o11y_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/attribute"
	sdklog "go.opentelemetry.io/otel/sdk/log"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// flatJSON flattens a decoded JSON value to dotted keys. Array elements share
// their holder's key, so a slice of objects contributes every element's
// members under one key; values are sorted for comparison.
func flatJSON(prefix string, v any, out map[string][]string) {
	switch x := v.(type) {
	case map[string]any:
		for k, m := range x {
			key := k
			if prefix != "" {
				key = prefix + "." + k
			}
			flatJSON(key, m, out)
		}
	case []any:
		for _, e := range x {
			flatJSON(prefix, e, out)
		}
	default:
		out[prefix] = append(out[prefix], fmt.Sprint(x))
		slices.Sort(out[prefix])
	}
}

// flatAttr flattens an OTel attribute value the same way.
func flatAttr(prefix string, v attribute.Value, out map[string][]string) {
	switch v.Type() {
	case attribute.MAP:
		for _, m := range v.AsMap() {
			key := string(m.Key)
			if prefix != "" {
				key = prefix + "." + key
			}
			flatAttr(key, m.Value, out)
		}
	case attribute.SLICE:
		for _, e := range v.AsSlice() {
			flatAttr(prefix, e, out)
		}
	default:
		out[prefix] = append(out[prefix], v.String())
		slices.Sort(out[prefix])
	}
}

// hostOf returns the flattened attributes under "host" of one JSON log line.
func hostOfJSON(t *testing.T, line []byte) map[string][]string {
	t.Helper()
	var rec map[string]any
	if err := json.Unmarshal(line, &rec); err != nil {
		t.Fatalf("unmarshal %q: %v", line, err)
	}
	out := map[string][]string{}
	if host, ok := rec["host"]; ok {
		flatJSON("host", host, out)
	}
	return out
}

func hostOfRecord(r sdklog.Record) map[string][]string {
	out := map[string][]string{}
	r.WalkAttributes(func(kv attribute.KeyValue) bool {
		if kv.Key == "host" {
			flatAttr("host", kv.Value, out)
		}
		return true
	})
	return out
}

// A Go map logged as one slog value, a map nested in it, and a slice of maps
// are classified on their dotted member keys on every slog sink (console,
// extra sink, OTLP leg) exactly as a third-party bridge record is, and
// unclassified members keep their values.
func TestSlogMapValuesClassifiedOnEverySink(t *testing.T) {
	t.Parallel()
	table := map[attribute.Key]spectables.Sensitivity{"host.net.ip": spectables.PII}
	cases := map[string]struct {
		value      any
		classified string
	}{
		"map":          {map[string]any{"ip": "10.9.9.9", "name": "web-1"}, "host.ip"},
		"nested map":   {map[string]any{"net": map[string]any{"ip": "10.9.9.9"}, "name": "web-1"}, "host.net.ip"},
		"slice of map": {[]map[string]any{{"ip": "10.9.9.9", "name": "web-1"}, {"ip": "10.9.9.8"}}, "host.ip"},
	}
	modes := map[string][]o11y.Option{
		"drop": nil,
		"hash": {o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey)},
	}
	for name, tc := range cases {
		for mode, opts := range modes {
			t.Run(name+"/"+mode, func(t *testing.T) {
				t.Parallel()
				exp := &memLogExporter{}
				extra, captured := newSlogCapture()
				sdk, _, _, console := newHermetic(t, append(opts,
					o11y.WithLogExporter(exp), o11y.WithExtraLogHandler(extra),
					o11y.WithSensitivityForTest(table))...)
				sdk.Logger().Info("own", "host", tc.value)
				otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider())).
					Info("bridged", "host", tc.value)
				if err := sdk.ForceFlush(context.Background()); err != nil {
					t.Fatal(err)
				}

				lines := strings.Split(strings.TrimSpace(console.String()), "\n")
				recs := exp.snapshot()
				extras := captured()
				if len(lines) != 1 || len(recs) != 2 || len(extras) != 1 {
					t.Fatalf("console %d, OTLP %d, extra %d records; want 1, 2, 1", len(lines), len(recs), len(extras))
				}
				var extraLine bytes.Buffer
				if err := slog.NewJSONHandler(&extraLine, nil).Handle(context.Background(), extras[0]); err != nil {
					t.Fatal(err)
				}
				sinks := map[string]map[string][]string{
					"console": hostOfJSON(t, []byte(lines[0])),
					"extra":   hostOfJSON(t, extraLine.Bytes()),
					"otlp":    hostOfRecord(recs[0]),
				}
				bridge := hostOfRecord(recs[1])
				if got := bridge["host.name"]; len(got) != 1 || got[0] != "web-1" {
					t.Errorf("bridge lost unclassified host.name: %v", bridge)
				}
				for _, v := range bridge[tc.classified] {
					if strings.HasPrefix(v, "10.9.9.") {
						t.Fatalf("bridge leaked %s: %v", tc.classified, bridge)
					}
				}
				for sink, got := range sinks {
					if !slices.Equal(got[tc.classified], bridge[tc.classified]) {
						t.Errorf("%s %s = %v, bridge %v", sink, tc.classified, got[tc.classified], bridge[tc.classified])
					}
					if !slices.Equal(got["host.name"], bridge["host.name"]) {
						t.Errorf("%s host.name = %v, bridge %v", sink, got["host.name"], bridge["host.name"])
					}
				}
			})
		}
	}
}

// A self-referencing map is walked to a bounded depth, never forever.
func TestSlogSelfReferencingMapTerminates(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp))
	m := map[string]any{"ip": "10.9.9.9"}
	m["self"] = m
	sdk.Logger().Info("own", "host", m)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(console.String(), "10.9.9.9") {
		t.Errorf("console leaked host.ip from a self-referencing map: %s", console.String())
	}
	if len(exp.snapshot()) != 1 {
		t.Errorf("OTLP got %d records, want 1", len(exp.snapshot()))
	}
}
