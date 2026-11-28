package rules

import (
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/rulefmt"
	"github.com/prometheus/prometheus/promql/parser"
	"gopkg.in/yaml.v3"
)

func sample() File {
	return File{Groups: []Group{{
		Name: "g", Interval: "1m",
		Rules: []Rule{
			{Record: "service_name:x:rate5m", Expr: "sum by (service_name) (rate(x_total[5m]))"},
			{
				Alert: "XHigh", Expr: "service_name:x:rate5m > 1\nand on (service_name) service_name:x:rate5m < 9", For: "5m",
				Labels:      map[string]string{"severity": "warning"},
				Annotations: map[string]string{"summary": "x is high for {{ $labels.service_name }}", "description": "x is high."},
			},
		},
	}}}
}

func TestFileYAML(t *testing.T) {
	f := sample()
	b, err := f.YAML()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(b), "\n") || strings.Contains(string(b), "alert: \"\"") {
		t.Fatalf("unexpected YAML:\n%s", b)
	}
	var back File
	if err := yaml.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.Groups[0].Rules[1].Labels["severity"] != "warning" || back.Groups[0].Rules[0].Record != "service_name:x:rate5m" {
		t.Fatalf("round trip lost data: %+v", back)
	}
	if back.Groups[0].Rules[1].Expr != f.Groups[0].Rules[1].Expr {
		t.Fatalf("multi-line expr changed: %q", back.Groups[0].Rules[1].Expr)
	}
	again, err := f.YAML()
	if err != nil || string(again) != string(b) {
		t.Fatal("output is not stable")
	}
}

// TestFileYAMLIsAPrometheusRuleFile parses the output as Prometheus does
// when it loads a rule file, unknown fields refused.
func TestFileYAMLIsAPrometheusRuleFile(t *testing.T) {
	b, err := sample().YAML()
	if err != nil {
		t.Fatal(err)
	}
	groups, errs := rulefmt.Parse(b, false, model.UTF8Validation, parser.NewParser(parser.Options{}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if len(errs) > 0 {
		t.Fatalf("rulefmt.Parse: %v\n%s", errs, b)
	}
	if len(groups.Groups) != 1 || len(groups.Groups[0].Rules) != 2 {
		t.Fatalf("parsed %+v", groups)
	}
}

// TestFileYAMLKeyOrder keeps each rule readable top to bottom: what it
// records or alerts on, the expression, then for, labels and annotations.
func TestFileYAMLKeyOrder(t *testing.T) {
	b, err := sample().YAML()
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Groups []struct {
			Rules []yaml.Node `yaml:"rules"`
		} `yaml:"groups"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"record", "expr"}, {"alert", "expr", "for", "labels", "annotations"}}
	for i, n := range doc.Groups[0].Rules {
		var keys []string
		for j := 0; j < len(n.Content); j += 2 {
			keys = append(keys, n.Content[j].Value)
		}
		if !slices.Equal(keys, want[i]) {
			t.Errorf("rule %d keys %q, want %q", i, keys, want[i])
		}
	}
}

func TestPrometheusRule(t *testing.T) {
	a := sample()
	b := File{Groups: []Group{{Name: "h", Rules: []Rule{{Alert: "Y", Expr: "up == 0", Labels: map[string]string{"severity": "critical"}}}}}}
	out, err := PrometheusRule("libo11y-rum", a, b)
	if err != nil {
		t.Fatal(err)
	}
	var pr struct {
		APIVersion string `yaml:"apiVersion"`
		Kind       string `yaml:"kind"`
		Metadata   struct {
			Name   string            `yaml:"name"`
			Labels map[string]string `yaml:"labels"`
		} `yaml:"metadata"`
		Spec File `yaml:"spec"`
	}
	dec := yaml.NewDecoder(strings.NewReader(string(out)))
	dec.KnownFields(true)
	if err := dec.Decode(&pr); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if pr.APIVersion != "monitoring.coreos.com/v1" || pr.Kind != "PrometheusRule" || pr.Metadata.Name != "libo11y-rum" {
		t.Errorf("header %s %s %s", pr.APIVersion, pr.Kind, pr.Metadata.Name)
	}
	if pr.Metadata.Labels["app.kubernetes.io/part-of"] != "libo11y" {
		t.Errorf("labels %v, want app.kubernetes.io/part-of: libo11y", pr.Metadata.Labels)
	}
	var names []string
	for _, g := range pr.Spec.Groups {
		names = append(names, g.Name)
	}
	if !slices.Equal(names, []string{"g", "h"}) || pr.Spec.Groups[0].Rules[1].Expr != a.Groups[0].Rules[1].Expr {
		t.Errorf("spec.groups %+v, want the groups of both files in order", pr.Spec.Groups)
	}
	if _, err := PrometheusRule(""); err == nil {
		t.Error("a PrometheusRule without a name was accepted")
	}
}
