package o11y

import (
	"log/slog"
	"testing"
)

func TestSpecReplacerRedactsGroupedSecret(t *testing.T) {
	// host.ip is PII in the current table; emitted through slog.Group("host",...)
	// the replacer must still classify it on the effective key "host.ip".
	rep := specReplacer(nil, PIIDrop, nil)
	got := rep([]string{"host"}, slog.String("ip", "10.0.0.1"))
	if !got.Equal(slog.Attr{}) {
		t.Fatalf("grouped host.ip not dropped: got %v", got)
	}
}
