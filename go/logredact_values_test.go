package o11y_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	o11y "github.com/jamesainslie/libo11y/go"
)

type sliceHolder struct{ Values []string }

func TestLoggerAcceptsUncomparableValues(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name  string
		value any
		want  string // substring the console JSON must contain
	}{
		{"map", map[string]string{"key": "value"}, `"key":"value"`},
		{"slice", []string{"value"}, `["value"]`},
		{"struct", sliceHolder{Values: []string{"value"}}, `"Values":["value"]`},
		{"bytes", []byte("value"), `"dmFsdWU="`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			exp := &memLogExporter{}
			extra, captured := newSlogCapture()
			sdk, _, _, console := newHermetic(t,
				o11y.WithLogExporter(exp),
				o11y.WithExtraLogHandler(extra),
				o11y.WithPIIMode(o11y.PIIDrop),
			)
			logger := sdk.Logger()
			logger.Info("direct", "v", tc.value, "host.ip", "10.9.8.7")
			logger.Info("grouped", slog.Group("g", slog.Any("v", tc.value)))
			logger.With("v", tc.value).Info("with")
			logger.WithGroup("wg").Info("withgroup", "v", tc.value)
			if err := sdk.ForceFlush(context.Background()); err != nil {
				t.Fatalf("ForceFlush: %v", err)
			}

			lines := consoleRecords(t, console)
			if len(lines) != 4 {
				t.Fatalf("console got %d records, want 4", len(lines))
			}
			for _, line := range strings.Split(strings.TrimSpace(console.String()), "\n") {
				if !strings.Contains(line, tc.want) {
					t.Errorf("console line missing %s: %s", tc.want, line)
				}
			}
			if strings.Contains(console.String(), "10.9.8.7") {
				t.Error("PII host.ip reached the console")
			}
			if got := len(captured()); got != 4 {
				t.Errorf("extra sink got %d records, want 4", got)
			}
			recs := exp.snapshot()
			if len(recs) != 4 {
				t.Fatalf("OTLP leg got %d records, want 4", len(recs))
			}
			for _, r := range recs {
				attrs := logAttrs(r)
				found := false
				// logAttrs flattens map values, so a map-valued v appears
				// as v.key (or g.v.key when grouped).
				for k := range attrs {
					if k == "v" || strings.HasSuffix(k, ".v") ||
						strings.HasPrefix(k, "v.") || strings.Contains(k, ".v.") {
						found = true
					}
				}
				if !found {
					t.Errorf("OTLP record %q lost attribute v: %v", r.Body().AsString(), attrs)
				}
				if _, leaked := attrs["host.ip"]; leaked {
					t.Error("PII host.ip reached the OTLP leg")
				}
			}
		})
	}
}
