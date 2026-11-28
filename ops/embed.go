// Package ops is the libo11y RUM ops pack: generated Grafana dashboards and
// Prometheus rules, and the Go code that generates and tests them. The root
// package only embeds the default thresholds.
package ops

import _ "embed"

// DefaultThresholds is thresholds.yaml, the thresholds the committed rules
// are generated from.
//
//go:embed thresholds.yaml
var DefaultThresholds []byte
