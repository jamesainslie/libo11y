// Package rules builds Prometheus rule files, and the Prometheus Operator's
// PrometheusRule, from Go values.
package rules

import (
	"bytes"
	"errors"

	"gopkg.in/yaml.v3"
)

// Rule is one recording or alerting rule. Fields are rendered in this
// order, so each rule reads top to bottom.
type Rule struct {
	Record      string            `yaml:"record,omitempty"`
	Alert       string            `yaml:"alert,omitempty"`
	Expr        string            `yaml:"expr"`
	For         string            `yaml:"for,omitempty"`
	Labels      map[string]string `yaml:"labels,omitempty"`
	Annotations map[string]string `yaml:"annotations,omitempty"`
}

// Group is one rule group.
type Group struct {
	Name     string `yaml:"name"`
	Interval string `yaml:"interval,omitempty"`
	Rules    []Rule `yaml:"rules"`
}

// File is one Prometheus rule file.
type File struct {
	Groups []Group `yaml:"groups"`
}

// YAML renders the file with a two-space indent. Map keys are sorted, so
// the output is stable.
func (f File) YAML() ([]byte, error) {
	return encode(f)
}

// prometheusRule is the monitoring.coreos.com/v1 PrometheusRule object.
type prometheusRule struct {
	APIVersion string   `yaml:"apiVersion"`
	Kind       string   `yaml:"kind"`
	Metadata   metadata `yaml:"metadata"`
	Spec       File     `yaml:"spec"`
}

type metadata struct {
	Name   string            `yaml:"name"`
	Labels map[string]string `yaml:"labels"`
}

// PrometheusRule renders one Prometheus Operator PrometheusRule named name
// holding the groups of every file, in order. It sets no namespace, so a
// kustomization or kubectl decides where it goes.
func PrometheusRule(name string, files ...File) ([]byte, error) {
	if name == "" {
		return nil, errors.New("rules: a PrometheusRule needs a name")
	}
	var spec File
	for _, f := range files {
		spec.Groups = append(spec.Groups, f.Groups...)
	}
	return encode(prometheusRule{
		APIVersion: "monitoring.coreos.com/v1",
		Kind:       "PrometheusRule",
		Metadata:   metadata{Name: name, Labels: map[string]string{"app.kubernetes.io/part-of": "libo11y"}},
		Spec:       spec,
	})
}

func encode(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(2)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}
