package o11y

import (
	"log/slog"
	"testing"
)

func TestClassifyDropsGroupedPII(t *testing.T) {
	// host.ip is PII in the current table; emitted through slog.Group("host",...)
	// the policy must still classify it on the effective key "host.ip".
	got, action := dropPolicy().slogAttr([]string{"host"}, slog.String("ip", "10.0.0.1"))
	if action != actionDrop {
		t.Fatalf("grouped host.ip not dropped: action %v, got %v", action, got)
	}
}
