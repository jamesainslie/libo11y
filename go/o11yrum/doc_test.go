package o11yrum_test

import (
	"testing"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

func TestSignalValues(t *testing.T) {
	for sig, want := range map[o11yrum.Signal]string{
		o11yrum.SignalTraces:  "traces",
		o11yrum.SignalLogs:    "logs",
		o11yrum.SignalMetrics: "metrics",
	} {
		if string(sig) != want {
			t.Errorf("signal %q, want %q", sig, want)
		}
	}
}
