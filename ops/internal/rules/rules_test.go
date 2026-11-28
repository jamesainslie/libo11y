package rules

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestFileYAML(t *testing.T) {
	f := File{Groups: []Group{{
		Name: "g", Interval: "1m",
		Rules: []Rule{
			{Record: "service_name:x:rate5m", Expr: "sum by (service_name) (rate(x_total[5m]))"},
			{Alert: "XHigh", Expr: "service_name:x:rate5m > 1", For: "5m", Labels: map[string]string{"severity": "warning"}, Annotations: map[string]string{"summary": "x is high"}},
		},
	}}}
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
	again, err := f.YAML()
	if err != nil || string(again) != string(b) {
		t.Fatal("output is not stable")
	}
}
