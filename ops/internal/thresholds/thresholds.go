// Package thresholds reads and validates the thresholds the generated alert
// rules use.
package thresholds

import (
	"bytes"
	"errors"
	"fmt"
	"maps"
	"math"
	"os"
	"slices"

	"github.com/prometheus/prometheus/promql/parser"
	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/ops"
)

// Vital holds one vital's rating bounds: good up to Good, poor above Poor.
type Vital struct {
	Good float64 `yaml:"good"`
	Poor float64 `yaml:"poor"`
}

// Thresholds holds every threshold, minimum traffic and the gateway
// selector.
type Thresholds struct {
	MinViewsPerHour          int              `yaml:"min_views_per_hour"`
	RegressionRatio          float64          `yaml:"regression_ratio"`
	ErrorsPerView            float64          `yaml:"errors_per_view"`
	GatewaySelector          string           `yaml:"gateway_selector"`
	GatewayRejectionRatio    float64          `yaml:"gateway_rejection_ratio"`
	GatewayMinRequestsPerSec float64          `yaml:"gateway_min_requests_per_second"`
	RateLimitedRatio         float64          `yaml:"rate_limited_ratio"`
	SinkFailureRatio         float64          `yaml:"sink_failure_ratio"`
	SinkP99Seconds           float64          `yaml:"sink_p99_seconds"`
	AggregatorSeriesWarn     int              `yaml:"aggregator_series_warn"`
	Vitals                   map[string]Vital `yaml:"vitals"` // lcp, inp, cls, fcp, ttfb
}

// VitalKeys are the vitals a thresholds file must cover.
var VitalKeys = []string{"lcp", "inp", "cls", "fcp", "ttfb"}

// Load reads and validates a thresholds file.
func Load(path string) (Thresholds, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Thresholds{}, err
	}
	t, err := Parse(raw)
	if err != nil {
		return Thresholds{}, fmt.Errorf("%s: %w", path, err)
	}
	return t, nil
}

// Default returns the embedded ops/thresholds.yaml. Its validity is a test
// of this package, so a failure here is a build defect.
func Default() Thresholds {
	t, err := Parse(ops.DefaultThresholds)
	if err != nil {
		panic(fmt.Sprintf("thresholds: the embedded thresholds.yaml is invalid: %v", err))
	}
	return t
}

// Parse decodes and validates thresholds. Unknown keys are an error, so a
// misspelt threshold never silently keeps its default.
func Parse(raw []byte) (Thresholds, error) {
	var t Thresholds
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&t); err != nil {
		return Thresholds{}, err
	}
	if err := t.validate(); err != nil {
		return Thresholds{}, err
	}
	return t, nil
}

func (t Thresholds) validate() error {
	var errs []error
	if t.MinViewsPerHour < 0 {
		errs = append(errs, errors.New("min_views_per_hour must not be negative"))
	}
	if t.AggregatorSeriesWarn < 0 {
		errs = append(errs, errors.New("aggregator_series_warn must not be negative"))
	}
	if t.RegressionRatio <= 1 || !finite(t.RegressionRatio) {
		errs = append(errs, errors.New("regression_ratio must be above 1"))
	}
	ratios := map[string]float64{
		"errors_per_view":                 t.ErrorsPerView,
		"gateway_rejection_ratio":         t.GatewayRejectionRatio,
		"gateway_min_requests_per_second": t.GatewayMinRequestsPerSec,
		"rate_limited_ratio":              t.RateLimitedRatio,
		"sink_failure_ratio":              t.SinkFailureRatio,
	}
	for _, name := range slices.Sorted(maps.Keys(ratios)) {
		if v := ratios[name]; v < 0 || !finite(v) {
			errs = append(errs, fmt.Errorf("%s must be a finite number, not negative", name))
		}
	}
	if t.SinkP99Seconds <= 0 || !finite(t.SinkP99Seconds) {
		errs = append(errs, errors.New("sink_p99_seconds must be above 0"))
	}
	if _, err := parser.NewParser(parser.Options{}).ParseMetricSelector("{" + t.GatewaySelector + "}"); err != nil {
		errs = append(errs, fmt.Errorf("gateway_selector %q is not a PromQL label matcher list: %w", t.GatewaySelector, err))
	}
	for _, k := range VitalKeys {
		v, ok := t.Vitals[k]
		switch {
		case !ok:
			errs = append(errs, fmt.Errorf("vitals.%s is missing", k))
		case !finite(v.Good) || !finite(v.Poor) || v.Good <= 0 || v.Good >= v.Poor:
			errs = append(errs, fmt.Errorf("vitals.%s: good %v must be above 0 and under poor %v", k, v.Good, v.Poor))
		}
	}
	for _, k := range slices.Sorted(maps.Keys(t.Vitals)) {
		if !slices.Contains(VitalKeys, k) {
			errs = append(errs, fmt.Errorf("vitals.%s is not a vital the gateway derives", k))
		}
	}
	return errors.Join(errs...)
}

// finite reports whether v is neither NaN nor infinite. YAML can spell
// both, and every comparison with NaN is false, so bounds checks alone
// would let it through.
func finite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}
