package o11y

import (
	"log/slog"
	"testing"
)

func TestClassifyDropsGroupedPII(t *testing.T) {
	// host.ip is PII in the current table; emitted through slog.Group("host",...)
	// the policy must still classify it on the effective key "host.ip".
	c := &classifier{policy: dropPolicy()}
	got, keep, changed := c.classifyAttr([]string{"host"}, slog.String("ip", "10.0.0.1"))
	if keep || !changed {
		t.Fatalf("grouped host.ip not dropped: keep=%v changed=%v, got %v", keep, changed, got)
	}
}
