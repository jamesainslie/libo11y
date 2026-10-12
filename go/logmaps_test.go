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
	table := map[attribute.Key]spectables.Sensitivity{"host.net.ip": spectables.PII, "host.7.ip": spectables.PII}
	cases := map[string]struct {
		value      any
		classified string
		kept       string // unclassified member key; default host.name
	}{
		"map":          {map[string]any{"ip": "10.9.9.9", "name": "web-1"}, "host.ip", ""},
		"nested map":   {map[string]any{"net": map[string]any{"ip": "10.9.9.9"}, "name": "web-1"}, "host.net.ip", ""},
		"slice of map": {[]map[string]any{{"ip": "10.9.9.9", "name": "web-1"}, {"ip": "10.9.9.8"}}, "host.ip", ""},
		"pointer to map": {
			&map[string]any{"ip": "10.9.9.9", "name": "web-1"}, "host.ip", "",
		},
		"pointer to pointer": {
			ptrTo(&map[string]any{"ip": "10.9.9.9", "name": "web-1"}), "host.ip", "",
		},
		"pointer to interface": {
			ptrTo[any](map[string]any{"ip": "10.9.9.9", "name": "web-1"}), "host.ip", "",
		},
		"slice of pointers": {
			[]*map[string]any{{"ip": "10.9.9.9", "name": "web-1"}}, "host.ip", "",
		},
		"map member pointer": {
			map[string]any{"net": &map[string]any{"ip": "10.9.9.9"}, "name": "web-1"}, "host.net.ip", "",
		},
		"non-string keys": {
			map[int]any{7: map[string]any{"ip": "10.9.9.9", "name": "web-1"}}, "host.7.ip", "host.7.name",
		},
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
				kept := tc.kept
				if kept == "" {
					kept = "host.name"
				}
				if got := bridge[kept]; len(got) != 1 || got[0] != "web-1" {
					t.Errorf("bridge lost unclassified %s: %v", kept, bridge)
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
					if !slices.Equal(got[kept], bridge[kept]) {
						t.Errorf("%s %s = %v, bridge %v", sink, kept, got[kept], bridge[kept])
					}
				}
			})
		}
	}
}

func ptrTo[T any](v T) *T { return &v }

// ownSinks logs value under "host" through the SDK's own logger and returns
// the flattened "host" attributes each slog sink received: console, extra
// sink, and the OTLP leg.
func ownSinks(t *testing.T, value any) map[string]map[string][]string {
	t.Helper()
	exp := &memLogExporter{}
	extra, captured := newSlogCapture()
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp), o11y.WithExtraLogHandler(extra))
	sdk.Logger().Info("own", "host", value)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(console.String()), "\n")
	recs := exp.snapshot()
	extras := captured()
	if len(lines) != 1 || len(recs) != 1 || len(extras) != 1 {
		t.Fatalf("console %d, OTLP %d, extra %d records; want 1 each", len(lines), len(recs), len(extras))
	}
	var extraLine bytes.Buffer
	if err := slog.NewJSONHandler(&extraLine, nil).Handle(context.Background(), extras[0]); err != nil {
		t.Fatal(err)
	}
	return map[string]map[string][]string{
		"console": hostOfJSON(t, []byte(lines[0])),
		"extra":   hostOfJSON(t, extraLine.Bytes()),
		"otlp":    hostOfRecord(recs[0]),
	}
}

// assertNoValue fails if any sink carries want anywhere under "host".
func assertNoValue(t *testing.T, sinks map[string]map[string][]string, want string) {
	t.Helper()
	for sink, attrs := range sinks {
		for key, values := range attrs {
			for _, v := range values {
				if strings.Contains(v, want) {
					t.Errorf("%s leaked %s=%s", sink, key, v)
				}
			}
		}
	}
}

// A self-referencing map is walked to a bounded depth: members are judged on
// their effective keys at every level walked (host.ip is classified, the
// deeper host.self.ip is not), and what lies past the bound is dropped
// rather than forwarded raw, so no sink receives the cycle itself.
func TestSlogSelfReferencingMapFailsClosed(t *testing.T) {
	t.Parallel()
	m := map[string]any{"ip": "10.9.9.9", "name": "web-1"}
	m["self"] = m
	sinks := ownSinks(t, m)
	for sink, attrs := range sinks {
		if _, leaked := attrs["host.ip"]; leaked {
			t.Errorf("%s leaked host.ip: %v", sink, attrs["host.ip"])
		}
		for key, values := range attrs {
			// The raw cycle would render as a JSON encoding error on the
			// console and nest to the bridge's depth limit on OTLP.
			if depth := strings.Count(key, "."); depth > 17 {
				t.Errorf("%s carries %s, deeper than the walk bound", sink, key)
			}
			for _, v := range values {
				if strings.Contains(v, "!ERROR") || strings.Contains(v, "max depth") {
					t.Errorf("%s forwarded the raw cycle: %s=%s", sink, key, v)
				}
			}
		}
		if got := attrs["host.name"]; len(got) != 1 || got[0] != "web-1" {
			t.Errorf("%s host.name = %v, want [web-1]", sink, got)
		}
		if got := attrs["host.self.name"]; len(got) != 1 || got[0] != "web-1" {
			t.Errorf("%s host.self.name = %v, want [web-1]", sink, got)
		}
	}
}

// Slice elements share their holder's key, so nesting slices does not grow
// the effective key. A map nested deeper than the bound is dropped, never
// forwarded raw.
func TestSlogDeeplyNestedSlicesFailClosed(t *testing.T) {
	t.Parallel()
	var v any = map[string]any{"ip": "10.9.9.9"}
	for range 17 {
		v = []any{v}
	}
	assertNoValue(t, ownSinks(t, v), "10.9.9.9")
}

// A nil pointer is a leaf: logging it neither panics nor drops the record.
func TestSlogNilPointerToMap(t *testing.T) {
	t.Parallel()
	ownSinks(t, (*map[string]any)(nil))
}

// A whole map under a classified key is one value: under PIIHash the slog
// pipeline and a bridge render it to the same canonical form and so produce
// the same token.
func TestSlogMapUnderClassifiedKeyTokenMatchesBridge(t *testing.T) {
	t.Parallel()
	exp := &memLogExporter{}
	sdk, _, _, console := newHermetic(t, o11y.WithLogExporter(exp),
		o11y.WithPIIMode(o11y.PIIHash), o11y.WithPIIHashKey(testKey))
	value := map[string]any{"v4": "10.9.9.9", "port": 22}
	sdk.Logger().Info("own", "host.ip", value)
	otelslog.NewLogger("thirdparty", otelslog.WithLoggerProvider(sdk.LoggerProvider())).Info("bridged", "host.ip", value)
	if err := sdk.ForceFlush(context.Background()); err != nil {
		t.Fatal(err)
	}
	consoleToken, _ := consoleRecords(t, console)[0]["host.ip"].(string)
	recs := exp.snapshot()
	ownToken, bridgeToken := logAttrs(recs[0])["host.ip"], logAttrs(recs[1])["host.ip"]
	if !strings.HasPrefix(consoleToken, "hmac-sha256:") || ownToken != consoleToken || bridgeToken != consoleToken {
		t.Errorf("console %q, OTLP leg %q, bridge %q: want one token", consoleToken, ownToken, bridgeToken)
	}
}
