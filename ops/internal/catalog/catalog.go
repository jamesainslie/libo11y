// Package catalog holds the metric families the o11yrum gateway exports on
// its Prometheus endpoint, as names, types and label names. The golden
// catalog in testdata/exported.txt is captured from the real gateway, and
// every query and rule in the pack is checked against it.
package catalog

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"slices"
	"strings"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// Family is one metric family.
type Family struct {
	Name   string
	Type   string   // counter, gauge or histogram, from the exposition TYPE line
	Labels []string // sorted, without le, job, instance and the otel_scope_* labels
}

// Catalog maps a family name to its family.
type Catalog map[string]Family

// Types a family may have.
var types = map[string]bool{"counter": true, "gauge": true, "histogram": true}

// dropped lists labels that are not part of a family's own label set: le
// belongs to histogram buckets, job and instance come from the scrape, and
// the scope labels from the exporter.
var dropped = map[string]bool{
	"le": true, "job": true, "instance": true,
	"otel_scope_name": true, "otel_scope_version": true, "otel_scope_schema_url": true,
}

// histogramSuffixes are the series a histogram family exposes.
var histogramSuffixes = []string{"_bucket", "_sum", "_count"}

// Resolve returns the family a series name belongs to. A histogram's
// _bucket, _sum and _count series resolve to the histogram.
func (c Catalog) Resolve(series string) (Family, bool) {
	if f, ok := c[series]; ok {
		return f, true
	}
	for _, s := range histogramSuffixes {
		if base, ok := strings.CutSuffix(series, s); ok {
			if f, ok := c[base]; ok && f.Type == "histogram" {
				return f, true
			}
		}
	}
	return Family{}, false
}

// Format renders the catalog in the golden form: one family per line,
// sorted by name, as "<name> <type> <label>,<label>,...". A family with no
// labels has no third field.
func (c Catalog) Format() []byte {
	var b bytes.Buffer
	for _, name := range slices.Sorted(maps.Keys(c)) {
		f := c[name]
		b.WriteString(f.Name + " " + f.Type)
		if len(f.Labels) > 0 {
			b.WriteString(" " + strings.Join(f.Labels, ","))
		}
		b.WriteByte('\n')
	}
	return b.Bytes()
}

// Load reads a golden catalog file.
func Load(path string) (Catalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := Catalog{}
	prev := ""
	for i, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || len(fields) > 3 {
			return nil, fmt.Errorf("%s:%d: want <name> <type> [<label>,...], got %q", path, i+1, line)
		}
		f := Family{Name: fields[0], Type: fields[1]}
		if !types[f.Type] {
			return nil, fmt.Errorf("%s:%d: unknown type %q", path, i+1, f.Type)
		}
		if f.Name <= prev {
			return nil, fmt.Errorf("%s:%d: %s is out of order or repeated", path, i+1, f.Name)
		}
		prev = f.Name
		if len(fields) == 3 {
			f.Labels = strings.Split(fields[2], ",")
			if slices.Contains(f.Labels, "") || !slices.IsSorted(f.Labels) {
				return nil, fmt.Errorf("%s:%d: labels must be non-empty and sorted", path, i+1)
			}
		}
		c[f.Name] = f
	}
	return c, nil
}

// Parse reads a Prometheus text exposition into a catalog. target_info,
// which carries the resource rather than a metric, is left out.
func Parse(r io.Reader) (Catalog, error) {
	p := expfmt.NewTextParser(model.UTF8Validation)
	fams, err := p.TextToMetricFamilies(r)
	if err != nil {
		return nil, err
	}
	c := Catalog{}
	for name, mf := range fams {
		if name == "target_info" {
			continue
		}
		typ, err := familyType(mf.GetType())
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		labels := map[string]bool{}
		for _, m := range mf.GetMetric() {
			for _, lp := range m.GetLabel() {
				if !dropped[lp.GetName()] {
					labels[lp.GetName()] = true
				}
			}
		}
		c[name] = Family{Name: name, Type: typ, Labels: slices.Sorted(maps.Keys(labels))}
	}
	return c, nil
}

func familyType(t dto.MetricType) (string, error) {
	switch t {
	case dto.MetricType_COUNTER:
		return "counter", nil
	case dto.MetricType_GAUGE:
		return "gauge", nil
	case dto.MetricType_HISTOGRAM:
		return "histogram", nil
	}
	return "", errors.New("type " + t.String() + " is not one the pack queries")
}
